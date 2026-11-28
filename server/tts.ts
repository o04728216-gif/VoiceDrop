import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { MPEGDecoder } from 'mpg123-decoder';

export type TelephonyCodec = 'pcm16' | 'pcmu';
export type TelephonyRate = 8000 | 16000 | 24000;
export type TtsEngineName = 'edge-neural' | 'piper-local' | 'google-tts' | 'espeak-local';

export const PCM16_SAMPLE_RATE = 16000;
export const PCM16_FRAME_MS = 20;
export const PCM16_BYTES_PER_FRAME = ((PCM16_SAMPLE_RATE * PCM16_FRAME_MS) / 1000) * 2; // 640 bytes

export function resolveFfmpegBin(): string {
  return process.env.FFMPEG_BIN?.trim() || 'ffmpeg';
}

interface CachedAudioEntry {
  samples: Float32Array;
  sampleRate: number;
  engine: TtsEngineName;
  voice: string;
  createdAt: number;
}

const MAX_CACHE_ENTRIES = 120;
const decodedAudioCache = new Map<string, CachedAudioEntry>();

/**
 * Maps VoiceDrop's UI voice profile IDs (Polly/Google/Standard) to matching
 * studio-grade Microsoft Edge Neural TTS voices (100% free, zero API keys).
 */
export function mapVoiceDropToEdgeVoice(voiceId?: string): string {
  const v = String(voiceId || '').trim().toLowerCase();
  if (!v) return 'en-US-JennyNeural';

  if (v.endsWith('neural')) return String(voiceId).trim();

  if (
    v.includes('joanna') ||
    v.includes('wavenet-f') ||
    v.includes('wavenet-c') ||
    v === 'alice' ||
    v === 'woman'
  ) {
    return 'en-US-JennyNeural';
  }
  if (
    v.includes('salli') ||
    v.includes('kendra') ||
    v.includes('kimberly') ||
    v.includes('ivy') ||
    v.includes('ruth') ||
    v.includes('danielle')
  ) {
    return 'en-US-AriaNeural';
  }

  if (v.includes('matthew') || v.includes('wavenet-d') || v.includes('wavenet-b') || v === 'man') {
    return 'en-US-AndrewNeural';
  }
  if (
    v.includes('joey') ||
    v.includes('justin') ||
    v.includes('stephen') ||
    v.includes('gregory')
  ) {
    return 'en-US-GuyNeural';
  }

  if (v.includes('amy') || v.includes('emma') || v.includes('en-gb')) {
    return 'en-GB-SoniaNeural';
  }
  if (v.includes('brian') || v.includes('arthur')) {
    return 'en-GB-RyanNeural';
  }

  if (v.includes('nicole') || v.includes('olivia') || v.includes('en-au')) {
    return 'en-AU-NatashaNeural';
  }
  if (v.includes('russell')) {
    return 'en-AU-WilliamNeural';
  }

  if (v.includes('lupe') || v.includes('penelope') || v.includes('es-')) {
    return 'es-US-PalomaNeural';
  }

  return 'en-US-JennyNeural';
}

