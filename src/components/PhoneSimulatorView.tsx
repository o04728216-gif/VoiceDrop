import React, { useState, useEffect, useRef } from 'react';
import {
  Phone,
  PhoneOff,
  Volume2,
  X,
  Radio,
  Delete,
  CheckCircle2,
  AlertTriangle,
  PauseCircle,
  Smartphone,
  Maximize2,
  Minimize2,
  Shield,
  Clock,
  Wifi,
  Battery,
  Mic,
  MicOff,
  Voicemail,
  Send,
  UserCheck,
} from 'lucide-react';
import { CallSession } from '../types/telephony';
import { playDtmfTone } from '../utils/audioTones';

interface PhoneSimulatorViewProps {
  session: CallSession | null;
  onSimulateEvent: (action: string, payload?: any) => Promise<any>;
  onRecordingSaved?: (updatedSession?: CallSession) => void;
  soundEnabled: boolean;
  isDocked?: boolean;
  onClose?: () => void;
  onToggleDock?: () => void;
}

// Global memory across unmounts / tab switches so switching tabs never replays speech
const globallySpokenGreetings = new Set<string>();
const globallySpokenDecisions = new Set<string>();
const globallySpokenCues = new Set<string>();

const TERMINAL_STATUSES = ['completed', 'failed', 'busy', 'no-answer'];

