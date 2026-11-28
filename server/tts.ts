import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { MPEGDecoder } from 'mpg123-decoder';

export type TelephonyCodec = 'pcm16' | 'pcmu';
export type TelephonyRate = 8000 | 16000 | 24000;

export const PCM16_SAMPLE_RATE = 16000;
export const PCM16_FRAME_MS = 20;
export const PCM16_BYTES_PER_FRAME = (PCM16_SAMPLE_RATE * PCM16_FRAME_MS / 1000) * 2; // 640 bytes

export function resolveFfmpegBin(): string {
  return process.env.FFMPEG_BIN?.trim() || 'ffmpeg';
}

interface CachedMp3Entry {
  mp3: Buffer;
  engine: 'edge-neural' | 'google-tts';
  voice: string;
  createdAt: number;
}

const MAX_CACHE_ENTRIES = 120;
const mp3Cache = new Map<string, CachedMp3Entry>();

/**
 * Maps VoiceDrop's UI voice profile IDs (Polly/Google/Standard) to matching
 * studio-grade Microsoft Edge Neural TTS voices (100% free, zero API keys).
 */
export function mapVoiceDropToEdgeVoice(voiceId?: string): string {
  const v = String(voiceId || '').trim().toLowerCase();
  if (!v) return 'en-US-JennyNeural';

  // Direct Edge Neural voice passthrough
  if (v.endsWith('neural')) return String(voiceId).trim();

  // Female US voices
  if (v.includes('joanna') || v.includes('wavenet-f') || v.includes('wavenet-c') || v === 'alice' || v === 'woman') {
    return 'en-US-JennyNeural';
  }
  if (v.includes('salli') || v.includes('kendra') || v.includes('kimberly') || v.includes('ivy') || v.includes('ruth') || v.includes('danielle')) {
    return 'en-US-AriaNeural';
  }

  // Male US voices
  if (v.includes('matthew') || v.includes('wavenet-d') || v.includes('wavenet-b') || v === 'man') {
    return 'en-US-AndrewNeural';
  }
  if (v.includes('joey') || v.includes('justin') || v.includes('stephen') || v.includes('gregory')) {
    return 'en-US-GuyNeural';
  }

  // UK voices
  if (v.includes('amy') || v.includes('emma') || v.includes('en-gb')) {
    return 'en-GB-SoniaNeural';
  }
  if (v.includes('brian') || v.includes('arthur')) {
    return 'en-GB-RyanNeural';
  }

  // AU voices
  if (v.includes('nicole') || v.includes('olivia') || v.includes('en-au')) {
    return 'en-AU-NatashaNeural';
  }
  if (v.includes('russell')) {
    return 'en-AU-WilliamNeural';
  }

  // Spanish
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

function putCache(key: string, entry: CachedMp3Entry) {
  if (mp3Cache.has(key)) {
    mp3Cache.delete(key);
  }
  mp3Cache.set(key, entry);
  if (mp3Cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = mp3Cache.keys().next().value;
    if (oldestKey) mp3Cache.delete(oldestKey);
  }
}

async function synthesizeWithEdgeNeural(text: string, edgeVoice: string, timeoutMs = 8000): Promise<Buffer> {
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
        timer = setTimeout(() => reject(new Error(`Edge Neural TTS timed out after ${timeoutMs}ms`)), timeoutMs);
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
    const timer = setTimeout(() => controller.abort(), 7000);
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

async function getOrSynthesizeMp3(
  rawText: string,
  voiceId?: string
): Promise<{ mp3: Buffer; engine: 'edge-neural' | 'google-tts'; voice: string; cached: boolean }> {
  const text = normalizeSpokenText(rawText);
  if (!text) {
    throw new Error('Cannot synthesize empty spoken text.');
  }

  const edgeVoice = mapVoiceDropToEdgeVoice(voiceId);
  const key = getCacheKey(edgeVoice, text);
  const hit = mp3Cache.get(key);
  if (hit) {
    return { mp3: hit.mp3, engine: hit.engine, voice: hit.voice, cached: true };
  }

  try {
    const mp3 = await synthesizeWithEdgeNeural(text, edgeVoice);
    putCache(key, { mp3, engine: 'edge-neural', voice: edgeVoice, createdAt: Date.now() });
    return { mp3, engine: 'edge-neural', voice: edgeVoice, cached: false };
  } catch (edgeErr: any) {
    console.warn(
      `[VoiceDrop TTS] Edge Neural TTS failed for voice=${edgeVoice}, falling back to Google TTS:`,
      edgeErr?.message || edgeErr
    );
    const lang = edgeVoice.toLowerCase().startsWith('es-') ? 'es' : 'en';
    const mp3 = await synthesizeWithGoogleTts(text, lang);
    putCache(key, { mp3, engine: 'google-tts', voice: `google-${lang}`, createdAt: Date.now() });
    return { mp3, engine: 'google-tts', voice: `google-${lang}`, cached: false };
  }
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
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

/**
 * Decode an ITU-T G.711 mu-law byte to signed 16-bit PCM for local RMS voice activity detection.
 */
export function mulawToLinear(uVal: number): number {
  const u = (~uVal) & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

/**
 * Computes normalized RMS energy (0.0 to 1.0) of a raw incoming telephony audio frame
 * (works for both pcm16 LE and pcmu without any external STT or Deepgram dependency).
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
      return { samples: channels[0], sampleRate: decoded.sampleRate };
    }

    // Downmix stereo to mono cleanly
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
  engine: 'edge-neural' | 'google-tts';
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

  const { mp3, engine, voice, cached } = await getOrSynthesizeMp3(text, options.voice);
  const decoded = await decodeMp3ToMonoFloat32(mp3);
  const resampled = resampleMonoFloat32(decoded.samples, decoded.sampleRate, sampleRate);
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
export async function warmTtsCache(texts: Array<string | undefined>, voice?: string): Promise<void> {
  const unique = Array.from(
    new Set(
      texts
        .map((t) => normalizeSpokenText(t || ''))
        .filter((t) => t.length > 0)
    )
  );
  await Promise.allSettled(unique.map((text) => getOrSynthesizeMp3(text, voice)));
}
