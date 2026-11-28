import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import {
  PCM16_BYTES_PER_FRAME,
  PCM16_FRAME_MS,
  PCM16_SAMPLE_RATE,
  resolveFfmpegBin,
} from './tts.ts';

// ---------------------------------------------------------------------------
// 0. Negotiated Session Audio Codec & Resampler (pcm16@8k/16k/24k & pcmu@8k)
// ---------------------------------------------------------------------------
export interface SessionAudioFormat {
  codec: 'pcm16' | 'pcmu';
  rate: number;
}

export function normalizeSessionAudioFormat(raw?: {
  codec?: string;
  rate?: number;
}): SessionAudioFormat {
  const codec = String(raw?.codec || 'pcm16').toLowerCase() === 'pcmu' ? 'pcmu' : 'pcm16';
  const rawRate = Number(raw?.rate);
  if (codec === 'pcmu') {
    return { codec: 'pcmu', rate: 8000 };
  }
  const rate =
    rawRate === 8000 || rawRate === 16000 || rawRate === 24000 ? rawRate : PCM16_SAMPLE_RATE;
  return { codec: 'pcm16', rate };
}

function linearToMuLawByte(sample: number): number {
  const MULAW_MAX = 0x1fff;
  const MULAW_BIAS = 33;
  let sign = 0;
  let s = sample;
  if (s < 0) {
    sign = 0x80;
    s = -s;
  }
  if (s > 32767) s = 32767;
  s = (s >> 2) + MULAW_BIAS;
  if (s > MULAW_MAX) s = MULAW_MAX;

  let exponent = 7;
  for (let expMask = 0x1000; (s & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {
    // Find highest bit
  }
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const inv = ~i & 0xff;
  const sign = inv & 0x80;
  const exponent = (inv >> 4) & 0x07;
  const mantissa = inv & 0x0f;
  let magnitude = ((mantissa << 3) + 0x84) << exponent;
  magnitude -= 0x84;
  MULAW_DECODE_TABLE[i] = sign ? -magnitude : magnitude;
}

export function resamplePcm16(pcm16: Buffer, fromRate: number, toRate: number): Buffer {
  if (!pcm16 || pcm16.length < 2 || fromRate === toRate) return pcm16;
  const inSamples = pcm16.length >> 1;
  const outSamples = Math.max(1, Math.round((inSamples * toRate) / fromRate));
  const out = Buffer.allocUnsafe(outSamples * 2);
  const ratio = fromRate / toRate;

  for (let i = 0; i < outSamples; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const s0 = pcm16.readInt16LE(Math.min(idx, inSamples - 1) * 2);
    const s1 = pcm16.readInt16LE(Math.min(idx + 1, inSamples - 1) * 2);
    const interp = Math.round(s0 + (s1 - s0) * frac);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, interp)), i * 2);
  }
  return out;
}

export function encodePcm16ForSession(
  pcm16At16k: Buffer,
  format: SessionAudioFormat
): { encoded: Buffer; bytesPer20ms: number } {
  if (format.codec === 'pcmu') {
    const pcm8k = resamplePcm16(pcm16At16k, PCM16_SAMPLE_RATE, 8000);
    const count = pcm8k.length >> 1;
    const ulaw = Buffer.allocUnsafe(count);
    for (let i = 0; i < count; i++) {
      ulaw[i] = linearToMuLawByte(pcm8k.readInt16LE(i * 2));
    }
    return { encoded: ulaw, bytesPer20ms: 160 };
  }

  const targetRate = format.rate || PCM16_SAMPLE_RATE;
  const resampled =
    targetRate === PCM16_SAMPLE_RATE
      ? pcm16At16k
      : resamplePcm16(pcm16At16k, PCM16_SAMPLE_RATE, targetRate);
  const bytesPer20ms = ((targetRate * PCM16_FRAME_MS) / 1000) * 2;
  return { encoded: resampled, bytesPer20ms };
}

