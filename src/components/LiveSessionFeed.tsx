import React, { useRef, useEffect, useState } from 'react';
import {
  Activity,
  PhoneOff,
  Volume2,
  CheckCircle2,
  Clock,
  Radio,
  FileCode,
  Copy,
  Check,
  Smartphone,
  AlertTriangle,
  KeyRound,
  ShieldCheck,
  RotateCcw,
  PauseCircle,
  Send,
  Voicemail,
  UserCheck,
  Mic,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { CallSession, CallStatus } from '../types/telephony';
import { CompactAudioPlayer, formatAudioBytes } from './CompactAudioPlayer';

const celebratedSessions = new Set<string>();

interface LiveSessionFeedProps {
  session: CallSession | null;
  onEndCall: () => void;
  onOpenSimulator: () => void;
  onOperatorAction?: (
    action:
      | 'approve'
      | 'reject'
      | 'hold'
      | 'incorrect_prompt'
      | 'custom_cue'
      | 'start_human_greeting',
    customMessage?: string
  ) => Promise<any>;
}

export const LiveSessionFeed: React.FC<LiveSessionFeedProps> = ({
  session,
  onEndCall,
  onOpenSimulator,
  onOperatorAction,
}) => {
  const [copied, setCopied] = useState(false);
  const [showTwimlModal, setShowTwimlModal] = useState(false);
  const [customCueText, setCustomCueText] = useState('');
  const [isSendingCue, setIsSendingCue] = useState(false);
  const eventsEndRef = useRef<HTMLDivElement>(null);

  // Pre-register already-completed sessions on mount/load so historical records don't fire confetti
  useEffect(() => {
    if (
      session?.id &&
      (session.status === 'completed' || session.codeStatus === 'valid')
    ) {
      celebratedSessions.add(session.id);
    }
  }, [session?.id]);

  // Trigger celebration confetti once when multi-digit code transitions to valid
  useEffect(() => {
    if (!session?.id) return;
    if (session.codeStatus === 'valid' && !celebratedSessions.has(session.id)) {
      celebratedSessions.add(session.id);
      try {
        confetti({
          particleCount: 45,
          spread: 60,
          origin: { y: 0.6 },
          colors: ['#4f46e5', '#10b981', '#06b6d4'],
        });
      } catch (e) {
        // Fallback
      }
    }
  }, [session?.id, session?.codeStatus]);

  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session?.events]);

  const copyTranscript = () => {
    if (!session) return;
    const lines = session.events.map(
      (e) => `[${new Date(e.timestamp).toLocaleTimeString()}] ${e.title}: ${e.description}`
    );
    navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSendCustomCue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customCueText.trim() || !onOperatorAction) return;
    try {
      setIsSendingCue(true);
      await onOperatorAction('custom_cue', customCueText.trim());
      setCustomCueText('');
    } catch (err) {
      console.error(err);
    } finally {
      setIsSendingCue(false);
    }
  };

  const getStatusBadge = (status: CallStatus) => {
    switch (status) {
      case 'ringing':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-300 border border-amber-500/30">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping"></span>
            Ringing Recipient
          </span>
        );
      case 'initiating':
      case 'queued':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-cyan-500/10 text-cyan-400 border border-cyan-500/30">
            <Activity className="w-3.5 h-3.5 animate-spin" />
            Connecting Route...
          </span>
        );
      case 'in-progress':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 font-bold">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            Call Connected
          </span>
        );
      case 'collecting-input':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-indigo-500/10 text-indigo-300 border border-indigo-500/30">
            <Radio className="w-3.5 h-3.5 animate-pulse text-indigo-400" />
            Awaiting Code Keypress
          </span>
        );
      case 'awaiting-operator':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold animate-pulse">
            <PauseCircle className="w-3.5 h-3.5 text-amber-400" />
            Caller On Hold (Your Decision)
          </span>
        );
      case 'completed':
        return session?.codeStatus === 'valid' ? (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-bold">
            <CheckCircle2 className="w-3.5 h-3.5" />
            Verified &amp; Completed
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-slate-800 text-slate-300 border border-slate-700">
            <PhoneOff className="w-3.5 h-3.5 text-slate-400" />
            Call Ended
          </span>
        );
      case 'failed':
      case 'busy':
      case 'no-answer':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/30">
            <AlertTriangle className="w-3.5 h-3.5" />
            {session?.codeStatus === 'max_exceeded'
              ? 'Max Retries Exceeded'
              : status === 'busy'
              ? 'Line Busy'
              : status === 'no-answer'
              ? 'No Answer'
              : 'Failed'}
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-slate-800 text-slate-400">
            Standby
          </span>
        );
    }
  };

  const isCallActive = Boolean(
    session &&
      ['queued', 'initiating', 'ringing', 'in-progress', 'collecting-input', 'awaiting-operator'].includes(
        session.status
      )
  );

  const expectedLength = session?.numDigits || 6;
  const pendingCode = session?.pendingDigits;
  const captured = session?.capturedDigits || '';
  const displayDigits = pendingCode || captured || session?.lastInvalidDigits || '';

  const isAwaitingOperator = session?.status === 'awaiting-operator';
  const isValidState = session?.codeStatus === 'valid';
  const isInvalidState = session?.codeStatus === 'invalid' && Boolean(session?.attempts);
  const hasInputtedCode = Boolean(
    session?.pendingDigits ||
      session?.capturedDigits ||
      session?.lastInvalidDigits ||
      session?.status === 'awaiting-operator'
  );
  const isVoicemailMuted = session?.answeredBy === 'voicemail';
  const speechTranscripts = session?.speechTranscripts || [];

  const carrierXmlLabel =
    session?.carrier === 'plivo'
      ? 'Plivo XML'
      : session?.carrier === 'telnyx'
      ? 'TeXML'
      : session?.carrier === 'signalwire'
      ? 'LAML'
      : session?.carrier === 'fonoster'
      ? 'Voice XML'
      : 'TwiML';

  const carrierGatherPath =
    session?.carrier === 'plivo'
      ? '/api/plivo/gather'
      : session?.carrier === 'telnyx'
      ? '/api/telnyx/gather'
      : session?.carrier === 'signalwire'
      ? '/api/signalwire/gather'
      : session?.carrier === 'fonoster'
      ? '/api/fonoster/gather'
      : '/api/twiml/gather';

  return (
    <div className="flex flex-col h-full bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
      {/* Session Top Bar */}
      <div className="p-4 border-b border-slate-800 bg-slate-900/80 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
            <Activity className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-white tracking-tight">
                Live Operator Control Console
              </h2>
              {session && (
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
                  {session.id.slice(0, 14)}...
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400">
              {session
                ? `Target: ${session.to} • Mode: ${
                    session.verificationMode === 'manual'
                      ? 'Manual Operator Authority (You Control)'
                      : 'Auto Match'
                  }`
                : 'Awaiting outbound call launch'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {session?.answeredBy === 'voicemail' && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-orange-500/15 text-orange-300 border border-orange-500/40">
              <Voicemail className="w-3.5 h-3.5 text-orange-400" />
              <span>Voicemail (Prompts Muted)</span>
            </span>
          )}
          {session?.answeredBy === 'human' && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
              <UserCheck className="w-3.5 h-3.5 text-emerald-400" />
              <span>
                {session.humanPickedUpAfterVoicemail
                  ? 'Human Picked Up (After VM)'
                  : 'Human Answered'}
              </span>
            </span>
          )}
          {isCallActive && session?.recordCall !== false && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono font-bold bg-rose-500/10 text-rose-300 border border-rose-500/30">
              <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping"></span>
              <span>REC</span>
            </span>
          )}

          {session && getStatusBadge(session.status)}

          {isCallActive && (
            <button
              onClick={onEndCall}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold transition-all shadow-sm"
              title="Hangup Call"
            >
              <PhoneOff className="w-3.5 h-3.5" />
              <span>End Call</span>
            </button>
          )}

          {session?.isSimulated && isCallActive && (
            <button
              onClick={onOpenSimulator}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-all shadow-sm shadow-indigo-600/20 animate-pulse"
              title="Open Recipient Phone"
            >
              <Smartphone className="w-3.5 h-3.5" />
              <span>Open Phone</span>
            </button>
          )}
        </div>
      </div>

      {!session ? (
        /* Standby state */
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-slate-400">
          <div className="w-14 h-14 rounded-2xl bg-slate-950 border border-slate-800 flex items-center justify-center mb-3 text-indigo-400">
            <KeyRound className="w-7 h-7 opacity-80" />
          </div>
          <h3 className="text-sm font-semibold text-slate-200 mb-1">
            No Active Code Collection Session
          </h3>
          <p className="text-xs text-slate-400 max-w-sm leading-relaxed mb-6">
            Configure your target, launch the call, and use the live buttons to control whether the code is approved, rejected, or put on hold.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-xl text-left w-full">
            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
              <span className="text-[10px] uppercase font-bold text-indigo-400">Control 1</span>
              <p className="text-xs text-slate-200 font-medium mt-1">Manual Authority</p>
              <p className="text-[11px] text-slate-500 mt-0.5">You decide if code is correct</p>
            </div>
            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
              <span className="text-[10px] uppercase font-bold text-amber-400">Control 2</span>
              <p className="text-xs text-slate-200 font-medium mt-1">Hold &amp; Cue Buttons</p>
              <p className="text-[11px] text-slate-500 mt-0.5">Say "Kindly hold" or "Incorrect"</p>
            </div>
            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
              <span className="text-[10px] uppercase font-bold text-emerald-400">Control 3</span>
              <p className="text-xs text-slate-200 font-medium mt-1">Speak Custom Audio</p>
              <p className="text-[11px] text-slate-500 mt-0.5">Type any message to caller</p>
            </div>
          </div>
        </div>
      ) : (
        /* Active session view */
        <div className="flex-1 flex flex-col p-4 gap-4 overflow-y-auto">
          {/* VOICEMAIL / ANSWERING MACHINE ALERT BANNER */}
          {session.answeredBy === 'voicemail' && (
            <div className="p-3.5 rounded-xl bg-orange-950/40 border border-orange-500/50 flex flex-wrap items-center justify-between gap-3 shadow-sm">
              <div className="flex items-start gap-2.5 max-w-2xl">
                <div className="p-2 rounded-lg bg-orange-500/20 text-orange-300 shrink-0">
                  <Voicemail className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-orange-200 uppercase tracking-wide">
                    Voicemail Machine Detected — Bot Greetings &amp; Prompts Muted
                  </h4>
                  <p className="text-xs text-orange-300/90 mt-0.5 leading-snug">
                    Automated voicemail{session.amdRawResult ? ` (${session.amdRawResult})` : ''} answered. Spoken messages will NEVER play to the machine, while voice/DTMF listening &amp; recording remain active from 0:00. If a live human picks up the phone, immediate pickup greeting starts automatically.
                  </p>
                </div>
              </div>

              {isCallActive && (
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => onOperatorAction?.('start_human_greeting')}
                    className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer shadow-sm"
                    title="Override and start playing greeting if you hear a live human pick up"
                  >
                    <UserCheck className="w-3.5 h-3.5" />
                    <span>Human Picked Up — Play Greeting</span>
                  </button>

                  <button
                    type="button"
                    onClick={onEndCall}
                    className="px-3 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer shadow-sm"
                  >
                    <PhoneOff className="w-3.5 h-3.5" />
                    <span>Hang Up Voicemail</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* POST-VOICEMAIL LIVE HUMAN PICKUP BANNER */}
          {session.answeredBy === 'human' && session.humanPickedUpAfterVoicemail && (
            <div className="p-3 rounded-xl bg-emerald-950/40 border border-emerald-500/40 flex items-center gap-2.5 text-xs text-emerald-200">
              <UserCheck className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>
                <strong className="text-emerald-300">Live Human Picked Up After Voicemail:</strong> Immediate pickup greeting &amp; code prompt started automatically while continuing full-call recording.
              </span>
            </div>
          )}

          {/* Audio Waveform bar */}
          {isCallActive && (
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 flex items-center justify-between">
              <div className="flex items-center gap-2.5 text-xs text-slate-300">
                <Volume2 className="w-4 h-4 text-cyan-400 animate-pulse" />
                <span className="font-medium">
                  {session.status === 'ringing'
                    ? 'Ringing recipient line...'
                    : session.answeredBy === 'voicemail'
                    ? 'Voicemail screening active — bot prompts muted, listening & recording for live human pickup...'
                    : session.status === 'awaiting-operator'
                    ? 'Caller is on hold & listening for voice while awaiting your decision...'
                    : !session.promptsStarted
                    ? 'Listening & recording from 0:00 — verifying live human before speaking greeting...'
                    : 'Live human verified — greeting & prompts active, listening for keypad & speech...'}
                </span>
              </div>

              <div className="flex items-center gap-1 h-5">
                {[
                  'h-1.5',
                  'h-3.5',
                  'h-4',
                  'h-2.5',
                  'h-5',
                  'h-3',
                  'h-4',
                  'h-2',
                  'h-5',
                  'h-3.5',
                  'h-2',
                ].map((heightClass, i) => (
                  <span
                    key={i}
                    className={`w-1 ${heightClass} ${
                      session.answeredBy === 'voicemail' ? 'bg-orange-400/70' : 'bg-indigo-500'
                    } rounded-full animate-pulse`}
                  ></span>
                ))}
              </div>
            </div>
          )}

          {/* REAL-TIME DIGIT DISPLAY (PIN / OTP BOXES) */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-5 text-center">
            <div className="flex items-center justify-between mb-3 text-xs text-slate-400">
              <div className="flex items-center gap-2">
                <span className="font-semibold uppercase tracking-wider text-slate-300">
                  Keypad Code Stream ({expectedLength} Digits)
                </span>
                {session.expectedCode && (
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-950/60 text-emerald-400 border border-emerald-500/30 font-semibold flex items-center gap-1">
                    <ShieldCheck className="w-3 h-3" />
                    <span>Reference: [{session.expectedCode}]</span>
                  </span>
                )}
              </div>

              <span className="font-mono text-xs">
                {session.attempts ? (
                  <span className="text-amber-400 font-semibold flex items-center gap-1">
                    <RotateCcw className="w-3 h-3" />
                    <span>Attempt {session.attempts}/{session.maxAttempts || 3}</span>
                  </span>
                ) : isAwaitingOperator ? (
                  <span className="text-amber-400 font-bold animate-pulse">Decision Pending</span>
                ) : (
                  <span>Awaiting Input</span>
                )}
              </span>
            </div>

            {/* Digit Boxes */}
            <div className="flex items-center justify-center gap-2 sm:gap-3 py-2">
              {Array.from({ length: expectedLength }).map((_, i) => {
                const digit = displayDigits[i];
                const isNext = displayDigits.length === i && isCallActive && !isAwaitingOperator;

                return (
                  <div
                    key={i}
                    className={`w-12 h-14 sm:w-14 sm:h-16 rounded-xl border flex items-center justify-center font-mono text-2xl sm:text-3xl font-bold transition-all ${
                      isValidState
                        ? 'bg-slate-900 border-emerald-500 text-emerald-400 shadow-md shadow-emerald-500/10'
                        : isAwaitingOperator
                        ? 'bg-slate-900 border-amber-500 text-amber-300 shadow-lg shadow-amber-500/20 ring-2 ring-amber-500/30'
                        : isInvalidState && digit
                        ? 'bg-slate-900 border-rose-500 text-rose-400 shadow-md shadow-rose-500/10'
                        : digit
                        ? 'bg-slate-900 border-indigo-500 text-white shadow-md'
                        : isNext
                        ? 'bg-slate-900/60 border-indigo-500 ring-2 ring-indigo-500/30 text-slate-600 animate-pulse'
                        : 'bg-slate-900/30 border-slate-800 text-slate-700'
                    }`}
                  >
                    {digit || (isNext ? '•' : '—')}
                  </div>
                );
              })}
            </div>

            {/* Result status banner */}
            <div className="mt-3">
              {isValidState ? (
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-xs font-bold">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Code Approved: [{captured || pendingCode}] &bull; Confirmation Message Spoken</span>
                </div>
              ) : isAwaitingOperator ? (
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 text-xs font-bold animate-pulse">
                  <PauseCircle className="w-4 h-4" />
                  <span>Caller Entered [{pendingCode}] &bull; Waiting for your decision below</span>
                </div>
              ) : isInvalidState ? (
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/30 text-xs font-semibold animate-pulse">
                  <AlertTriangle className="w-4 h-4" />
                  <span>
                    Attempt {session.attempts}: Code Marked Incorrect &bull; Retry Voice Prompt Playing
                  </span>
                </div>
              ) : isCallActive ? (
                <span className="text-xs text-slate-400">
                  Recipient is on the call. Waiting for {expectedLength}-digit keypad input...
                </span>
              ) : (
                <span className="text-xs text-slate-500">
                  Call ended. Final: {captured || 'None'}
                </span>
              )}
            </div>
          </div>

          {/* PRIMARY OPERATOR DECISION DECK (Approve / Reject) */}
          {isCallActive && isAwaitingOperator && (
            <div className="p-4 rounded-xl bg-slate-950 border-2 border-indigo-500 shadow-xl space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-amber-400 animate-ping"></span>
                  <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                    Caller Entered Code: <span className="font-mono text-amber-300 text-sm">[{pendingCode}]</span>
                  </h3>
                </div>
                <span className="text-[11px] font-mono font-semibold px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                  Caller Waiting on Hold
                </span>
              </div>

              <p className="text-xs text-slate-300 leading-relaxed">
                You have manual authority over this call. Choose whether to accept the code or reject it and ask the caller to try again:
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => onOperatorAction?.('approve')}
                  className="py-3 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs uppercase flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/30 transition-all cursor-pointer active:scale-[0.98]"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Approve (Code Correct)</span>
                </button>

                <button
                  type="button"
                  onClick={() => onOperatorAction?.('reject')}
                  className="py-3 px-4 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs uppercase flex items-center justify-center gap-2 shadow-lg shadow-rose-600/30 transition-all cursor-pointer active:scale-[0.98]"
                >
                  <AlertTriangle className="w-4 h-4" />
                  <span>Reject (Code Incorrect &bull; Retry)</span>
                </button>
              </div>
            </div>
          )}

          {/* LIVE CALL AUDIO INFLUENCER & CANNED SPEECH TRIGGERS */}
          {isCallActive && (
            <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Volume2 className="w-4 h-4 text-indigo-400" />
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-200">
                    Influence Call Audio (Canned Speech Triggers)
                  </h4>
                </div>
                <span className="text-[10px] text-slate-500 font-mono">Real-time TTS triggers</span>
              </div>

              {isVoicemailMuted && (
                <div className="p-2.5 rounded-lg bg-orange-950/30 border border-orange-500/30 text-[11px] text-orange-200 flex items-center justify-between gap-2">
                  <span>
                    Spoken prompts are muted so nothing plays into the Voicemail Machine. Controls unlock automatically as soon as a live human picks up.
                  </span>
                </div>
              )}

              {/* Quick Canned Audio Buttons */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button
                  type="button"
                  disabled={!hasInputtedCode || isVoicemailMuted}
                  onClick={() => onOperatorAction?.('hold')}
                  className={`py-2 px-3 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1.5 transition-all shadow-sm ${
                    hasInputtedCode && !isVoicemailMuted
                      ? 'bg-slate-900 hover:bg-slate-850 border-slate-700 text-amber-300 cursor-pointer active:scale-[0.98]'
                      : 'bg-slate-900/40 border-slate-800/80 text-slate-600 cursor-not-allowed'
                  }`}
                  title={
                    isVoicemailMuted
                      ? 'Muted while Voicemail Machine is on the line'
                      : hasInputtedCode
                      ? "Speaks 'Kindly hold while your information is being processed.'"
                      : 'Only plays AFTER keypad code is inputted by caller'
                  }
                >
                  <PauseCircle
                    className={`w-3.5 h-3.5 ${
                      hasInputtedCode && !isVoicemailMuted ? 'text-amber-400' : 'text-slate-600'
                    }`}
                  />
                  <span>{hasInputtedCode ? '"Kindly Hold / Please Wait"' : 'Hold (After Code Input)'}</span>
                </button>

                <button
                  type="button"
                  disabled={isVoicemailMuted}
                  onClick={() => onOperatorAction?.('incorrect_prompt')}
                  className={`py-2 px-3 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1.5 transition-all shadow-sm ${
                    !isVoicemailMuted
                      ? 'bg-slate-900 hover:bg-slate-850 border-slate-700 text-rose-300 cursor-pointer active:scale-[0.98]'
                      : 'bg-slate-900/40 border-slate-800/80 text-slate-600 cursor-not-allowed'
                  }`}
                  title={
                    isVoicemailMuted
                      ? 'Muted while Voicemail Machine is on the line'
                      : "Speaks 'The code entered is incorrect. Please try again.'"
                  }
                >
                  <AlertTriangle
                    className={`w-3.5 h-3.5 ${!isVoicemailMuted ? 'text-rose-400' : 'text-slate-600'}`}
                  />
                  <span>"Password / Code Incorrect"</span>
                </button>

                <button
                  type="button"
                  disabled={isVoicemailMuted}
                  onClick={() => onOperatorAction?.('custom_cue', session.script)}
                  className={`py-2 px-3 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1.5 transition-all shadow-sm ${
                    !isVoicemailMuted
                      ? 'bg-slate-900 hover:bg-slate-850 border-slate-700 text-indigo-300 cursor-pointer active:scale-[0.98]'
                      : 'bg-slate-900/40 border-slate-800/80 text-slate-600 cursor-not-allowed'
                  }`}
                  title={
                    isVoicemailMuted
                      ? 'Muted while Voicemail Machine is on the line'
                      : 'Repeats the original code collection prompt'
                  }
                >
                  <RotateCcw
                    className={`w-3.5 h-3.5 ${!isVoicemailMuted ? 'text-indigo-400' : 'text-slate-600'}`}
                  />
                  <span>"Repeat Code Request"</span>
                </button>
              </div>

              {/* Custom Spoken Text Broadcaster ("Say to Caller Now") */}
              <form onSubmit={handleSendCustomCue} className="pt-1">
                <label className="text-[11px] font-semibold text-slate-300 block mb-1">
                  Say Custom Message to Caller Now
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    disabled={isVoicemailMuted}
                    value={customCueText}
                    onChange={(e) => setCustomCueText(e.target.value)}
                    placeholder={
                      isVoicemailMuted
                        ? 'Bot speech muted for Voicemail until a live human picks up...'
                        : "Type anything you want the caller to hear (e.g. 'One moment, checking records')..."
                    }
                    className="flex-1 py-1.5 px-3 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                  />
                  <button
                    type="submit"
                    disabled={!customCueText.trim() || isSendingCue || isVoicemailMuted}
                    className="py-1.5 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white font-semibold text-xs flex items-center gap-1.5 shrink-0 transition-all cursor-pointer shadow-sm"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Speak to Caller</span>
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* LIVE VOICE & TALKS TRANSCRIPT + CALL RECORDING PLAYBACK */}
          {(isCallActive ||
            speechTranscripts.length > 0 ||
            session.capturedSpeech ||
            session.recordingUrl ||
            session.recordingStatus === 'recording') && (
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-3.5 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-800">
                <div className="flex items-center gap-2">
                  <Mic className="w-3.5 h-3.5 text-cyan-400" />
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-200">
                    Caller Voice &amp; Talks + HD Audio Recording
                  </h4>
                </div>
                <span className="text-[10px] font-mono text-slate-400">
                  {session.recordingUrl
                    ? `HD Audio Ready${
                        session.recordingDuration ? ` (${session.recordingDuration}s)` : ''
                      }${
                        formatAudioBytes(session.recordingSizeBytes)
                          ? ` • ${formatAudioBytes(session.recordingSizeBytes)}`
                          : ''
                      }`
                    : isCallActive
                    ? 'Listening & Recording Line...'
                    : session.recordingStatus === 'recording'
                    ? 'Finalizing HD Audio...'
                    : `${speechTranscripts.length} utterance${speechTranscripts.length === 1 ? '' : 's'}`}
                </span>
              </div>

              {/* Spoken Voice Transcripts */}
              {speechTranscripts.length > 0 ? (
                <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1">
                  {speechTranscripts.map((item) => (
                    <div
                      key={item.id}
                      className="p-2 rounded-lg bg-cyan-950/25 border border-cyan-500/25 text-xs flex items-start justify-between gap-2"
                    >
                      <div className="text-cyan-200">
                        <span className="font-semibold text-cyan-400 mr-1.5">Caller:</span>
                        <span>"{item.text}"</span>
                      </div>
                      <span className="text-[10px] font-mono text-slate-500 shrink-0">
                        {new Date(item.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
              ) : session.capturedSpeech ? (
                <div className="p-2 rounded-lg bg-cyan-950/25 border border-cyan-500/25 text-xs text-cyan-200">
                  <span className="font-semibold text-cyan-400 mr-1.5">Caller:</span>
                  <span>"{session.capturedSpeech}"</span>
                </div>
              ) : isCallActive ? (
                <p className="text-xs text-slate-500 italic">
                  Listening for spoken words from recipient... Any speech or talks will appear here live.
                </p>
              ) : null}

              {/* Playable Call Recording Bar */}
              {session.recordingUrl ? (
                <div className="pt-1.5 border-t border-slate-800/80">
                  <CompactAudioPlayer
                    src={session.recordingUrl}
                    durationHint={session.recordingDuration || session.duration}
                    sizeBytes={session.recordingSizeBytes}
                  />
                </div>
              ) : !isCallActive && session.recordingStatus === 'recording' ? (
                <div className="pt-1.5 border-t border-slate-800/80 flex items-center gap-2 text-[11px] font-mono text-amber-300">
                  <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping"></span>
                  <span>Grabbing &amp; optimizing HD call recording...</span>
                </div>
              ) : null}
            </div>
          )}

          {/* Event Stream Log */}
          <div className="flex-1 flex flex-col bg-slate-950 border border-slate-800 rounded-xl p-4 min-h-[180px]">
            <div className="flex items-center justify-between mb-2.5 pb-2 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <Clock className="w-3.5 h-3.5 text-indigo-400" />
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                  Live Event Stream
                </h4>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={copyTranscript}
                  className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200 transition-colors"
                >
                  {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  <span>{copied ? 'Copied' : 'Copy'}</span>
                </button>
                <button
                  onClick={() => setShowTwimlModal(true)}
                  className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200 transition-colors"
                >
                  <FileCode className="w-3 h-3 text-indigo-400" />
                  <span>{carrierXmlLabel}</span>
                </button>
              </div>
            </div>

            <div className="flex-1 space-y-1.5 overflow-y-auto pr-1 max-h-[220px]">
              {session.events.length === 0 ? (
                <p className="text-xs text-slate-500 italic py-2 text-center">Connecting...</p>
              ) : (
                session.events.map((evt) => (
                  <div
                    key={evt.id}
                    className={`p-2 rounded-lg border text-xs flex items-center justify-between ${
                      evt.type === 'error'
                        ? 'bg-rose-950/40 border-rose-500/30 text-rose-300'
                        : evt.type === 'amd' && evt.title.includes('Voicemail')
                        ? 'bg-orange-950/40 border-orange-500/40 text-orange-200'
                        : evt.type === 'speech'
                        ? 'bg-cyan-950/35 border-cyan-500/30 text-cyan-200'
                        : evt.type === 'recording'
                        ? 'bg-indigo-950/40 border-indigo-500/30 text-indigo-200'
                        : evt.title.includes('Approved') || (evt.type === 'dtmf' && evt.title.includes('Valid'))
                        ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300'
                        : evt.title.includes('Hold') || evt.title.includes('Awaiting')
                        ? 'bg-amber-950/40 border-amber-500/30 text-amber-300'
                        : 'bg-slate-900 border-slate-850 text-slate-300'
                    }`}
                  >
                    <div>
                      <span className="font-semibold text-slate-200 mr-2">[{evt.type.toUpperCase()}]</span>
                      <span>{evt.title}</span>
                    </div>
                    <span className="text-[10px] text-slate-500 font-mono">
                      {new Date(evt.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                ))
              )}
              <div ref={eventsEndRef} />
            </div>
          </div>
        </div>
      )}

      {/* Carrier Voice XML Modal */}
      {showTwimlModal && session && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-lg w-full p-4 shadow-xl">
            <div className="flex items-center justify-between mb-2 pb-2 border-b border-slate-800">
              <h3 className="text-xs font-bold text-white uppercase">
                Generated {carrierXmlLabel} ({(session.carrier || 'twilio').toUpperCase()})
              </h3>
              <button
                onClick={() => setShowTwimlModal(false)}
                className="text-xs px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded"
              >
                Close
              </button>
            </div>
            <pre className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-[11px] font-mono text-cyan-300 overflow-x-auto leading-relaxed">
              {session.carrier === 'plivo'
                ? `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <!-- t=0s: Record & silently listen for voice/DTMF (NEVER speak to Voicemail) -->
  <Record recordSession="true" redirect="false" maxLength="3600" fileFormat="mp3"/>
  <GetInput action="/api/plivo/amd-gate?callId=${session.id}" method="POST" inputType="dtmf speech" executionTimeout="2" speechEndTimeout="1">
    <Wait length="2"/>
  </GetInput>

  <!-- ONLY once Live Human confirmed (direct or picks up after Voicemail): -->
  <Speak>${session.introGreeting.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Speak>
  <GetInput action="${carrierGatherPath}?callId=${session.id}" method="POST" inputType="dtmf speech" numDigits="${session.numDigits}" executionTimeout="15" digitEndTimeout="5">
    <Speak>${session.script.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Speak>
  </GetInput>
</Response>`
                : `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <!-- t=0s: Record & silently listen for voice/DTMF (NEVER speak to Voicemail) -->
  <Gather input="dtmf speech" numDigits="${session.numDigits}" action="/api/twiml/amd-gate?callId=${session.id}" method="POST" timeout="2" speechTimeout="1">
    <Pause length="2"/>
  </Gather>

  <!-- ONLY once Live Human confirmed (direct or picks up after Voicemail): -->
  <Say voice="${session.voice}">${session.introGreeting.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Say>
  <Gather input="dtmf speech" numDigits="${session.numDigits}" action="${carrierGatherPath}?callId=${session.id}" method="POST" timeout="15" speechTimeout="auto" finishOnKey="#">
    <Say voice="${session.voice}">${session.script.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Say>
  </Gather>
</Response>`}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};
