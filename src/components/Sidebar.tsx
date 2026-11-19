import React from 'react';
import {
  KeyRound,
  Grid3X3,
  History,
  Sliders,
  Volume2,
  VolumeX,
  Smartphone,
  Activity,
  X,
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
  deviceLabel?: string;
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onSelectTab,
  activeSession,
  soundEnabled,
  onToggleSound,
  mode,
  onToggleMode,
  onOpenSimulator,
  callsCount,
  activeCarrier = 'twilio',
  deviceLabel,
  mobileOpen = false,
  onCloseMobile,
}) => {
  const isCallLive =
    activeSession &&
    ['queued', 'initiating', 'ringing', 'in-progress', 'collecting-input', 'awaiting-operator'].includes(
      activeSession.status
    );

  const navItems = [
    {
      id: 'dispatcher' as NavTab,
      label: 'Code Collector',
      shortLabel: 'Collector',
      icon: KeyRound,
      badge: isCallLive ? 'LIVE' : null,
      badgeColor: 'bg-emerald-500 text-slate-950 font-bold',
    },
    {
      id: 'keypad' as NavTab,
      label: 'DTMF Keypad',
      shortLabel: 'Keypad',
      icon: Grid3X3,
      badge: null,
      badgeColor: '',
    },
    {
      id: 'history' as NavTab,
      label: 'Call Records',
      shortLabel: 'Records',
      icon: History,
      badge: callsCount > 0 ? String(callsCount) : null,
      badgeColor: 'bg-slate-800 text-slate-300',
    },
    {
      id: 'settings' as NavTab,
      label: 'Carrier Settings',
      shortLabel: 'Carriers',
      icon: Sliders,
      badge: activeCarrier.toUpperCase(),
      badgeColor: 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 font-mono',
    },
  ];

  const handleNavClick = (tab: NavTab) => {
    onSelectTab(tab);
    onCloseMobile?.();
  };

  const handleSimulatorClick = () => {
    onCloseMobile?.();
    onOpenSimulator();
  };

  const sidebarContent = (isDrawer: boolean) => (
    <div className="flex flex-col h-full">
      {/* Brand Header */}
      <div className="p-4 border-b border-slate-800 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <img
            src="/favicon.svg?v=3"
            alt="VoiceDrop"
            className="w-8 h-8 rounded-lg shadow-sm shrink-0"
          />
          <div className="min-w-0">
            <div className="font-bold text-sm text-white tracking-tight truncate">VoiceDrop</div>
            <div className="text-[11px] text-slate-400 truncate">Multi-Digit Telephony</div>
          </div>
        </div>

        {isDrawer && onCloseMobile && (
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label="Close navigation menu"
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg bg-slate-800 text-slate-300 hover:text-white border border-slate-700 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Live Call Alert Banner in Sidebar if call is active */}
      {isCallLive && (
        <button
          type="button"
          onClick={() => handleNavClick('dispatcher')}
          className="m-3 mb-1 p-2.5 rounded-lg bg-emerald-950/60 border border-emerald-500/40 text-emerald-200 cursor-pointer hover:bg-emerald-950 transition-all flex items-center justify-between text-left"
        >
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0"></span>
            <div className="text-xs font-semibold">Active Call Live</div>
          </div>
          <Activity className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
        </button>
      )}

      {/* Navigation Menu */}
      <nav className="p-2.5 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentTab === item.id;

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => handleNavClick(item.id)}
              className={`w-full min-h-[42px] flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                isActive
                  ? 'bg-indigo-600 text-white font-semibold shadow-sm'
                  : 'text-slate-300 hover:text-white hover:bg-slate-800'
              }`}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </div>

              {item.badge && (
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ml-2 ${
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

      {/* Quick Controls — Positioned directly below Carrier Settings */}
      <div className="mx-2.5 mt-1 pt-3 pb-4 border-t border-slate-800 space-y-2.5">
        <div className="px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Session Controls
        </div>

        {/* Recipient Phone Simulator Trigger */}
        <button
          type="button"
          onClick={handleSimulatorClick}
          className="w-full min-h-[40px] py-2 px-3 rounded-lg bg-slate-800 hover:bg-slate-750 text-slate-200 text-xs font-medium flex items-center justify-center gap-2 border border-slate-700 transition-colors cursor-pointer"
        >
          <Smartphone className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
          <span className="whitespace-nowrap">Phone Simulator</span>
        </button>

        {/* Mode Selector */}
        <div className="grid grid-cols-2 gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800 text-[11px]">
          <button
            type="button"
            onClick={() => onToggleMode('simulator')}
            className={`min-h-[34px] py-1.5 rounded font-medium transition-all cursor-pointer ${
              mode === 'simulator'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Simulator
          </button>
          <button
            type="button"
            onClick={() => onToggleMode('live')}
            className={`min-h-[34px] py-1.5 rounded font-medium transition-all truncate px-1.5 cursor-pointer ${
              mode === 'live'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {activeCarrier ? activeCarrier.charAt(0).toUpperCase() + activeCarrier.slice(1) : 'Carrier'}
          </button>
        </div>

        {/* Audio Toggle & Isolated Session Label */}
        <div className="flex items-center justify-between gap-2 text-xs text-slate-400 pt-1 px-1">
          <button
            type="button"
            onClick={onToggleSound}
            className="min-h-[36px] flex items-center gap-1.5 text-slate-300 hover:text-white transition-colors cursor-pointer"
          >
            {soundEnabled ? (
              <>
                <Volume2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span className="whitespace-nowrap">Audio On</span>
              </>
            ) : (
              <>
                <VolumeX className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                <span className="whitespace-nowrap">Muted</span>
              </>
            )}
          </button>
          <span
            className="text-[10px] text-slate-500 font-mono truncate max-w-[105px]"
            title="Isolated device session"
          >
            {deviceLabel || 'Private'}
          </span>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Sticky Left Sidebar */}
      <aside className="hidden md:flex md:w-60 bg-slate-900 border-r border-slate-800 flex-col shrink-0 select-none md:sticky md:top-0 md:h-screen md:overflow-y-auto">
        {sidebarContent(false)}
      </aside>

      {/* Mobile Slide-Over Navigation Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <aside className="relative z-10 w-[280px] max-w-[85vw] h-full bg-slate-900 border-r border-slate-800 shadow-2xl overflow-y-auto select-none">
            {sidebarContent(true)}
          </aside>
        </div>
      )}

      {/* Mobile Fixed Thumb-Zone Bottom Navigation Bar */}
      <nav
        aria-label="Primary mobile navigation"
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-slate-900/95 backdrop-blur-md border-t border-slate-800 pb-safe select-none"
      >
        <div className="grid grid-cols-4 h-14">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`relative flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                  isActive ? 'text-indigo-400' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <div className="relative">
                  <Icon className="w-5 h-5" />
                  {item.id === 'dispatcher' && isCallLive && (
                    <span className="absolute -top-0.5 -right-1.5 w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  )}
                  {item.id === 'history' && callsCount > 0 && (
                    <span className="absolute -top-1.5 -right-3 min-w-[16px] h-4 px-1 rounded-full bg-slate-800 border border-slate-700 text-[9px] font-mono text-slate-200 flex items-center justify-center">
                      {callsCount > 99 ? '99+' : callsCount}
                    </span>
                  )}
                </div>
                <span className="leading-none truncate max-w-[74px]">{item.shortLabel}</span>
                {isActive && (
                  <span className="absolute top-0 left-3 right-3 h-0.5 bg-indigo-500 rounded-b-full" />
                )}
              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
};
