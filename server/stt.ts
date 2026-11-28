import type { TelephonyCodec, TelephonyRate } from './tts.ts';

// Precomputed exact ITU-T G.711 u-law -> Float32 lookup table (-1.0 .. +1.0)
const MULAW_TO_FLOAT32 = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const u = (~i) & 0xff;
  const sign = u & 0x80;
  const exp = (u >> 4) & 0x07;
  const mant = u & 0x0f;
  let sample = ((mant << 3) + 0x84) << exp;
  sample -= 0x84;
  MULAW_TO_FLOAT32[i] = (sign ? -sample : sample) / 32768;
}

/**
 * Decodes a raw telephony frame (`pcmu` @ 8kHz or `pcm16` @ 8k/16k/24kHz) into
 * mono Float32 samples at 16,000 Hz (the native sample rate expected by Whisper).
 */
export function decodeFrameToFloat16k(
  frame: Buffer,
  codec: TelephonyCodec,
  sampleRate: TelephonyRate
): Float32Array {
  if (!frame || frame.length === 0) return new Float32Array(0);

  let src: Float32Array;
  if (codec === 'pcmu') {
    src = new Float32Array(frame.length);
    for (let i = 0; i < frame.length; i++) {
      src[i] = MULAW_TO_FLOAT32[frame[i]];
    }
    sampleRate = 8000;
  } else {
    const count = Math.floor(frame.length / 2);
    src = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      src[i] = frame.readInt16LE(i * 2) / 32768;
    }
  }

  if (sampleRate === 16000) return src;

  if (sampleRate === 8000) {
    // Fast 2x linear upsample (8kHz -> 16kHz)
    const out = new Float32Array(src.length * 2);
    for (let i = 0; i < src.length; i++) {
      const s0 = src[i];
      const s1 = i + 1 < src.length ? src[i + 1] : s0;
      out[i * 2] = s0;
      out[i * 2 + 1] = (s0 + s1) * 0.5;
    }
    return out;
  }

  // General linear resampler (e.g., 24kHz -> 16kHz)
  const ratio = sampleRate / 16000;
  const outLen = Math.max(1, Math.round(src.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = src[Math.min(idx, src.length - 1)];
    const s1 = src[Math.min(idx + 1, src.length - 1)];
    out[i] = s0 + (s1 - s0) * frac;
  }
  return out;
}

function normalizeFloat16kForWhisper(samples: Float32Array): Float32Array {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak <= 0.01 || peak >= 0.7) return samples;
  const gain = Math.min(4.0, 0.78 / peak);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(-1, Math.min(1, samples[i] * gain));
  }
  return out;
}

const HALLUCINATION_PATTERNS: RegExp[] = [
  /^\[.*\]$/,
  /^\(.*\)$/,
  /^(blank[_\s-]?audio|silence|inaudible|unintelligible|music|static|beep|beeping|ringing|applause|laughter|sigh|cough|breathing|no speech|you\.?|thank you\.?)$/i,
  /^(thanks for watching|thank you for watching|please subscribe|subtitles by|amara\.org)\.?$/i,
];

function cleanTranscriptText(raw: string): string {
  if (!raw) return '';
  let text = raw
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[♪♫]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return '';
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  if (!text || text.length < 2) return '';
  if (!/[a-z0-9]/i.test(text)) return '';
  for (const rx of HALLUCINATION_PATTERNS) {
    if (rx.test(text)) return '';
  }
  return text;
}

let whisperPipelinePromise: Promise<any> | null = null;
let whisperLoadFailedAt = 0;

/**
 * Loads the built-in zero-key local neural Whisper model (`Xenova/whisper-tiny.en`, q8 ONNX)
 * directly inside Node.js — no Gemini key, no Deepgram key, no external STT API required.
 */
