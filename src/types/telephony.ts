export type CallStatus =
  | 'idle'
  | 'queued'
  | 'initiating'
  | 'ringing'
  | 'in-progress'
  | 'collecting-input'
  | 'awaiting-operator'
  | 'completed'
  | 'busy'
  | 'failed'
  | 'no-answer';

export interface CallEvent {
  id: string;
  timestamp: string;
  type: 'system' | 'call-state' | 'playback' | 'gather' | 'dtmf' | 'speech' | 'error';
  title: string;
  description: string;
  data?: any;
}

export interface CallSession {
  id: string;
  to: string;
  from: string;
  status: CallStatus;
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
  carrier?: TelephonyCarrier;
  createdAt: string;
  completedAt?: string;
  events: CallEvent[];
}

export interface VoiceProfile {
  id: string;
  name: string;
  gender: 'Female' | 'Male';
  accent: string;
  provider: 'Amazon Polly' | 'Google' | 'Standard';
  samplePreview: string;
}

export interface CallTemplate {
  id: string;
  title: string;
  category: string;
  description: string;
  script: string;
  voice: string;
  numDigits: number;
  keypadActions: Record<string, string>;
}

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
}

export interface PlivoConfig {
  authId: string;
  authToken: string;
  phoneNumber: string;
}

export interface TelnyxConfig {
  apiKey: string;
  connectionId: string;
  phoneNumber: string;
}

export interface SignalWireConfig {
  spaceUrl: string;
  projectId: string;
  apiToken: string;
  phoneNumber: string;
}

export interface FonosterConfig {
  projectId: string;
  accessKeyId: string;
  accessKeySecret: string;
  phoneNumber: string;
}

export type TelephonyCarrier = 'twilio' | 'plivo' | 'telnyx' | 'signalwire' | 'fonoster';

export interface CarriersConfig {
  activeCarrier: TelephonyCarrier;
  twilio?: TwilioConfig;
  plivo?: PlivoConfig;
  telnyx?: TelnyxConfig;
  signalwire?: SignalWireConfig;
  fonoster?: FonosterConfig;
}

export interface ServerConfig {
  hasTwilioAccountSid: boolean;
  hasTwilioAuthToken: boolean;
  hasTwilioPhoneNumber: boolean;
  isTwilioConfigured: boolean;
  configuredPhoneNumber: string | null;
  appUrl: string;
  hasGemini: boolean;
  activeCarrier?: TelephonyCarrier;
}
