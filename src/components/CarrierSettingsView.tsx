import React, { useState, useEffect } from 'react';
import {
  Key,
  Phone,
  Copy,
  Check,
  CheckCircle,
  Info,
  Server,
  Globe,
  Lock,
  Eye,
  EyeOff,
  Zap,
  ShieldCheck,
  RotateCcw,
  RefreshCw,
  AlertCircle,
} from 'lucide-react';
import { normalizeE164Phone } from '../utils/phoneFormat';
import { getDeviceHeaders } from '../utils/deviceSession';
import {
  ServerConfig,
  TwilioConfig,
  PlivoConfig,
  TelnyxConfig,
  SignalWireConfig,
  FonosterConfig,
  CarriersConfig,
  TelephonyCarrier,
} from '../types/telephony';

interface CarrierSettingsViewProps {
  serverConfig: ServerConfig | null;
  savedCarriersConfig: CarriersConfig | null;
  onSaveCarriersConfig: (config: CarriersConfig) => void;
  savedConfig?: TwilioConfig | null;
  onSaveConfig?: (config: TwilioConfig) => void;
  deviceLabel?: string;
  onResetDeviceSession?: () => void;
}

interface CarrierMeta {
  id: TelephonyCarrier;
  name: string;
  badge: string;
  color: string;
  description: string;
  docsUrl: string;
}

const CARRIER_LIST: CarrierMeta[] = [
  {
    id: 'twilio',
    name: 'Twilio',
    badge: 'TwiML Voice',
    color: 'from-rose-600 to-red-600',
    description: 'Dispatch calls with Twilio Voice API, TwiML, and real-time DTMF Gather webhooks.',
    docsUrl: 'https://console.twilio.com',
  },
  {
    id: 'plivo',
    name: 'Plivo',
    badge: 'Plivo XML',
    color: 'from-blue-600 to-cyan-600',
    description: 'Dispatch calls via Plivo Voice REST API and interactive Plivo XML Speak & GetDigits elements.',
    docsUrl: 'https://console.plivo.com',
  },
  {
    id: 'telnyx',
    name: 'Telnyx',
    badge: 'TeXML Voice',
    color: 'from-emerald-600 to-teal-600',
    description: 'Dispatch calls with Telnyx Voice API and TeXML compatible Gather & Say endpoints.',
    docsUrl: 'https://portal.telnyx.com',
  },
  {
    id: 'signalwire',
    name: 'SignalWire',
    badge: 'LAML Voice',
    color: 'from-indigo-600 to-violet-600',
    description: 'Dispatch calls with SignalWire Compatibility API and interactive LAML responses.',
    docsUrl: 'https://signalwire.com',
  },
  {
    id: 'fonoster',
    name: 'Fonoster',
    badge: 'Stream Voice API',
    color: 'from-amber-600 to-orange-600',
    description: 'Dispatch real outbound PSTN calls via Fonoster Cloud/Self-Hosted gRPC API & Voice Stream.',
    docsUrl: 'https://fonoster.com',
  },
];