export function decodeSessionFrameToPcm16At16k(
  frame: Buffer,
  format: SessionAudioFormat
): Buffer {
  if (!frame || frame.length === 0) return Buffer.alloc(0);
  if (format.codec === 'pcmu') {
    const pcm8k = Buffer.allocUnsafe(frame.length * 2);
    for (let i = 0; i < frame.length; i++) {
      pcm8k.writeInt16LE(MULAW_DECODE_TABLE[frame[i]], i * 2);
    }
    return resamplePcm16(pcm8k, 8000, PCM16_SAMPLE_RATE);
  }
  const srcRate = format.rate || PCM16_SAMPLE_RATE;
  if (srcRate === PCM16_SAMPLE_RATE) return frame;
  return resamplePcm16(frame, srcRate, PCM16_SAMPLE_RATE);
}

// ---------------------------------------------------------------------------
// 1. In-Band Goertzel DTMF Detector (PCM16 16kHz Mono — Backup to RFC 2833)
// ---------------------------------------------------------------------------
const DTMF_LOW_FREQS = [697, 770, 852, 941];
const DTMF_HIGH_FREQS = [1209, 1336, 1477, 1633];
const DTMF_KEYPAD: string[][] = [
  ['1', '2', '3', 'A'],
  ['4', '5', '6', 'B'],
  ['7', '8', '9', 'C'],
  ['*', '0', '#', 'D'],
];

function goertzelPower(
  samples: Int16Array,
  targetFreq: number,
  sampleRate = PCM16_SAMPLE_RATE
): number {
  const n = samples.length;
  const k = Math.round((n * targetFreq) / sampleRate);
  const omega = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(omega);
  let sPrev = 0;
  let sPrev2 = 0;

  for (let i = 0; i < n; i++) {
    const s = samples[i] / 32768 + coeff * sPrev - sPrev2;
    sPrev2 = sPrev;
    sPrev = s;
  }
  return sPrev2 * sPrev2 + sPrev * sPrev - coeff * sPrev * sPrev2;
}

export class GoertzelDtmfDetector {
  private residual = Buffer.alloc(0);
  private candidateDigit: string | null = null;
  private candidateStreak = 0;
  private silentStreak = 0;
  private activeEmittedDigit: string | null = null;
  private readonly onDigit: (digit: string) => void;

  constructor(onDigit: (digit: string) => void) {
    this.onDigit = onDigit;
  }

  public pushPcm16(chunk: Buffer): void {
    if (!chunk || chunk.length === 0) return;
    const combined = this.residual.length > 0 ? Buffer.concat([this.residual, chunk]) : chunk;
    let offset = 0;

    while (offset + PCM16_BYTES_PER_FRAME <= combined.length) {
      const frameBuf = combined.subarray(offset, offset + PCM16_BYTES_PER_FRAME);
      offset += PCM16_BYTES_PER_FRAME;
      this.processFrame(frameBuf);
    }

    this.residual =
      offset < combined.length ? Buffer.from(combined.subarray(offset)) : Buffer.alloc(0);
  }

