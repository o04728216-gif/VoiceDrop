import { decodeFrameToFloat16k } from './stt.ts';
import type { TelephonyCodec, TelephonyRate } from './tts.ts';

interface TimedAudioSegment {
  offsetMs: number;
  samples: Float32Array;
}

const RECORDER_SAMPLE_RATE = 16000;
const MAX_RECORDING_MS = 15 * 60 * 1000; // 15 min cap to bound RAM cleanly

/**
 * Real-time dual-leg telephony audio recorder (captures BOTH VoiceDrop outbound prompts
 * AND recipient inbound voice in exact wall-clock synchronization).
 * Mixes into a crisp, soft-limited 16kHz 16-bit PCM WAV buffer with zero external dependencies.
 */
export class LiveCallRecorder {
  private readonly callId: string;
  private readonly startedAtMs: number;
  private readonly inboundSegments: TimedAudioSegment[] = [];
  private readonly outboundSegments: TimedAudioSegment[] = [];
  private inboundBytes = 0;
  private outboundBytes = 0;
  private maxEndSample = 0;
  private finalized = false;

  constructor(callId: string) {
    this.callId = callId;
    this.startedAtMs = Date.now();
  }

  public recordInbound(frame: Buffer, codec: TelephonyCodec, sampleRate: TelephonyRate): void {
    if (this.finalized || !frame || frame.length === 0) return;
    const offsetMs = Date.now() - this.startedAtMs;
    if (offsetMs > MAX_RECORDING_MS) return;

    const samples = decodeFrameToFloat16k(frame, codec, sampleRate);
    if (samples.length === 0) return;

    this.inboundBytes += frame.length;
    this.inboundSegments.push({ offsetMs, samples });
    const endSample = Math.round((offsetMs / 1000) * RECORDER_SAMPLE_RATE) + samples.length;
    if (endSample > this.maxEndSample) this.maxEndSample = endSample;
  }

  public recordOutbound(frame: Buffer, codec: TelephonyCodec, sampleRate: TelephonyRate): void {
    if (this.finalized || !frame || frame.length === 0) return;
    const offsetMs = Date.now() - this.startedAtMs;
    if (offsetMs > MAX_RECORDING_MS) return;

    const samples = decodeFrameToFloat16k(frame, codec, sampleRate);
    if (samples.length === 0) return;

    this.outboundBytes += frame.length;
    this.outboundSegments.push({ offsetMs, samples });
    const endSample = Math.round((offsetMs / 1000) * RECORDER_SAMPLE_RATE) + samples.length;
    if (endSample > this.maxEndSample) this.maxEndSample = endSample;
  }

  public finalize(): {
    wavBuffer: Buffer;
    durationSec: number;
    inboundBytes: number;
    outboundBytes: number;
  } | null {
    if (this.finalized) return null;
    this.finalized = true;

    const totalSamples = Math.min(
      this.maxEndSample,
      Math.round((MAX_RECORDING_MS / 1000) * RECORDER_SAMPLE_RATE)
    );

    // Need at least 250ms of recorded audio
    if (totalSamples < RECORDER_SAMPLE_RATE / 4) {
      this.inboundSegments.length = 0;
      this.outboundSegments.length = 0;
      return null;
    }

    const inboundTrack = new Float32Array(totalSamples);
    const outboundTrack = new Float32Array(totalSamples);

    // Place inbound frames smoothly along the timeline (avoid micro-jitter gaps/overlaps)
    let lastInCursor = 0;
    for (const seg of this.inboundSegments) {
      const targetStart = Math.round((seg.offsetMs / 1000) * RECORDER_SAMPLE_RATE);
      // If wall-clock timestamp is within 60ms of sequential cursor, stitch seamlessly with zero clicks!
      const start =
        Math.abs(targetStart - lastInCursor) <= 960
          ? lastInCursor
          : Math.max(0, targetStart);
      const len = Math.min(seg.samples.length, totalSamples - start);
      if (len > 0) {
        inboundTrack.set(seg.samples.subarray(0, len), start);
        lastInCursor = start + len;
      }
    }

    // Place outbound frames smoothly along the timeline
    let lastOutCursor = 0;
    for (const seg of this.outboundSegments) {
      const targetStart = Math.round((seg.offsetMs / 1000) * RECORDER_SAMPLE_RATE);
      const start =
        Math.abs(targetStart - lastOutCursor) <= 960
          ? lastOutCursor
          : Math.max(0, targetStart);
      const len = Math.min(seg.samples.length, totalSamples - start);
      if (len > 0) {
        outboundTrack.set(seg.samples.subarray(0, len), start);
        lastOutCursor = start + len;
      }
    }

    // Free raw segment references immediately
    this.inboundSegments.length = 0;
    this.outboundSegments.length = 0;

    // Gently auto-level quiet PSTN inbound voice so recipient sounds just as clear as prompts
    let inboundPeak = 0;
    for (let i = 0; i < totalSamples; i++) {
      const a = Math.abs(inboundTrack[i]);
      if (a > inboundPeak) inboundPeak = a;
    }
    const inboundGain =
      inboundPeak > 0.015 && inboundPeak < 0.65
        ? Math.min(3.2, 0.72 / inboundPeak)
        : 1.0;
    const outboundGain = 0.82;

    // Encode standard 16kHz mono 16-bit PCM WAV with soft limiting
    const dataBytes = totalSamples * 2;
    const wav = Buffer.alloc(44 + dataBytes);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(36 + dataBytes, 4);
    wav.write('WAVE', 8);
    wav.write('fmt ', 12);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); // PCM
    wav.writeUInt16LE(1, 22); // mono
    wav.writeUInt32LE(RECORDER_SAMPLE_RATE, 24);
    wav.writeUInt32LE(RECORDER_SAMPLE_RATE * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(dataBytes, 40);

    for (let i = 0; i < totalSamples; i++) {
      const mixed = inboundTrack[i] * inboundGain + outboundTrack[i] * outboundGain;
      // Smooth soft-clipper prevents harsh digital clipping when both sides speak simultaneously
      const limited = Math.abs(mixed) > 0.85 ? Math.tanh(mixed) : mixed;
      const clamped = Math.max(-1, Math.min(1, limited));
      wav.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
    }

    const durationSec = Math.max(1, Math.round(totalSamples / RECORDER_SAMPLE_RATE));
    console.log(
      `[VoiceDrop Recorder] Finalized callId=${this.callId} duration=${durationSec}s wavKB=${Math.round(wav.length / 1024)} inBytes=${this.inboundBytes} outBytes=${this.outboundBytes} inGain=${inboundGain.toFixed(2)}x`
    );

    return {
      wavBuffer: wav,
      durationSec,
      inboundBytes: this.inboundBytes,
      outboundBytes: this.outboundBytes,
    };
  }
}