export const CarrierSettingsView: React.FC<CarrierSettingsViewProps> = ({
  serverConfig,
  savedCarriersConfig,
  onSaveCarriersConfig,
  savedConfig,
  onSaveConfig,
  deviceLabel,
  onResetDeviceSession,
}) => {
  const [activeCarrierTab, setActiveCarrierTab] = useState<TelephonyCarrier>(() => {
    return savedCarriersConfig?.activeCarrier || 'twilio';
  });

  // Carrier Config States
  const [twilio, setTwilio] = useState<TwilioConfig>({
    accountSid: savedCarriersConfig?.twilio?.accountSid || savedConfig?.accountSid || '',
    authToken: savedCarriersConfig?.twilio?.authToken || savedConfig?.authToken || '',
    phoneNumber: savedCarriersConfig?.twilio?.phoneNumber || savedConfig?.phoneNumber || '',
  });

  const [plivo, setPlivo] = useState<PlivoConfig>({
    authId: savedCarriersConfig?.plivo?.authId || '',
    authToken: savedCarriersConfig?.plivo?.authToken || '',
    phoneNumber: savedCarriersConfig?.plivo?.phoneNumber || '',
  });

  const [telnyx, setTelnyx] = useState<TelnyxConfig>({
    apiKey: savedCarriersConfig?.telnyx?.apiKey || '',
    connectionId: savedCarriersConfig?.telnyx?.connectionId || '',
    phoneNumber: savedCarriersConfig?.telnyx?.phoneNumber || '',
  });

  const [signalwire, setSignalwire] = useState<SignalWireConfig>({
    spaceUrl: savedCarriersConfig?.signalwire?.spaceUrl || '',
    projectId: savedCarriersConfig?.signalwire?.projectId || '',
    apiToken: savedCarriersConfig?.signalwire?.apiToken || '',
    phoneNumber: savedCarriersConfig?.signalwire?.phoneNumber || '',
  });

  const [fonoster, setFonoster] = useState<FonosterConfig>({
    projectId: savedCarriersConfig?.fonoster?.projectId || '',
    accessKeyId: savedCarriersConfig?.fonoster?.accessKeyId || '',
    accessKeySecret: savedCarriersConfig?.fonoster?.accessKeySecret || '',
    phoneNumber: savedCarriersConfig?.fonoster?.phoneNumber || '',
    endpoint: savedCarriersConfig?.fonoster?.endpoint || '',
    appRef: savedCarriersConfig?.fonoster?.appRef || '',
  });
  const [showSelfHostedEndpoint, setShowSelfHostedEndpoint] = useState<boolean>(() =>
    Boolean(savedCarriersConfig?.fonoster?.endpoint)
  );

  const [showTokens, setShowTokens] = useState<Record<string, boolean>>({});
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [savedSuccess, setSavedSuccess] = useState<string | null>(null);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const [fonosterTesting, setFonosterTesting] = useState(false);
  const [fonosterTestResult, setFonosterTestResult] = useState<{
    ok: boolean;
    message: string;
    detail?: string;
  } | null>(null);

  // Sync when parent config updates (including full wipe on session rotation)
  useEffect(() => {
    if (savedCarriersConfig) {
      setActiveCarrierTab(savedCarriersConfig.activeCarrier || 'twilio');
      setTwilio(
        savedCarriersConfig.twilio || { accountSid: '', authToken: '', phoneNumber: '' }
      );
      setPlivo(
        savedCarriersConfig.plivo || { authId: '', authToken: '', phoneNumber: '' }
      );
      setTelnyx(
        savedCarriersConfig.telnyx || { apiKey: '', connectionId: '', phoneNumber: '' }
      );
      setSignalwire(
        savedCarriersConfig.signalwire || {
          spaceUrl: '',
          projectId: '',
          apiToken: '',
          phoneNumber: '',
        }
      );
      const savedEndpoint = savedCarriersConfig.fonoster?.endpoint || '';
      setFonoster(
        savedCarriersConfig.fonoster
          ? {
              projectId: savedCarriersConfig.fonoster.projectId || '',
              accessKeyId: savedCarriersConfig.fonoster.accessKeyId || '',
              accessKeySecret: savedCarriersConfig.fonoster.accessKeySecret || '',
              phoneNumber: savedCarriersConfig.fonoster.phoneNumber || '',
              endpoint: savedEndpoint,
              appRef: savedCarriersConfig.fonoster.appRef || '',
            }
          : {
              projectId: '',
              accessKeyId: '',
              accessKeySecret: '',
              phoneNumber: '',
              endpoint: '',
              appRef: '',
            }
      );
      if (savedEndpoint) {
        setShowSelfHostedEndpoint(true);
      }
    } else if (savedConfig) {
      setTwilio(savedConfig);
    }
  }, [savedCarriersConfig, savedConfig]);

  // Public URL resolution
  const browserOrigin = typeof window !== 'undefined' && window.location.origin ? window.location.origin : '';
  const isBrowserLocal = !browserOrigin || browserOrigin.includes('localhost') || browserOrigin.includes('127.0.0.1');

  const appUrl = !isBrowserLocal
    ? browserOrigin
    : (serverConfig?.appUrl && !serverConfig.appUrl.includes('localhost')
      ? serverConfig.appUrl
      : browserOrigin || 'http://localhost:3000');

  const toggleShowToken = (key: string) => {
    setShowTokens((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedUrl(id);
    setTimeout(() => setCopiedUrl(null), 2000);
  };

  const currentSelectedCarrier = savedCarriersConfig?.activeCarrier || 'twilio';

  const buildNormalizedConfig = (activeCarrier: TelephonyCarrier): CarriersConfig => {
    const normTwilio: TwilioConfig = {
      ...twilio,
      phoneNumber: twilio.phoneNumber ? normalizeE164Phone(twilio.phoneNumber) : '',
    };
    const normPlivo: PlivoConfig = {
      ...plivo,
      phoneNumber: plivo.phoneNumber ? normalizeE164Phone(plivo.phoneNumber) : '',
    };
    const normTelnyx: TelnyxConfig = {
      ...telnyx,
      phoneNumber: telnyx.phoneNumber ? normalizeE164Phone(telnyx.phoneNumber) : '',
    };
    const normSignalwire: SignalWireConfig = {
      ...signalwire,
      phoneNumber: signalwire.phoneNumber ? normalizeE164Phone(signalwire.phoneNumber) : '',
    };
    const cleanFonosterEndpoint = (fonoster.endpoint || '').trim();
    const cleanFonosterAppRef = (fonoster.appRef || '').trim();
    const normFonoster: FonosterConfig = {
      projectId: fonoster.projectId.trim(),
      accessKeyId: fonoster.accessKeyId.trim(),
      accessKeySecret: fonoster.accessKeySecret.trim(),
      phoneNumber: fonoster.phoneNumber.trim() ? normalizeE164Phone(fonoster.phoneNumber.trim()) : '',
      ...(cleanFonosterEndpoint ? { endpoint: cleanFonosterEndpoint } : {}),
      ...(cleanFonosterAppRef ? { appRef: cleanFonosterAppRef } : {}),
    };

    setTwilio(normTwilio);
    setPlivo(normPlivo);
    setTelnyx(normTelnyx);
    setSignalwire(normSignalwire);
    setFonoster(normFonoster);

    return {
      activeCarrier,
      twilio: normTwilio,
      plivo: normPlivo,
      telnyx: normTelnyx,
      signalwire: normSignalwire,
      fonoster: normFonoster,
    };
  };

  const handleSetActiveCarrier = (carrier: TelephonyCarrier) => {
    const updated = buildNormalizedConfig(carrier);
    onSaveCarriersConfig(updated);
    setSavedSuccess(`Active carrier set to ${carrier.toUpperCase()}`);
    setTimeout(() => setSavedSuccess(null), 2500);
  };

  const handleSaveCurrentCarrier = (e: React.FormEvent) => {
    e.preventDefault();
    const updated = buildNormalizedConfig(currentSelectedCarrier);
    onSaveCarriersConfig(updated);

    if (onSaveConfig && updated.twilio) {
      onSaveConfig(updated.twilio);
    }

    setSavedSuccess(`${activeCarrierTab.toUpperCase()} credentials saved successfully!`);
    setTimeout(() => setSavedSuccess(null), 2500);

    // Automatically enforce Speech=None & PCM16 16kHz on the Fonoster Stream App whenever Fonoster settings are saved
    if (
      activeCarrierTab === 'fonoster' &&
      updated.fonoster?.projectId &&
      updated.fonoster?.accessKeyId &&
      updated.fonoster?.accessKeySecret
    ) {
      void fetch('/api/fonoster/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getDeviceHeaders(),
        },
        body: JSON.stringify({
          projectId: updated.fonoster.projectId,
          accessKeyId: updated.fonoster.accessKeyId,
          accessKeySecret: updated.fonoster.accessKeySecret,
          appRef: updated.fonoster.appRef || undefined,
          endpoint: updated.fonoster.endpoint || undefined,
          syncApp: true,
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data?.ok && typeof data.syncedAppRef === 'string' && data.syncedAppRef.trim()) {
            const nextFonoster: FonosterConfig = {
              ...updated.fonoster!,
              appRef: data.syncedAppRef.trim(),
            };
            setFonoster(nextFonoster);
            onSaveCarriersConfig({ ...updated, fonoster: nextFonoster });
          }
        })
        .catch(() => {
          // Silent background sync on save; user can still click Test Connection & Sync for detailed diagnostics
        });
    }
  };

  const handleVerifyFonoster = async () => {
    setFonosterTestResult(null);
    const cleanProjectId = fonoster.projectId.trim();
    const cleanAccessKeyId = fonoster.accessKeyId.trim();
    const cleanAccessKeySecret = fonoster.accessKeySecret.trim();
    const cleanPhoneNumber = fonoster.phoneNumber.trim();
    const cleanEndpoint = (fonoster.endpoint || '').trim();

    if (!cleanProjectId || !cleanAccessKeyId || !cleanAccessKeySecret) {
      setFonosterTestResult({
        ok: false,
        message: 'Enter Workspace Access Key ID (WO...), API Key ID (AP...), and API Key Secret first.',
      });
      return;
    }

    setFonosterTesting(true);
    try {
      const res = await fetch('/api/fonoster/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getDeviceHeaders(),
        },
        body: JSON.stringify({
          projectId: cleanProjectId,
          accessKeyId: cleanAccessKeyId,
          accessKeySecret: cleanAccessKeySecret,
          endpoint: cleanEndpoint || undefined,
          syncApp: true,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        if (data?.needsSelfHostedEndpoint) {
          setShowSelfHostedEndpoint(true);
        }
        setFonosterTestResult({
          ok: false,
          message: data.error || 'Fonoster authentication failed. Double-check your workspace and API keys.',
        });
        return;
      }

      const firstNum =
        Array.isArray(data.numbers) && data.numbers[0]?.telUrl
          ? String(data.numbers[0].telUrl).replace(/^tel:/i, '').trim()
          : '';
      const resolvedPhone = cleanPhoneNumber || firstNum;
      const resolvedAppRef =
        typeof data.syncedAppRef === 'string' && data.syncedAppRef.trim()
          ? data.syncedAppRef.trim()
          : (fonoster.appRef || '').trim();
      const updatedFonoster: FonosterConfig = {
        projectId: cleanProjectId,
        accessKeyId: cleanAccessKeyId,
        accessKeySecret: cleanAccessKeySecret,
        phoneNumber: resolvedPhone ? normalizeE164Phone(resolvedPhone) : '',
        ...(cleanEndpoint ? { endpoint: cleanEndpoint } : {}),
        ...(resolvedAppRef ? { appRef: resolvedAppRef } : {}),
      };
      setFonoster(updatedFonoster);

      const normalized = buildNormalizedConfig(currentSelectedCarrier);
      onSaveCarriersConfig({
        ...normalized,
        fonoster: updatedFonoster,
      });

      const appLabel =
        data.appAction === 'created'
          ? 'Auto-created Voice Stream App'
          : data.appAction === 'updated'
          ? 'Synced Voice Stream App'
          : 'Connected to Voice Stream App';

      const numCount = Array.isArray(data.numbers) ? data.numbers.length : 0;
      const endpointNote = data.endpoint ? ` Endpoint: ${data.endpoint}.` : '';
      setFonosterTestResult({
        ok: true,
        message: `Connected to Fonoster! ${appLabel}.`,
        detail: `${numCount} workspace number${numCount === 1 ? '' : 's'} found.${endpointNote}${
          data.warning ? ` Note: ${data.warning}` : ''
        }`,
      });
    } catch (err: any) {
      setFonosterTestResult({
        ok: false,
        message: err?.message || 'Network error verifying Fonoster credentials.',
      });
    } finally {
      setFonosterTesting(false);
    }
  };

  // Helper to check if a carrier is configured strictly on THIS device
  const isCarrierConfigured = (carrier: TelephonyCarrier) => {
    switch (carrier) {
      case 'twilio':
        return Boolean(twilio.accountSid && twilio.authToken && twilio.phoneNumber);
      case 'plivo':
        return Boolean(plivo.authId && plivo.authToken && plivo.phoneNumber);
      case 'telnyx':
        return Boolean(telnyx.apiKey && telnyx.connectionId && telnyx.phoneNumber);
      case 'signalwire':
        return Boolean(signalwire.spaceUrl && signalwire.projectId && signalwire.apiToken && signalwire.phoneNumber);
      case 'fonoster':
        return Boolean(fonoster.projectId && fonoster.accessKeyId && fonoster.accessKeySecret && fonoster.phoneNumber);
      default:
        return false;
    }
  };

  // Get webhooks for currently displayed carrier tab
  const getCarrierWebhooks = (carrier: TelephonyCarrier) => {
    switch (carrier) {
      case 'twilio':
        return [
          { label: 'Outbound TwiML URL', url: `${appUrl}/api/twiml/outbound`, method: 'POST/GET' },
          { label: 'DTMF <Gather> Action URL', url: `${appUrl}/api/twiml/gather`, method: 'POST' },
          { label: 'Call Status Callback URL', url: `${appUrl}/api/twiml/status`, method: 'POST' },
        ];
      case 'plivo':
        return [
          { label: 'Answer URL (Plivo XML)', url: `${appUrl}/api/plivo/outbound`, method: 'POST' },
          { label: 'GetDigits Action URL', url: `${appUrl}/api/plivo/gather`, method: 'POST' },
          { label: 'Hangup / Status URL', url: `${appUrl}/api/plivo/status`, method: 'POST' },
        ];
      case 'telnyx':
        return [
          { label: 'TeXML Webhook URL', url: `${appUrl}/api/telnyx/texml`, method: 'POST' },
          { label: 'TeXML Gather Callback', url: `${appUrl}/api/telnyx/gather`, method: 'POST' },
          { label: 'Status Callback URL', url: `${appUrl}/api/telnyx/status`, method: 'POST' },
        ];
      case 'signalwire':
        return [
          { label: 'Voice URL (LAML)', url: `${appUrl}/api/signalwire/laml`, method: 'POST' },
          { label: 'Gather Callback URL', url: `${appUrl}/api/signalwire/gather`, method: 'POST' },
          { label: 'Status Callback URL', url: `${appUrl}/api/signalwire/status`, method: 'POST' },
        ];
      case 'fonoster': {
        const wsUrl = appUrl.startsWith('https://')
          ? `wss://${appUrl.slice('https://'.length)}/api/fonoster/stream`
          : `ws://${appUrl.replace(/^http:\/\//, '')}/api/fonoster/stream`;
        return [
          { label: 'Voice Stream Endpoint (Auto-Synced)', url: wsUrl, method: 'WSS' },
          { label: 'Fallback Voice Webhook URL', url: `${appUrl}/api/fonoster/webhook`, method: 'POST' },
          { label: 'Status Event Webhook', url: `${appUrl}/api/fonoster/status`, method: 'POST' },
        ];
      }
    }
  };

  const currentTabMeta = CARRIER_LIST.find((c) => c.id === activeCarrierTab)!;
  const webhooks = getCarrierWebhooks(activeCarrierTab);
  const isCurrentActive = currentSelectedCarrier === activeCarrierTab;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Top Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 lg:p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <div className="w-2.5 h-2.5 rounded-full bg-indigo-400"></div>
              <h2 className="text-base font-bold text-white tracking-tight">
                Multi-Carrier PSTN Telephony Configuration
              </h2>
            </div>
            <p className="text-xs text-slate-400 max-w-2xl leading-relaxed">
              Connect <strong>Twilio</strong>, <strong>Plivo</strong>, <strong>Telnyx</strong>, <strong>SignalWire</strong>, or <strong>Fonoster</strong> to dispatch real cellular calls. You can store credentials for all five carriers and toggle the active dispatcher at any time.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {deviceLabel && (
              <span
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-mono font-semibold bg-emerald-500/10 text-emerald-300 border border-emerald-500/30"
                title="API credentials and call recordings are strictly isolated to this device session"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                <span>Device: {deviceLabel}</span>
              </span>
            )}
            <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-indigo-500/10 text-indigo-300 border border-indigo-500/30">
              <Zap className="w-3.5 h-3.5 text-indigo-400" />
              <span>Active: {currentSelectedCarrier.toUpperCase()}</span>
            </span>
          </div>
        </div>

        {/* Per-Device Session Isolation Notice & Wipe/Rotate Control */}
        <div className="mt-4 pt-3.5 border-t border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <p className="text-[11px] text-slate-400">
            <strong className="text-emerald-300">Private Device Session:</strong> Your carrier API keys, call history, and audio recordings belong exclusively to this browser/device and never appear on any other user&apos;s device.
          </p>

          {onResetDeviceSession && (
            <div className="flex items-center gap-2 shrink-0">
              {!confirmResetOpen ? (
                <button
                  type="button"
                  onClick={() => setConfirmResetOpen(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-950 hover:bg-rose-950/50 text-slate-300 hover:text-rose-300 border border-slate-700 hover:border-rose-500/40 text-xs font-medium transition-colors cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>New Isolated Session / Wipe Keys</span>
                </button>
              ) : (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmResetOpen(false);
                      onResetDeviceSession();
                      setSavedSuccess('Created fresh isolated device session and wiped saved API keys.');
                      setTimeout(() => setSavedSuccess(null), 3000);
                    }}
                    className="px-2.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold cursor-pointer"
                  >
                    Confirm Wipe &amp; Rotate
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmResetOpen(false)}
                    className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Carrier Selection Tabs */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {CARRIER_LIST.map((carrier) => {
          const isSelected = activeCarrierTab === carrier.id;
          const isLiveCarrier = currentSelectedCarrier === carrier.id;
          const isConfigured = isCarrierConfigured(carrier.id);

          return (
            <button
              key={carrier.id}
              type="button"
              onClick={() => setActiveCarrierTab(carrier.id)}
              className={`p-3 rounded-xl border text-left transition-all relative ${
                isSelected
                  ? 'bg-slate-900 border-indigo-500 shadow-md ring-1 ring-indigo-500/40'
                  : 'bg-slate-950/80 border-slate-800 hover:border-slate-700 hover:bg-slate-900/60'
              }`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-bold text-white">{carrier.name}</span>
                {isLiveCarrier && (
                  <span className="w-2 h-2 rounded-full bg-emerald-400" title="Active Carrier"></span>
                )}
              </div>
              <div className="text-[10px] text-slate-400 font-mono mb-1">{carrier.badge}</div>
              <div className="flex items-center gap-1 text-[10px]">
                {isConfigured ? (
                  <span className="text-emerald-400 font-medium">Configured</span>
                ) : (
                  <span className="text-slate-500">Not set</span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Main Carrier Configuration Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Credentials Form (7 cols) */}
        <div className="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-2xl p-5 lg:p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
                <Key className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <span>{currentTabMeta.name} API Credentials</span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                    {currentTabMeta.badge}
                  </span>
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5">{currentTabMeta.description}</p>
              </div>
            </div>

            {!isCurrentActive ? (
              <button
                type="button"
                onClick={() => handleSetActiveCarrier(activeCarrierTab)}
                className="py-1 px-2.5 bg-slate-800 hover:bg-indigo-600 hover:text-white text-slate-300 rounded-lg text-xs font-medium border border-slate-700 transition-all shrink-0"
              >
                Set as Active
              </button>
            ) : (
              <span className="flex items-center gap-1 text-xs font-semibold text-emerald-400 px-2 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/20">
                <CheckCircle className="w-3.5 h-3.5" />
                <span>Primary</span>
              </span>
            )}
          </div>

          <form onSubmit={handleSaveCurrentCarrier} className="space-y-4">
            {/* 1. TWILIO FORM */}
            {activeCarrierTab === 'twilio' && (
              <>
                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                    Twilio Account SID
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={twilio.accountSid}
                      onChange={(e) => setTwilio({ ...twilio, accountSid: e.target.value.trim() })}
                      placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                      className="w-full pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                      <Key className="w-3.5 h-3.5" />
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">Found in your Twilio Console overview.</p>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                    Twilio Auth Token
                  </label>
                  <div className="relative">
                    <input
                      type={showTokens['twilio'] ? 'text' : 'password'}
                      value={twilio.authToken}
                      onChange={(e) => setTwilio({ ...twilio, authToken: e.target.value.trim() })}
                      placeholder="Your Twilio Auth Token"
                      className="w-full pl-9 pr-10 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                      <Lock className="w-3.5 h-3.5" />
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleShowToken('twilio')}
                      className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-500 hover:text-slate-300"
                    >
                      {showTokens['twilio'] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                    Twilio Caller ID Phone Number (E.164)
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={twilio.phoneNumber}
                      onChange={(e) => setTwilio({ ...twilio, phoneNumber: e.target.value.trim() })}
                      placeholder="+18005550199"
                      className="w-full pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                      <Phone className="w-3.5 h-3.5" />
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">Must be an active number on your Twilio account.</p>
                </div>
              </>
            )}

            {/* 2. PLIVO FORM */}
            {activeCarrierTab === 'plivo' && (
              <>
                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                    Plivo Auth ID
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={plivo.authId}
                      onChange={(e) => setPlivo({ ...plivo, authId: e.target.value.trim() })}
                      placeholder="MAMZxxxxxxxxxxxxxxxxxxxx"
                      className="w-full pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                      <Key className="w-3.5 h-3.5" />
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">Found in your Plivo dashboard overview.</p>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                    Plivo Auth Token
                  </label>
                  <div className="relative">
                    <input
                      type={showTokens['plivo'] ? 'text' : 'password'}
                      value={plivo.authToken}
                      onChange={(e) => setPlivo({ ...plivo, authToken: e.target.value.trim() })}
                      placeholder="Your Plivo Auth Token"
                      className="w-full pl-9 pr-10 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                      <Lock className="w-3.5 h-3.5" />
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleShowToken('plivo')}
                      className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-500 hover:text-slate-300"
                    >
                      {showTokens['plivo'] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                    Plivo Caller ID Number (E.164)
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={plivo.phoneNumber}
                      onChange={(e) => setPlivo({ ...plivo, phoneNumber: e.target.value.trim() })}
                      placeholder="+18005550199"
                      className="w-full pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                      <Phone className="w-3.5 h-3.5" />
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* 3. TELNYX FORM */}
            {activeCarrierTab === 'telnyx' && (
              <>
                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                    Telnyx API Key (V2)
                  </label>
                  <div className="relative">
                    <input
                      type={showTokens['telnyx'] ? 'text' : 'password'}
                      value={telnyx.apiKey}
                      onChange={(e) => setTelnyx({ ...telnyx, apiKey: e.target.value.trim() })}
                      placeholder="KEY0123456789..."
                      className="w-full pl-9 pr-10 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                      <Key className="w-3.5 h-3.5" />
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleShowToken('telnyx')}
                      className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-500 hover:text-slate-300"
                    >
                      {showTokens['telnyx'] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">Generated under Account &rarr; Keys &amp; Credentials in Telnyx Portal.</p>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                    Telnyx Connection ID / TeXML Application ID
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={telnyx.connectionId}
                      onChange={(e) => setTelnyx({ ...telnyx, connectionId: e.target.value.trim() })}
                      placeholder="12345678-abcd-ef01-2345-6789abcdef01"
                      className="w-full pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                      <Server className="w-3.5 h-3.5" />
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">The SIP Connection or TeXML Application ID assigned to your phone number.</p>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                    Telnyx Caller ID Number (E.164)
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={telnyx.phoneNumber}
                      onChange={(e) => setTelnyx({ ...telnyx, phoneNumber: e.target.value.trim() })}
                      placeholder="+18005550199"
                      className="w-full pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                      <Phone className="w-3.5 h-3.5" />
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* 4. SIGNALWIRE FORM */}
            {activeCarrierTab === 'signalwire' && (
              <>
                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                    SignalWire Space URL
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={signalwire.spaceUrl}
                      onChange={(e) => setSignalwire({ ...signalwire, spaceUrl: e.target.value.trim() })}
                      placeholder="yourspace.signalwire.com"
                      className="w-full pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                      <Globe className="w-3.5 h-3.5" />
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                    SignalWire Project ID
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={signalwire.projectId}
                      onChange={(e) => setSignalwire({ ...signalwire, projectId: e.target.value.trim() })}
                      placeholder="3c44xxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      className="w-full pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                      <Key className="w-3.5 h-3.5" />
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                    SignalWire API Token
                  </label>
                  <div className="relative">
                    <input
                      type={showTokens['signalwire'] ? 'text' : 'password'}
                      value={signalwire.apiToken}
                      onChange={(e) => setSignalwire({ ...signalwire, apiToken: e.target.value.trim() })}
                      placeholder="PTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                      className="w-full pl-9 pr-10 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                      <Lock className="w-3.5 h-3.5" />
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleShowToken('signalwire')}
                      className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-500 hover:text-slate-300"
                    >
                      {showTokens['signalwire'] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                    SignalWire Phone Number (E.164)
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={signalwire.phoneNumber}
                      onChange={(e) => setSignalwire({ ...signalwire, phoneNumber: e.target.value.trim() })}
                      placeholder="+18005550199"
                      className="w-full pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                      <Phone className="w-3.5 h-3.5" />
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* 5. FONOSTER FORM */}
            {activeCarrierTab === 'fonoster' && (
              <>
                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                    Workspace Access Key ID
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={fonoster.projectId}
                      onChange={(e) => setFonoster({ ...fonoster, projectId: e.target.value.trim() })}
                      placeholder="WOxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                      className="w-full min-h-[44px] pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                      <Key className="w-3.5 h-3.5" />
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">
                    Your Fonoster Workspace Access Key ID (starts with <span className="font-mono text-slate-300">WO</span>).
                  </p>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                    API Key Access Key ID
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={fonoster.accessKeyId}
                      onChange={(e) => setFonoster({ ...fonoster, accessKeyId: e.target.value.trim() })}
                      placeholder="APxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                      className="w-full min-h-[44px] pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                      <Key className="w-3.5 h-3.5" />
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">
                    API Key ID from Workspace &rarr; API Keys (starts with <span className="font-mono text-slate-300">AP</span>).
                  </p>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                    API Key Secret
                  </label>
                  <div className="relative">
                    <input
                      type={showTokens['fonoster'] ? 'text' : 'password'}
                      value={fonoster.accessKeySecret}
                      onChange={(e) => setFonoster({ ...fonoster, accessKeySecret: e.target.value.trim() })}
                      placeholder="Your Fonoster API Key Secret"
                      className="w-full min-h-[44px] pl-9 pr-10 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                      <Lock className="w-3.5 h-3.5" />
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleShowToken('fonoster')}
                      className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-500 hover:text-slate-300"
                    >
                      {showTokens['fonoster'] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                    Caller ID Phone Number (E.164)
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={fonoster.phoneNumber}
                      onChange={(e) => setFonoster({ ...fonoster, phoneNumber: e.target.value.trim() })}
                      placeholder="+18005550199"
                      className="w-full min-h-[44px] pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                      <Phone className="w-3.5 h-3.5" />
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">
                    Active outbound phone number configured on your Fonoster trunk.
                  </p>
                </div>

                {/* Collapsed Self-Hosted Server Address Toggle (hidden by default to keep form clean) */}
                <div>
                  <button
                    type="button"
                    onClick={() => setShowSelfHostedEndpoint((prev) => !prev)}
                    className="text-[11px] text-slate-400 hover:text-indigo-300 transition-colors flex items-center gap-1.5 cursor-pointer"
                  >
                    <Server className="w-3 h-3" />
                    <span>
                      {showSelfHostedEndpoint
                        ? 'Hide self-hosted Fonoster server address'
                        : 'Using a self-hosted Fonoster server? Set server address'}
                    </span>
                  </button>

                  {showSelfHostedEndpoint && (
                    <div className="mt-2">
                      <div className="relative">
                        <input
                          type="text"
                          value={fonoster.endpoint || ''}
                          onChange={(e) => setFonoster({ ...fonoster, endpoint: e.target.value.trim() })}
                          placeholder="your-server-ip:8449 or fonoster.yourdomain.com"
                          className="w-full min-h-[44px] pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                        />
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                          <Globe className="w-3.5 h-3.5" />
                        </div>
                      </div>
                      <p className="text-[11px] text-slate-500 mt-1">
                        Leave blank when using Fonoster Cloud or when VoiceDrop is deployed on the same VPS (auto-detected). Required only when connecting from a remote preview to your self-hosted server.
                      </p>
                    </div>
                  )}
                </div>

                {/* Live Fonoster Connection Test & Voice App Auto-Sync */}
                <div className="pt-1 space-y-2">
                  <button
                    type="button"
                    onClick={handleVerifyFonoster}
                    disabled={fonosterTesting}
                    className="w-full sm:w-auto min-h-[42px] px-4 py-2 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/35 text-amber-200 text-xs font-semibold flex items-center justify-center gap-2 transition-colors disabled:opacity-60 cursor-pointer"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${fonosterTesting ? 'animate-spin' : ''}`} />
                    <span>{fonosterTesting ? 'Verifying & Syncing Voice App...' : 'Test Connection & Sync Voice App'}</span>
                  </button>

                  {fonosterTestResult && (
                    <div
                      className={`p-3 rounded-xl border text-xs flex items-start gap-2 ${
                        fonosterTestResult.ok
                          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                          : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                      }`}
                    >
                      {fonosterTestResult.ok ? (
                        <CheckCircle className="w-4 h-4 shrink-0 mt-0.5 text-emerald-400" />
                      ) : (
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
                      )}
                      <div>
                        <p className="font-semibold">{fonosterTestResult.message}</p>
                        {fonosterTestResult.detail && (
                          <p className="text-[11px] opacity-85 mt-0.5">{fonosterTestResult.detail}</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* Save Buttons & Feedback */}
            <div className="pt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              {savedSuccess ? (
                <span className="text-xs text-emerald-400 font-semibold flex items-center gap-1">
                  <CheckCircle className="w-4 h-4 shrink-0" />
                  <span>{savedSuccess}</span>
                </span>
              ) : (
                <span className="text-[11px] text-slate-500">
                  Credentials persist locally in your browser storage.
                </span>
              )}

              <button
                type="submit"
                className="w-full sm:w-auto min-h-[44px] py-2.5 px-5 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-xl transition-all shadow-sm shadow-indigo-600/30 cursor-pointer"
              >
                Save {currentTabMeta.name} Settings
              </button>
            </div>
          </form>
        </div>

        {/* Webhooks & Carrier Endpoints (5 cols) */}
        <div className="lg:col-span-5 space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                Automated {currentTabMeta.name} Webhooks
              </h3>
              {!isBrowserLocal && (
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-semibold">
                  Live Host Active
                </span>
              )}
            </div>

            <p className="text-[11px] text-slate-400 mb-3 leading-relaxed">
              Copy and paste these endpoints into your <strong>{currentTabMeta.name}</strong> phone number settings or voice application:
            </p>

            <div className="space-y-3">
              {webhooks.map((hook, idx) => (
                <div key={idx} className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] uppercase font-bold text-slate-400">{hook.label}</span>
                    <button
                      type="button"
                      onClick={() => handleCopy(hook.url, `hook-${idx}`)}
                      className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                    >
                      {copiedUrl === `hook-${idx}` ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      <span>{copiedUrl === `hook-${idx}` ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                  <div className="font-mono text-[11px] text-slate-300 truncate" title={hook.url}>
                    {hook.url}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Help box */}
          <div className="p-4 bg-slate-900/60 border border-slate-800 rounded-2xl text-xs text-slate-400 leading-relaxed">
            <h4 className="font-semibold text-slate-200 mb-1 flex items-center gap-1.5">
              <Info className="w-4 h-4 text-indigo-400" />
              <span>Zero-Config Simulator Mode</span>
            </h4>
            <p>
              If you don't have active accounts or phone numbers configured right now, you can keep testing seamlessly! Switch the mode toggle to <strong>Simulator</strong> to test live verification calls, keypad inputs, and operator approval flows directly in the docked phone mockup.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
