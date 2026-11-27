import { getDeviceId } from './deviceSession';

const DEFAULT_SAMPLE_RATE = 16000;

/**
 * Browser Web Audio API player for real-time 16 kHz PCM16 live call monitoring.
 * Connects to /api/call/audio-monitor over WebSocket when the operator enables "Audio On".
 */
export class LiveAudioMonitor {
  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private nextPlayTime = 0;
  private sampleRate = DEFAULT_SAMPLE_RATE;
  private stopped = false;

  public start(callId: string): void {
    this.stop();
    this.stopped = false;

    if (typeof window === 'undefined' || !callId) return;
    const deviceId = getDeviceId();
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/api/call/audio-monitor?callId=${encodeURIComponent(
      callId
    )}&deviceId=${encodeURIComponent(deviceId)}`;

    try {
      const AudioCtxCtor =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new AudioCtxCtor();
      if (this.audioCtx.state === 'suspended') {
        void this.audioCtx.resume().catch(() => {});
      }
      this.nextPlayTime = this.audioCtx.currentTime + 0.06;

      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      ws.onmessage = (event) => {
        if (this.stopped) return;
        if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            if (msg?.type === 'audio.format' && Number(msg.sampleRate) > 0) {
              this.sampleRate = Number(msg.sampleRate);
            } else if (msg?.type === 'audio.end') {
              this.stop();
            }
          } catch {
            // Ignore malformed control packet
          }
          return;
        }

        if (event.data instanceof ArrayBuffer) {
          this.playPcm16Buffer(event.data);
        }
      };

      ws.onerror = () => {
        // Closed cleanly on unmount or mute
      };
    } catch {
      this.stop();
    }
  }

  private playPcm16Buffer(raw: ArrayBuffer): void {
    if (!this.audioCtx || this.stopped || raw.byteLength < 2) return;
    if (this.audioCtx.state === 'suspended') {
      void this.audioCtx.resume().catch(() => {});
    }

    const int16 = new Int16Array(raw, 0, Math.floor(raw.byteLength / 2));
    if (int16.length === 0) return;

    const audioBuffer = this.audioCtx.createBuffer(1, int16.length, this.sampleRate);
    const channelData = audioBuffer.getChannelData(0);
    for (let i = 0; i < int16.length; i++) {
      channelData[i] = int16[i] / 32768;
    }

    const now = this.audioCtx.currentTime;
    // Keep playback tightly synced within a 60ms..350ms live jitter window
    if (this.nextPlayTime < now + 0.02 || this.nextPlayTime > now + 0.35) {
      this.nextPlayTime = now + 0.06;
    }

    const source = this.audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioCtx.destination);
    source.start(this.nextPlayTime);
    this.nextPlayTime += audioBuffer.duration;
  }

  public stop(): void {
    this.stopped = true;
    if (this.ws) {
      try {
        this.ws.onmessage = null;
        this.ws.close(1000);
      } catch {}
      this.ws = null;
    }
    if (this.audioCtx) {
      const ctx = this.audioCtx;
      this.audioCtx = null;
      void ctx.close().catch(() => {});
    }
    this.nextPlayTime = 0;
  }
}