export const PhoneSimulatorView: React.FC<PhoneSimulatorViewProps> = ({
  session,
  onSimulateEvent,
  onRecordingSaved,
  soundEnabled,
  isDocked = true,
  onClose,
  onToggleDock,
}) => {
  const [callDuration, setCallDuration] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [currentPromptText, setCurrentPromptText] = useState('');
  const [enteredDigits, setEnteredDigits] = useState<string>('');
  const [isSubmittingCode, setIsSubmittingCode] = useState(false);
  const [attemptFeedback, setAttemptFeedback] = useState<{
    type: 'valid' | 'invalid' | 'waiting' | 'max';
    message: string;
  } | null>(null);
  const [isMicRecording, setIsMicRecording] = useState(false);
  const [simulatedSpeechInput, setSimulatedSpeechInput] = useState('');

  const targetLength = session?.numDigits || 6;
  const lastSpokenDecisionRef = useRef<string | null>(null);
  const lastSpeakCallTimeRef = useRef<{ text: string; time: number } | null>(null);
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mixCtxRef = useRef<AudioContext | null>(null);
  const mixDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const activeRecordingCallIdRef = useRef<string | null>(null);
  const uploadingLockRef = useRef<Promise<void> | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordStartTimeRef = useRef<number>(0);
  const speechRecRef = useRef<any>(null);

  const playToneIntoRecordingMix = (freqA: number, freqB?: number, durationMs = 160) => {
    const ctx = mixCtxRef.current;
    const dest = mixDestRef.current;
    if (!ctx || !dest || ctx.state === 'closed') return;
    try {
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => {});
      }
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.14, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + durationMs / 1000);
      gain.connect(dest);

      const osc1 = ctx.createOscillator();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(freqA, now);
      osc1.connect(gain);
      osc1.start(now);
      osc1.stop(now + durationMs / 1000);

      if (freqB) {
        const osc2 = ctx.createOscillator();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(freqB, now);
        osc2.connect(gain);
        osc2.start(now);
        osc2.stop(now + durationMs / 1000);
      }
    } catch {
      // Ignore Web Audio synthesis error
    }
  };

  const recordDtmfIntoMix = (key: string) => {
    const dtmfMap: Record<string, [number, number]> = {
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
    const pair = dtmfMap[key];
    if (pair) {
      playToneIntoRecordingMix(pair[0], pair[1], 180);
    }
  };

  const pickBestRecorderOptions = (): MediaRecorderOptions => {
    if (typeof MediaRecorder === 'undefined') return {};
    const preferredTypes = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    for (const mimeType of preferredTypes) {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        return { mimeType, audioBitsPerSecond: 32000 };
      }
    }
    return { audioBitsPerSecond: 32000 };
  };

  const startSimulatorCallRecording = async (callId: string, requestMic: boolean) => {
    if (!callId || typeof window === 'undefined' || typeof MediaRecorder === 'undefined') {
      return;
    }

    // If already recording this call and user didn't newly request mic upgrade, keep current recorder
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state === 'recording' &&
      activeRecordingCallIdRef.current === callId &&
      (!requestMic || isMicRecording)
    ) {
      return;
    }

    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;

      let ctx = mixCtxRef.current;
      let dest = mixDestRef.current;
      if (!ctx || ctx.state === 'closed' || !dest) {
        ctx = new AudioCtx({ sampleRate: 24000 });
        dest = ctx.createMediaStreamDestination();
        mixCtxRef.current = ctx;
        mixDestRef.current = dest;

        // Subtle continuous carrier-floor oscillator (-65 dB) so MediaRecorder always produces continuous valid audio frames
        const carrierOsc = ctx.createOscillator();
        const carrierGain = ctx.createGain();
        carrierOsc.frequency.value = 180;
        carrierGain.gain.value = 0.0004;
        carrierOsc.connect(carrierGain);
        carrierGain.connect(dest);
        carrierOsc.start();
      }
      if (ctx.state === 'suspended') {
        await ctx.resume().catch(() => {});
      }

      // Attach high-quality mono microphone if requested or already granted
      let shouldAttachMic = requestMic;
      if (!shouldAttachMic && navigator.permissions?.query) {
        try {
          const perm = await navigator.permissions.query({ name: 'microphone' as PermissionName });
          if (perm.state === 'granted') {
            shouldAttachMic = true;
          }
        } catch {}
      }

      if (shouldAttachMic && navigator.mediaDevices?.getUserMedia && !mediaStreamRef.current) {
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              channelCount: 1,
              sampleRate: 48000,
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });
          mediaStreamRef.current = micStream;
          const micSource = ctx.createMediaStreamSource(micStream);
          micSource.connect(dest);
          setIsMicRecording(true);

          const SpeechRec =
            (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
          if (SpeechRec && !speechRecRef.current) {
            const recognition = new SpeechRec();
            recognition.continuous = true;
            recognition.interimResults = false;
            recognition.lang = 'en-US';
            recognition.onresult = (event: any) => {
              for (let i = event.resultIndex; i < event.results.length; i++) {
                if (event.results[i].isFinal) {
                  const transcript = event.results[i][0]?.transcript?.trim();
                  const conf = event.results[i][0]?.confidence || 0.94;
                  if (transcript) {
                    void onSimulateEvent('speech', { speech: transcript, confidence: conf });
                  }
                }
              }
            };
            recognition.onerror = () => {};
            try {
              recognition.start();
              speechRecRef.current = recognition;
            } catch {}
          }
        } catch (micErr) {
          if (requestMic) {
            console.error('Microphone permission error:', micErr);
          }
          setIsMicRecording(false);
        }
      }

      if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
        recordedChunksRef.current = [];
        recordStartTimeRef.current = Date.now();
        activeRecordingCallIdRef.current = callId;

        const recorder = new MediaRecorder(dest.stream, pickBestRecorderOptions());
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            recordedChunksRef.current.push(e.data);
          }
        };
        recorder.start(200);
        mediaRecorderRef.current = recorder;

        // Play clean pickup connection chime into recording
        playToneIntoRecordingMix(523.25, 659.25, 140);
      }
    } catch (err) {
      console.error('Simulator call recorder error:', err);
    }
  };

  const stopAndUploadMicRecording = async (targetCallId?: string) => {
    if (uploadingLockRef.current) {
      return uploadingLockRef.current;
    }

    const job = (async () => {
      if (speechRecRef.current) {
        try {
          speechRecRef.current.stop();
        } catch {}
        speechRecRef.current = null;
      }

      const callIdToSave = targetCallId || activeRecordingCallIdRef.current || session?.id;
      const recorder = mediaRecorderRef.current;

      if (recorder && recorder.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          recorder.onstop = async () => {
            try {
              if (callIdToSave && recordedChunksRef.current.length > 0) {
                const mimeType = recorder.mimeType || 'audio/webm';
                const blob = new Blob(recordedChunksRef.current, { type: mimeType });
                const durationSec = Math.max(
                  1,
                  Math.round((Date.now() - recordStartTimeRef.current) / 1000)
                );
                const dataUrl = await new Promise<string | null>((resRead) => {
                  const reader = new FileReader();
                  reader.onloadend = () =>
                    resRead(typeof reader.result === 'string' ? reader.result : null);
                  reader.onerror = () => resRead(null);
                  reader.readAsDataURL(blob);
                });

                if (dataUrl) {
                  try {
                    const upRes = await fetch(
                      `/api/calls/${encodeURIComponent(callIdToSave)}/recording-upload`,
                      {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          audioBase64: dataUrl,
                          mimeType,
                          duration: durationSec,
                        }),
                      }
                    );
                    if (upRes.ok) {
                      const upJson = await upRes.json();
                      onRecordingSaved?.(upJson.session);
                    }
                  } catch (err) {
                    console.error('Upload simulator recording failed:', err);
                  }
                }
              }
            } finally {
              resolve();
            }
          };
          try {
            recorder.requestData();
          } catch {}
          recorder.stop();
        });
      }

      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
      }
      if (mixCtxRef.current && mixCtxRef.current.state !== 'closed') {
        await mixCtxRef.current.close().catch(() => {});
      }
      mixCtxRef.current = null;
      mixDestRef.current = null;
      mediaRecorderRef.current = null;
      activeRecordingCallIdRef.current = null;
      recordedChunksRef.current = [];
      setIsMicRecording(false);
    })();

    uploadingLockRef.current = job;
    try {
      await job;
    } finally {
      uploadingLockRef.current = null;
    }
  };

  const toggleMicRecording = async () => {
    if (isMicRecording) {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
      }
      if (speechRecRef.current) {
        try {
          speechRecRef.current.stop();
        } catch {}
        speechRecRef.current = null;
      }
      setIsMicRecording(false);
      return;
    }
    if (!session?.id) return;
    await startSimulatorCallRecording(session.id, true);
  };

  const handleSendSimulatedSpeech = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!simulatedSpeechInput.trim()) return;
    const text = simulatedSpeechInput.trim();
    setSimulatedSpeechInput('');
    await onSimulateEvent('speech', { speech: text, confidence: 0.98 });
  };

  // Cancel any active speech immediately if user mutes audio
  useEffect(() => {
    if (!soundEnabled && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    }
  }, [soundEnabled]);

  // Cancel any speech when leaving the view / unmounting
  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  // Reset state on new call session & guard already-finished sessions from replaying audio
  useEffect(() => {
    setEnteredDigits('');
    setIsSubmittingCode(false);
    setAttemptFeedback(null);
    setCurrentPromptText('');
    lastSpeakCallTimeRef.current = null;

    if (session?.id) {
      const isTerminal = TERMINAL_STATUSES.includes(session.status);
      if (isTerminal) {
        globallySpokenGreetings.add(session.id);
      }
      if (isTerminal || session.operatorDecision === 'approved' || session.codeStatus === 'valid') {
        const decisionKey = `${session.id}-approved`;
        globallySpokenDecisions.add(decisionKey);
        lastSpokenDecisionRef.current = decisionKey;
      } else {
        lastSpokenDecisionRef.current = null;
      }

      if (isTerminal && session.attempts) {
        globallySpokenDecisions.add(`${session.id}-rejected-${session.attempts}`);
      }
      if (isTerminal && session.activeCue?.timestamp) {
        globallySpokenCues.add(`${session.id}-cue-${session.activeCue.timestamp}`);
      }
    }
  }, [session?.id]);

  useEffect(() => {
    let interval: any;
    if (
      session &&
      (session.status === 'in-progress' ||
        session.status === 'collecting-input' ||
        session.status === 'awaiting-operator')
    ) {
      if (session.isSimulated && session.recordCall !== false) {
        void startSimulatorCallRecording(session.id, false);
      }
      interval = setInterval(() => {
        setCallDuration((prev) => prev + 1);
      }, 1000);
    } else {
      setCallDuration(0);
      if (mediaRecorderRef.current || activeRecordingCallIdRef.current) {
        void stopAndUploadMicRecording(activeRecordingCallIdRef.current || session?.id);
      }
    }
    return () => clearInterval(interval);
  }, [session?.id, session?.status]);

  // Voice speech synthesis helper with deduplication & mute guard
  const speakText = (text: string, onEnd?: () => void) => {
    if (!text || typeof window === 'undefined' || !('speechSynthesis' in window)) {
      if (onEnd) onEnd();
      return;
    }

    if (!soundEnabledRef.current) {
      if (onEnd) onEnd();
      return;
    }

    const now = Date.now();
    if (
      lastSpeakCallTimeRef.current &&
      lastSpeakCallTimeRef.current.text === text &&
      now - lastSpeakCallTimeRef.current.time < 2000
    ) {
      return;
    }
    lastSpeakCallTimeRef.current = { text, time: now };

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => {
      setIsSpeaking(false);
      if (onEnd) onEnd();
    };
    utterance.onerror = () => {
      setIsSpeaking(false);
      if (onEnd) onEnd();
    };
    window.speechSynthesis.speak(utterance);
  };

  // React to live operator audio cues triggered from the dashboard (strictly once per cue)
  useEffect(() => {
    if (!session?.id || !session?.activeCue?.text || !session?.activeCue?.timestamp) return;
    if (TERMINAL_STATUSES.includes(session.status)) return;

    const cueKey = `${session.id}-cue-${session.activeCue.timestamp}`;
    if (globallySpokenCues.has(cueKey)) return;
    globallySpokenCues.add(cueKey);

    setCurrentPromptText(session.activeCue.text);
    speakText(session.activeCue.text);
  }, [session?.id, session?.activeCue?.timestamp, session?.status]);

  // React to operator decisions (Approve / Reject) in real time - strictly once per event
  useEffect(() => {
    if (!session) return;

    if (session.operatorDecision === 'approved' || session.codeStatus === 'valid') {
      const decisionKey = `${session.id}-approved`;
      if (lastSpokenDecisionRef.current === decisionKey || globallySpokenDecisions.has(decisionKey)) {
        return;
      }
      lastSpokenDecisionRef.current = decisionKey;
      globallySpokenDecisions.add(decisionKey);

      const msg = session.successMessage || 'Code verified successfully. Goodbye.';
      setAttemptFeedback({
        type: 'valid',
        message: `Code Verified! Valid [${session.capturedDigits || session.pendingDigits || ''}]`,
      });
      setCurrentPromptText(msg);
      speakText(msg);
    } else if (session.operatorDecision === 'rejected' || (session.codeStatus === 'invalid' && session.attempts)) {
      const decisionKey = `${session.id}-rejected-${session.attempts}`;
      if (lastSpokenDecisionRef.current === decisionKey || globallySpokenDecisions.has(decisionKey)) {
        return;
      }
      lastSpokenDecisionRef.current = decisionKey;
      globallySpokenDecisions.add(decisionKey);

      const msg = session.invalidMessage || 'That code is incorrect. Please try again.';
      setAttemptFeedback({
        type: 'invalid',
        message: `Attempt ${session.attempts || 1}: Invalid Code [${session.lastInvalidDigits || ''}]`,
      });
      setCurrentPromptText(msg);
      if (!TERMINAL_STATUSES.includes(session.status)) {
        speakText(msg);
      }
      setTimeout(() => {
        setEnteredDigits('');
        setIsSubmittingCode(false);
      }, 1000);
    }
  }, [session?.id, session?.operatorDecision, session?.codeStatus, session?.attempts, session?.status]);

  // Automatically play immediate pickup greeting -> code prompt strictly ONCE when a Live Human is confirmed
  // (Handles direct human pickup AND human picking up the phone after a voicemail machine answered!)
  useEffect(() => {
    if (!session?.id) return;
    if (TERMINAL_STATUSES.includes(session.status)) return;
    if (
      session.promptsStarted &&
      session.answeredBy === 'human' &&
      !globallySpokenGreetings.has(session.id)
    ) {
      globallySpokenGreetings.add(session.id);
      setCurrentPromptText(session.introGreeting);
      speakText(session.introGreeting, () => {
        setCurrentPromptText(session.script);
        speakText(session.script);
      });
    }
  }, [session?.id, session?.promptsStarted, session?.answeredBy, session?.status]);

  // Direct Live Human answers the call: listen, record, and play greeting + script immediately
  const handleAnswerCall = async () => {
    if (session?.id && session.recordCall !== false) {
      await startSimulatorCallRecording(session.id, false);
    }
    if (session?.id) {
      globallySpokenGreetings.add(session.id);
    }
    await onSimulateEvent('answer');

    if (session) {
      setCurrentPromptText(session.introGreeting);
      speakText(session.introGreeting, () => {
        setCurrentPromptText(session.script);
        speakText(session.script);
      });
    }
  };

  // Voicemail Machine answers the call: listen & record from 0:00, NEVER play bot greetings to voicemail
  const handleVoicemailAnswer = async () => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setIsSpeaking(false);

    if (session?.id && session.recordCall !== false) {
      await startSimulatorCallRecording(session.id, false);
    }
    const res = await onSimulateEvent('voicemail');
    setCurrentPromptText(
      '[Voicemail Machine Answered] Bot prompts muted — silently listening & recording for live human pickup...'
    );
    if (res?.session?.status === 'no-answer') {
      await stopAndUploadMicRecording(session?.id);
    }
  };

  // Live Human picks up the handset AFTER Voicemail Machine initially answered
  const handleHumanPickupAfterVoicemail = async () => {
    await onSimulateEvent('human_pickup');
  };

  const formatTimer = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const handleKeyClick = (key: string) => {
    if (isSubmittingCode) return;

    if (soundEnabled) {
      playDtmfTone(key, 200);
    }
    recordDtmfIntoMix(key);

    // If Voicemail answered first and a live human picks up and presses a key, immediately wake greeting
    if (session?.answeredBy === 'voicemail' && !session?.promptsStarted) {
      void onSimulateEvent('human_pickup');
    }

    if (key === '#') {
      if (enteredDigits.length >= targetLength) {
        submitFullCode(enteredDigits.slice(0, targetLength));
      }
      return;
    }

    if (key === '*') {
      return;
    }

    if (attemptFeedback?.type === 'invalid') {
      setAttemptFeedback(null);
    }

    const next = enteredDigits + key;
    setEnteredDigits(next);

    if (next.length >= targetLength) {
      submitFullCode(next);
    }
  };

  const submitFullCode = async (code: string) => {
    setIsSubmittingCode(true);
    setAttemptFeedback(null);

    const res = await onSimulateEvent('dtmf', { digits: code });

    if (res?.codeStatus === 'awaiting_operator') {
      const holdMsg = res.message || session?.holdMessage || 'Kindly hold while your information is being processed.';
      setAttemptFeedback({
        type: 'waiting',
        message: `Code [${code}] submitted — On hold for operator review`,
      });
      setCurrentPromptText(holdMsg);
      speakText(holdMsg);
    } else if (res?.codeStatus === 'invalid') {
      const msg = res.message || session?.invalidMessage || 'That code is incorrect. Please try again.';
      const rejKey = `${session?.id}-rejected-${res.attempts}`;
      lastSpokenDecisionRef.current = rejKey;
      globallySpokenDecisions.add(rejKey);
      setAttemptFeedback({
        type: 'invalid',
        message: `Attempt ${res.attempts}/${res.maxAttempts || 3}: Invalid Code [${code}]`,
      });
      setCurrentPromptText(msg);
      speakText(msg);

      setTimeout(() => {
        setEnteredDigits('');
        setIsSubmittingCode(false);
      }, 1000);
    } else if (res?.codeStatus === 'valid') {
      const msg = res.message || session?.successMessage || 'Code verified successfully. Goodbye.';
      setAttemptFeedback({
        type: 'valid',
        message: `Code Verified! Valid [${code}]`,
      });
      setCurrentPromptText(msg);
      const decisionKey = `${session?.id}-approved`;
      if (lastSpokenDecisionRef.current !== decisionKey && !globallySpokenDecisions.has(decisionKey)) {
        lastSpokenDecisionRef.current = decisionKey;
        globallySpokenDecisions.add(decisionKey);
        speakText(msg);
      }
      void stopAndUploadMicRecording(session?.id);
    } else if (res?.codeStatus === 'max_exceeded') {
      const msg = res.message || 'Maximum attempts exceeded. Goodbye.';
      setAttemptFeedback({
        type: 'max',
        message: `Max attempts exceeded. Call ending.`,
      });
      setCurrentPromptText(msg);
      speakText(msg);
      void stopAndUploadMicRecording(session?.id);
    } else {
      setIsSubmittingCode(false);
    }
  };

  const handleDeleteDigit = () => {
    if (enteredDigits.length > 0 && !isSubmittingCode) {
      setEnteredDigits((prev) => prev.slice(0, -1));
    }
  };

  const isRinging = session && (session.status === 'ringing' || session.status === 'initiating' || session.status === 'queued');
  const isLive = session && (session.status === 'in-progress' || session.status === 'collecting-input' || session.status === 'awaiting-operator');
  const isDone = session && (session.status === 'completed' || session.status === 'failed' || session.status === 'busy');

  const content = (
    <div className="flex flex-col h-full bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
      {/* Device Header Bar */}
      <div className="p-3 border-b border-slate-800 bg-slate-900/90 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
            <Smartphone className="w-3.5 h-3.5" />
          </div>
          <div>
            <h3 className="text-xs font-bold text-white tracking-tight flex items-center gap-1.5">
              <span>Receiver Phone</span>
              <span className="text-[10px] font-normal px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 font-mono">
                {session ? session.to : 'Ready'}
              </span>
            </h3>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {onToggleDock && (
            <button
              onClick={onToggleDock}
              className="p-1 text-slate-400 hover:text-white rounded hover:bg-slate-800 transition-colors"
              title={isDocked ? 'Popout window' : 'Dock side-by-side'}
            >
              {isDocked ? <Maximize2 className="w-3.5 h-3.5" /> : <Minimize2 className="w-3.5 h-3.5" />}
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 text-slate-400 hover:text-white rounded hover:bg-slate-800 transition-colors"
              title="Close phone"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Embedded Phone Hardware Frame */}
      <div className="flex-1 p-3 lg:p-4 flex items-center justify-center bg-slate-950/60 overflow-y-auto">
        <div className="relative w-full max-w-[310px] rounded-[36px] border-[5px] border-slate-800 bg-slate-950 shadow-2xl flex flex-col justify-between overflow-hidden ring-1 ring-slate-700/80 min-h-[580px]">
          {/* Top Notch with speaker and battery */}
          <div className="pt-2.5 pb-1 flex justify-between items-center px-4 bg-slate-950 text-[10px] text-slate-400 font-mono">
            <span>9:41</span>
            <div className="w-20 h-4 bg-black rounded-full flex items-center justify-between px-2 border border-slate-800">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-800"></span>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
            </div>
            <div className="flex items-center gap-1">
              <Wifi className="w-2.5 h-2.5" />
              <Battery className="w-2.5 h-2.5" />
            </div>
          </div>

          {/* SCREEN CONTENT */}
          <div className="flex-1 flex flex-col justify-between px-4 py-2">
            {!session ? (
              /* Standby Lockscreen Mode */
              <div className="flex-1 flex flex-col items-center justify-between py-6 text-center">
                <div className="pt-4">
                  <div className="w-12 h-12 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center mx-auto mb-2 text-indigo-400">
                    <Shield className="w-6 h-6" />
                  </div>
                  <h4 className="text-sm font-bold text-white">VoiceDrop Mobile</h4>
                  <p className="text-[11px] text-slate-400 mt-0.5">Cellular Line Active</p>
                </div>

                <div className="my-auto p-3 rounded-xl bg-slate-900/80 border border-slate-800 text-left w-full text-xs space-y-1.5">
                  <div className="flex items-center justify-between text-[10px] text-slate-400">
                    <span className="font-semibold text-slate-300">Target Line</span>
                    <span className="text-emerald-400 font-mono">Ready</span>
                  </div>
                  <p className="text-[11px] text-slate-300 leading-snug">
                    Launch a call from the Operator panel on the left to test answering, code entry, and live audio cues.
                  </p>
                </div>

                <div className="text-[10px] text-slate-500 font-mono">
                  Simulated Terminal • Dual-Pane Active
                </div>
              </div>
            ) : (
              /* Active Call Screen */
              <>
                {/* Caller Info */}
                <div className="text-center pt-1">
                  <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-[10px] mb-1 font-mono">
                    <Radio className="w-2.5 h-2.5 animate-pulse" />
                    <span>Inbound Receiver</span>
                  </div>
                  <h4 className="text-sm font-bold text-white tracking-tight">VoiceDrop Telephony</h4>
                  <p className="text-[11px] font-mono text-slate-400">{session.from}</p>

                  {/* Status pill */}
                  <div className="mt-1.5">
                    {isRinging && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/30 animate-pulse">
                        Incoming Call...
                      </span>
                    )}
                    {isLive && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 font-mono">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span>
                        {formatTimer(callDuration)}
                      </span>
                    )}
                    {isDone && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-slate-800 text-slate-400">
                        Call Ended
                      </span>
                    )}
                  </div>
                </div>

                {/* Prompt playback / Silent Voicemail Screening banner */}
                {isLive && (
                  <div
                    className={`my-1.5 p-2 rounded-xl border text-left ${
                      session.answeredBy === 'voicemail'
                        ? 'bg-orange-950/35 border-orange-500/40'
                        : 'bg-slate-900 border-slate-800'
                    }`}
                  >
                    <div className="flex items-center justify-between text-[9px] text-slate-400 mb-0.5">
                      {session.answeredBy === 'voicemail' ? (
                        <span className="flex items-center gap-1 text-orange-300 font-semibold">
                          <Voicemail className="w-2.5 h-2.5 text-orange-400" />
                          <span>Voicemail Screening • Bot Audio Muted</span>
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-indigo-300 font-medium">
                          <Volume2 className="w-2.5 h-2.5 text-cyan-400 animate-bounce" />
                          <span>{isSpeaking ? 'Playing Voice...' : 'Human Line Active'}</span>
                        </span>
                      )}
                      <span className="font-mono text-slate-500">{session.voice}</span>
                    </div>
                    <p className="text-[11px] text-slate-200 line-clamp-2 leading-tight font-medium">
                      {session.answeredBy === 'voicemail'
                        ? 'Silent listen & recording active. Say "Hello?" below or tap Human Picks Up to start greeting.'
                        : `"${currentPromptText || session.introGreeting}"`}
                    </p>

                    {session.answeredBy === 'voicemail' && (
                      <button
                        type="button"
                        onClick={handleHumanPickupAfterVoicemail}
                        className="mt-1.5 w-full py-1 px-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold flex items-center justify-center gap-1 transition-all cursor-pointer shadow-sm"
                      >
                        <UserCheck className="w-3 h-3" />
                        <span>Human Picks Up Phone (Start Greeting)</span>
                      </button>
                    )}
                  </div>
                )}

                {/* MULTI-DIGIT CODE ENTRY BAR (Real-time typed numbers) */}
                {isLive && (
                  <div className="my-1 text-center">
                    <div className="flex items-center justify-between text-[9px] uppercase font-semibold text-slate-400 mb-1 px-1">
                      <span>Enter {targetLength}-Digit Code</span>
                      <span className="text-slate-500 font-mono">
                        {session.verificationMode === 'manual' ? 'Manual Operator' : 'Auto Match'}
                      </span>
                    </div>

                    {/* Boxed display */}
                    <div className="flex items-center justify-center gap-1 mb-1">
                      {Array.from({ length: targetLength }).map((_, idx) => {
                        const char = enteredDigits[idx] || (session.pendingDigits ? session.pendingDigits[idx] : null);
                        const isCurrent = enteredDigits.length === idx;
                        const isInvalid = attemptFeedback?.type === 'invalid';
                        const isValid = attemptFeedback?.type === 'valid';
                        const isWaiting = attemptFeedback?.type === 'waiting';

                        return (
                          <div
                            key={idx}
                            className={`w-7 h-8.5 rounded-lg border flex items-center justify-center font-mono font-bold text-base transition-all ${
                              isValid
                                ? 'bg-slate-900 border-emerald-500 text-emerald-400 shadow-sm'
                                : isInvalid
                                ? 'bg-slate-900 border-rose-500 text-rose-400 shadow-sm'
                                : isWaiting
                                ? 'bg-slate-900 border-amber-500 text-amber-300 shadow-sm'
                                : char
                                ? 'bg-slate-900 border-indigo-500 text-white shadow-sm'
                                : isCurrent
                                ? 'bg-slate-900 border-indigo-500 text-white animate-pulse'
                                : 'bg-slate-950 border-slate-800 text-slate-600'
                            }`}
                          >
                            {char || '·'}
                          </div>
                        );
                      })}
                    </div>

                    {/* Attempt feedback notification */}
                    {attemptFeedback ? (
                      <div className="flex items-center justify-center gap-1 text-[10px] font-semibold py-0.5">
                        {attemptFeedback.type === 'valid' ? (
                          <span className="text-emerald-400 flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3" />
                            <span>{attemptFeedback.message}</span>
                          </span>
                        ) : attemptFeedback.type === 'waiting' ? (
                          <span className="text-amber-300 flex items-center gap-1 animate-pulse">
                            <PauseCircle className="w-3 h-3" />
                            <span>On Hold: Waiting for operator decision...</span>
                          </span>
                        ) : attemptFeedback.type === 'invalid' ? (
                          <span className="text-rose-400 flex items-center gap-1 animate-pulse">
                            <AlertTriangle className="w-3 h-3" />
                            <span>{attemptFeedback.message} &bull; Try Again</span>
                          </span>
                        ) : (
                          <span className="text-rose-400">{attemptFeedback.message}</span>
                        )}
                      </div>
                    ) : isSubmittingCode ? (
                      <span className="text-[10px] text-indigo-400 font-semibold flex items-center justify-center gap-1">
                        <span>Submitting code...</span>
                      </span>
                    ) : (
                      <span className="text-[9px] text-slate-500">
                        Dial digits, end with <code className="text-indigo-400 font-mono font-bold">#</code>
                      </span>
                    )}
                  </div>
                )}

                {/* Recipient Interactive Dialpad */}
                {isLive && (
                  <div className="my-0.5">
                    <div className="grid grid-cols-3 gap-1 max-w-[190px] mx-auto">
                      {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((k) => (
                        <button
                          key={k}
                          type="button"
                          disabled={isSubmittingCode}
                          onClick={() => handleKeyClick(k)}
                          className="h-8.5 rounded-lg font-bold font-mono text-sm bg-slate-900 hover:bg-slate-850 active:bg-indigo-600 border border-slate-800 text-white transition-all disabled:opacity-50"
                        >
                          {k}
                        </button>
                      ))}
                    </div>

                    {/* Backspace + Mic Voice Recording Controls */}
                    <div className="flex items-center justify-center gap-1.5 mt-1">
                      <button
                        type="button"
                        onClick={handleDeleteDigit}
                        disabled={enteredDigits.length === 0 || isSubmittingCode}
                        className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-850 text-slate-300 hover:text-white border border-slate-700 text-[10px] disabled:opacity-30 cursor-pointer"
                      >
                        <Delete className="w-3 h-3" />
                        <span>Delete</span>
                      </button>

                      <button
                        type="button"
                        onClick={toggleMicRecording}
                        className={`flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-semibold transition-all cursor-pointer ${
                          isMicRecording
                            ? 'bg-rose-600/20 border-rose-500 text-rose-300 animate-pulse'
                            : 'bg-cyan-950/50 border-cyan-500/40 text-cyan-300 hover:bg-cyan-900/40'
                        }`}
                        title="Record real microphone audio & transcribe voice into Call History"
                      >
                        {isMicRecording ? (
                          <>
                            <MicOff className="w-3 h-3 text-rose-400" />
                            <span>Stop &amp; Save Mic</span>
                          </>
                        ) : (
                          <>
                            <Mic className="w-3 h-3 text-cyan-400" />
                            <span>Record Voice</span>
                          </>
                        )}
                      </button>
                    </div>

                    {/* Quick Simulated Caller Talk Input */}
                    <form onSubmit={handleSendSimulatedSpeech} className="mt-1.5 flex items-center gap-1">
                      <input
                        type="text"
                        value={simulatedSpeechInput}
                        onChange={(e) => setSimulatedSpeechInput(e.target.value)}
                        placeholder="Speak / talk on line..."
                        className="flex-1 px-2 py-1 rounded bg-slate-900 border border-slate-800 text-[10px] text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                      />
                      <button
                        type="submit"
                        disabled={!simulatedSpeechInput.trim()}
                        className="px-2 py-1 rounded bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-800 disabled:text-slate-600 text-white text-[10px] font-semibold flex items-center gap-1 cursor-pointer"
                        title="Send spoken words to call stream"
                      >
                        <Send className="w-2.5 h-2.5" />
                      </button>
                    </form>
                  </div>
                )}

                {/* Answer / Voicemail / Decline / Hangup Buttons */}
                <div className="pt-1.5 pb-1">
                  {isRinging && (
                    <div className="flex items-center justify-around">
                      <button
                        onClick={() => {
                          if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                            window.speechSynthesis.cancel();
                          }
                          onSimulateEvent('decline');
                        }}
                        className="flex flex-col items-center gap-1 cursor-pointer"
                      >
                        <div className="w-9 h-9 rounded-full bg-rose-600 hover:bg-rose-500 text-white flex items-center justify-center shadow-lg shadow-rose-600/30">
                          <PhoneOff className="w-4 h-4" />
                        </div>
                        <span className="text-[10px] text-slate-400">Decline</span>
                      </button>

                      <button
                        onClick={handleVoicemailAnswer}
                        className="flex flex-col items-center gap-1 cursor-pointer"
                        title="Simulate Voicemail Service Answering"
                      >
                        <div className="w-9 h-9 rounded-full bg-orange-600 hover:bg-orange-500 text-white flex items-center justify-center shadow-lg shadow-orange-600/30">
                          <Voicemail className="w-4 h-4" />
                        </div>
                        <span className="text-[10px] text-orange-300 font-medium">Voicemail</span>
                      </button>

                      <button
                        onClick={handleAnswerCall}
                        className="flex flex-col items-center gap-1 cursor-pointer"
                      >
                        <div className="w-9 h-9 rounded-full bg-emerald-500 hover:bg-emerald-400 text-white flex items-center justify-center shadow-lg shadow-emerald-500/40 animate-bounce">
                          <Phone className="w-4 h-4" />
                        </div>
                        <span className="text-[10px] text-emerald-400 font-semibold">Answer</span>
                      </button>
                    </div>
                  )}

                  {isLive && (
                    <div className="flex justify-center">
                      <button
                        onClick={async () => {
                          if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                            window.speechSynthesis.cancel();
                          }
                          await stopAndUploadMicRecording(session.id);
                          await onSimulateEvent('hangup');
                        }}
                        className="w-9 h-9 rounded-full bg-rose-600 hover:bg-rose-500 text-white flex items-center justify-center shadow-md cursor-pointer"
                        title="End Call"
                      >
                        <PhoneOff className="w-4 h-4" />
                      </button>
                    </div>
                  )}

                  {isDone && (
                    <div className="text-center text-xs text-slate-400">
                      <span>Call Completed</span>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Bottom Home Indicator */}
          <div className="pb-1.5 flex justify-center bg-slate-950">
            <div className="w-24 h-1 bg-slate-700 rounded-full"></div>
          </div>
        </div>
      </div>
    </div>
  );

  // If floating modal mode on small screens:
  if (!isDocked) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md">
        <div className="relative w-full max-w-sm">
          {content}
        </div>
      </div>
    );
  }

  // Embedded dock mode:
  return content;
};
