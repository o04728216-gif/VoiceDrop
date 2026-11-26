import type { Server as HttpServer } from 'http';
import * as FonosterSDK from '@fonoster/sdk';
import { VoiceServer, type Session as FonosterVoiceSession } from '@fonoster/voice';

export interface FonosterCredentials {
  projectId: string; // Workspace Access Key ID (e.g. WO...)
  accessKeyId: string; // API Key Access Key ID (e.g. AP...)
  accessKeySecret: string;
  phoneNumber?: string;
  appRef?: string;
  endpoint?: string;
  allowInsecure?: boolean;
}

export interface FonosterSessionState {
  voiceSession: FonosterVoiceSession;
  callId: string;
  digitBuffer: string;
  greetStarted: boolean;
  amdResolved: boolean;
  amdFallbackTimer?: ReturnType<typeof setTimeout>;
}

const activeFonosterCalls = new Map<string, FonosterSessionState>();

function parseDynamicEndpoint(raw?: string): { endpoint?: string; inferredInsecure?: boolean } {
  if (!raw || !raw.trim()) return {};
  const trimmed = raw.trim();
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  let inferredInsecure: boolean | undefined;

  if (hasScheme) {
    const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\//i);
    const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : '';
    if (scheme === 'http' || scheme === 'grpc') {
      inferredInsecure = true;
    } else if (scheme === 'https' || scheme === 'grpcs') {
      inferredInsecure = false;
    }
    try {
      // Normalize via URL parser using http:// stand-in for grpc(s) schemes so host:port is extracted cleanly
      const parsable = trimmed.replace(/^grpcs?:\/\//i, 'https://');
      const parsed = new URL(parsable);
      return {
        endpoint: parsed.host || undefined,
        inferredInsecure,
      };
    } catch {
      const stripped = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0].trim();
      return { endpoint: stripped || undefined, inferredInsecure };
    }
  }

  const hostOnly = trimmed.split('/')[0].trim();
  return { endpoint: hostOnly || undefined };
}

function resolveDynamicTlsInsecure(
  explicitAllowInsecure?: boolean,
  inferredInsecure?: boolean
): boolean {
  if (typeof explicitAllowInsecure === 'boolean') return explicitAllowInsecure;
  const envAllow = (process.env.FONOSTER_ALLOW_INSECURE || '').trim().toLowerCase();
  if (envAllow === 'true' || envAllow === '1') return true;
  if (envAllow === 'false' || envAllow === '0') return false;
  if ((process.env.NODE_TLS_REJECT_UNAUTHORIZED || '').trim() === '0') return true;
  return Boolean(inferredInsecure);
}

export function buildFonosterStreamUrl(appBaseUrl: string): string {
  const clean = appBaseUrl.replace(/\/+$/, '');
  if (clean.startsWith('https://')) {
    return `wss://${clean.slice('https://'.length)}/api/fonoster/stream`;
  }
  if (clean.startsWith('http://')) {
    return `ws://${clean.slice('http://'.length)}/api/fonoster/stream`;
  }
  return `wss://${clean}/api/fonoster/stream`;
}

export function isLocalStreamUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes('localhost') || lower.includes('127.0.0.1') || lower.includes('0.0.0.0');
}

function isAuthDeniedError(err: any): boolean {
  const msg = String(err?.details || err?.message || '').toLowerCase();
  return err?.code === 7 || msg.includes('invalid credentials') || msg.includes('permission_denied');
}

