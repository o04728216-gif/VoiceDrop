import React from 'react';
import {
  Smartphone,
  ShieldCheck,
  Volume2,
  VolumeX,
  Menu,
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
  deviceLabel?: string;
  onOpenMobileMenu?: () => void;
}

const TAB_TITLES: Record<NavTab, { title: string; shortTitle: string; subtitle: string }> = {
  dispatcher: {
    title: 'Multi-Digit Code Collector',
    shortTitle: 'Code Collector',
    subtitle: 'Call US phones and collect up to 16-digit keypad codes (# to submit) in real time.',
  },
  keypad: {
    title: 'DTMF Keypad Studio',
    shortTitle: 'DTMF Keypad',
    subtitle: 'Test dual-tone frequencies (697–1477 Hz) and multi-digit dial sequences.',
  },
  history: {
    title: 'Call Records & Code Log',
    shortTitle: 'Call Records',
    subtitle: 'Audit captured multi-digit codes, durations, and telephony session history.',
  },
  settings: {
    title: 'Carrier & Telephony Configuration',
    shortTitle: 'Carrier Settings',
    subtitle: 'Manage Twilio, Plivo, Telnyx, SignalWire, and Fonoster API keys and webhooks.',
  },
};

export const Header: React.FC<HeaderProps> = ({
  currentTab,
  activeSession,
  onOpenSimulator,
  soundEnabled,
  onToggleSound,
  mode,
  activeCarrier = 'twilio',
  deviceLabel,
  onOpenMobileMenu,
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
    <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur-md px-3 sm:px-4 lg:px-8 py-2.5 sm:py-3.5 sticky top-0 z-30 flex items-center justify-between gap-2 sm:gap-4">
      <div className="flex items-center gap-2.5 min-w-0">
        {/* Mobile Drawer Trigger */}
        {onOpenMobileMenu && (
          <button
            type="button"
            onClick={onOpenMobileMenu}
            aria-label="Open menu"
            className="md:hidden min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg bg-slate-800/90 hover:bg-slate-700 text-slate-200 border border-slate-700 shrink-0 transition-colors cursor-pointer"
          >
            <Menu className="w-4 h-4" />
          </button>
        )}

        {/* Mobile Brand Favicon */}
        <img
          src="/favicon.svg?v=3"
          alt="VoiceDrop"
          className="md:hidden w-7 h-7 rounded-lg shrink-0"
        />

        <div className="min-w-0">
          <h1 className="text-sm sm:text-base lg:text-lg font-bold text-white tracking-tight flex items-center gap-2 min-w-0">
            <span className="truncate sm:hidden">{meta.shortTitle}</span>
            <span className="hidden sm:inline truncate">{meta.title}</span>
            {mode === 'simulator' ? (
              <span className="hidden sm:inline-flex text-[11px] font-medium px-2 py-0.5 rounded-md bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 whitespace-nowrap shrink-0">
                Simulator
              </span>
            ) : (
              <span className="hidden sm:inline-flex text-[11px] font-medium px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 whitespace-nowrap shrink-0">
                {carrierDisplayName}
              </span>
            )}
            {deviceLabel && (
              <span
                className="hidden lg:inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-md bg-slate-800 text-slate-300 border border-slate-700 whitespace-nowrap shrink-0"
                title="Private device session — recordings & API keys isolated to this device"
              >
                <ShieldCheck className="w-3 h-3 text-emerald-400" />
                <span>{deviceLabel}</span>
              </span>
            )}
          </h1>
          <p className="text-xs text-slate-400 hidden sm:block mt-0.5 truncate">{meta.subtitle}</p>
        </div>
      </div>

      <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
        {/* Active Call Live Status */}
        {isCallLive && (
          <div className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-[11px] sm:text-xs font-medium whitespace-nowrap">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span className="font-semibold hidden xs:inline sm:inline">{activeSession.status.toUpperCase()}</span>
            <span className="font-semibold sm:hidden">LIVE</span>
            <span className="text-slate-400 font-mono hidden lg:inline">({activeSession.to})</span>
          </div>
        )}

        {/* Quick Simulator Button */}
        <button
          type="button"
          onClick={onOpenSimulator}
          className="min-h-[40px] sm:min-h-[36px] flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white border border-slate-700 text-xs font-medium transition-all shadow-sm whitespace-nowrap shrink-0 cursor-pointer"
          title="Open Recipient Smartphone Mockup"
        >
          <Smartphone className="w-4 h-4 sm:w-3.5 sm:h-3.5 text-indigo-400 shrink-0" />
          <span className="hidden sm:inline">Phone Mockup</span>
        </button>

        {/* Audio Mute/Unmute */}
        <button
          type="button"
          onClick={onToggleSound}
          className={`min-h-[40px] min-w-[40px] sm:min-h-[36px] sm:min-w-[36px] p-2 rounded-lg border text-xs transition-colors flex items-center justify-center shrink-0 cursor-pointer ${
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
