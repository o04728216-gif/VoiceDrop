import React from 'react';
import {
  PhoneCall,
  KeyRound,
  Grid3X3,
  History,
  Sliders,
  Volume2,
  VolumeX,
  Smartphone,
  Activity,
} from 'lucide-react';
import { CallSession, ServerConfig, TelephonyCarrier } from '../types/telephony';

export type NavTab = 'dispatcher' | 'keypad' | 'history' | 'settings';

interface SidebarProps {
  currentTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  serverConfig: ServerConfig | null;
  activeSession: CallSession | null;
  soundEnabled: boolean;
  onToggleSound: () => void;
  mode: 'live' | 'simulator';
  onToggleMode: (mode: 'live' | 'simulator') => void;
  onOpenSimulator: () => void;
  callsCount: number;
  activeCarrier?: TelephonyCarrier;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onSelectTab,
  serverConfig,
  activeSession,
  soundEnabled,
  onToggleSound,
  mode,
  onToggleMode,
  onOpenSimulator,
  callsCount,
  activeCarrier = 'twilio',
}) => {
  const isTwilioReady = serverConfig?.isTwilioConfigured;
  const isCallLive =
    activeSession &&
    ['queued', 'initiating', 'ringing', 'in-progress', 'collecting-input', 'awaiting-operator'].includes(
      activeSession.status
    );

  const navItems = [
    {
      id: 'dispatcher' as NavTab,
      label: 'Code Collector',
      icon: KeyRound,
      badge: isCallLive ? 'LIVE' : null,
      badgeColor: 'bg-emerald-500 text-slate-950 font-bold',
    },
    {
      id: 'keypad' as NavTab,
      label: 'DTMF Keypad',
      icon: Grid3X3,
      badge: null,
      badgeColor: '',
    },
    {
      id: 'history' as NavTab,
      label: 'Call Records',
      icon: History,
      badge: callsCount > 0 ? String(callsCount) : null,
      badgeColor: 'bg-slate-800 text-slate-300',
    },
    {
      id: 'settings' as NavTab,
      label: 'Carrier Settings',
      icon: Sliders,
      badge: activeCarrier.toUpperCase(),
      badgeColor: 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 font-mono',
    },
  ];

  return (
    <aside className="w-full md:w-60 bg-slate-900 border-r border-slate-800 flex flex-col justify-between shrink-0 select-none">
      <div>
        {/* Brand Header */}
        <div className="p-4 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white shadow-sm">
              <PhoneCall className="w-4 h-4" />
            </div>
            <div>
              <div className="font-bold text-sm text-white tracking-tight">VoiceDrop</div>
              <div className="text-[11px] text-slate-400">Multi-Digit Telephony</div>
            </div>
          </div>
        </div>

        {/* Live Call Alert Pill in Sidebar if call is active */}
        {isCallLive && (
          <div
            onClick={() => onSelectTab('dispatcher')}
            className="m-3 p-2.5 rounded-lg bg-emerald-950/60 border border-emerald-500/40 text-emerald-200 cursor-pointer hover:bg-emerald-950 transition-all flex items-center justify-between"
          >
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              <div className="text-xs font-semibold">Active Call Live</div>
            </div>
            <Activity className="w-3.5 h-3.5 text-emerald-400" />
          </div>
        )}

        {/* Navigation Menu */}
        <nav className="p-2 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentTab === item.id;

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                  isActive
                    ? 'bg-indigo-600 text-white font-semibold'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Icon className="w-4 h-4" />
                  <span>{item.label}</span>
                </div>

                {item.badge && (
                  <span
                    className={`text-[10px] px-1.5 py-0.2 rounded font-medium ${
                      isActive ? 'bg-white/20 text-white' : item.badgeColor
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-slate-800 space-y-2 bg-slate-900/60">
        {/* Recipient Phone Simulator Trigger */}
        <button
          type="button"
          onClick={onOpenSimulator}
          className="w-full py-1.5 px-3 rounded-lg bg-slate-800 hover:bg-slate-750 text-slate-200 text-xs font-medium flex items-center justify-center gap-2 border border-slate-700 transition-colors"
        >
          <Smartphone className="w-3.5 h-3.5 text-indigo-400" />
          <span>Phone Simulator</span>
        </button>

        {/* Mode Selector */}
        <div className="grid grid-cols-2 gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800 text-[11px]">
          <button
            type="button"
            onClick={() => onToggleMode('simulator')}
            className={`py-1 rounded font-medium transition-all ${
              mode === 'simulator'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Simulator
          </button>
          <button
            type="button"
            onClick={() => onToggleMode('live')}
            className={`py-1 rounded font-medium transition-all truncate px-1 ${
              mode === 'live'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {activeCarrier ? activeCarrier.charAt(0).toUpperCase() + activeCarrier.slice(1) : 'Carrier'}
          </button>
        </div>

        {/* Audio Toggle */}
        <div className="flex items-center justify-between text-xs text-slate-400 pt-1 px-1">
          <button
            type="button"
            onClick={onToggleSound}
            className="flex items-center gap-1.5 text-slate-400 hover:text-slate-200"
          >
            {soundEnabled ? (
              <>
                <Volume2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>Audio On</span>
              </>
            ) : (
              <>
                <VolumeX className="w-3.5 h-3.5 text-slate-500" />
                <span>Muted</span>
              </>
            )}
          </button>
          <span className="text-[10px] text-slate-600 font-mono">v2.5</span>
        </div>
      </div>
    </aside>
  );
};
