import crypto from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

export const PCM16_SAMPLE_RATE = 16000;
export const PCM16_CHANNELS = 1;
export const PCM16_FRAME_MS = 20;
export const PCM16_BYTES_PER_FRAME = (PCM16_SAMPLE_RATE * PCM16_FRAME_MS / 1000) * 2; // 640 bytes

export interface SynthesizeOptions {
  voice?: string;
  provider?: string;
  rate?: number;
}

export interface SynthesizeResult {
  pcm16: Buffer;
  engine: 'piper' | 'edge-tts' | 'espeak-ng' | 'openai' | 'elevenlabs' | 'tone-fallback';
  voiceUsed: string;
  cached: boolean;
  durationMs: number;
}

// LRU Cache: SHA-256 key -> PCM16 16kHz mono Buffer (capped at 128 entries / 64 MB)
const MAX_CACHE_ENTRIES = 128;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const pcmCache = new Map<string, { pcm16: Buffer; engine: SynthesizeResult['engine']; voiceUsed: string }>();
const inFlightSyntheses = new Map<string, Promise<SynthesizeResult>>();
let cachedBytesTotal = 0;

const EDGE_VOICE_MAP: Record<string, string> = {
  'Polly.Joanna': 'en-US-JennyNeural',
  'Polly.Joanna-Neural': 'en-US-JennyNeural',
  'Polly.Salli': 'en-US-AriaNeural',
  'Polly.Kendra': 'en-US-MichelleNeural',
  'Polly.Kimberly': 'en-US-AnaNeural',
  'Polly.Ivy': 'en-US-AriaNeural',
  'Polly.Matthew': 'en-US-GuyNeural',
  'Polly.Matthew-Neural': 'en-US-GuyNeural',
  'Polly.Joey': 'en-US-ChristopherNeural',
  'Polly.Justin': 'en-US-EricNeural',
  'Polly.Amy': 'en-GB-SoniaNeural',
  'Polly.Emma': 'en-GB-LibbyNeural',
  'Polly.Brian': 'en-GB-RyanNeural',
  'Polly.Nicole': 'en-AU-NatashaNeural',
  'Polly.Russell': 'en-AU-WilliamNeural',
  'Google.en-US-Wavenet-F': 'en-US-JennyNeural',
  'Google.en-US-Wavenet-D': 'en-US-GuyNeural',
  'Google.en-GB-Wavenet-A': 'en-GB-SoniaNeural',
  alice: 'en-US-JennyNeural',
  woman: 'en-US-JennyNeural',
  man: 'en-US-GuyNeural',
};

function resolveEdgeVoice(voice?: string): string {
  const envDefault = (process.env.VOICEDROP_TTS_VOICE || '').trim();
  const raw = (voice || '').trim();
  if (!raw) return envDefault || 'en-US-JennyNeural';
  if (/^[a-z]{2}-[A-Z]{2}-[A-Za-z0-9]+Neural$/.test(raw)) return raw;
  if (EDGE_VOICE_MAP[raw]) return EDGE_VOICE_MAP[raw];
  const lower = raw.toLowerCase();
  if (lower.includes('matthew') || lower.includes('joey') || lower.includes('brian') || lower.includes('male') || lower.includes('guy')) {
    return lower.includes('gb') || lower.includes('brian') ? 'en-GB-RyanNeural' : 'en-US-GuyNeural';
  }
  if (lower.includes('amy') || lower.includes('emma') || lower.includes('gb') || lower.includes('uk')) {
    return 'en-GB-SoniaNeural';
  }
  return envDefault || 'en-US-JennyNeural';
}

function resolveEspeakVoice(voice?: string): string {
  const raw = (voice || '').toLowerCase();
  if (raw.includes('gb') || raw.includes('amy') || raw.includes('brian') || raw.includes('emma')) {
    return raw.includes('brian') ? 'en-gb+m3' : 'en-gb+f3';
  }
  if (raw.includes('matthew') || raw.includes('joey') || raw.includes('guy') || raw.includes('man')) {
    return 'en-us+m3';
  }
  return 'en-us+f3';
}

