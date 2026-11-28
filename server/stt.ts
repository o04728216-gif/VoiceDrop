import { Worker } from 'node:worker_threads';
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
 * mono Float32 samples at 16,000 Hz (native sample rate expected by Whisper).
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

// --- Isolated Worker Thread Client (zero main-thread blocking!) ---

interface PendingRequest {
  resolve: (value: any) => void;
  timer: ReturnType<typeof setTimeout>;
}

let sttWorker: Worker | null = null;
let nextReqId = 1;
const pendingRequests = new Map<number, PendingRequest>();

function clearPendingRequests() {
  for (const [id, req] of pendingRequests.entries()) {
    clearTimeout(req.timer);
    req.resolve(null);
    pendingRequests.delete(id);
  }
}

function getOrStartSttWorker(): Worker | null {
  if (sttWorker) return sttWorker;
  try {
    const workerUrl = new URL('./sttWorker.mjs', import.meta.url);
    const worker = new Worker(workerUrl, {
      execArgv: [],
      workerData: {
        cacheDir: (process.env.STT_CACHE_DIR || '').trim() || '/tmp/voicedrop-stt-cache',
        modelId: (process.env.VOICEDROP_STT_MODEL || '').trim() || 'Xenova/whisper-tiny.en',
      },
    });
    // Don't keep Node process alive solely for the background worker
    worker.unref();

    worker.on('message', (msg: any) => {
      if (!msg || typeof msg.id !== 'number') return;
      const req = pendingRequests.get(msg.id);
      if (!req) return;
      clearTimeout(req.timer);
      pendingRequests.delete(msg.id);
      req.resolve(msg);
    });

    worker.on('error', (err) => {
      console.error('[VoiceDrop STT] Worker thread error (non-fatal to live calls):', err?.message || err);
      if (sttWorker === worker) sttWorker = null;
      clearPendingRequests();
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        console.warn(`[VoiceDrop STT] Worker thread exited with code ${code}; will respawn on next call.`);
      }
      if (sttWorker === worker) sttWorker = null;
      clearPendingRequests();
    });

    sttWorker = worker;
    return worker;
  } catch (err: any) {
    console.error('[VoiceDrop STT] Could not spawn STT worker thread:', err?.message || err);
    return null;
  }
}

let warmInFlight: Promise<void> | null = null;

/**
 * Pre-warms VoiceDrop's built-in zero-key local Whisper STT model inside the background
 * worker thread so it NEVER stalls the main telephony event loop.
 */
export async function warmSttEngine(): Promise<void> {
  if (warmInFlight) return warmInFlight;
  warmInFlight = (async () => {
    const worker = getOrStartSttWorker();
    if (!worker) return;
    const id = nextReqId++;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        resolve();
      }, 90_000);
      pendingRequests.set(id, {
        resolve: () => resolve(),
        timer,
      });
      try {
        worker.postMessage({ id, type: 'warm' });
      } catch {
        clearTimeout(timer);
        pendingRequests.delete(id);
        resolve();
      }
    });
  })().finally(() => {
    warmInFlight = null;
  });
  return warmInFlight;
}

/**
 * Transcribes a 16kHz mono Float32 speech segment off the main thread using
 * VoiceDrop's built-in zero-key local neural Whisper worker (`Xenova/whisper-tiny.en`, q8).
 */
export async function transcribeTelephonySpeech(
  pcm16kFloat: Float32Array
): Promise<{ text: string; engine: 'local-whisper'; confidence: number } | null> {
  if (!pcm16kFloat || pcm16kFloat.length < 3800) return null; // < ~237ms

  const worker = getOrStartSttWorker();
  if (!worker) return null;

  const id = nextReqId++;
  // Copy into a standalone transferable Float32Array so postMessage is zero-copy
  const transferable = new Float32Array(pcm16kFloat);

  const response = await new Promise<any>((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      resolve(null);
    }, 25_000);
    pendingRequests.set(id, { resolve, timer });
    try {
      worker.postMessage({ id, type: 'transcribe', samples: transferable }, [transferable.buffer]);
    } catch (err: any) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      console.error('[VoiceDrop STT] Failed to post audio chunk to worker:', err?.message || err);
      resolve(null);
    }
  });

  if (response && response.ok && typeof response.text === 'string' && response.text.trim()) {
    return {
      text: response.text.trim(),
      engine: 'local-whisper',
      confidence: typeof response.confidence === 'number' ? response.confidence : 0.91,
    };
  }
  return null;
}

export interface InboundSpeechTrackerOptions {
  callId: string;
  codec: TelephonyCodec;
  sampleRate: TelephonyRate;
  onTranscript: (text: string, confidence: number, engine: string) => Promise<void> | void;
}

interface SpeechChunkEntry {
  samples: Float32Array;
  durationMs: number;
}

/**
 * Real-time Voice Activity Detector + utterance segmenter + async worker STT queue.
 * Uses exact millisecond timing (works with 10ms, 20ms, 40ms, 100ms, or variable packets)
 * and PSTN-tuned adaptive thresholds so quiet or short phone utterances transcribe live
 * without EVER interrupting active voice prompts.
 */
