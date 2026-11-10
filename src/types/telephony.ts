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
  createdAt: string;
  completedAt?: string;
  events: CallEvent[];
}

export interface VoiceProfile {
  id: string;
  name: string;
  gender: 'Female' | 'Male';
  accent: string;
  provider: 'Amazon Polly' | 'Amazon Polly Neural' | 'Amazon Polly Generative' | 'Google' | 'Standard';
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

export interface ServerConfig {
  hasTwilioAccountSid: boolean;
  hasTwilioAuthToken: boolean;
  hasTwilioPhoneNumber: boolean;
  isTwilioConfigured: boolean;
  configuredPhoneNumber: string | null;
  appUrl: string;
  hasGemini: boolean;
}