  private processFrame(frameBuf: Buffer): void {
    const sampleCount = frameBuf.length >> 1;
    const samples = new Int16Array(sampleCount);
    let totalEnergy = 0;
    for (let i = 0; i < sampleCount; i++) {
      const s = frameBuf.readInt16LE(i * 2);
      samples[i] = s;
      const norm = s / 32768;
      totalEnergy += norm * norm;
    }

    const rms = Math.sqrt(totalEnergy / sampleCount);
    const detected = rms >= 0.025 ? this.detectDigitInFrame(samples, totalEnergy) : null;

    if (detected) {
      this.silentStreak = 0;
      if (detected === this.candidateDigit) {
        this.candidateStreak++;
      } else {
        this.candidateDigit = detected;
        this.candidateStreak = 1;
      }

      // Require >= 2 consecutive 20ms frames (40ms valid DTMF tone) and new press after release
      if (this.candidateStreak >= 2 && this.activeEmittedDigit !== detected) {
        this.activeEmittedDigit = detected;
        if (/^[0-9*#]$/.test(detected)) {
          this.onDigit(detected);
        }
      }
    } else {
      this.candidateDigit = null;
      this.candidateStreak = 0;
      this.silentStreak++;
      if (this.silentStreak >= 2) {
        this.activeEmittedDigit = null;
      }
    }
  }

  private detectDigitInFrame(samples: Int16Array, totalEnergy: number): string | null {
    const lowPowers = DTMF_LOW_FREQS.map((f) => goertzelPower(samples, f));
    const highPowers = DTMF_HIGH_FREQS.map((f) => goertzelPower(samples, f));

    let lowIdx = 0;
    let lowMax = -1;
    let lowSecond = -1;
    for (let i = 0; i < lowPowers.length; i++) {
      if (lowPowers[i] > lowMax) {
        lowSecond = lowMax;
        lowMax = lowPowers[i];
        lowIdx = i;
      } else if (lowPowers[i] > lowSecond) {
        lowSecond = lowPowers[i];
      }
    }

    let highIdx = 0;
    let highMax = -1;
    let highSecond = -1;
    for (let i = 0; i < highPowers.length; i++) {
      if (highPowers[i] > highMax) {
        highSecond = highMax;
        highMax = highPowers[i];
        highIdx = i;
      } else if (highPowers[i] > highSecond) {
        highSecond = highPowers[i];
      }
    }

    if (lowMax <= 0.15 || highMax <= 0.15) return null;
    if (lowSecond > 0 && lowMax / lowSecond < 5.0) return null;
    if (highSecond > 0 && highMax / highSecond < 5.0) return null;

    const twistRatio = highMax / lowMax;
    if (twistRatio > 6.5 || twistRatio < 0.15) return null;

    const low2nd = goertzelPower(samples, DTMF_LOW_FREQS[lowIdx] * 2);
    const high2nd = goertzelPower(samples, DTMF_HIGH_FREQS[highIdx] * 2);
    if (low2nd > lowMax * 0.35 || high2nd > highMax * 0.35) return null;

    const expectedBinScale = samples.length / 2;
    const toneEnergyRatio = (lowMax + highMax) / (totalEnergy * expectedBinScale + 1e-9);
    if (toneEnergyRatio < 0.42) return null;

    return DTMF_KEYPAD[lowIdx][highIdx];
  }
}

// ---------------------------------------------------------------------------
// 2. Local Energy / VAD Answering Machine & Voice Activity Detector (Zero Deepgram)
// ---------------------------------------------------------------------------
export interface VadAmdHooks {
  onAmdClassified: (status: 'human' | 'voicemail', reason: string) => void;
  onVoiceActivity?: (speaking: boolean, rms: number) => void;
  onHumanPickupAfterVoicemail?: () => void;
}

export class Pcm16VadAmdDetector {
  private readonly hooks: VadAmdHooks;
  private residual = Buffer.alloc(0);
  private noiseFloor = 0.015;
  private isSpeaking = false;
  private totalElapsedMs = 0;
  private currentSpeechMs = 0;
  private currentSilenceMs = 0;
  private speechBurstCount = 0;
  private longestSpeechBurstMs = 0;
  private beepStreakMs = 0;
  private amdClassified = false;
  private classifiedAs: 'human' | 'voicemail' | null = null;
  private silenceSinceVoicemailMs = 0;
  private postVoicemailSpeechMs = 0;
  private humanWakeSent = false;

  constructor(hooks: VadAmdHooks) {
    this.hooks = hooks;
  }

  public get speaking(): boolean {
    return this.isSpeaking;
  }

  public get resolved(): boolean {
    return this.amdClassified;
  }