export async function createAuthenticatedFonosterClient(
  creds: FonosterCredentials
): Promise<FonosterSDK.Client> {
  let workspaceKey = (creds.projectId || '').trim();
  let apiKeyId = (creds.accessKeyId || '').trim();
  const apiKeySecret = (creds.accessKeySecret || '').trim();

  if (!workspaceKey) {
    throw new Error('Fonoster Workspace Access Key ID (WO...) is required.');
  }
  if (!apiKeyId || !apiKeySecret) {
    throw new Error('Fonoster API Key Access Key ID (AP...) and API Key Secret are required.');
  }

  // Auto-correct if user accidentally placed AP... in Workspace ID and WO... in API Key ID
  if (/^AP/i.test(workspaceKey) && /^WO/i.test(apiKeyId)) {
    const tmp = workspaceKey;
    workspaceKey = apiKeyId;
    apiKeyId = tmp;
  }

  const rawEndpoint =
    creds.endpoint ||
    process.env.FONOSTER_ENDPOINT ||
    process.env.FONOSTER_URL ||
    process.env.FONOSTER_BASE_URL ||
    '';
  const { endpoint, inferredInsecure } = parseDynamicEndpoint(rawEndpoint);
  const allowInsecure = resolveDynamicTlsInsecure(creds.allowInsecure, inferredInsecure);

  const primaryClient = new FonosterSDK.Client({
    accessKeyId: workspaceKey,
    ...(endpoint ? { endpoint } : {}),
    ...(allowInsecure ? { allowInsecure: true } : {}),
  });

  const triedEndpoints: string[] = [];
  const primaryEp = (primaryClient as any).endpoint as string | undefined;
  if (primaryEp) triedEndpoints.push(primaryEp);

  try {
    await primaryClient.loginWithApiKey(apiKeyId, apiKeySecret);
    return primaryClient;
  } catch (primaryErr: any) {
    // If no explicit endpoint was configured and the SDK default ends with .ai,
    // also try the sibling .com cloud endpoint dynamically for classic Fonoster accounts.
    if (!endpoint && isAuthDeniedError(primaryErr) && primaryEp && /\.ai$/i.test(primaryEp)) {
      const siblingEndpoint = primaryEp.replace(/\.ai$/i, '.com');
      triedEndpoints.push(siblingEndpoint);
      try {
        const siblingClient = new FonosterSDK.Client({
          accessKeyId: workspaceKey,
          endpoint: siblingEndpoint,
          ...(allowInsecure ? { allowInsecure: true } : {}),
        });
        await siblingClient.loginWithApiKey(apiKeyId, apiKeySecret);
        return siblingClient;
      } catch {
        // Fall through to detailed error below
      }
    }

    if (isAuthDeniedError(primaryErr)) {
      const targetSummary = triedEndpoints.length ? triedEndpoints.join(' and ') : 'configured endpoint';
      const isPlaceholderWorkspace = /^WO0{32}$/i.test(workspaceKey);
      const hints: string[] = [];
      if (!endpoint) {
        hints.push(
          'If you are using a self-hosted Fonoster server, set the FONOSTER_ENDPOINT environment variable (and FONOSTER_ALLOW_INSECURE=true if without TLS) so VoiceDrop connects to your server instead of Fonoster Cloud.'
        );
      }
      if (isPlaceholderWorkspace) {
        hints.push(
          'Your Workspace Access Key ID looks like the default/self-hosted WO000... ID — double-check it matches your real Fonoster Workspace Access Key ID.'
        );
      }
      hints.push(
        'Otherwise verify your API Key ID (AP...) and API Key Secret are active and were not regenerated or revoked.'
      );
      throw new Error(`Invalid credentials rejected by ${targetSummary}. ${hints.join(' ')}`);
    }

    throw primaryErr;
  }
}

