/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { Sidebar, NavTab } from './components/Sidebar';
import { Header } from './components/Header';
import { ControlCenter } from './components/ControlCenter';
import { LiveSessionFeed } from './components/LiveSessionFeed';
import { KeypadLabView } from './components/KeypadLabView';
import { CallHistoryView } from './components/CallHistoryView';
import { TwilioSettingsView } from './components/TwilioSettingsView';
import { PhoneSimulatorView } from './components/PhoneSimulatorView';
import { CallSession, ServerConfig, TwilioConfig, CarriersConfig, TelephonyCarrier } from './types/telephony';
import {
  playDtmfTone,
  startRingbackTone,
  stopRingbackTone,
  playConnectedChime,
  playHangupTone,
} from './utils/audioTones';
import { LiveAudioMonitor } from './utils/liveAudioMonitor';
import {
  getDeviceHeaders,
  getDeviceId,
  withDeviceParam,
  resetDeviceSessionStorage,
  getDeviceShortLabel,
} from './utils/deviceSession';
import { AlertCircle, X, ShieldCheck, Activity, PhoneCall, LayoutGrid } from 'lucide-react';

const STORAGE_KEY_TWILIO = 'voicedrop_twilio_config';
const STORAGE_KEY_CARRIERS = 'voicedrop_carriers_config';
const STORAGE_KEY_SOUND = 'voicedrop_sound_enabled';
const STORAGE_KEY_MODE = 'voicedrop_active_mode';