  public markResolvedExternally(status: 'human' | 'voicemail'): void {
    this.amdClassified = true;
    this.classifiedAs = status;
  }

  public pushPcm16(chunk: Buffer): void {
    if (!chunk || chunk.length === 0) return;
    const combined = this.residual.length > 0 ? Buffer.concat([this.residual, chunk]) : chunk;
    let offset = 0;

    while (offset + PCM16_BYTES_PER_FRAME <= combined.length) {
      const frame = combined.subarray(offset, offset + PCM16_BYTES_PER_FRAME);
      offset += PCM16_BYTES_PER_FRAME;
      this.processFrame(frame);
    }

    this.residual =
      offset < combined.length ? Buffer.from(combined.subarray(offset)) : Buffer.alloc(0);
  }

  private processFrame(frame: Buffer): void {
    const n = frame.length >> 1;
    let sumSq = 0;
    let zeroCrossings = 0;
    let prevSample = 0;
    const samples = new Int16Array(n);

    for (let i = 0; i < n; i++) {
      const s = frame.readInt16LE(i * 2);
      samples[i] = s;
      const norm = s / 32768;
      sumSq += norm * norm;
      if (i > 0 && ((s >= 0 && prevSample < 0) || (s < 0 && prevSample >= 0))) {
        zeroCrossings++;
      }
      prevSample = s;
    }

    const rms = Math.sqrt(sumSq / n);
    this.totalElapsedMs += PCM16_FRAME_MS;

    // Adaptive noise floor tracking (resilient to PSTN/mobile background hum)
    if (rms < this.noiseFloor * 1.9) {
      this.noiseFloor = this.noiseFloor * 0.92 + rms * 0.08;
      this.noiseFloor = Math.max(0.008, Math.min(0.055, this.noiseFloor));
    }

    const speechThreshold = Math.max(0.032, this.noiseFloor * 3.2);
    const frameActive = rms >= speechThreshold;

    // Strict voicemail beep detection: pure sine tone strictly in 800-1250 Hz (excludes 440/480Hz ringback & voice)
    const zcrHz = (zeroCrossings * PCM16_SAMPLE_RATE) / (2 * n);
    if (rms >= 0.06 && zcrHz >= 800 && zcrHz <= 1250) {
      const tonePwr = goertzelPower(samples, zcrHz);
      const ratio = tonePwr / (sumSq * (n / 2) + 1e-9);
      if (ratio > 0.85) {
        this.beepStreakMs += PCM16_FRAME_MS;
      } else {
        this.beepStreakMs = 0;
      }
    } else {
      this.beepStreakMs = 0;
    }

    if (frameActive) {
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.speechBurstCount++;
        this.hooks.onVoiceActivity?.(true, rms);
      }
      this.currentSpeechMs += PCM16_FRAME_MS;
      this.currentSilenceMs = 0;
      if (this.currentSpeechMs > this.longestSpeechBurstMs) {
        this.longestSpeechBurstMs = this.currentSpeechMs;
      }
    } else {
      if (this.isSpeaking && this.currentSilenceMs >= 160) {
        this.isSpeaking = false;
        this.hooks.onVoiceActivity?.(false, rms);
      }
      this.currentSilenceMs += PCM16_FRAME_MS;
      if (this.currentSilenceMs >= 260) {
        this.currentSpeechMs = 0;
      }
    }