export async function ensureFonosterVoiceApp(
  client: FonosterSDK.Client,
  appBaseUrl: string,
  preferredAppRef?: string,
  recordCall = true
): Promise<{ appRef: string; streamUrl: string; created: boolean; updated: boolean }> {
  const appsApi = new FonosterSDK.Applications(client);
  const streamUrl = buildFonosterStreamUrl(appBaseUrl);
  const canSyncUrl = !isLocalStreamUrl(streamUrl);
  const recordingPolicy = recordCall ? ('on' as const) : ('off' as const);

  const listRes = await appsApi.listApplications({ pageSize: 50 });
  const existingApps = Array.isArray(listRes?.items) ? listRes.items : [];

  const trimmedPreferred = (preferredAppRef || '').trim();
  if (trimmedPreferred) {
    const matched = existingApps.find((a) => a.ref === trimmedPreferred);
    if (matched) {
      let updated = false;
      if (
        canSyncUrl &&
        matched.type === FonosterSDK.ApplicationType.STREAM &&
        (matched.url !== streamUrl ||
          matched.recording !== recordingPolicy ||
          !matched.amd?.enabled)
      ) {
        await appsApi
          .updateApplication({
            ref: matched.ref,
            name: matched.name,
            type: FonosterSDK.ApplicationType.STREAM,
            url: streamUrl,
            protocol: 'fonoster',
            recording: recordingPolicy,
            amd: { enabled: true, windowMs: 4000 },
            speech: { language: 'en-US' },
          })
          .then(() => {
            updated = true;
          })
          .catch(() => {});
      }
      return { appRef: matched.ref, streamUrl, created: false, updated };
    }
    return { appRef: trimmedPreferred, streamUrl, created: false, updated: false };
  }

  const managedName = 'VoiceDrop Stream';
  const existingManaged = existingApps.find(
    (a) =>
      a.type === FonosterSDK.ApplicationType.STREAM &&
      (a.name === managedName || (a.url && a.url.endsWith('/api/fonoster/stream')))
  );

  if (existingManaged) {
    let updated = false;
    if (
      canSyncUrl &&
      (existingManaged.url !== streamUrl ||
        existingManaged.recording !== recordingPolicy ||
        !existingManaged.amd?.enabled)
    ) {
      await appsApi
        .updateApplication({
          ref: existingManaged.ref,
          name: existingManaged.name || managedName,
          type: FonosterSDK.ApplicationType.STREAM,
          url: streamUrl,
          protocol: 'fonoster',
          recording: recordingPolicy,
          amd: { enabled: true, windowMs: 4000 },
          speech: { language: 'en-US' },
        })
        .then(() => {
          updated = true;
        })
        .catch(() => {});
    }
    return { appRef: existingManaged.ref, streamUrl, created: false, updated };
  }

  if (!canSyncUrl) {
    const fallbackApp =
      existingApps.find((a) => a.type === FonosterSDK.ApplicationType.STREAM) || existingApps[0];
    if (fallbackApp) {
      return { appRef: fallbackApp.ref, streamUrl, created: false, updated: false };
    }
    throw new Error(
      'Cannot auto-create a Fonoster Stream Application with a localhost URL. Open the app via its public HTTPS URL or create an application in Fonoster.'
    );
  }

  try {
    const createdRes = await appsApi.createApplication({
      name: managedName,
      type: FonosterSDK.ApplicationType.STREAM,
      url: streamUrl,
      protocol: 'fonoster',
      recording: recordingPolicy,
      amd: { enabled: true, windowMs: 4000 },
      speech: { language: 'en-US' },
    });

    return { appRef: createdRes.ref, streamUrl, created: true, updated: false };
  } catch (createErr) {
    if (existingApps.length > 0) {
      return { appRef: existingApps[0].ref, streamUrl, created: false, updated: false };
    }
    throw createErr;
  }
}

export async function verifyFonosterConnection(
  creds: FonosterCredentials,
  appBaseUrl: string,
  syncApp = true
) {
  const client = await createAuthenticatedFonosterClient(creds);
  const appsApi = new FonosterSDK.Applications(client);
  const numbersApi = new FonosterSDK.Numbers(client);

  let syncedAppRef = (creds.appRef || '').trim() || undefined;
  let appAction: 'created' | 'updated' | 'existing' | 'none' = 'none';
  const streamUrl = buildFonosterStreamUrl(appBaseUrl);

  if (syncApp) {
    const ensured = await ensureFonosterVoiceApp(client, appBaseUrl, syncedAppRef, true);
    syncedAppRef = ensured.appRef;
    appAction = ensured.created ? 'created' : ensured.updated ? 'updated' : 'existing';
  }

  const [appsRes, numbersRes] = await Promise.all([
    appsApi.listApplications({ pageSize: 50 }).catch(() => ({ items: [] })),
    numbersApi.listNumbers({ pageSize: 50 }).catch(() => ({ items: [] })),
  ]);

  const applications = (appsRes?.items || []).map((a) => ({
    ref: a.ref,
    name: a.name,
    type: a.type,
    url: a.url,
    recording: a.recording,
    amdEnabled: Boolean(a.amd?.enabled),
  }));

  const numbers = (numbersRes?.items || []).map((n) => ({
    ref: n.ref,
    name: n.name,
    telUrl: n.telUrl,
    appRef: n.appRef,
  }));

  return {
    ok: true,
    streamUrl,
    syncedAppRef,
    appAction,
    applications,
    numbers,
    warning: isLocalStreamUrl(streamUrl)
      ? 'Server is currently addressed via localhost; Fonoster Cloud requires a public wss:// URL to connect back to voice streams.'
      : undefined,
  };
}