function sanitizeTextForTts(raw: string): string {
  return String(raw || '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeXmlForSsml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function ensureEvenPcm16(buf: Buffer): Buffer {
  if (buf.length % 2 === 0) return buf;
  return buf.subarray(0, buf.length - 1);
}

function cacheSet(key: string, entry: { pcm16: Buffer; engine: SynthesizeResult['engine']; voiceUsed: string }) {
  if (pcmCache.has(key)) {
    const old = pcmCache.get(key)!;
    cachedBytesTotal -= old.pcm16.length;
    pcmCache.delete(key);
  }
  pcmCache.set(key, entry);
  cachedBytesTotal += entry.pcm16.length;

  while (pcmCache.size > MAX_CACHE_ENTRIES || cachedBytesTotal > MAX_CACHE_BYTES) {
    const oldestKey = pcmCache.keys().next().value;
    if (!oldestKey) break;
    const evicted = pcmCache.get(oldestKey);
    if (evicted) cachedBytesTotal -= evicted.pcm16.length;
    pcmCache.delete(oldestKey);
  }
}

/**
 * Converts arbitrary audio bytes (mp3/wav/ogg/opus/raw) to 16-bit signed little-endian mono PCM at 16000 Hz via ffmpeg.
 */
export function transcodeBufferToPcm16(
  inputBuffer: Buffer,
  inputArgs: string[] = []
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      ...inputArgs,
      '-i',
      'pipe:0',
      '-ac',
      String(PCM16_CHANNELS),
      '-ar',
      String(PCM16_SAMPLE_RATE),
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      'pipe:1',
    ];

    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill('SIGKILL');
      } catch {}
      reject(new Error('ffmpeg PCM16 transcode timed out'));
    }, 15000);

    proc.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = ensureEvenPcm16(Buffer.concat(stdoutChunks));
      if (code === 0 && out.length > 0) {
        resolve(out);
      } else {
        const errMsg = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(new Error(`ffmpeg exited with code ${code}: ${errMsg || 'empty PCM16 output'}`));
      }
    });

    proc.stdin.on('error', () => {
      // Ignore EPIPE when ffmpeg closes early
    });
    proc.stdin.end(inputBuffer);
  });
}

/**
 * Engine 1: Local offline neural Piper TTS (when PIPER_BIN + PIPER_MODEL are configured/installed).
 */
async function synthesizeWithPiper(text: string): Promise<{ pcm16: Buffer; voiceUsed: string }> {
  const piperBin = (process.env.PIPER_BIN || '/usr/local/bin/piper').trim();
  const piperModel = (process.env.PIPER_MODEL || '').trim();
  if (!piperModel || !fs.existsSync(piperBin) || !fs.existsSync(piperModel)) {
    throw new Error('Piper TTS binary or ONNX model not configured');
  }

  const wavBuf = await new Promise<Buffer>((resolve, reject) => {
    const proc = spawn(piperBin, ['--model', piperModel, '--output_file', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill('SIGKILL');
      } catch {}
      reject(new Error('Piper TTS timed out'));
    }, 15000);

    proc.stdout.on('data', (c: Buffer) => outChunks.push(c));
    proc.stderr.on('data', (c: Buffer) => errChunks.push(c));
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(outChunks);
      if (code === 0 && out.length > 44) {
        resolve(out);
      } else {
        reject(new Error(`Piper exited ${code}: ${Buffer.concat(errChunks).toString('utf8').trim()}`));
      }
    });

    proc.stdin.on('error', () => {});
    proc.stdin.end(text + '\n');
  });

  const pcm16 = await transcodeBufferToPcm16(wavBuf, ['-f', 'wav']);
  return { pcm16, voiceUsed: `piper:${piperModel.split('/').pop() || 'local'}` };
}

/**
 * Engine 2: Built-in Edge Neural TTS (zero paid API keys, natural human neural voices) -> ffmpeg -> PCM16 16kHz mono.
 */