async function getLocalWhisperPipeline(): Promise<any | null> {
  // Retry after 60s if an earlier download failed temporarily
  if (!whisperPipelinePromise && whisperLoadFailedAt && Date.now() - whisperLoadFailedAt < 60_000) {
    return null;
  }
  if (!whisperPipelinePromise) {
    whisperPipelinePromise = (async () => {
      const t0 = Date.now();
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = (process.env.STT_CACHE_DIR || '').trim() || '/tmp/voicedrop-stt-cache';
      env.allowLocalModels = true;
      const modelId = (process.env.VOICEDROP_STT_MODEL || '').trim() || 'Xenova/whisper-tiny.en';
      console.log(`[VoiceDrop STT] Loading built-in zero-key local Whisper model (${modelId})...`);
      const transcriber = await pipeline('automatic-speech-recognition', modelId, {
        dtype: 'q8',
      });
      console.log(`[VoiceDrop STT] Built-in local Whisper model ready in ${Date.now() - t0}ms`);
      return transcriber;
    })().catch((err) => {
      console.error('[VoiceDrop STT] Failed to initialize built-in local Whisper model:', err);
      whisperPipelinePromise = null;
      whisperLoadFailedAt = Date.now();
      return null;
    });
  }
  return whisperPipelinePromise;
}

/**
 * Pre-warms the built-in zero-key local Whisper STT model on server boot & call dial
 * so the recipient's very first "Hello?" transcribes immediately out of the box.
 */
export async function warmSttEngine(): Promise<void> {
  await getLocalWhisperPipeline();
}

/**
 * Transcribes a 16kHz mono Float32 speech segment from a live phone call using
 * VoiceDrop's built-in zero-key local neural Whisper engine (`Xenova/whisper-tiny.en`, q8 ONNX).
 */
export async function transcribeTelephonySpeech(
  pcm16kFloat: Float32Array
): Promise<{ text: string; engine: 'local-whisper'; confidence: number } | null> {
  if (!pcm16kFloat || pcm16kFloat.length < 4000) return null; // < 250ms

  const transcriber = await getLocalWhisperPipeline();
  if (!transcriber) return null;

  try {
    const normalized = normalizeFloat16kForWhisper(pcm16kFloat);
    const result = await transcriber(normalized);
    const rawText =
      typeof result === 'string'
        ? result
        : Array.isArray(result)
        ? result.map((r: any) => r?.text || '').join(' ')
        : String(result?.text || '');
    const cleaned = cleanTranscriptText(rawText);
    if (!cleaned) return null;
    return { text: cleaned, engine: 'local-whisper', confidence: 0.91 };
  } catch (err: any) {
    console.error('[VoiceDrop STT] Local Whisper inference failed:', err?.message || err);
    return null;
  }
}

export interface InboundSpeechTrackerOptions {
  callId: string;
  codec: TelephonyCodec;
  sampleRate: TelephonyRate;
  onTranscript: (text: string, confidence: number, engine: string) => Promise<void> | void;
}

/**
 * Real-time Voice Activity Detector + utterance segmenter + async local Whisper STT queue.
 * Continuously listens to inbound recipient audio frames and emits transcribed words live
 * without interrupting any voice prompt playback.
 */
export class InboundSpeechTracker {
  private readonly callId: string;
  private readonly codec: TelephonyCodec;
  private readonly sampleRate: TelephonyRate;
  private readonly onTranscript: InboundSpeechTrackerOptions['onTranscript'];

  private readonly preRoll: Float32Array[] = [];
  private readonly maxPreRollFrames = 10; // ~200ms pre-roll so first syllable is never clipped

  private speechFrames: Float32Array[] = [];
  private isSpeaking = false;
  private onsetFrames = 0;
  private voicedFramesInUtterance = 0;
  private trailingSilenceFrames = 0;
  private peakRmsInUtterance = 0;
  private totalSamplesInUtterance = 0;
  private noiseFloor = 0.008;
  private closed = false;
  private loggedFirstFrame = false;

  private readonly pendingQueue: Float32Array[] = [];
  private processingQueue = false;

  constructor(opts: InboundSpeechTrackerOptions) {
    this.callId = opts.callId;
    this.codec = opts.codec;
    this.sampleRate = opts.sampleRate;
    this.onTranscript = opts.onTranscript;
  }

  public pushFrame(rawFrame: Buffer): void {
    if (this.closed || !rawFrame || rawFrame.length === 0) return;

    if (!this.loggedFirstFrame) {
      this.loggedFirstFrame = true;
      console.log(
        `[VoiceDrop STT] Inbound audio active for callId=${this.callId} (codec=${this.codec}, rate=${this.sampleRate}Hz, frameBytes=${rawFrame.length})`
      );
    }

    const samples = decodeFrameToFloat16k(rawFrame, this.codec, this.sampleRate);
    if (samples.length === 0) return;

    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
      sumSq += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSq / samples.length);

