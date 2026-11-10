import React, { useState, useEffect } from 'react';
import {
  Sliders,
  Shield,
  Key,
  Phone,
  Copy,
  Check,
  Radio,
  CheckCircle,
  ExternalLink,
  Info,
} from 'lucide-react';
import { ServerConfig, TwilioConfig } from '../types/telephony';

interface TwilioSettingsViewProps {
  serverConfig: ServerConfig | null;
  savedConfig: TwilioConfig | null;
  onSaveConfig: (config: TwilioConfig) => void;
}

export const TwilioSettingsView: React.FC<TwilioSettingsViewProps> = ({
  serverConfig,
  savedConfig,
  onSaveConfig,
}) => {
  const [accountSid, setAccountSid] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [savedSuccess, setSavedSuccess] = useState(false);

  useEffect(() => {
    if (savedConfig) {
      setAccountSid(savedConfig.accountSid || '');
      setAuthToken(savedConfig.authToken || '');
      setPhoneNumber(savedConfig.phoneNumber || '');
    }
  }, [savedConfig]);

  // Dynamically resolve application URL: prioritize current browser origin if on a public domain,
  // or use explicit non-localhost domain from server configuration.
  const appUrl = (() => {
    if (typeof window !== 'undefined' && window.location.origin) {
      const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      if (!isLocalHost) {
        if (serverConfig?.appUrl && !serverConfig.appUrl.includes('localhost') && !serverConfig.appUrl.includes('127.0.0.1')) {
          return serverConfig.appUrl;
        }
        return window.location.origin;
      }
    }
    return serverConfig?.appUrl || (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');
  })();
  const outboundWebhook = `${appUrl}/api/twiml/outbound`;
  const gatherWebhook = `${appUrl}/api/twiml/gather`;
  const statusWebhook = `${appUrl}/api/twiml/status`;

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedUrl(id);
    setTimeout(() => setCopiedUrl(null), 2000);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveConfig({
      accountSid: accountSid.trim(),
      authToken: authToken.trim(),
      phoneNumber: phoneNumber.trim(),
    });
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 2500);
  };

  const isServerConfigured = serverConfig?.isTwilioConfigured;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header Banner */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 lg:p-6 shadow-sm backdrop-blur-md">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="w-2.5 h-2.5 rounded-full bg-indigo-400"></span>
              <h2 className="text-base font-bold text-white tracking-tight">
                Twilio Programmable Voice &amp; Carrier Setup
              </h2>
            </div>
            <p className="text-xs text-slate-400 max-w-2xl leading-relaxed">
              Configure your Twilio telephony credentials to dispatch real cellular calls across the United States PSTN network. All interactive responses stream directly back into the live session feed.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {isServerConfigured ? (
              <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                <CheckCircle className="w-3.5 h-3.5" />
                <span>Twilio Active</span>
              </span>
            ) : (
              <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-indigo-500/10 text-indigo-400 border border-indigo-500/30">
                <span>Simulator Ready</span>
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Credentials Form (7 cols) */}
        <div className="lg:col-span-7 bg-slate-900/90 border border-slate-800 rounded-2xl p-5 lg:p-6 shadow-sm">
          <div className="flex items-center gap-2.5 mb-4 pb-3 border-b border-slate-800">
            <Key className="w-4 h-4 text-indigo-400" />
            <h3 className="text-sm font-bold text-white">Twilio API Keys</h3>
          </div>

          <form onSubmit={handleSave} className="space-y-4">
            {/* Account SID */}
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                Twilio Account SID
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={accountSid}
                  onChange={(e) => setAccountSid(e.target.value)}
                  placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  className="w-full pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                />
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                  <Key className="w-3.5 h-3.5" />
                </div>
              </div>
              <p className="text-[11px] text-slate-500 mt-1">Found in your Twilio Console dashboard overview.</p>
            </div>

            {/* Auth Token */}
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                Twilio Auth Token
              </label>
              <div className="relative">
                <input
                  type="password"
                  value={authToken}
                  onChange={(e) => setAuthToken(e.target.value)}
                  placeholder="Your Twilio Auth Token"
                  className="w-full pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                />
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                  <Key className="w-3.5 h-3.5" />
                </div>
              </div>
            </div>

            {/* Twilio Phone Number */}
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                Twilio Caller ID Phone Number (E.164)
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  placeholder="+18005550199"
                  className="w-full pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                />
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                  <Phone className="w-3.5 h-3.5" />
                </div>
              </div>
              <p className="text-[11px] text-slate-500 mt-1">Must be an active Twilio number with Voice capabilities enabled.</p>
            </div>

            <div className="pt-2 flex items-center justify-between">
              {savedSuccess ? (
                <span className="text-xs text-emerald-400 font-semibold flex items-center gap-1">
                  <CheckCircle className="w-4 h-4" />
                  <span>Configuration saved successfully!</span>
                </span>
              ) : (
                <span className="text-[11px] text-slate-500">
                  Credentials persist locally in your browser storage.
                </span>
              )}

              <button
                type="submit"
                className="py-2.5 px-5 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-xl transition-all shadow-sm shadow-indigo-600/30"
              >
                Save Credentials
              </button>
            </div>
          </form>
        </div>

        {/* Webhooks & Telephony Architecture (5 cols) */}
        <div className="lg:col-span-5 space-y-4">
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-sm">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 mb-3">
              Automated Twilio Webhook Endpoints
            </h3>

            <div className="space-y-3">
              <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] uppercase font-bold text-slate-400">Outbound TwiML URL</span>
                  <button
                    type="button"
                    onClick={() => handleCopy(outboundWebhook, 'outbound')}
                    className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                  >
                    {copiedUrl === 'outbound' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedUrl === 'outbound' ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
                <div className="font-mono text-[11px] text-slate-300 truncate">{outboundWebhook}</div>
              </div>

              <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] uppercase font-bold text-slate-400">DTMF &lt;Gather&gt; Callback</span>
                  <button
                    type="button"
                    onClick={() => handleCopy(gatherWebhook, 'gather')}
                    className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                  >
                    {copiedUrl === 'gather' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedUrl === 'gather' ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
                <div className="font-mono text-[11px] text-slate-300 truncate">{gatherWebhook}</div>
              </div>

              <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] uppercase font-bold text-slate-400">Status Callback URL</span>
                  <button
                    type="button"
                    onClick={() => handleCopy(statusWebhook, 'status')}
                    className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                  >
                    {copiedUrl === 'status' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedUrl === 'status' ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
                <div className="font-mono text-[11px] text-slate-300 truncate">{statusWebhook}</div>
              </div>
            </div>
          </div>

          <div className="p-4 bg-slate-900/60 border border-slate-800 rounded-2xl text-xs text-slate-400 leading-relaxed">
            <h4 className="font-semibold text-slate-200 mb-1 flex items-center gap-1.5">
              <Info className="w-4 h-4 text-indigo-400" />
              <span>Zero-Config Simulator Mode</span>
            </h4>
            <p>
              If you don't have a paid Twilio account right now, simply switch the mode toggle in the sidebar to <strong>Simulator</strong>. You can test the complete interactive phone call flow directly in the browser!
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
