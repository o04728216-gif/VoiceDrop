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
import { PhoneSimulatorModal } from './components/PhoneSimulatorModal';
import { CallSession, ServerConfig, TwilioConfig } from './types/telephony';
import {
  playDtmfTone,
  startRingbackTone,
  stopRingbackTone,
  playConnectedChime,
  playHangupTone,
} from './utils/audioTones';
import { AlertCircle, X } from 'lucide-react';

const STORAGE_KEY_TWILIO = 'voicedrop_twilio_config';
const STORAGE_KEY_SOUND = 'voicedrop_sound_enabled';
const STORAGE_KEY_MODE = 'voicedrop_active_mode';

export default function App() {
  const [currentTab, setCurrentTab] = useState<NavTab>('dispatcher');
  const [activeSession, setActiveSession] = useState<CallSession | null>(null);
  const [activeDigit, setActiveDigit] = useState<string | null>(null);
  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);
  const [savedTwilioConfig, setSavedTwilioConfig] = useState<TwilioConfig | null>(null);
  const [callsHistory, setCallsHistory] = useState<CallSession[]>([]);

  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    const val = localStorage.getItem(STORAGE_KEY_SOUND);
    return val !== null ? val === 'true' : true;
  });

  const [mode, setMode] = useState<'live' | 'simulator'>(() => {
    const val = localStorage.getItem(STORAGE_KEY_MODE);
    return (val as 'live' | 'simulator') || 'simulator';
  });

  const [isPhoneSimulatorOpen, setIsPhoneSimulatorOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;

  useEffect(() => {
    fetch('/api/config')
      .then((res) => res.json())
      .then((data: ServerConfig) => {
        setServerConfig(data);
        if (data.isTwilioConfigured && !localStorage.getItem(STORAGE_KEY_MODE)) {
          setMode('live');
        }
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
      const res = await fetch('/api/calls');
      if (res.ok) {
        const data = await res.json();
        setCallsHistory(data);
      }
    } catch (err) {
      console.error('Error fetching call history:', err);
    }
  };

  const handleToggleSound = () => {
    setSoundEnabled((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY_SOUND, String(next));
      if (!next) {
        stopRingbackTone();
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
  };

  // SSE Telemetry listener
  useEffect(() => {
    if (!activeSession?.id) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      stopRingbackTone();
      return;
    }

    const es = new EventSource(`/api/call/events/${activeSession.id}`);
    eventSourceRef.current = es;

    es.addEventListener('session-update', (event) => {
      try {
        const updatedSession: CallSession = JSON.parse(event.data);
        setActiveSession(updatedSession);

        if (soundEnabledRef.current) {
          if (updatedSession.status === 'ringing') {
            startRingbackTone();
          } else if (updatedSession.status === 'in-progress') {
            stopRingbackTone();
            playConnectedChime();
          } else if (
            ['completed', 'failed', 'busy', 'no-answer'].includes(updatedSession.status)
          ) {
            stopRingbackTone();
            playHangupTone();
          }
        } else {
          stopRingbackTone();
        }

        if (['completed', 'failed', 'busy', 'no-answer'].includes(updatedSession.status)) {
          loadCallHistory();
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
          setActiveDigit(digit);
          if (soundEnabledRef.current) {
            playDtmfTone(digit);
          }
          setTimeout(() => setActiveDigit(null), 1500);
        }
      } catch (err) {
        console.error('SSE event parse error:', err);
      }
    });

    return () => {
      es.close();
      stopRingbackTone();
    };
  }, [activeSession?.id]);

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
  }) => {
    try {
      setIsLoading(true);
      setErrorBanner(null);

      const payload = {
        ...params,
        mode,
        customTwilio: savedTwilioConfig,
      };

      const res = await fetch('/api/call/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to place call');
      }

      setActiveSession(data.session);

      loadCallHistory();
    } catch (err: any) {
      console.error(err);
      setErrorBanner(err.message || 'Call placement failed. Check carrier configuration.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleEndCall = async () => {
    if (!activeSession) return;
    try {
      stopRingbackTone();
      const res = await fetch('/api/call/hangup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callId: activeSession.id,
          customTwilio: savedTwilioConfig,
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
        headers: { 'Content-Type': 'application/json' },
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
    action: 'approve' | 'reject' | 'hold' | 'incorrect_prompt' | 'custom_cue',
    customMessage?: string
  ) => {
    if (!activeSession) return null;
    try {
      const res = await fetch('/api/call/operator-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callId: activeSession.id,
          action,
          customMessage,
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

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col md:flex-row font-sans selection:bg-indigo-500/30 selection:text-white">
      {/* Left Sidebar Menu */}
      <Sidebar
        currentTab={currentTab}
        onSelectTab={setCurrentTab}
        serverConfig={serverConfig}
        activeSession={activeSession}
        soundEnabled={soundEnabled}
        onToggleSound={handleToggleSound}
        mode={mode}
        onToggleMode={handleToggleMode}
        onOpenSimulator={() => setIsPhoneSimulatorOpen(true)}
        callsCount={callsHistory.length}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        {/* Top Header */}
        <Header
          currentTab={currentTab}
          serverConfig={serverConfig}
          activeSession={activeSession}
          onOpenSimulator={() => setIsPhoneSimulatorOpen(true)}
          onEndCall={handleEndCall}
          soundEnabled={soundEnabled}
          onToggleSound={handleToggleSound}
          mode={mode}
        />

        {/* Error Banner */}
        {errorBanner && (
          <div className="bg-rose-950/90 border-b border-rose-500/30 px-4 py-2.5 flex items-center justify-between text-xs text-rose-200">
            <div className="flex items-center gap-2 max-w-7xl mx-auto w-full">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span className="font-medium">{errorBanner}</span>
            </div>
            <button
              onClick={() => setErrorBanner(null)}
              className="text-rose-400 hover:text-white p-1"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* View Routing Body */}
        <main className="flex-1 p-4 lg:p-6">
          {currentTab === 'dispatcher' && (
            <div className="space-y-6">
              {/* Call setup controls */}
              <div className="flex flex-col">
                <ControlCenter
                  onLaunchCall={handleLaunchCall}
                  isLoading={isLoading}
                  activeCall={
                    activeSession !== null &&
                    ['queued', 'initiating', 'ringing', 'in-progress', 'collecting-input', 'awaiting-operator'].includes(
                      activeSession.status
                    )
                  }
                  mode={mode}
                  hasGemini={Boolean(serverConfig?.hasGemini)}
                  twilioConfig={savedTwilioConfig}
                />
              </div>

              {/* Operator and recipient stay visible together during a simulation */}
              <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-stretch">
                <div className="xl:col-span-7 flex flex-col min-h-[600px]">
                  <LiveSessionFeed
                    session={activeSession}
                    activeDigit={activeDigit}
                    soundEnabled={soundEnabled}
                    onEndCall={handleEndCall}
                    onOpenSimulator={() => setIsPhoneSimulatorOpen(true)}
                    onOperatorAction={handleOperatorAction}
                    onSimulateDtmf={(digit) => {
                      if (activeSession?.isSimulated) {
                        handleSimulateEvent('dtmf', { digits: digit });
                      }
                    }}
                  />
                </div>
                <div className="xl:col-span-5 flex flex-col min-h-[600px]">
                  <PhoneSimulatorModal
                    session={activeSession}
                    isOpen={!isPhoneSimulatorOpen}
                    onClose={() => setIsPhoneSimulatorOpen(false)}
                    onSimulateEvent={handleSimulateEvent}
                    soundEnabled={soundEnabled}
                    embedded
                  />
                </div>
              </div>
            </div>
          )}

          {currentTab === 'keypad' && (
            <KeypadLabView soundEnabled={soundEnabled} />
          )}

          {currentTab === 'history' && (
            <CallHistoryView
              calls={callsHistory}
              onSelectCall={(call) => {
                setActiveSession(call);
                setCurrentTab('dispatcher');
              }}
            />
          )}

          {currentTab === 'settings' && (
            <TwilioSettingsView
              serverConfig={serverConfig}
              savedConfig={savedTwilioConfig}
              onSaveConfig={handleSaveTwilioConfig}
            />
          )}
        </main>
      </div>

      {/* Popup simulator remains available outside the dispatcher page */}
      <PhoneSimulatorModal
        session={activeSession}
        isOpen={isPhoneSimulatorOpen}
        onClose={() => setIsPhoneSimulatorOpen(false)}
        onSimulateEvent={handleSimulateEvent}
        soundEnabled={soundEnabled}
      />
    </div>
  );
}
