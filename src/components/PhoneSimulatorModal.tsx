import React, { useState, useEffect } from 'react';
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
} from 'lucide-react';
import { CallSession } from '../types/telephony';
import { playDtmfTone } from '../utils/audioTones';

interface PhoneSimulatorModalProps {
  session: CallSession | null;
  isOpen: boolean;
  onClose: () => void;
  onSimulateEvent: (action: string, payload?: any) => Promise<any>;
  soundEnabled: boolean;
  embedded?: boolean;
}

export const PhoneSimulatorModal: React.FC<PhoneSimulatorModalProps> = ({
  session,
  isOpen,
  onClose,
  onSimulateEvent,
  soundEnabled,
  embedded = false,
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

  // Reset state on new call session
  useEffect(() => {
    setEnteredDigits('');
    setIsSubmittingCode(false);
    setAttemptFeedback(null);
    setCurrentPromptText(session?.introGreeting || '');
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

  // Voice speech synthesis helper
  const speakText = (text: string, onEnd?: () => void) => {
    if ('speechSynthesis' in window) {
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
    }
  };

  // React to live operator audio cues triggered from the dashboard
  useEffect(() => {
    if (isOpen && session?.isSimulated && session.activeCue?.text) {
      setCurrentPromptText(session.activeCue.text);
      speakText(session.activeCue.text);
    }
  }, [session?.activeCue?.timestamp]);

  // React to operator decisions (Approve / Reject) in real time
  useEffect(() => {
    if (!isOpen || !session?.isSimulated) return;

    if (session?.operatorDecision === 'approved') {
      const msg = session.successMessage || 'Code verified successfully. Goodbye.';
      setAttemptFeedback({
        type: 'valid',
        message: `Code Verified! Valid [${session.capturedDigits || session.pendingDigits || ''}]`,
      });
      setCurrentPromptText(msg);
      speakText(msg);
    } else if (session?.operatorDecision === 'rejected') {
      const msg = session.invalidMessage || 'That code is incorrect. Please try again.';
      setAttemptFeedback({
        type: 'invalid',
        message: `Attempt ${session.attempts || 1}: Invalid Code [${session.lastInvalidDigits || ''}]`,
      });
      setCurrentPromptText(msg);
      speakText(msg);
      setTimeout(() => {
        setEnteredDigits('');
        setIsSubmittingCode(false);
      }, 1000);
    }
  }, [session?.operatorDecision, session?.attempts]);

  // Speak greeting and prompt when answered
  const handleAnswerCall = async () => {
    if (!session?.isSimulated) return;
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

  if (!embedded && (!isOpen || !session)) return null;

  if (embedded && (!session || !session.isSimulated)) {
    return (
      <section className="h-full min-h-[480px] rounded-xl border border-slate-800 bg-slate-900 p-6 flex flex-col items-center justify-center text-center">
        <div className="w-14 h-14 rounded-2xl bg-slate-950 border border-slate-800 flex items-center justify-center mb-4 text-indigo-400">
          <Radio className="w-7 h-7" />
        </div>
        <h2 className="text-sm font-bold text-white">Receiver Simulator</h2>
        <p className="mt-2 max-w-xs text-xs leading-relaxed text-slate-400">
          {session
            ? 'The receiver phone is available in Simulator mode. Switch modes or start a simulated call to interact here.'
            : 'Start a simulated call, then answer and enter a code here. The operator controls stay visible alongside this phone.'}
        </p>
      </section>
    );
  }

  if (!session) return null;

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
      const holdMsg = res.message || session.holdMessage || 'Kindly hold while your information is being processed.';
      setAttemptFeedback({
        type: 'waiting',
        message: `Code [${code}] submitted — On hold for operator review`,
      });
      setCurrentPromptText(holdMsg);
      speakText(holdMsg);
    } else if (res?.codeStatus === 'invalid') {
      const msg = res.message || session.invalidMessage || 'That code is incorrect. Please try again.';
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
      const msg = res.message || session.successMessage || 'Code verified successfully. Goodbye.';
      setAttemptFeedback({
        type: 'valid',
        message: `Code Verified! Valid [${code}]`,
      });
      setCurrentPromptText(msg);
      speakText(msg);
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

  const isRinging = session.status === 'ringing' || session.status === 'initiating' || session.status === 'queued';
  const isLive = session.status === 'in-progress' || session.status === 'collecting-input' || session.status === 'awaiting-operator';
  const isDone = session.status === 'completed' || session.status === 'failed' || session.status === 'busy';

  return (
    <div className={embedded
      ? 'h-full min-h-[480px] rounded-xl border border-slate-800 bg-slate-900 p-4 flex flex-col items-center justify-center'
      : 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md'}>
      <div className={`relative w-full ${embedded ? 'max-w-sm' : 'max-w-sm'}`}>
        {/* Close Button */}
        {!embedded && <button
          onClick={onClose}
          className="absolute -top-11 right-0 text-slate-400 hover:text-white p-2 rounded-full hover:bg-slate-800 transition-colors"
          title="Close Mockup"
        >
          <X className="w-5 h-5" />
        </button>}

        {/* Smartphone Hardware Frame */}
        <div className="relative mx-auto rounded-[38px] border-[6px] border-slate-800 bg-slate-950 shadow-2xl aspect-[9/18] flex flex-col justify-between overflow-hidden ring-1 ring-slate-700/80">
          {/* Top Notch */}
          <div className="pt-3 pb-2 flex justify-center items-center bg-slate-950">
            <div className="w-24 h-4.5 bg-black rounded-full flex items-center justify-between px-2.5 border border-slate-800">
              <span className="w-2 h-2 rounded-full bg-slate-850"></span>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
            </div>
          </div>

          {/* SCREEN CONTENT */}
          <div className="flex-1 flex flex-col justify-between px-6 py-2 overflow-y-auto">
            {/* Caller Info */}
            <div className="text-center pt-1">
              <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-[11px] mb-1 font-mono">
                <Radio className="w-3 h-3 animate-pulse" />
                <span>Simulated Target Phone</span>
              </div>
              <h3 className="text-base font-bold text-white tracking-tight">VoiceDrop Telephony</h3>
              <p className="text-xs font-mono text-slate-400">{session.from}</p>

              {/* Status pill */}
              <div className="mt-2">
                {isRinging && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/30 animate-pulse">
                    Incoming Call...
                  </span>
                )}
                {isLive && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 font-mono">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span>
                    {formatTimer(callDuration)}
                  </span>
                )}
                {isDone && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-0.5 rounded-full bg-slate-800 text-slate-400">
                    Call Finished
                  </span>
                )}
              </div>
            </div>

            {/* Prompt playback banner (displays pickup greeting, code prompt, hold message, or operator cue) */}
            {isLive && (
              <div className="my-1.5 p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-left">
                <div className="flex items-center justify-between text-[10px] text-slate-400 mb-1">
                  <span className="flex items-center gap-1 text-indigo-300 font-medium">
                    <Volume2 className="w-3 h-3 text-cyan-400 animate-bounce" />
                    <span>{isSpeaking ? 'Voice Playing...' : 'Voice Line Active'}</span>
                  </span>
                  <span className="text-[10px] font-mono text-slate-500">{session.voice}</span>
                </div>
                <p className="text-[11px] text-slate-200 line-clamp-3 leading-tight font-medium">
                  "{currentPromptText || session.introGreeting}"
                </p>
              </div>
            )}

            {/* MULTI-DIGIT CODE ENTRY BAR (Real-time typed numbers) */}
            {isLive && (
              <div className="my-1 text-center">
                <div className="flex items-center justify-between text-[10px] uppercase font-semibold text-slate-400 mb-1 px-1">
                  <span>Enter {targetLength}-Digit Code</span>
                  <span className="text-slate-500 font-mono">
                    {session.verificationMode === 'manual' ? 'Manual Operator' : 'Auto Match'}
                  </span>
                </div>

                {/* Boxed display */}
                <div className="flex items-center justify-center gap-1.5 mb-1.5">
                  {Array.from({ length: targetLength }).map((_, idx) => {
                    const char = enteredDigits[idx] || (session.pendingDigits ? session.pendingDigits[idx] : null);
                    const isCurrent = enteredDigits.length === idx;
                    const isInvalid = attemptFeedback?.type === 'invalid';
                    const isValid = attemptFeedback?.type === 'valid';
                    const isWaiting = attemptFeedback?.type === 'waiting';

                    return (
                      <div
                        key={idx}
                        className={`w-8 h-9 rounded-lg border flex items-center justify-center font-mono font-bold text-lg transition-all ${
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
                  <div className="flex items-center justify-center gap-1.5 text-[11px] font-semibold py-0.5">
                    {attemptFeedback.type === 'valid' ? (
                      <span className="text-emerald-400 flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>{attemptFeedback.message}</span>
                      </span>
                    ) : attemptFeedback.type === 'waiting' ? (
                      <span className="text-amber-300 flex items-center gap-1 animate-pulse">
                        <PauseCircle className="w-3.5 h-3.5" />
                        <span>On Hold: Waiting for operator decision...</span>
                      </span>
                    ) : attemptFeedback.type === 'invalid' ? (
                      <span className="text-rose-400 flex items-center gap-1 animate-pulse">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        <span>{attemptFeedback.message} &bull; Try Again</span>
                      </span>
                    ) : (
                      <span className="text-rose-400">{attemptFeedback.message}</span>
                    )}
                  </div>
                ) : isSubmittingCode ? (
                  <span className="text-[11px] text-indigo-400 font-semibold flex items-center justify-center gap-1">
                    <span>Submitting code...</span>
                  </span>
                ) : (
                  <span className="text-[10px] text-slate-500">
                    Press numbers, terminate with <code className="text-indigo-400 font-mono font-bold">#</code>
                  </span>
                )}
              </div>
            )}

            {/* Recipient Interactive Dialpad */}
            {isLive && (
              <div className="my-1">
                <div className="grid grid-cols-3 gap-1.5 max-w-[210px] mx-auto">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((k) => (
                    <button
                      key={k}
                      type="button"
                      disabled={isSubmittingCode}
                      onClick={() => handleKeyClick(k)}
                      className="h-10 rounded-lg font-bold font-mono text-base bg-slate-900 hover:bg-slate-850 active:bg-indigo-600 border border-slate-800 text-white transition-all disabled:opacity-50"
                    >
                      {k}
                    </button>
                  ))}
                </div>

                {/* Backspace row */}
                <div className="flex justify-center mt-1.5">
                  <button
                    type="button"
                    onClick={handleDeleteDigit}
                    disabled={enteredDigits.length === 0 || isSubmittingCode}
                    className="flex items-center gap-1 px-3 py-1 rounded bg-slate-850 text-slate-300 hover:text-white border border-slate-700 text-xs disabled:opacity-30"
                  >
                    <Delete className="w-3.5 h-3.5" />
                    <span>Delete</span>
                  </button>
                </div>
              </div>
            )}

            {/* Answer / Decline Buttons */}
            <div className="pt-2 pb-1">
              {isRinging && (
                <div className="flex items-center justify-around">
                  <button
                    onClick={() => onSimulateEvent('decline')}
                    className="flex flex-col items-center gap-1"
                  >
                    <div className="w-12 h-12 rounded-full bg-rose-600 hover:bg-rose-500 text-white flex items-center justify-center shadow-lg shadow-rose-600/30">
                      <PhoneOff className="w-5 h-5" />
                    </div>
                    <span className="text-[11px] text-slate-400">Decline</span>
                  </button>

                  <button
                    onClick={handleAnswerCall}
                    className="flex flex-col items-center gap-1"
                  >
                    <div className="w-12 h-12 rounded-full bg-emerald-500 hover:bg-emerald-400 text-white flex items-center justify-center shadow-lg shadow-emerald-500/40 animate-bounce">
                      <Phone className="w-5 h-5" />
                    </div>
                    <span className="text-[11px] text-emerald-400 font-semibold">Answer</span>
                  </button>
                </div>
              )}

              {isLive && (
                <div className="flex justify-center">
                  <button
                    onClick={() => onSimulateEvent('hangup')}
                    className="w-11 h-11 rounded-full bg-rose-600 hover:bg-rose-500 text-white flex items-center justify-center shadow-md"
                    title="End Call"
                  >
                    <PhoneOff className="w-5 h-5" />
                  </button>
                </div>
              )}

              {isDone && (
                <div className="text-center">
                  {embedded ? (
                    <span className="text-xs text-slate-400">Session finished</span>
                  ) : (
                    <button
                      onClick={onClose}
                      className="px-4 py-1.5 bg-slate-850 hover:bg-slate-800 text-slate-200 rounded-lg text-xs font-semibold"
                    >
                      Close Screen
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Bottom Bar */}
          <div className="pb-2 flex justify-center bg-slate-950">
            <div className="w-28 h-1 bg-slate-700 rounded-full"></div>
          </div>
        </div>
      </div>
    </div>
  );
};