    // ---- AMD Classification Logic (Fast human pickup, strict voicemail guard) ----
    if (!this.amdClassified) {
      // 1. Unmistakable voicemail beep (>= 400ms pure 800-1250 Hz sine tone)
      if (this.beepStreakMs >= 400) {
        this.amdClassified = true;
        this.classifiedAs = 'voicemail';
        this.hooks.onAmdClassified('voicemail', 'pcm16_vad_beep_detected');
        return;
      }

      // 2. Continuous unbroken monologue >= 4200ms (classic long voicemail greeting)
      if (this.currentSpeechMs >= 4200) {
        this.amdClassified = true;
        this.classifiedAs = 'voicemail';
        this.hooks.onAmdClassified('voicemail', 'pcm16_vad_long_greeting');
        return;
      }

      // 3. Natural human pickup ("Hello?" — short 120ms..2400ms burst followed by >= 320ms silence)
      if (
        this.speechBurstCount >= 1 &&
        this.longestSpeechBurstMs >= 120 &&
        this.longestSpeechBurstMs <= 2400 &&
        this.currentSilenceMs >= 320 &&
        this.totalElapsedMs >= 500
      ) {
        this.amdClassified = true;
        this.classifiedAs = 'human';
        this.hooks.onAmdClassified('human', 'pcm16_vad_short_greeting');
        return;
      }

      // 4. Quiet pickup: if no active continuous speech after 1400ms, immediately treat as live human so custom prompts play right away
      if (this.totalElapsedMs >= 1400 && !this.isSpeaking && this.longestSpeechBurstMs < 2400) {
        this.amdClassified = true;
        this.classifiedAs = 'human';
        this.hooks.onAmdClassified('human', 'pcm16_vad_quick_human_pickup');
        return;
      }

      // 5. Hard cap at 4500ms if caller is still talking continuously
      if (this.totalElapsedMs >= 4500) {
        const isMachine = this.longestSpeechBurstMs >= 3600;
        this.amdClassified = true;
        this.classifiedAs = isMachine ? 'voicemail' : 'human';
        this.hooks.onAmdClassified(
          this.classifiedAs,
          isMachine ? 'pcm16_vad_window_machine' : 'pcm16_vad_window_human'
        );
        return;
      }
    } else if (this.classifiedAs === 'voicemail' && !this.humanWakeSent) {
      if (!frameActive) {
        this.silenceSinceVoicemailMs += PCM16_FRAME_MS;
        if (
          this.silenceSinceVoicemailMs >= 500 &&
          this.postVoicemailSpeechMs >= 180 &&
          this.postVoicemailSpeechMs <= 2200
        ) {
          this.humanWakeSent = true;
          this.classifiedAs = 'human';
          this.hooks.onHumanPickupAfterVoicemail?.();
        }
      } else {
        if (this.silenceSinceVoicemailMs >= 800) {
          this.postVoicemailSpeechMs += PCM16_FRAME_MS;
        }
        this.silenceSinceVoicemailMs = 0;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Bidirectional PCM16 16kHz Call Recorder (Inbound + Outbound Mix -> MP3/WAV)
// ---------------------------------------------------------------------------
function clampInt16(val: number): number {
  if (val > 32767) return 32767;
  if (val < -32768) return -32768;
  return val | 0;
}

function createWavHeader(pcmDataBytes: number, sampleRate = PCM16_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmDataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmDataBytes, 40);
  return header;
}

export class Pcm16CallRecorder {
  private readonly callId: string;
  private readonly tempRawPath: string;
  private readonly writeStream: fs.WriteStream;
  private inboundQueue: Buffer[] = [];
  private outboundQueue: Buffer[] = [];
  private totalMixedBytes = 0;
  private mixTimer?: ReturnType<typeof setInterval>;
  private finalized = false;

  constructor(callId: string) {
    this.callId = callId;
    const safeId = callId.replace(/[^a-zA-Z0-9_-]/g, '');
    this.tempRawPath = path.join(os.tmpdir(), `voicedrop_rec_${safeId}_${Date.now()}.s16le`);
    this.writeStream = fs.createWriteStream(this.tempRawPath);
    this.writeStream.on('error', () => {});

    this.mixTimer = setInterval(() => this.flushMixTick(), PCM16_FRAME_MS);
  }

  public pushInbound(frame: Buffer): void {
    if (this.finalized || !frame || frame.length === 0) return;
    let off = 0;
    while (off + PCM16_BYTES_PER_FRAME <= frame.length) {
      this.inboundQueue.push(Buffer.from(frame.subarray(off, off + PCM16_BYTES_PER_FRAME)));
      off += PCM16_BYTES_PER_FRAME;
    }
    if (off < frame.length) {
      const padded = Buffer.alloc(PCM16_BYTES_PER_FRAME);
      frame.copy(padded, 0, off);
      this.inboundQueue.push(padded);
    }
    if (this.inboundQueue.length > 100) this.inboundQueue.splice(0, this.inboundQueue.length - 100);
  }

  public pushOutbound(frame: Buffer): void {
    if (this.finalized || !frame || frame.length === 0) return;
    let off = 0;
    while (off + PCM16_BYTES_PER_FRAME <= frame.length) {
      this.outboundQueue.push(Buffer.from(frame.subarray(off, off + PCM16_BYTES_PER_FRAME)));
      off += PCM16_BYTES_PER_FRAME;
    }
    if (off < frame.length) {
      const padded = Buffer.alloc(PCM16_BYTES_PER_FRAME);
      frame.copy(padded, 0, off);
      this.outboundQueue.push(padded);
    }
    if (this.outboundQueue.length > 100)
      this.outboundQueue.splice(0, this.outboundQueue.length - 100);
  }

  private flushMixTick(): void {
    if (this.finalized) return;
    const inBuf = this.inboundQueue.shift();
    const outBuf = this.outboundQueue.shift();

    if (!inBuf && !outBuf && this.totalMixedBytes === 0) return;

    const mixed = Buffer.alloc(PCM16_BYTES_PER_FRAME);
    const samples = PCM16_BYTES_PER_FRAME >> 1;
    for (let i = 0; i < samples; i++) {
      const a = inBuf ? inBuf.readInt16LE(i * 2) : 0;
      const b = outBuf ? Math.round(outBuf.readInt16LE(i * 2) * 0.85) : 0;
      mixed.writeInt16LE(clampInt16(a + b), i * 2);
    }
    this.writeStream.write(mixed);
    this.totalMixedBytes += mixed.length;
  }

  public async finalize(
    recordingsDir: string
  ): Promise<{ filePath: string; ext: string; durationSec: number; sizeBytes: number } | null> {
    if (this.finalized) return null;
    this.finalized = true;

    if (this.mixTimer) {
      clearInterval(this.mixTimer);
      this.mixTimer = undefined;
    }

    while (this.inboundQueue.length > 0 || this.outboundQueue.length > 0) {
      const inBuf = this.inboundQueue.shift();
      const outBuf = this.outboundQueue.shift();
      const mixed = Buffer.alloc(PCM16_BYTES_PER_FRAME);
      const samples = PCM16_BYTES_PER_FRAME >> 1;
      for (let i = 0; i < samples; i++) {
        const a = inBuf ? inBuf.readInt16LE(i * 2) : 0;
        const b = outBuf ? Math.round(outBuf.readInt16LE(i * 2) * 0.85) : 0;
        mixed.writeInt16LE(clampInt16(a + b), i * 2);
      }
      this.writeStream.write(mixed);
      this.totalMixedBytes += mixed.length;
    }

    await new Promise<void>((resolve) => {
      this.writeStream.end(() => resolve());
    });

    if (this.totalMixedBytes < PCM16_BYTES_PER_FRAME * 5) {
      try {
        fs.unlinkSync(this.tempRawPath);
      } catch {}
      return null;
    }

    try {
      if (!fs.existsSync(recordingsDir)) {
        fs.mkdirSync(recordingsDir, { recursive: true });
      }
      const safeId = this.callId.replace(/[^a-zA-Z0-9_-]/g, '');
      const durationSec = Math.max(1, Math.round(this.totalMixedBytes / 2 / PCM16_SAMPLE_RATE));
      const mp3Path = path.join(recordingsDir, `${safeId}.mp3`);
      const ffmpegBin = resolveFfmpegBin();

      const mp3Ok = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ok);
        };
        const proc = spawn(
          ffmpegBin,
          [
            '-y',
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            's16le',
            '-ar',
            String(PCM16_SAMPLE_RATE),
            '-ac',
            '1',
            '-i',
            this.tempRawPath,
            '-codec:a',
            'libmp3lame',
            '-b:a',
            '48k',
            mp3Path,
          ],
          { stdio: 'ignore' }
        );
        const timer = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {}
          finish(false);
        }, 15000);
        proc.on('error', () => finish(false));
        proc.on('close', (code) =>
          finish(code === 0 && fs.existsSync(mp3Path) && fs.statSync(mp3Path).size > 256)
        );
      });

      if (mp3Ok) {
        const sizeBytes = fs.statSync(mp3Path).size;
        try {
          fs.unlinkSync(this.tempRawPath);
        } catch {}
        return { filePath: mp3Path, ext: 'mp3', durationSec, sizeBytes };
      }

      const wavPath = path.join(recordingsDir, `${safeId}.wav`);
      const rawData = fs.readFileSync(this.tempRawPath);
      const header = createWavHeader(rawData.length, PCM16_SAMPLE_RATE);
      fs.writeFileSync(wavPath, Buffer.concat([header, rawData]));
      try {
        fs.unlinkSync(this.tempRawPath);
      } catch {}
      const sizeBytes = fs.statSync(wavPath).size;
      return { filePath: wavPath, ext: 'wav', durationSec, sizeBytes };
    } catch (err) {
      console.error(`[Pcm16CallRecorder] Finalize failed for ${this.callId}:`, err);
      try {
        fs.unlinkSync(this.tempRawPath);
      } catch {}
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Real-Time 20ms Audio Frame Pacer with Instant Barge-In Support
// ---------------------------------------------------------------------------
export async function streamPcm16Frames(
  encodedAudio: Buffer,
  options: {
    signal: AbortSignal;
    sendFrame: (frame: Buffer) => void;
    onFrameSent?: (frame: Buffer, frameIndex: number) => void;
    bytesPerFrame?: number;
    prebufferFrames?: number;
  }
): Promise<{ interrupted: boolean; framesSent: number }> {
  const {
    signal,
    sendFrame,
    onFrameSent,
    bytesPerFrame = PCM16_BYTES_PER_FRAME,
    prebufferFrames = 3,
  } = options;
  if (!encodedAudio || encodedAudio.length === 0) {
    return { interrupted: false, framesSent: 0 };
  }

  const totalFrames = Math.ceil(encodedAudio.length / bytesPerFrame);
  const startTime = performance.now();
  let framesSent = 0;

  for (let i = 0; i < totalFrames; i++) {
    if (signal.aborted) {
      return { interrupted: true, framesSent };
    }

    const start = i * bytesPerFrame;
    const end = Math.min(start + bytesPerFrame, encodedAudio.length);
    let frame: Buffer;
    if (end - start === bytesPerFrame) {
      frame = encodedAudio.subarray(start, end);
    } else {
      frame = Buffer.alloc(bytesPerFrame);
      encodedAudio.copy(frame, 0, start, end);
    }

    sendFrame(frame);
    onFrameSent?.(frame, i);
    framesSent++;

    if (i >= prebufferFrames) {
      const targetElapsedMs = (i - prebufferFrames + 1) * PCM16_FRAME_MS;
      const waitMs = targetElapsedMs - (performance.now() - startTime);
      if (waitMs > 1) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, waitMs);
          const onAbort = () => {
            clearTimeout(timer);
            resolve();
          };
          signal.addEventListener('abort', onAbort, { once: true });
        });
      }
    }
  }

  return { interrupted: signal.aborted, framesSent };
}