export async function dispatchFonosterOutboundCall(
  creds: FonosterCredentials,
  params: {
    from: string;
    to: string;
    callId: string;
    deviceId: string;
    appBaseUrl: string;
    recordCall: boolean;
  }
) {
  const client = await createAuthenticatedFonosterClient(creds);
  const { appRef, streamUrl, created, updated } = await ensureFonosterVoiceApp(
    client,
    params.appBaseUrl,
    creds.appRef,
    params.recordCall
  );

  const callsApi = new FonosterSDK.Calls(client);
  const createdCall = await callsApi.createCall({
    from: params.from,
    to: params.to,
    appRef,
    timeout: 45,
    metadata: {
      callId: params.callId,
      deviceId: params.deviceId,
    },
  });

  return {
    client,
    ref: createdCall.ref,
    statusStream: createdCall.statusStream,
    appRef,
    streamUrl,
    appCreated: created,
    appUpdated: updated,
  };
}

export async function fetchFonosterRecording(
  creds: FonosterCredentials,
  callRef: string
): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!callRef) return null;
  try {
    const client = await createAuthenticatedFonosterClient(creds);
    const recordsApi = new FonosterSDK.CallRecords(client);
    const rec = await recordsApi.getRecording(callRef);
    if (rec?.data && rec.data.byteLength > 128) {
      return {
        buffer: Buffer.from(rec.data),
        contentType: (rec.contentType || 'audio/wav').toLowerCase(),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function getActiveFonosterState(callId: string): FonosterSessionState | undefined {
  return activeFonosterCalls.get(callId);
}

export async function sayOnFonosterCall(
  callId: string,
  text: string,
  options?: { interruptible?: boolean; preempt?: boolean }
): Promise<boolean> {
  const state = activeFonosterCalls.get(callId);
  if (!state || state.voiceSession.ended || !text.trim()) return false;
  try {
    await state.voiceSession.say(text.trim(), {
      interruptible: options?.interruptible ?? true,
      preempt: options?.preempt ?? true,
    });
    return true;
  } catch (err) {
    console.error(`Fonoster say failed for ${callId}:`, err);
    return false;
  }
}

export async function hangupFonosterCall(callId: string): Promise<boolean> {
  const state = activeFonosterCalls.get(callId);
  if (!state) return false;
  if (state.amdFallbackTimer) {
    clearTimeout(state.amdFallbackTimer);
    state.amdFallbackTimer = undefined;
  }
  if (state.voiceSession.ended) {
    activeFonosterCalls.delete(callId);
    return true;
  }
  try {
    await state.voiceSession.hangup();
    activeFonosterCalls.delete(callId);
    return true;
  } catch (err) {
    console.error(`Fonoster hangup failed for ${callId}:`, err);
    activeFonosterCalls.delete(callId);
    return false;
  }
}

export interface FonosterVoiceBridgeHooks {
  resolveSession: (meta: { callId?: string; callRef: string; to: string }) => any | undefined;
  onSessionConnected: (session: any, callRef: string) => void;
  onAmdResult: (
    session: any,
    status: 'human' | 'voicemail' | 'fax' | 'unknown',
    rawLabel: string
  ) => Promise<void>;
  onStartHumanGreeting: (session: any, state: FonosterSessionState) => Promise<void>;
  onSpeechTurn: (session: any, text: string, confidence?: number) => Promise<boolean>;
  onDigitsSubmitted: (
    session: any,
    digits: string,
    submittedViaPound: boolean,
    state: FonosterSessionState
  ) => Promise<void>;
  onSessionEnded: (session: any, reason: string) => Promise<void>;
  getMaxDigits: (numDigits?: number) => number;
}

export function attachFonosterVoiceServer(
  httpServer: HttpServer,
  hooks: FonosterVoiceBridgeHooks
): VoiceServer {
  const voiceServer = new VoiceServer({
    path: '/api/fonoster/stream',
    verifySignature: false,
  });

  voiceServer.attach(httpServer, async (voiceSession: FonosterVoiceSession) => {
    const metaCallId =
      typeof voiceSession.metadata?.callId === 'string' ? voiceSession.metadata.callId : undefined;
    const session = hooks.resolveSession({
      callId: metaCallId,
      callRef: voiceSession.callRef,
      to: voiceSession.to,
    });

    if (!session) {
      console.warn(
        `[Fonoster Voice] Incoming stream for unknown callRef=${voiceSession.callRef} to=${voiceSession.to}`
      );
      try {
        await voiceSession.hangup();
      } catch {}
      return;
    }

    const state: FonosterSessionState = {
      voiceSession,
      callId: session.id,
      digitBuffer: '',
      greetStarted: Boolean(session.promptsStarted),
      amdResolved: false,
    };

    activeFonosterCalls.set(session.id, state);
    hooks.onSessionConnected(session, voiceSession.callRef);

    const triggerGreetingOnce = async () => {
      if (state.greetStarted || voiceSession.ended) return;
      if (session.answeredBy === 'voicemail' && !session.humanPickedUpAfterVoicemail) {
        return;
      }
      state.greetStarted = true;
      if (state.amdFallbackTimer) {
        clearTimeout(state.amdFallbackTimer);
        state.amdFallbackTimer = undefined;
      }
      await hooks.onStartHumanGreeting(session, state);
    };

    // Start listening for voice & DTMF immediately on answer
    try {
      await voiceSession.listen({ language: 'en-US' });
    } catch (err) {
      console.error(`[Fonoster Voice] listen() error for ${session.id}:`, err);
    }

    // Fallback: if AMD doesn't emit within 4.5s and no voicemail speech was detected, start greeting
    state.amdFallbackTimer = setTimeout(() => {
      if (!state.amdResolved && !state.greetStarted && !voiceSession.ended) {
        if (session.answeredBy !== 'voicemail') {
          state.amdResolved = true;
          void hooks
            .onAmdResult(session, 'human', 'fonoster_timeout_human')
            .then(() => triggerGreetingOnce());
        }
      }
    }, 4500);

    voiceSession.on('amd.result', (amd) => {
      state.amdResolved = true;
      if (state.amdFallbackTimer) {
        clearTimeout(state.amdFallbackTimer);
        state.amdFallbackTimer = undefined;
      }

      const rawStatus = String(amd.status || 'unknown').toLowerCase();
      const mapped: 'human' | 'voicemail' | 'fax' | 'unknown' =
        rawStatus === 'human'
          ? 'human'
          : rawStatus === 'voicemail' || rawStatus === 'machine' || rawStatus === 'ivr'
          ? 'voicemail'
          : 'unknown';

      const rawLabel = `fonoster_${rawStatus}${amd.reason ? `_${amd.reason}` : ''}`;
      void hooks.onAmdResult(session, mapped, rawLabel).then(async () => {
        if (mapped === 'human' || (mapped === 'unknown' && session.answeredBy !== 'voicemail')) {
          await triggerGreetingOnce();
        }
      });
    });

    voiceSession.on('turn.ended', (turn) => {
      const text = (turn.text || '').trim();
      if (!text) return;
      void hooks.onSpeechTurn(session, text, turn.confidence).then(async (shouldWakeHuman) => {
        if (shouldWakeHuman) {
          await triggerGreetingOnce();
        }
      });
    });

    voiceSession.on('dtmf', ({ digit }) => {
      const key = String(digit || '').trim();
      if (!key) return;

      // Any keypress confirms a live human on the handset
      if (session.answeredBy === 'voicemail' && !session.humanPickedUpAfterVoicemail) {
        session.humanPickedUpAfterVoicemail = true;
        void hooks.onAmdResult(session, 'human', 'dtmf_human_pickup').then(() => triggerGreetingOnce());
      } else if (!state.greetStarted) {
        state.amdResolved = true;
        void hooks.onAmdResult(session, 'human', 'dtmf_confirmed_human');
      }

      if (key === '#') {
        if (state.digitBuffer.length >= 1) {
          const submitted = state.digitBuffer;
          state.digitBuffer = '';
          void hooks.onDigitsSubmitted(session, submitted, true, state);
        }
        return;
      }

      if (/^[0-9*]$/.test(key)) {
        state.digitBuffer += key;
        const maxDigits = hooks.getMaxDigits(session.numDigits);
        if (state.digitBuffer.length >= maxDigits) {
          const submitted = state.digitBuffer.slice(0, maxDigits);
          state.digitBuffer = '';
          void hooks.onDigitsSubmitted(session, submitted, false, state);
        }
      }
    });

    voiceSession.on('error', (err) => {
      console.error(`[Fonoster Voice] Session error (${session.id}):`, err);
    });

    voiceSession.on('end', ({ reason }) => {
      if (state.amdFallbackTimer) {
        clearTimeout(state.amdFallbackTimer);
        state.amdFallbackTimer = undefined;
      }
      activeFonosterCalls.delete(session.id);
      void hooks.onSessionEnded(session, reason || 'ended');
    });
  });

  return voiceServer;
}
