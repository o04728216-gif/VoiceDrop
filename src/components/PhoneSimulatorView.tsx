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
} from 'lucide-react';
import { CallSession } from '../types/telephony';
import { playDtmfTone } from '../utils/audioTones';

interface PhoneSimulatorViewProps {
  session: CallSession | null;
  onSimulateEvent: (action: string, payload?: any) => Promise<any>;
  soundEnabled: boolean;
  isDocked?: boolean;
  onClose?: () => void;
  onToggleDock?: () => void;
}

// Global memory across unmounts / tab switches so switching tabs never replays speech
const globallySpokenDecisions = new Set<string>();
const globallySpokenCues = new Set<string>();

const TERMINAL_STATUSES = ['completed', 'failed', 'busy', 'no-answer'];

export const PhoneSimulatorView: React.FC<PhoneSimulatorViewProps> = ({
  session,
  onSimulateEvent,
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

  const targetLength = session?.numDigits || 6;
  const lastSpokenDecisionRef = useRef<string | null>(null);
  const lastSpeakCallTimeRef = useRef<{ text: string; time: number } | null>(null);
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;

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
    setCurrentPromptText(session?.introGreeting || '');
    lastSpeakCallTimeRef.current = null;

    if (session?.id) {
      const isTerminal = TERMINAL_STATUSES.includes(session.status);
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
      interval = setInterval(() => {
        setCallDuration((prev) => prev + 1);
      }, 1000);
    } else {
      setCallDuration(0);
    }
    return () => clearInterval(interval);
  }, [session?.status]);

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

  // Speak greeting and prompt when answered
  const handleAnswerCall = async () => {
    await onSimulateEvent('answer');

    if (session) {
      // Step 1: Speak immediate greeting upon pickup
      setCurrentPromptText(session.introGreeting);
      speakText(session.introGreeting, () => {
        // Step 2: Speak code collection prompt
        setCurrentPromptText(session.script);
        speakText(session.script);
      });
    }
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

    if (key === '#') {
      if (enteredDigits.length > 0) {
        submitFullCode(enteredDigits);
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
    } else if (res?.codeStatus === 'max_exceeded') {
      const msg = res.message || 'Maximum attempts exceeded. Goodbye.';
      setAttemptFeedback({
        type: 'max',
        message: `Max attempts exceeded. Call ending.`,
      });
      setCurrentPromptText(msg);
      speakText(msg);
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

                {/* Prompt playback banner (displays pickup greeting, code prompt, hold message, or operator cue) */}
                {isLive && (
                  <div className="my-1.5 p-2 rounded-xl bg-slate-900 border border-slate-800 text-left">
                    <div className="flex items-center justify-between text-[9px] text-slate-400 mb-0.5">
                      <span className="flex items-center gap-1 text-indigo-300 font-medium">
                        <Volume2 className="w-2.5 h-2.5 text-cyan-400 animate-bounce" />
                        <span>{isSpeaking ? 'Playing Voice...' : 'Line Connected'}</span>
                      </span>
                      <span className="font-mono text-slate-500">{session.voice}</span>
                    </div>
                    <p className="text-[11px] text-slate-200 line-clamp-2 leading-tight font-medium">
                      "{currentPromptText || session.introGreeting}"
                    </p>
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

                    {/* Backspace row */}
                    <div className="flex justify-center mt-1">
                      <button
                        type="button"
                        onClick={handleDeleteDigit}
                        disabled={enteredDigits.length === 0 || isSubmittingCode}
                        className="flex items-center gap-1 px-2.5 py-0.5 rounded bg-slate-850 text-slate-300 hover:text-white border border-slate-700 text-[11px] disabled:opacity-30"
                      >
                        <Delete className="w-3 h-3" />
                        <span>Delete</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* Answer / Decline / Hangup Buttons */}
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
                        <div className="w-10 h-10 rounded-full bg-rose-600 hover:bg-rose-500 text-white flex items-center justify-center shadow-lg shadow-rose-600/30">
                          <PhoneOff className="w-4 h-4" />
                        </div>
                        <span className="text-[10px] text-slate-400">Decline</span>
                      </button>

                      <button
                        onClick={handleAnswerCall}
                        className="flex flex-col items-center gap-1 cursor-pointer"
                      >
                        <div className="w-10 h-10 rounded-full bg-emerald-500 hover:bg-emerald-400 text-white flex items-center justify-center shadow-lg shadow-emerald-500/40 animate-bounce">
                          <Phone className="w-4 h-4" />
                        </div>
                        <span className="text-[10px] text-emerald-400 font-semibold">Answer</span>
                      </button>
                    </div>
                  )}

                  {isLive && (
                    <div className="flex justify-center">
                      <button
                        onClick={() => {
                          if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                            window.speechSynthesis.cancel();
                          }
                          onSimulateEvent('hangup');
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
