import React from 'react';
import {
  PhoneCall,
  Activity,
  Smartphone,
  ShieldCheck,
  Sparkles,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { CallSession, ServerConfig, TelephonyCarrier } from '../types/telephony';
import { NavTab } from './Sidebar';

interface HeaderProps {
  currentTab: NavTab;
  serverConfig: ServerConfig | null;
  activeSession: CallSession | null;
  onOpenSimulator: () => void;
  onEndCall: () => void;
  soundEnabled: boolean;
  onToggleSound: () => void;
  mode: 'live' | 'simulator';
  activeCarrier?: TelephonyCarrier;
}

const TAB_TITLES: Record<NavTab, { title: string; subtitle: string }> = {
  dispatcher: {
    title: 'Multi-Digit Code Collector',
    subtitle: 'Call US phones and collect 4, 5, or 6-digit keypad inputs in real time.',
  },
  keypad: {
    title: 'DTMF Keypad Studio',
    subtitle: 'Test dual-tone frequencies (697–1477 Hz) and multi-digit dial sequences.',
  },
  history: {
    title: 'Call Records & Code Log',
    subtitle: 'Audit captured multi-digit codes, durations, and telephony session history.',
  },
  settings: {
    title: 'Carrier & Telephony Configuration',
    subtitle: 'Manage Twilio, Plivo, Telnyx, SignalWire, and Fonoster API keys and webhooks.',
  },
};

export const Header: React.FC<HeaderProps> = ({
  currentTab,
  serverConfig,
  activeSession,
  onOpenSimulator,
  onEndCall,
  soundEnabled,
  onToggleSound,
  mode,
  activeCarrier = 'twilio',
}) => {
  const meta = TAB_TITLES[currentTab];
  const isCallLive =
    activeSession &&
    ['queued', 'initiating', 'ringing', 'in-progress', 'collecting-input', 'awaiting-operator'].includes(
      activeSession.status
    );

  const carrierDisplayName =
    activeCarrier.charAt(0).toUpperCase() + activeCarrier.slice(1);

  return (
    <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-md px-4 lg:px-8 py-3.5 sticky top-0 z-30 flex items-center justify-between gap-4">
      <div>
        <h1 className="text-base lg:text-lg font-bold text-white tracking-tight flex items-center gap-2">
          <span>{meta.title}</span>
          {mode === 'simulator' ? (
            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              Simulator Mode
            </span>
          ) : (
            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              {carrierDisplayName} Carrier
            </span>
          )}
        </h1>
        <p className="text-xs text-slate-400 hidden sm:block mt-0.5">{meta.subtitle}</p>
      </div>

      <div className="flex items-center gap-3">
        {/* Active Call Live Banner */}
        {isCallLive && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-medium">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span className="font-semibold">{activeSession.status.toUpperCase()}</span>
            <span className="text-slate-400 font-mono hidden md:inline">({activeSession.to})</span>
          </div>
        )}

        {/* Quick Simulator Button */}
        <button
          type="button"
          onClick={onOpenSimulator}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white border border-slate-700 text-xs font-medium transition-all shadow-sm"
          title="Open Recipient Smartphone Mockup"
        >
          <Smartphone className="w-3.5 h-3.5 text-indigo-400" />
          <span className="hidden sm:inline">Phone Mockup</span>
        </button>

        {/* Audio Mute/Unmute */}
        <button
          type="button"
          onClick={onToggleSound}
          className={`p-2 rounded-lg border text-xs transition-colors flex items-center justify-center ${
            soundEnabled
              ? 'bg-slate-800 border-slate-700 text-emerald-400 hover:bg-slate-750'
              : 'bg-slate-900 border-slate-800 text-slate-500 hover:text-slate-400'
          }`}
          title={soundEnabled ? 'Telephony audio ON' : 'Telephony audio MUTED'}
        >
          {soundEnabled ? (
            <Volume2 className="w-4 h-4" />
          ) : (
            <VolumeX className="w-4 h-4" />
          )}
        </button>
      </div>
    </header>
  );
};