export class InboundSpeechTracker {
  private readonly callId: string;
  private readonly codec: TelephonyCodec;
  private readonly sampleRate: TelephonyRate;
  private readonly onTranscript: InboundSpeechTrackerOptions['onTranscript'];

  private readonly preRoll: SpeechChunkEntry[] = [];
  private preRollMs = 0;
  private readonly maxPreRollMs = 220;

  private speechChunks: SpeechChunkEntry[] = [];
  private isSpeaking = false;
  private onsetMs = 0;
  private voicedMsInUtterance = 0;
  private trailingSilenceMs = 0;
  private totalMsInUtterance = 0;
  private peakRmsInUtterance = 0;
  private noiseFloor = 0.006;
  private closed = false;
  private loggedFirstFrame = false;
  private framesSeen = 0;
  private maxRmsSeen = 0;

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

    const samples = decodeFrameToFloat16k(rawFrame, this.codec, this.sampleRate);
    if (samples.length === 0) return;

    const frameMs = (samples.length / 16000) * 1000;
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
      sumSq += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSq / samples.length);

    this.framesSeen += 1;
    if (rms > this.maxRmsSeen) this.maxRmsSeen = rms;

    if (!this.loggedFirstFrame) {
      this.loggedFirstFrame = true;
      console.log(
        `[VoiceDrop STT] Inbound audio stream active callId=${this.callId} codec=${this.codec} rate=${this.sampleRate}Hz bytes=${rawFrame.length} frameMs=${frameMs.toFixed(1)} initialRms=${rms.toFixed(4)}`
      );
    }

    // PSTN-sensitive adaptive speech threshold: catches quiet -36dBFS mobile/landline voices
    const speechThreshold = Math.max(0.008, Math.min(0.045, this.noiseFloor * 2.2));
    const isVoice = rms >= speechThreshold;

    if (!this.isSpeaking) {
      this.preRoll.push({ samples, durationMs: frameMs });
      this.preRollMs += frameMs;
      while (this.preRollMs > this.maxPreRollMs && this.preRoll.length > 1) {
        const dropped = this.preRoll.shift()!;
        this.preRollMs -= dropped.durationMs;
      }

      if (isVoice) {
        this.onsetMs += frameMs;
        if (this.onsetMs >= 55) {
          this.isSpeaking = true;
          this.speechChunks = [...this.preRoll];
          this.totalMsInUtterance = this.preRollMs;
          this.voicedMsInUtterance = this.onsetMs;
          this.trailingSilenceMs = 0;
          this.peakRmsInUtterance = rms;
          this.preRoll.length = 0;
          this.preRollMs = 0;
        }
      } else {
        this.onsetMs = 0;
        this.noiseFloor = this.noiseFloor * 0.96 + rms * 0.04;
      }
      return;
    }

    // Inside an active spoken utterance
    this.speechChunks.push({ samples, durationMs: frameMs });
    this.totalMsInUtterance += frameMs;
    if (rms > this.peakRmsInUtterance) {
      this.peakRmsInUtterance = rms;
    }

    if (isVoice) {
      this.voicedMsInUtterance += frameMs;
      this.trailingSilenceMs = 0;
    } else {
      this.trailingSilenceMs += frameMs;
    }

    // Flush utterance when caller pauses for >= 580ms OR speaks continuously for 5.5s
    if (this.trailingSilenceMs >= 580 || this.totalMsInUtterance >= 5500) {
      this.flushCurrentUtterance();
    }
  }

  public flushAndClose(): void {
    if (this.closed) return;
    if (this.isSpeaking) {
      this.flushCurrentUtterance();
    }
    console.log(
      `[VoiceDrop STT] Closed tracker callId=${this.callId} frames=${this.framesSeen} peakRms=${this.maxRmsSeen.toFixed(4)}`
    );
    this.closed = true;
  }

  private flushCurrentUtterance(): void {
    const rawChunks = this.speechChunks;
    const voicedMs = this.voicedMsInUtterance;
    const peakRms = this.peakRmsInUtterance;
    const trailingSilenceMs = this.trailingSilenceMs;

    this.speechChunks = [];
    this.isSpeaking = false;
    this.onsetMs = 0;
    this.voicedMsInUtterance = 0;
    this.trailingSilenceMs = 0;
    this.totalMsInUtterance = 0;
    this.peakRmsInUtterance = 0;

    // Trim excess trailing silence beyond ~160ms so Whisper stays crisp & fast
    let trimBudgetMs = Math.max(0, trailingSilenceMs - 160);
    let endIdx = rawChunks.length;
    while (endIdx > 1 && trimBudgetMs >= rawChunks[endIdx - 1].durationMs) {
      trimBudgetMs -= rawChunks[endIdx - 1].durationMs;
      endIdx -= 1;
    }
    const chunks = rawChunks.slice(0, endIdx);

    let totalSamples = 0;
    let totalMs = 0;
    for (const c of chunks) {
      totalSamples += c.samples.length;
      totalMs += c.durationMs;
    }

    // Require >= 140ms voiced energy, >= 240ms total clip, and real vocal volume
    if (voicedMs < 140 || peakRms < 0.012 || totalMs < 240 || totalSamples < 3800) {
      return;
    }

    const merged = new Float32Array(totalSamples);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c.samples, offset);
      offset += c.samples.length;
    }

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
