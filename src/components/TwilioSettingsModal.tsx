import React, { useState, useEffect } from 'react';
import {
  X,
  Shield,
  Key,
  Phone,
  Copy,
  Check,
  Radio,
} from 'lucide-react';
import { ServerConfig, TwilioConfig } from '../types/telephony';

interface TwilioSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  serverConfig: ServerConfig | null;
  savedConfig: TwilioConfig | null;
  onSaveConfig: (config: TwilioConfig) => void;
}

export const TwilioSettingsModal: React.FC<TwilioSettingsModalProps> = ({
  isOpen,
  onClose,
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

  if (!isOpen) return null;

  const appUrl = serverConfig?.appUrl || window.location.origin;
  const outboundWebhook = `${appUrl}/api/twiml/outbound`;
  const gatherWebhook = `${appUrl}/api/twiml/gather`;

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
    setTimeout(() => {
      setSavedSuccess(false);
      onClose();
    }, 1000);
  };

  const isServerConfigured = serverConfig?.isTwilioConfigured;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
      <div className="bg-gradient-to-b from-[#16181e] to-[#0f1115] border border-zinc-700/80 rounded-2xl max-w-lg w-full p-6 relative shadow-2xl text-zinc-100">
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-zinc-400 hover:text-white p-1 rounded-lg hover:bg-zinc-850 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Modal Title */}
        <div className="flex items-center gap-3 mb-4 pb-3 border-b border-zinc-800">
          <div className="p-2.5 rounded-xl bg-zinc-800 border border-zinc-700 text-zinc-200 shadow-sm">
            <Shield className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold tracking-tight text-zinc-100">
              Twilio Telephony Carrier Configuration
            </h2>
            <p className="text-xs text-zinc-400">
              Set credentials for outbound cellular calling
            </p>
          </div>
        </div>

        {/* Server Status Banner */}
        <div className="p-3.5 rounded-xl border border-zinc-750 bg-zinc-900/80 mb-4 text-xs">
          <div className="flex items-start gap-2.5">
            <Radio className="w-4 h-4 text-zinc-300 shrink-0 mt-0.5" />
            <div>
              <h4 className="font-semibold text-zinc-200">
                {isServerConfigured ? 'Twilio Carrier Configured on Server' : 'Simulator Mode Ready (Zero Config Required)'}
              </h4>
              <p className="text-zinc-400 mt-0.5 leading-relaxed text-[11px]">
                {isServerConfigured
                  ? `Environment caller ID is active: ${serverConfig?.configuredPhoneNumber}.`
                  : 'You can test all interactive telephony features immediately with the built-in simulator, or enter live credentials below.'}
              </p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSave} className="space-y-3.5">
          {/* Account SID */}
          <div>
            <label className="text-xs font-semibold text-zinc-300 block mb-1">
              Twilio Account SID
            </label>
            <div className="relative">
              <input
                type="text"
                value={accountSid}
                onChange={(e) => setAccountSid(e.target.value)}
                placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                className="w-full pl-9 pr-3 py-2 bg-[#0c0d10] border border-zinc-750 rounded-xl text-xs font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-400"
              />
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-500">
                <Key className="w-3.5 h-3.5" />
              </div>
            </div>
          </div>

          {/* Auth Token */}
          <div>
            <label className="text-xs font-semibold text-zinc-300 block mb-1">
              Twilio Auth Token
            </label>
            <div className="relative">
              <input
                type="password"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                placeholder="Your Twilio Auth Token"
                className="w-full pl-9 pr-3 py-2 bg-[#0c0d10] border border-zinc-750 rounded-xl text-xs font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-400"
              />
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-500">
                <Key className="w-3.5 h-3.5" />
              </div>
            </div>
          </div>

          {/* Twilio Phone Number */}
          <div>
            <label className="text-xs font-semibold text-zinc-300 block mb-1">
              Twilio Caller Phone Number (E.164)
            </label>
            <div className="relative">
              <input
                type="text"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                placeholder="+18005550199"
                className="w-full pl-9 pr-3 py-2 bg-[#0c0d10] border border-zinc-750 rounded-xl text-xs font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-400"
              />
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-500">
                <Phone className="w-3.5 h-3.5" />
              </div>
            </div>
          </div>

          {/* Webhook URLs */}
          <div className="pt-2 border-t border-zinc-800 space-y-1.5 text-xs">
            <span className="font-semibold text-zinc-300 block">
              Twilio Console Webhook Endpoints
            </span>

            <div className="p-2 bg-[#0c0d10] border border-zinc-800 rounded-lg flex items-center justify-between">
              <div className="truncate mr-2">
                <span className="text-[10px] text-zinc-500 block uppercase font-mono">Outbound TwiML URL</span>
                <span className="font-mono text-zinc-300 text-[11px] truncate">{outboundWebhook}</span>
              </div>
              <button
                type="button"
                onClick={() => handleCopy(outboundWebhook, 'outbound')}
                className="p-1.5 text-zinc-400 hover:text-white rounded-lg hover:bg-zinc-800 transition-colors"
              >
                {copiedUrl === 'outbound' ? <Check className="w-3.5 h-3.5 text-zinc-200" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2.5 pt-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-medium text-zinc-400 hover:text-white bg-zinc-850 hover:bg-zinc-800 border border-zinc-750 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2 rounded-xl text-xs font-bold text-zinc-950 bg-gradient-to-b from-zinc-100 to-zinc-300 hover:from-white hover:to-zinc-200 border border-white/80 shadow-sm transition-all"
            >
              {savedSuccess ? 'Saved!' : 'Save Configuration'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