async function synthesizeWithEdgeTts(text: string, voice?: string): Promise<{ pcm16: Buffer; voiceUsed: string }> {
  const edgeVoice = resolveEdgeVoice(voice);
  const tts = new MsEdgeTTS({
    connectionTimeoutMs: 8000,
    synthesisTimeoutMs: 15000,
  });

  try {
    await tts.setMetadata(edgeVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(escapeXmlForSsml(text));

    const mp3Buf = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Edge TTS stream timed out'));
      }, 15000);

      audioStream.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      audioStream.on('error', (err: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      audioStream.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const buf = Buffer.concat(chunks);
        if (buf.length < 64) {
          reject(new Error('Edge TTS returned empty audio stream'));
        } else {
          resolve(buf);
        }
      });
    });

    const pcm16 = await transcodeBufferToPcm16(mp3Buf, ['-f', 'mp3']);
    return { pcm16, voiceUsed: edgeVoice };
  } finally {
    try {
      tts.close();
    } catch {}
  }
}

/**
 * Engine 3: Local offline espeak-ng / espeak -> ffmpeg -> PCM16 16kHz mono (zero network dependency).
 */
async function synthesizeWithEspeak(text: string, voice?: string): Promise<{ pcm16: Buffer; voiceUsed: string }> {
  const espeakVoice = resolveEspeakVoice(voice);
  const candidates = ['espeak-ng', 'espeak'];
  let lastErr: any = null;

  for (const bin of candidates) {
    try {
      const wavBuf = await new Promise<Buffer>((resolve, reject) => {
        const proc = spawn(bin, ['-v', espeakVoice, '-s', '155', '--stdout', text], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            proc.kill('SIGKILL');
          } catch {}
          reject(new Error(`${bin} timed out`));
        }, 10000);

        proc.stdout.on('data', (c: Buffer) => chunks.push(c));
        proc.stderr.on('data', (c: Buffer) => errChunks.push(c));
        proc.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
        proc.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const out = Buffer.concat(chunks);
          if (code === 0 && out.length > 44) {
            resolve(out);
          } else {
            reject(new Error(`${bin} exited ${code}: ${Buffer.concat(errChunks).toString('utf8').trim()}`));
          }
        });
      });

      const pcm16 = await transcodeBufferToPcm16(wavBuf, ['-f', 'wav']);
      return { pcm16, voiceUsed: `${bin}:${espeakVoice}` };
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error('espeak-ng / espeak not installed');
}

/**
 * Optional Engine: OpenAI TTS (used ONLY if user explicitly sets VOICEDROP_TTS_PROVIDER=openai and OPENAI_API_KEY).
 */
async function synthesizeWithOpenAi(text: string, voice?: string): Promise<{ pcm16: Buffer; voiceUsed: string }> {
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  const oaVoice = (process.env.VOICEDROP_TTS_VOICE || '').trim() ||
    (voice?.toLowerCase().includes('matthew') || voice?.toLowerCase().includes('male') ? 'onyx' : 'alloy');

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_TTS_MODEL || 'tts-1',
      input: text,
      voice: oaVoice,
      response_format: 'pcm', // OpenAI raw PCM is 24kHz s16le mono
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI TTS HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const raw24k = Buffer.from(await res.arrayBuffer());
  const pcm16 = await transcodeBufferToPcm16(raw24k, ['-f', 's16le', '-ar', '24000', '-ac', '1']);
  return { pcm16, voiceUsed: `openai:${oaVoice}` };
}

/**
 * Last-resort pure-JS tone chime (16kHz PCM16) so audio stream never crashes even if every binary/network fails.
 */