export default function App() {
  const [currentTab, setCurrentTab] = useState<NavTab>('dispatcher');
  const [activeSession, setActiveSession] = useState<CallSession | null>(null);
  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);
  const [savedTwilioConfig, setSavedTwilioConfig] = useState<TwilioConfig | null>(null);

  const [carriersConfig, setCarriersConfig] = useState<CarriersConfig>(() => {
    const stored = localStorage.getItem(STORAGE_KEY_CARRIERS);
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch (e) {}
    }
    const legacyTwilio = localStorage.getItem(STORAGE_KEY_TWILIO);
    let twilio: TwilioConfig | undefined = undefined;
    if (legacyTwilio) {
      try {
        twilio = JSON.parse(legacyTwilio);
      } catch (e) {}
    }
    return {
      activeCarrier: 'twilio',
      twilio,
    };
  });

  const [callsHistory, setCallsHistory] = useState<CallSession[]>([]);

  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    const val = localStorage.getItem(STORAGE_KEY_SOUND);
    return val !== null ? val === 'true' : true;
  });

  const [mode, setMode] = useState<'live' | 'simulator'>(() => {
    const val = localStorage.getItem(STORAGE_KEY_MODE);
    return (val as 'live' | 'simulator') || 'simulator';
  });

  const [isPhoneDocked, setIsPhoneDocked] = useState<boolean>(true);
  const [isPhoneModalOpen, setIsPhoneModalOpen] = useState<boolean>(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
  const [operatorTab, setOperatorTab] = useState<'live' | 'setup' | 'both'>('setup');
  const [isLoading, setIsLoading] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [deviceLabel, setDeviceLabel] = useState<string>(() => getDeviceShortLabel());

  const eventSourceRef = useRef<EventSource | null>(null);
  const liveAudioMonitorRef = useRef<LiveAudioMonitor | null>(null);
  const prevSessionStatusRef = useRef<{ id: string; status: string } | null>(null);
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;

  useEffect(() => {
    // Ensure this browser/device has a persistent cryptographic session ID before making API calls
    const currentDeviceId = getDeviceId();
    setDeviceLabel(getDeviceShortLabel(currentDeviceId));

    fetch('/api/config', { headers: getDeviceHeaders() })
      .then((res) => res.json())
      .then((data: ServerConfig) => {
        setServerConfig(data);
      })
      .catch((err) => console.error('Failed to load server config:', err));

    const storedTwilio = localStorage.getItem(STORAGE_KEY_TWILIO);
    if (storedTwilio) {
      try {
        setSavedTwilioConfig(JSON.parse(storedTwilio));
      } catch (e) {
        // Ignore
      }
    }

    loadCallHistory();
  }, []);

  const loadCallHistory = async () => {
    try {
      const res = await fetch('/api/calls', { headers: getDeviceHeaders() });
      if (res.ok) {
        const data: CallSession[] = await res.json();
        setCallsHistory(data);
        setActiveSession((prev) => {
          if (!prev) return prev;
          const fresher = data.find((c) => c.id === prev.id);
          return fresher ? fresher : prev;
        });
      }
    } catch (err) {
      console.error('Error fetching call history:', err);
    }
  };

  useEffect(() => {
    if (currentTab === 'history') {
      void loadCallHistory();
    }
  }, [currentTab]);

  const handleToggleSound = () => {
    setSoundEnabled((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY_SOUND, String(next));
      if (!next) {
        stopRingbackTone();
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
          window.speechSynthesis.cancel();
        }
      }
      return next;
    });
  };

  const handleToggleMode = (newMode: 'live' | 'simulator') => {
    setMode(newMode);
    localStorage.setItem(STORAGE_KEY_MODE, newMode);
  };

  const handleSaveTwilioConfig = (config: TwilioConfig) => {
    setSavedTwilioConfig(config);
    localStorage.setItem(STORAGE_KEY_TWILIO, JSON.stringify(config));
    setCarriersConfig((prev) => {
      const updated = { ...prev, twilio: config };
      localStorage.setItem(STORAGE_KEY_CARRIERS, JSON.stringify(updated));
      return updated;
    });
  };

  const handleSaveCarriersConfig = (config: CarriersConfig) => {
    setCarriersConfig(config);
    localStorage.setItem(STORAGE_KEY_CARRIERS, JSON.stringify(config));
    if (config.twilio) {
      setSavedTwilioConfig(config.twilio);
      localStorage.setItem(STORAGE_KEY_TWILIO, JSON.stringify(config.twilio));
    }
  };

  const handleChangeActiveCarrier = (carrier: TelephonyCarrier) => {
    setCarriersConfig((prev) => {
      const updated: CarriersConfig = { ...prev, activeCarrier: carrier };
      localStorage.setItem(STORAGE_KEY_CARRIERS, JSON.stringify(updated));
      return updated;
    });
  };

  const handleRecordingSaved = (updatedSession?: CallSession) => {
    if (updatedSession) {
      setActiveSession((prev) =>
        prev && prev.id === updatedSession.id ? updatedSession : prev
      );
    }
    void loadCallHistory();
  };

  const handleResetDeviceSession = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    stopRingbackTone();
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    const nextId = resetDeviceSessionStorage();
    setDeviceLabel(getDeviceShortLabel(nextId));
    setSavedTwilioConfig(null);
    setCarriersConfig({ activeCarrier: 'twilio' });
    setActiveSession(null);
    setCallsHistory([]);
    setErrorBanner(null);
    void loadCallHistory();
  };

  // SSE Telemetry listener (continuous per callId, stays open until recording finalizes)
  useEffect(() => {
    if (!activeSession?.id) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      stopRingbackTone();
      prevSessionStatusRef.current = null;
      return;
    }

    const initiallyTerminal = ['completed', 'failed', 'busy', 'no-answer'].includes(
      activeSession.status
    );
    const initiallyFinalizing =
      activeSession.recordingStatus === 'recording' && !activeSession.recordingUrl;

    if (initiallyTerminal && !initiallyFinalizing) {
      stopRingbackTone();
      prevSessionStatusRef.current = {
        id: activeSession.id,
        status: activeSession.status,
      };
      return;
    }

    const es = new EventSource(withDeviceParam(`/api/call/events/${activeSession.id}`));
    eventSourceRef.current = es;

    es.addEventListener('session-update', (event) => {
      try {
        const updatedSession: CallSession = JSON.parse(event.data);
        const prev = prevSessionStatusRef.current;
        const statusChanged =
          !prev || prev.id !== updatedSession.id || prev.status !== updatedSession.status;

        prevSessionStatusRef.current = {
          id: updatedSession.id,
          status: updatedSession.status,
        };

        setActiveSession(updatedSession);
        setCallsHistory((prevList) => {
          const exists = prevList.some((c) => c.id === updatedSession.id);
          if (!exists) return [updatedSession, ...prevList];
          return prevList.map((c) => (c.id === updatedSession.id ? updatedSession : c));
        });

        const updatedTerminal = ['completed', 'failed', 'busy', 'no-answer'].includes(
          updatedSession.status
        );

        if (soundEnabledRef.current) {
          if (updatedSession.status === 'ringing' && statusChanged) {
            startRingbackTone();
          } else if (
            ['in-progress', 'collecting-input'].includes(updatedSession.status) &&
            statusChanged &&
            prev?.id === updatedSession.id &&
            ['queued', 'initiating', 'ringing'].includes(prev.status)
          ) {
            stopRingbackTone();
            playConnectedChime();
          } else if (updatedTerminal) {
            stopRingbackTone();
            if (statusChanged && prev?.id === updatedSession.id) {
              playHangupTone();
            }
          }
        } else {
          stopRingbackTone();
        }

        if (updatedTerminal || updatedSession.recordingStatus === 'completed') {
          void loadCallHistory();
        }

        // Close SSE only once call has ended AND recording is no longer finalizing
        if (
          updatedTerminal &&
          (Boolean(updatedSession.recordingUrl) || updatedSession.recordingStatus !== 'recording')
        ) {
          es.close();
          if (eventSourceRef.current === es) {
            eventSourceRef.current = null;
          }
        }
      } catch (err) {
        console.error('SSE session parse error:', err);
      }
    });

    es.addEventListener('call-event', (event) => {
      try {
        const callEvt = JSON.parse(event.data);
        if (callEvt.type === 'dtmf' && callEvt.data?.digits) {
          const digit = String(callEvt.data.digits);
          if (soundEnabledRef.current) {
            playDtmfTone(digit.slice(-1));
          }
        }
      } catch (err) {
        console.error('SSE event parse error:', err);
      }
    });

    return () => {
      es.close();
      if (eventSourceRef.current === es) {
        eventSourceRef.current = null;
      }
      stopRingbackTone();
    };
  }, [activeSession?.id]);

  // Active-call polling fallback (2s) so proxy-buffered SSE never leaves the UI timer counting after hangup/failure
  useEffect(() => {
    const isActive = Boolean(
      activeSession?.id &&
        ['queued', 'initiating', 'ringing', 'in-progress', 'collecting-input', 'awaiting-operator'].includes(
          activeSession.status
        )
    );
    if (!isActive || !activeSession?.id) return;

    const callId = activeSession.id;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(withDeviceParam(`/api/calls/${encodeURIComponent(callId)}`));
        if (!res.ok || cancelled) return;
        const fresh: CallSession = await res.json();
        if (cancelled || !fresh?.id || fresh.id !== callId) return;
        setActiveSession((curr) => {
          if (!curr || curr.id !== callId) return curr;
          const changed =
            curr.status !== fresh.status ||
            (curr.events?.length || 0) !== (fresh.events?.length || 0) ||
            curr.completedAt !== fresh.completedAt;
          return changed ? fresh : curr;
        });
        if (['completed', 'failed', 'busy', 'no-answer'].includes(fresh.status)) {
          stopRingbackTone();
        }
      } catch {}
    };

    const timer = setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeSession?.id, activeSession?.status]);

  // Rapid post-call polling fallback so recordingUrl appears immediately after call completion
  useEffect(() => {
    const isTerminal =
      activeSession &&
      ['completed', 'failed', 'busy', 'no-answer'].includes(activeSession.status);

    if (!isTerminal || !activeSession?.id || activeSession.recordingUrl) {
      return;
    }

    const timers = [450, 1200, 2400, 4200, 7000, 10500].map((ms) =>
      setTimeout(() => void loadCallHistory(), ms)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [activeSession?.id, activeSession?.status, Boolean(activeSession?.recordingUrl)]);

  // Live Operator Audio Monitor ("Audio On") for real-time Fonoster PCM16 16kHz calls
  useEffect(() => {
    const shouldMonitorLiveAudio = Boolean(
      soundEnabled &&
        activeSession &&
        !activeSession.isSimulated &&
        activeSession.carrier === 'fonoster' &&
        ['in-progress', 'collecting-input', 'awaiting-operator'].includes(activeSession.status)
    );

    if (!shouldMonitorLiveAudio || !activeSession?.id) {
      if (liveAudioMonitorRef.current) {
        liveAudioMonitorRef.current.stop();
        liveAudioMonitorRef.current = null;
      }
      return;
    }

    const monitor = new LiveAudioMonitor();
    liveAudioMonitorRef.current = monitor;
    monitor.start(activeSession.id);

    return () => {
      monitor.stop();
      if (liveAudioMonitorRef.current === monitor) {
        liveAudioMonitorRef.current = null;
      }
    };
  }, [
    activeSession?.id,
    activeSession?.status,
    activeSession?.isSimulated,
    activeSession?.carrier,
    soundEnabled,
  ]);

  const handleLaunchCall = async (params: {
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
    carrier?: TelephonyCarrier;
    autoHangupOnVoicemail?: boolean;
    recordCall?: boolean;
  }) => {
    try {
      setIsLoading(true);
      setErrorBanner(null);

      const payload = {
        ...params,
        mode,
        carrier: params.carrier || carriersConfig.activeCarrier,
        carriersConfig,
        customTwilio: savedTwilioConfig,
        clientOrigin: typeof window !== 'undefined' ? window.location.origin : undefined,
      };

      const res = await fetch('/api/call/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getDeviceHeaders() },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        if (data?.session) {
          setActiveSession(data.session);
          setOperatorTab('live');
          loadCallHistory();
        }
        throw new Error(data.error || 'Failed to place call');
      }

      setActiveSession(data.session);
      setOperatorTab('live');

      if (!isPhoneDocked) {
        setIsPhoneModalOpen(true);
      }

      loadCallHistory();
    } catch (err: any) {
      console.error(err);
      setErrorBanner(err.message || 'Call placement failed. Check carrier configuration.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenSimulator = () => {
    if (currentTab !== 'dispatcher') {
      setCurrentTab('dispatcher');
    }
    const isNarrowViewport = typeof window !== 'undefined' && window.innerWidth < 1280;
    if (!isPhoneDocked || isNarrowViewport) {
      setIsPhoneModalOpen(true);
    } else {
      const el = document.getElementById('phone-simulator-dock');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth' });
      }
    }
  };

  const handleEndCall = async () => {
    if (!activeSession) return;
    try {
      stopRingbackTone();
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      const res = await fetch('/api/call/hangup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getDeviceHeaders() },
        body: JSON.stringify({
          callId: activeSession.id,
          customTwilio: savedTwilioConfig,
          carriersConfig,
        }),
      });
      const data = await res.json();
      if (data.session) {
        setActiveSession(data.session);
      }
      loadCallHistory();
    } catch (err) {
      console.error('Error ending call:', err);
    }
  };

  const handleSimulateEvent = async (action: string, payload?: any) => {
    if (!activeSession) return null;
    try {
      const res = await fetch('/api/call/simulate-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getDeviceHeaders() },
        body: JSON.stringify({
          callId: activeSession.id,
          action,
          ...payload,
        }),
      });
      const data = await res.json();
      if (data.session) {
        setActiveSession(data.session);
      }
      return data;
    } catch (err) {
      console.error('Error simulating event:', err);
      return null;
    }
  };

  const handleOperatorAction = async (
    action:
      | 'approve'
      | 'reject'
      | 'hold'
      | 'incorrect_prompt'
      | 'custom_cue'
      | 'start_human_greeting',
    customMessage?: string
  ) => {
    if (!activeSession) return null;
    try {
      const res = await fetch('/api/call/operator-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getDeviceHeaders() },
        body: JSON.stringify({
          callId: activeSession.id,
          action,
          customMessage,
          customTwilio: savedTwilioConfig,
          carriersConfig,
        }),
      });
      const data = await res.json();
      if (data.session) {
        setActiveSession(data.session);
      }
      return data;
    } catch (err) {
      console.error('Error executing operator action:', err);
      return null;
    }
  };

  const isCallActive =
    activeSession !== null &&
    ['queued', 'initiating', 'ringing', 'in-progress', 'collecting-input', 'awaiting-operator'].includes(
      activeSession.status
    );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col md:flex-row font-sans selection:bg-indigo-500/30 selection:text-white overflow-x-hidden">
      {/* Left Sidebar Menu + Mobile Drawer + Bottom Thumb Bar */}
      <Sidebar
        currentTab={currentTab}
        onSelectTab={setCurrentTab}
        serverConfig={serverConfig}
        activeSession={activeSession}
        soundEnabled={soundEnabled}
        onToggleSound={handleToggleSound}
        mode={mode}
        onToggleMode={handleToggleMode}
        onOpenSimulator={handleOpenSimulator}
        callsCount={callsHistory.length}
        activeCarrier={carriersConfig.activeCarrier}
        deviceLabel={deviceLabel}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Header */}
        <Header
          currentTab={currentTab}
          serverConfig={serverConfig}
          activeSession={activeSession}
          onOpenSimulator={handleOpenSimulator}
          onEndCall={handleEndCall}
          soundEnabled={soundEnabled}
          onToggleSound={handleToggleSound}
          mode={mode}
          activeCarrier={carriersConfig.activeCarrier}
          deviceLabel={deviceLabel}
          onOpenMobileMenu={() => setMobileMenuOpen(true)}
        />

        {/* Error Banner */}
        {errorBanner && (
          <div className="bg-rose-950/90 border-b border-rose-500/30 px-3 sm:px-4 py-2.5 flex items-center justify-between text-xs text-rose-200">
            <div className="flex items-center gap-2 max-w-7xl mx-auto w-full min-w-0">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span className="font-medium break-words">{errorBanner}</span>
            </div>
            <button
              type="button"
              onClick={() => setErrorBanner(null)}
              className="text-rose-400 hover:text-white p-1.5 min-h-[36px] min-w-[36px] flex items-center justify-center shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* View Routing Body */}
        <main className="flex-1 p-3 sm:p-4 lg:p-6 pb-20 md:pb-6">
          {currentTab === 'dispatcher' && (
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 sm:gap-6 items-start">
              {/* Operator Command Console (7-8 cols on desktop, or 12 if undocked) */}
              <div
                className={`flex flex-col gap-4 sm:gap-5 min-w-0 ${
                  isPhoneDocked ? 'xl:col-span-7 2xl:col-span-8' : 'xl:col-span-12'
                }`}
              >
                {/* Operator Subnav Header */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-900 border border-slate-800 rounded-xl px-3.5 sm:px-4 py-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="p-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 shrink-0">
                      <ShieldCheck className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-xs font-bold text-white uppercase tracking-wider">
                          Operator Command Console
                        </h2>
                        {isCallActive ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span>
                            <span>ACTIVE ({activeSession?.status.toUpperCase()})</span>
                          </span>
                        ) : (
                          <span className="text-[10px] text-slate-500 font-mono">
                            STANDBY
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400 leading-snug mt-0.5">
                        {activeSession?.status === 'awaiting-operator'
                          ? 'Caller code received — Pending your manual approval or rejection'
                          : 'Control calls, trigger live voice cues, and supervise keypad streams'}
                      </p>
                    </div>
                  </div>

                  {/* Operator Subtab Switcher */}
                  <div className="grid grid-cols-2 sm:flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs w-full sm:w-auto shrink-0">
                    <button
                      type="button"
                      onClick={() => setOperatorTab('live')}
                      className={`min-h-[38px] sm:min-h-[32px] flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-all whitespace-nowrap cursor-pointer ${
                        operatorTab === 'live'
                          ? 'bg-indigo-600 text-white shadow-sm font-semibold'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      <Activity className="w-3.5 h-3.5 shrink-0" />
                      <span>Live Controls</span>
                      {isCallActive && (
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => setOperatorTab('setup')}
                      className={`min-h-[38px] sm:min-h-[32px] flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-all whitespace-nowrap cursor-pointer ${
                        operatorTab === 'setup'
                          ? 'bg-indigo-600 text-white shadow-sm font-semibold'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      <PhoneCall className="w-3.5 h-3.5 shrink-0" />
                      <span>Call Dispatcher</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setOperatorTab('both')}
                      className={`hidden 2xl:flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-all whitespace-nowrap cursor-pointer ${
                        operatorTab === 'both'
                          ? 'bg-indigo-600 text-white shadow-sm font-semibold'
                          : 'text-slate-400 hover:text-white'
                      }`}
                      title="Display both Setup and Live Telemetry side-by-side"
                    >
                      <LayoutGrid className="w-3.5 h-3.5" />
                      <span>Both Panes</span>
                    </button>
                  </div>
                </div>

                {/* Operator Subtab Content */}
                {operatorTab === 'live' && (
                  <div className="flex flex-col min-h-[500px]">
                    <LiveSessionFeed
                      session={activeSession}
                      onEndCall={handleEndCall}
                      onOpenSimulator={handleOpenSimulator}
                      onOperatorAction={handleOperatorAction}
                    />
                  </div>
                )}

                {operatorTab === 'setup' && (
                  <div className="flex flex-col">
                    <ControlCenter
                      onLaunchCall={handleLaunchCall}
                      isLoading={isLoading}
                      activeCall={isCallActive}
                      mode={mode}
                      hasGemini={Boolean(serverConfig?.hasGemini)}
                      twilioConfig={savedTwilioConfig}
                      activeCarrier={carriersConfig.activeCarrier}
                      onChangeActiveCarrier={handleChangeActiveCarrier}
                    />
                  </div>
                )}

                {operatorTab === 'both' && (
                  <div className="grid grid-cols-1 2xl:grid-cols-2 gap-5 items-start">
                    <ControlCenter
                      onLaunchCall={handleLaunchCall}
                      isLoading={isLoading}
                      activeCall={isCallActive}
                      mode={mode}
                      hasGemini={Boolean(serverConfig?.hasGemini)}
                      twilioConfig={savedTwilioConfig}
                      activeCarrier={carriersConfig.activeCarrier}
                      onChangeActiveCarrier={handleChangeActiveCarrier}
                    />
                    <LiveSessionFeed
                      session={activeSession}
                      onEndCall={handleEndCall}
                      onOpenSimulator={handleOpenSimulator}
                      onOperatorAction={handleOperatorAction}
                    />
                  </div>
                )}
              </div>

              {/* Right Side: Docked Smartphone Simulator (side-by-side on desktop, neatly stacked on mobile) */}
              {isPhoneDocked && (
                <div
                  id="phone-simulator-dock"
                  className="xl:col-span-5 2xl:col-span-4 xl:sticky xl:top-20"
                >
                  <PhoneSimulatorView
                    session={activeSession}
                    onSimulateEvent={handleSimulateEvent}
                    onRecordingSaved={handleRecordingSaved}
                    soundEnabled={soundEnabled}
                    isDocked={true}
                    onToggleDock={() => {
                      setIsPhoneDocked(false);
                      setIsPhoneModalOpen(true);
                    }}
                  />
                </div>
              )}
            </div>
          )}

          {currentTab === 'keypad' && (
            <KeypadLabView soundEnabled={soundEnabled} />
          )}

          {currentTab === 'history' && (
            <CallHistoryView
              calls={callsHistory}
              onRefresh={loadCallHistory}
              onSelectCall={(call) => {
                setActiveSession(call);
                setCurrentTab('dispatcher');
                setOperatorTab('live');
              }}
            />
          )}

          {currentTab === 'settings' && (
            <TwilioSettingsView
              serverConfig={serverConfig}
              savedConfig={savedTwilioConfig}
              onSaveConfig={handleSaveTwilioConfig}
              savedCarriersConfig={carriersConfig}
              onSaveCarriersConfig={handleSaveCarriersConfig}
              deviceLabel={deviceLabel}
              onResetDeviceSession={handleResetDeviceSession}
            />
          )}
        </main>
      </div>

      {/* Recipient Phone Floating Popout (active when undocked or opened via mobile trigger) */}
      {isPhoneModalOpen && (
        <PhoneSimulatorView
          session={activeSession}
          onSimulateEvent={handleSimulateEvent}
          onRecordingSaved={handleRecordingSaved}
          soundEnabled={soundEnabled}
          isDocked={false}
          onClose={() => setIsPhoneModalOpen(false)}
          onToggleDock={() => {
            setIsPhoneDocked(true);
            setIsPhoneModalOpen(false);
          }}
        />
      )}
    </div>
  );
}