function normalizeSpokenText(text: string): string {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getCacheKey(voice: string, text: string): string {
  return `${voice}|${text}`;
}

function putCache(key: string, entry: CachedAudioEntry) {
  if (decodedAudioCache.has(key)) {
    decodedAudioCache.delete(key);
  }
  decodedAudioCache.set(key, entry);
  if (decodedAudioCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = decodedAudioCache.keys().next().value;
    if (oldestKey) decodedAudioCache.delete(oldestKey);
  }
}

async function synthesizeWithEdgeNeural(
  text: string,
  edgeVoice: string,
  timeoutMs = 4500
): Promise<Buffer> {
  const tts = new MsEdgeTTS();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const run = async (): Promise<Buffer> => {
      await tts.setMetadata(edgeVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(text);
      const chunks: Buffer[] = [];
      for await (const chunk of audioStream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const combined = Buffer.concat(chunks);
      if (combined.length < 128) {
        throw new Error('Edge Neural TTS returned empty audio stream.');
      }
      return combined;
    };

    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Edge Neural TTS timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    try {
      tts.close();
    } catch {
      // Ignore close error
    }
  }
}

function splitForGoogleTts(text: string, maxLen = 180): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let current = '';

  for (const sentence of sentences) {
    if ((current ? `${current} ${sentence}` : sentence).length <= maxLen) {
      current = current ? `${current} ${sentence}` : sentence;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = '';
    }
    if (sentence.length <= maxLen) {
      current = sentence;
    } else {
      const words = sentence.split(/\s+/);
      for (const word of words) {
        if ((current ? `${current} ${word}` : word).length <= maxLen) {
          current = current ? `${current} ${word}` : word;
        } else {
          if (current) chunks.push(current);
          current = word.slice(0, maxLen);
        }
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function synthesizeWithGoogleTts(text: string, lang = 'en'): Promise<Buffer> {
  const parts = splitForGoogleTts(text, 180);
  const buffers: Buffer[] = [];

  for (const part of parts) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(
      part
    )}&tl=${encodeURIComponent(lang)}&client=tw-ob`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Google TTS HTTP ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 64) {
        throw new Error('Google TTS returned empty audio');
      }
      buffers.push(buf);
    } finally {
      clearTimeout(timer);
    }
  }

  return Buffer.concat(buffers);
}

/**
 * Tier 2 (100% offline local neural TTS): uses the Piper binary & voice model installed
 * in Dockerfile (/opt/piper/piper + /opt/piper/voices/en_US-lessac-medium.onnx).
 * Zero network, zero rate limits, ~100ms synthesis!
 */
async function synthesizeWithLocalPiper(
  text: string
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const piperBin = (process.env.PIPER_BIN || '').trim() || '/opt/piper/piper';
  const modelPath =
    (process.env.PIPER_MODEL_PATH || '').trim() || '/opt/piper/voices/en_US-lessac-medium.onnx';

  if (!fs.existsSync(piperBin) || !fs.existsSync(modelPath)) {
    throw new Error(`Local Piper binary/model not present (${piperBin}, ${modelPath})`);
  }

  let modelSampleRate = 22050;
  try {
    const cfgPath = `${modelPath}.json`;
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const rate = Number(cfg?.audio?.sample_rate);
      if (rate >= 8000 && rate <= 48000) modelSampleRate = rate;
    }
  } catch {
    // Use default 22050Hz
  }

  const rawPcm = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(piperBin, ['--model', modelPath, '--output-raw'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(new Error('Local Piper TTS timed out after 8000ms'));
    }, 8000);

    child.stdout.on('data', (d) => outChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    child.stderr.on('data', (d) => errChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(outChunks);
      if (code !== 0 || buf.length < 320) {
        reject(
          new Error(
            `Piper exited code=${code} bytes=${buf.length} stderr=${Buffer.concat(errChunks).toString('utf8').slice(0, 200)}`
          )
        );
        return;
      }
      resolve(buf);
    });

    child.stdin.write(`${text}\n`);
    child.stdin.end();
  });

  const count = Math.floor(rawPcm.length / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = rawPcm.readInt16LE(i * 2) / 32768;
  }
  return { samples, sampleRate: modelSampleRate };
}

function parsePcm16Wav(wav: Buffer): { samples: Float32Array; sampleRate: number } {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('Invalid WAV header from local TTS');
  }
  let sampleRate = 22050;
  let channels = 1;
  let dataOffset = 44;
  let dataLen = wav.length - 44;

  let offset = 12;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ' && offset + 24 <= wav.length) {
      channels = wav.readUInt16LE(offset + 10) || 1;
      sampleRate = wav.readUInt32LE(offset + 12) || 22050;
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataLen = Math.min(chunkSize, wav.length - dataOffset);
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  const totalFrames = Math.floor(dataLen / (2 * channels));
  const samples = new Float32Array(totalFrames);
  for (let i = 0; i < totalFrames; i++) {
    let acc = 0;
    for (let ch = 0; ch < channels; ch++) {
      acc += wav.readInt16LE(dataOffset + (i * channels + ch) * 2) / 32768;
    }
    samples[i] = acc / channels;
  }
  return { samples, sampleRate };
}

/**
 * Tier 4 (100% offline guaranteed fallback): espeak-ng WAV output (installed in Dockerfile).
 */
async function synthesizeWithEspeak(
  text: string
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const wav = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn('espeak-ng', ['--stdout', '-s', '155', text], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const outChunks: Buffer[] = [];
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(new Error('espeak-ng timed out'));
    }, 6000);

    child.stdout.on('data', (d) => outChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(outChunks);
      if (code !== 0 || buf.length < 128) {
        reject(new Error(`espeak-ng failed code=${code} bytes=${buf.length}`));
        return;
      }
      resolve(buf);
    });
  });

  return parsePcm16Wav(wav);
}

async function decodeMp3ToMonoFloat32(
  mp3: Buffer
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    const decoded = decoder.decode(new Uint8Array(mp3.buffer, mp3.byteOffset, mp3.byteLength));
    const channels = decoded.channelData;
    if (!channels || channels.length === 0 || decoded.samplesDecoded === 0) {
      throw new Error('MP3 decoder produced zero audio samples.');
    }

    if (channels.length === 1) {
      return { samples: new Float32Array(channels[0]), sampleRate: decoded.sampleRate };
    }

    const mono = new Float32Array(decoded.samplesDecoded);
    const ch0 = channels[0];
    const ch1 = channels[1];
    for (let i = 0; i < decoded.samplesDecoded; i++) {
      mono[i] = (ch0[i] + ch1[i]) * 0.5;
    }
    return { samples: mono, sampleRate: decoded.sampleRate };
  } finally {
    try {
      decoder.free();
    } catch {
      // Ignore cleanup error
    }
  }
}

/**
 * 4-tier bulletproof TTS synthesis cascade:
 * 1. Microsoft Edge Neural TTS (cloud neural, matches exact UI voice)
 * 2. Local offline Piper Neural TTS (/opt/piper/piper — zero internet, zero rate limits!)
 * 3. Google Translate TTS (cloud fallback)
 * 4. Local offline espeak-ng (guaranteed last-resort fallback)
 */
async function getOrSynthesizeFloatAudio(
  rawText: string,
  voiceId?: string
): Promise<{
  samples: Float32Array;
  sampleRate: number;
  engine: TtsEngineName;
  voice: string;
  cached: boolean;
}> {
  const text = normalizeSpokenText(rawText);
  if (!text) {
    throw new Error('Cannot synthesize empty spoken text.');
  }

  const edgeVoice = mapVoiceDropToEdgeVoice(voiceId);
  const key = getCacheKey(edgeVoice, text);
  const hit = decodedAudioCache.get(key);
  if (hit) {
    return {
      samples: hit.samples,
      sampleRate: hit.sampleRate,
      engine: hit.engine,
      voice: hit.voice,
      cached: true,
    };
  }

  // Tier 1: Edge Neural TTS
  try {
    const mp3 = await synthesizeWithEdgeNeural(text, edgeVoice);
    const decoded = await decodeMp3ToMonoFloat32(mp3);
    putCache(key, {
      samples: decoded.samples,
      sampleRate: decoded.sampleRate,
      engine: 'edge-neural',
      voice: edgeVoice,
      createdAt: Date.now(),
    });
    return { ...decoded, engine: 'edge-neural', voice: edgeVoice, cached: false };
  } catch (edgeErr: any) {
    console.warn(
      `[VoiceDrop TTS] Tier 1 (Edge Neural) failed for voice=${edgeVoice}: ${edgeErr?.message || edgeErr}`
    );
  }

  // Tier 2: Local Offline Piper Neural TTS (fast, zero network, never rate-limited!)
  try {
    const piperAudio = await synthesizeWithLocalPiper(text);
    putCache(key, {
      samples: piperAudio.samples,
      sampleRate: piperAudio.sampleRate,
      engine: 'piper-local',
      voice: 'piper-en_US-lessac-medium',
      createdAt: Date.now(),
    });
    return {
      ...piperAudio,
      engine: 'piper-local',
      voice: 'piper-en_US-lessac-medium',
      cached: false,
    };
  } catch (piperErr: any) {
    console.warn(`[VoiceDrop TTS] Tier 2 (Local Piper) unavailable: ${piperErr?.message || piperErr}`);
  }

  // Tier 3: Google TTS
  try {
    const lang = edgeVoice.toLowerCase().startsWith('es-') ? 'es' : 'en';
    const mp3 = await synthesizeWithGoogleTts(text, lang);
    const decoded = await decodeMp3ToMonoFloat32(mp3);
    putCache(key, {
      samples: decoded.samples,
      sampleRate: decoded.sampleRate,
      engine: 'google-tts',
      voice: `google-${lang}`,
      createdAt: Date.now(),
    });
    return { ...decoded, engine: 'google-tts', voice: `google-${lang}`, cached: false };
  } catch (googleErr: any) {
    console.warn(`[VoiceDrop TTS] Tier 3 (Google TTS) failed: ${googleErr?.message || googleErr}`);
  }

  // Tier 4: Local Offline espeak-ng (guaranteed last resort)
  const espeakAudio = await synthesizeWithEspeak(text);
  putCache(key, {
    samples: espeakAudio.samples,
    sampleRate: espeakAudio.sampleRate,
    engine: 'espeak-local',
    voice: 'espeak-ng',
    createdAt: Date.now(),
  });
  return { ...espeakAudio, engine: 'espeak-local', voice: 'espeak-ng', cached: false };
}

/**
 * ITU-T G.711 mu-law encoding of a signed 16-bit PCM sample.
 */
function linearToMulaw(sample: number): number {
  const MULAW_MAX = 0x7fff;
  const MULAW_BIAS = 0x84;

  let sign = 0;
  let pcm = sample;
  if (pcm < 0) {
    sign = 0x80;
    pcm = -pcm;
  }
  if (pcm > MULAW_MAX) pcm = MULAW_MAX;
  pcm += MULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {
    // find highest set bit
  }
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/**
 * Decode an ITU-T G.711 mu-law byte to signed 16-bit PCM for local RMS voice activity detection.
 */
export function mulawToLinear(uVal: number): number {
  const u = ~uVal & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

/**
 * Computes normalized RMS energy (0.0 to 1.0) of a raw incoming telephony audio frame.
 */
export function computeFrameRms(frame: Buffer, codec: TelephonyCodec): number {
  if (!frame || frame.length < 2) return 0;
  let sumSq = 0;
  let count = 0;

  if (codec === 'pcmu') {
    count = frame.length;
    for (let i = 0; i < count; i++) {
      const s = mulawToLinear(frame[i]) / 32768;
      sumSq += s * s;
    }
  } else {
    count = Math.floor(frame.length / 2);
    for (let i = 0; i < count; i++) {
      const s = frame.readInt16LE(i * 2) / 32768;
      sumSq += s * s;
    }
  }

  return count > 0 ? Math.sqrt(sumSq / count) : 0;
}

function resampleMonoFloat32(
  input: Float32Array,
  inRate: number,
  outRate: number
): Float32Array {
  if (inRate === outRate || input.length === 0) return input;
  const ratio = inRate / outRate;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = input[idx] ?? 0;
    const s1 = input[Math.min(idx + 1, input.length - 1)] ?? s0;
    out[i] = s0 + (s1 - s0) * frac;
  }

  return out;
}

function encodeTelephonySamples(
  samples: Float32Array,
  codec: TelephonyCodec,
  sampleRate: number,
  leadInMs = 120,
  tailMs = 140
): Buffer {
  const leadSamples = Math.round((sampleRate * leadInMs) / 1000);
  const tailSamples = Math.round((sampleRate * tailMs) / 1000);
  const totalSamples = leadSamples + samples.length + tailSamples;

  if (codec === 'pcmu') {
    const out = Buffer.alloc(totalSamples, 0xff); // 0xff is exact mu-law silence
    for (let i = 0; i < samples.length; i++) {
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      const int16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
      out[leadSamples + i] = linearToMulaw(int16);
    }
    return out;
  }

  const out = Buffer.alloc(totalSamples * 2, 0);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    out.writeInt16LE(int16, (leadSamples + i) * 2);
  }
  return out;
}

export async function synthesizeTelephonyAudio(
  text: string,
  options: {
    voice?: string;
    codec?: TelephonyCodec;
    sampleRate?: number;
  } = {}
): Promise<{
  audio: Buffer;
  codec: TelephonyCodec;
  sampleRate: number;
  durationMs: number;
  engine: TtsEngineName;
  voice: string;
  cached: boolean;
}> {
  const codec: TelephonyCodec = options.codec === 'pcmu' ? 'pcmu' : 'pcm16';
  const sampleRate =
    codec === 'pcmu'
      ? 8000
      : options.sampleRate === 8000 || options.sampleRate === 24000
      ? options.sampleRate
      : 16000;

  const { samples, sampleRate: srcRate, engine, voice, cached } = await getOrSynthesizeFloatAudio(
    text,
    options.voice
  );
  const resampled = resampleMonoFloat32(samples, srcRate, sampleRate);
  const audio = encodeTelephonySamples(resampled, codec, sampleRate);
  const bytesPerSample = codec === 'pcmu' ? 1 : 2;
  const durationMs = Math.round((audio.length / (sampleRate * bytesPerSample)) * 1000);

  return {
    audio,
    codec,
    sampleRate,
    durationMs,
    engine,
    voice,
    cached,
  };
}

/**
 * Pre-warms the in-memory TTS cache in the background while an outbound call is ringing
 * so spoken prompts play with near-zero latency the instant the recipient answers.
 */
export async function warmTtsCache(
  texts: Array<string | undefined>,
  voice?: string
): Promise<void> {
  const unique = Array.from(
    new Set(
      texts
        .map((t) => normalizeSpokenText(t || ''))
        .filter((t) => t.length > 0)
    )
  );
  await Promise.allSettled(unique.map((text) => getOrSynthesizeFloatAudio(text, voice)));
}