function generateToneFallbackPcm16(durationMs = 450): Buffer {
  const numSamples = Math.floor((PCM16_SAMPLE_RATE * durationMs) / 1000);
  const buf = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const t = i / PCM16_SAMPLE_RATE;
    const freq = t < 0.2 ? 523.25 : 659.25;
    const env = Math.min(1, i / 160) * Math.min(1, (numSamples - i) / 320);
    const sample = Math.round(Math.sin(2 * Math.PI * freq * t) * 7000 * env);
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

/**
 * Synthesizes text directly into 16-bit signed little-endian mono PCM at 16,000 Hz.
 * Zero external paid keys required by default; caches buffers by text + voice hash.
 */
export async function synthesizePcm16(
  rawText: string,
  options: SynthesizeOptions = {}
): Promise<SynthesizeResult> {
  const text = sanitizeTextForTts(rawText);
  if (!text) {
    return {
      pcm16: Buffer.alloc(0),
      engine: 'tone-fallback',
      voiceUsed: 'none',
      cached: true,
      durationMs: 0,
    };
  }

  const preferredProvider = (options.provider || process.env.VOICEDROP_TTS_PROVIDER || 'auto')
    .trim()
    .toLowerCase();
  const voiceKey = (options.voice || process.env.VOICEDROP_TTS_VOICE || 'Polly.Joanna').trim();
  const cacheKey = crypto
    .createHash('sha256')
    .update(`${preferredProvider}|${voiceKey}|${PCM16_SAMPLE_RATE}|${text}`)
    .digest('hex');

  const hit = pcmCache.get(cacheKey);
  if (hit) {
    // Refresh LRU position
    pcmCache.delete(cacheKey);
    pcmCache.set(cacheKey, hit);
    return {
      pcm16: hit.pcm16,
      engine: hit.engine,
      voiceUsed: hit.voiceUsed,
      cached: true,
      durationMs: Math.round((hit.pcm16.length / 2 / PCM16_SAMPLE_RATE) * 1000),
    };
  }

  const existingInFlight = inFlightSyntheses.get(cacheKey);
  if (existingInFlight) {
    return existingInFlight;
  }

  const work = (async (): Promise<SynthesizeResult> => {
    const order: Array<'piper' | 'edge-tts' | 'espeak-ng' | 'openai'> =
      preferredProvider === 'piper'
        ? ['piper', 'edge-tts', 'espeak-ng']
        : preferredProvider === 'espeak' || preferredProvider === 'espeak-ng'
        ? ['espeak-ng', 'edge-tts']
        : preferredProvider === 'openai'
        ? ['openai', 'edge-tts', 'espeak-ng']
        : ['piper', 'edge-tts', 'espeak-ng'];

    for (const engine of order) {
      try {
        let out: { pcm16: Buffer; voiceUsed: string };
        if (engine === 'piper') {
          out = await synthesizeWithPiper(text);
        } else if (engine === 'edge-tts') {
          out = await synthesizeWithEdgeTts(text, voiceKey);
        } else if (engine === 'espeak-ng') {
          out = await synthesizeWithEspeak(text, voiceKey);
        } else {
          out = await synthesizeWithOpenAi(text, voiceKey);
        }

        if (out.pcm16.length > 0) {
          cacheSet(cacheKey, { pcm16: out.pcm16, engine, voiceUsed: out.voiceUsed });
          const durationMs = Math.round((out.pcm16.length / 2 / PCM16_SAMPLE_RATE) * 1000);
          console.log(
            `[VoiceDrop TTS] Synthesized ${durationMs}ms (${out.pcm16.length}B PCM16 16kHz) via ${engine} (${out.voiceUsed})`
          );
          return {
            pcm16: out.pcm16,
            engine,
            voiceUsed: out.voiceUsed,
            cached: false,
            durationMs,
          };
        }
      } catch (err: any) {
        if (engine !== 'piper') {
          console.warn(`[VoiceDrop TTS] Engine ${engine} unavailable: ${err?.message || err}`);
        }
      }
    }

    console.error('[VoiceDrop TTS] All TTS engines failed; using tone fallback.');
    const fallback = generateToneFallbackPcm16(450);
    return {
      pcm16: fallback,
      engine: 'tone-fallback',
      voiceUsed: 'tone',
      cached: false,
      durationMs: 450,
    };
  })();

  inFlightSyntheses.set(cacheKey, work);
  try {
    return await work;
  } finally {
    inFlightSyntheses.delete(cacheKey);
  }
}

/**
 * Pre-warms the PCM16 TTS cache in the background (e.g. right when an outbound call starts ringing)
 * so pickup greeting and standard prompts stream with <1ms latency on answer.
 */
export function warmVoiceDropTtsCache(prompts: Array<string | undefined>, voice?: string): void {
  const unique = Array.from(
    new Set(prompts.map((p) => sanitizeTextForTts(p || '')).filter(Boolean))
  );
  for (const text of unique) {
    void synthesizePcm16(text, { voice }).catch(() => {});
  }
}