    const speechThreshold = Math.max(0.016, Math.min(0.055, this.noiseFloor * 2.5));
    const isVoice = rms >= speechThreshold;

    if (!this.isSpeaking) {
      // Maintain rolling 200ms pre-speech buffer
      this.preRoll.push(samples);
      if (this.preRoll.length > this.maxPreRollFrames) {
        this.preRoll.shift();
      }

      if (isVoice) {
        this.onsetFrames += 1;
        if (this.onsetFrames >= 3) {
          // Confirmed speech onset (~60ms): seed utterance with pre-roll so start of word is intact
          this.isSpeaking = true;
          this.speechFrames = [...this.preRoll];
          this.totalSamplesInUtterance = this.speechFrames.reduce((acc, f) => acc + f.length, 0);
          this.voicedFramesInUtterance = this.onsetFrames;
          this.trailingSilenceFrames = 0;
          this.peakRmsInUtterance = rms;
          this.preRoll.length = 0;
        }
      } else {
        this.onsetFrames = 0;
        // Gently adapt background noise floor during silence
        this.noiseFloor = this.noiseFloor * 0.96 + rms * 0.04;
      }
      return;
    }

    // Currently inside a spoken utterance
    this.speechFrames.push(samples);
    this.totalSamplesInUtterance += samples.length;
    if (rms > this.peakRmsInUtterance) {
      this.peakRmsInUtterance = rms;
    }

    if (isVoice) {
      this.voicedFramesInUtterance += 1;
      this.trailingSilenceFrames = 0;
    } else {
      this.trailingSilenceFrames += 1;
    }

    const utteranceMs = (this.totalSamplesInUtterance / 16000) * 1000;

    // Flush utterance when:
    // 1. Caller pauses for ~600ms (30 x 20ms frames), OR
    // 2. Caller speaks continuously for 5.5s (live rolling transcript for long sentences/voicemails!)
    if (this.trailingSilenceFrames >= 30 || utteranceMs >= 5500) {
      this.flushCurrentUtterance();
    }
  }

  public flushAndClose(): void {
    if (this.closed) return;
    if (this.isSpeaking) {
      this.flushCurrentUtterance();
    }
    this.closed = true;
  }

  private flushCurrentUtterance(): void {
    const rawFrames = this.speechFrames;
    const voicedFrames = this.voicedFramesInUtterance;
    const peakRms = this.peakRmsInUtterance;
    const trailingSilence = this.trailingSilenceFrames;

    this.speechFrames = [];
    this.isSpeaking = false;
    this.onsetFrames = 0;
    this.voicedFramesInUtterance = 0;
    this.trailingSilenceFrames = 0;
    this.peakRmsInUtterance = 0;
    this.totalSamplesInUtterance = 0;

    // Trim excessive trailing silence down to ~160ms (8 frames) so Whisper runs crisp & fast
    const trimCount = Math.max(0, trailingSilence - 8);
    const frames = trimCount > 0 && rawFrames.length > trimCount
      ? rawFrames.slice(0, rawFrames.length - trimCount)
      : rawFrames;

    let totalSamples = 0;
    for (const f of frames) totalSamples += f.length;

    // Require >= ~160ms of voiced energy (8 frames) and real vocal volume to filter clicks/pops
    if (voicedFrames < 8 || peakRms < 0.022 || totalSamples < 4800) {
      return;
    }

    const merged = new Float32Array(totalSamples);
    let offset = 0;
    for (const f of frames) {
      merged.set(f, offset);
      offset += f.length;
    }

    // Bound queue depth to avoid unbounded memory on slower CPUs
    if (this.pendingQueue.length >= 4) {
      this.pendingQueue.shift();
    }
    this.pendingQueue.push(merged);
    void this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    if (this.processingQueue) return;
    this.processingQueue = true;

    try {
      while (this.pendingQueue.length > 0) {
        const chunk = this.pendingQueue.shift()!;
        const t0 = Date.now();
        const result = await transcribeTelephonySpeech(chunk);
        if (result && result.text) {
          console.log(
            `[VoiceDrop STT] callId=${this.callId} engine=${result.engine} ms=${Date.now() - t0} text="${result.text}"`
          );
          await this.onTranscript(result.text, result.confidence, result.engine);
        }
      }
    } catch (err) {
      console.error(`[VoiceDrop STT] Queue error for callId=${this.callId}:`, err);
    } finally {
      this.processingQueue = false;
    }
  }
}
