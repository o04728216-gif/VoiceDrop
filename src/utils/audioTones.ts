/**
 * Dual-Tone Multi-Frequency (DTMF) Web Audio Synthesizer & Telephony Sound Effects
 */

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

// DTMF standard frequency map
const DTMF_FREQUENCIES: Record<string, [number, number]> = {
  '1': [697, 1209],
  '2': [697, 1336],
  '3': [697, 1477],
  '4': [770, 1209],
  '5': [770, 1336],
  '6': [770, 1477],
  '7': [852, 1209],
  '8': [852, 1336],
  '9': [852, 1477],
  '*': [941, 1209],
  '0': [941, 1336],
  '#': [941, 1477],
};

/**
 * Plays the official DTMF dual-frequency tone for a phone key
 */
export function playDtmfTone(digit: string, durationMs: number = 220) {
  const ctx = getAudioContext();
  if (!ctx) return;

  const freqs = DTMF_FREQUENCIES[digit];
  if (!freqs) return;

  const now = ctx.currentTime;
  const duration = durationMs / 1000;

  const osc1 = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const gainNode = ctx.createGain();

  osc1.type = 'sine';
  osc2.type = 'sine';
  osc1.frequency.setValueAtTime(freqs[0], now);
  osc2.frequency.setValueAtTime(freqs[1], now);

  // Soft attack and release to avoid audio click/pop
  gainNode.gain.setValueAtTime(0.001, now);
  gainNode.gain.exponentialRampToValueAtTime(0.2, now + 0.02);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  osc1.connect(gainNode);
  osc2.connect(gainNode);
  gainNode.connect(ctx.destination);

  osc1.start(now);
  osc2.start(now);
  osc1.stop(now + duration);
  osc2.stop(now + duration);
}

/**
 * Plays a US telephone ringback audio chime
 */
let ringbackInterval: any = null;
export function startRingbackTone() {
  stopRingbackTone();
  const ctx = getAudioContext();
  if (!ctx) return;

  const playSingleRing = () => {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const osc1 = audioCtx.createOscillator();
    const osc2 = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc1.type = 'sine';
    osc2.type = 'sine';
    osc1.frequency.setValueAtTime(440, now);
    osc2.frequency.setValueAtTime(480, now);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.08, now + 0.05);
    gain.gain.setValueAtTime(0.08, now + 1.8);
    gain.gain.linearRampToValueAtTime(0.0001, now + 2.0);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(audioCtx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 2.0);
    osc2.stop(now + 2.0);
  };

  playSingleRing();
  ringbackInterval = setInterval(playSingleRing, 4000);
}

export function stopRingbackTone() {
  if (ringbackInterval) {
    clearInterval(ringbackInterval);
    ringbackInterval = null;
  }
}

/**
 * Plays a call connected chime
 */
export function playConnectedChime() {
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(587.33, now); // D5
  osc.frequency.exponentialRampToValueAtTime(880, now + 0.15); // A5

  gain.gain.setValueAtTime(0.001, now);
  gain.gain.linearRampToValueAtTime(0.15, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + 0.35);
}

/**
 * Plays a hangup / call ended busy cadence
 */
export function playHangupTone() {
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  for (let i = 0; i < 3; i++) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const startTime = now + i * 0.3;

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(480, startTime);

    gain.gain.setValueAtTime(0.001, startTime);
    gain.gain.linearRampToValueAtTime(0.12, startTime + 0.02);
    gain.gain.setValueAtTime(0.12, startTime + 0.18);
    gain.gain.linearRampToValueAtTime(0.0001, startTime + 0.2);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(startTime);
    osc.stop(startTime + 0.2);
  }
}
