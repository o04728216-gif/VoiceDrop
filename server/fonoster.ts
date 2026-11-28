import type { Server as HttpServer } from 'http';
import { createRequire } from 'module';
import net from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import * as FonosterSDK from '@fonoster/sdk';
import {
  synthesizeTelephonyAudio,
  computeFrameRms,
  type TelephonyCodec,
  type TelephonyRate,
} from './tts.ts';
import { InboundSpeechTracker, type SpeechTranscriptMeta } from './stt.ts';
import { LiveCallRecorder } from './callRecorder.ts';

const requireFromHere = createRequire(import.meta.url);
let cachedGrpcModule: any = null;

function loadGrpcFromSdk(): any {
  if (cachedGrpcModule) return cachedGrpcModule;
  try {
    const sdkEntry = requireFromHere.resolve('@fonoster/sdk');
    const requireFromSdk = createRequire(sdkEntry);
    cachedGrpcModule = requireFromSdk('@grpc/grpc-js');
    return cachedGrpcModule;
  } catch {
    try {
      cachedGrpcModule = requireFromHere('@grpc/grpc-js');
      return cachedGrpcModule;
    } catch {
      return null;
    }
  }
}

export interface FonosterCredentials {
  projectId: string; // Workspace Access Key ID (e.g. WO...)
  accessKeyId: string; // API Key Access Key ID (e.g. AP...)
  accessKeySecret: string;
  phoneNumber?: string;
  appRef?: string;
  endpoint?: string;
  allowInsecure?: boolean;
}

export interface FonosterStreamTransport {
  protocol: 'twilio' | 'fonoster';
  codec: TelephonyCodec;
  sampleRate: TelephonyRate;
  ended: boolean;
  sendAudioFrame: (frame: Buffer) => void;
  clearAudio: () => void;
  sendMark: (name: string) => Promise<{ cleared: boolean }>;
  hangup: () => Promise<void>;
}

export interface FonosterSessionState {
  transport: FonosterStreamTransport;
  callId: string;
  voice?: string;
  digitBuffer: string;
  greetStarted: boolean;
  amdResolved: boolean;
  playbackEpoch: number;
  isInterruptible: boolean;
  hasSentAudio: boolean;
  amdFallbackTimer?: ReturnType<typeof setTimeout>;
}

type FonosterTransportMode = 'tls' | 'tls-no-verify' | 'insecure';

const activeFonosterCalls = new Map<string, FonosterSessionState>();

function parseDynamicEndpoint(raw?: string): {
  endpoint?: string;
  scheme?: string;
  inferredInsecure?: boolean;
} {
  if (!raw || !raw.trim()) return {};
  const trimmed = raw.trim();
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  let inferredInsecure: boolean | undefined;
  let scheme = '';

  if (hasScheme) {
    const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\//i);
    scheme = schemeMatch ? schemeMatch[1].toLowerCase() : '';
    if (scheme === 'http' || scheme === 'grpc') {
      inferredInsecure = true;
    } else if (scheme === 'https' || scheme === 'grpcs') {
      inferredInsecure = false;
    }
    try {
      const parsable = trimmed.replace(/^grpcs?:\/\//i, 'https://');
      const parsed = new URL(parsable);
      return {
        endpoint: parsed.host || undefined,
        scheme,
        inferredInsecure,
      };
    } catch {
      const stripped = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0].trim();
      return { endpoint: stripped || undefined, scheme, inferredInsecure };
    }
  }

  const hostOnly = trimmed.split('/')[0].trim();
  return { endpoint: hostOnly || undefined };
}

function getOrderedTransportModes(
  explicitAllowInsecure?: boolean,
  inferredInsecure?: boolean,
  hasCustomEndpoint?: boolean
): FonosterTransportMode[] {
  const envAllow = (process.env.FONOSTER_ALLOW_INSECURE || '').trim().toLowerCase();
  const nodeTlsRelaxed = (process.env.NODE_TLS_REJECT_UNAUTHORIZED || '').trim() === '0';

  const preferInsecure =
    explicitAllowInsecure === true ||
    envAllow === 'true' ||
    envAllow === '1' ||
    (explicitAllowInsecure === undefined && envAllow === '' && inferredInsecure === true);

  if (preferInsecure) {
    return ['insecure', 'tls-no-verify', 'tls'];
  }
  if (nodeTlsRelaxed) {
    return ['tls-no-verify', 'insecure', 'tls'];
  }
  if (hasCustomEndpoint) {
    return ['tls', 'tls-no-verify', 'insecure'];
  }
  return ['tls'];
}

function formatFonosterError(err: any): {
  summary: string;
  code?: number | string;
  details?: string;
  message?: string;
  cause?: string;
  metadata?: Record<string, any>;
} {
  const code = err?.code;
  const details = typeof err?.details === 'string' && err.details.trim() ? err.details.trim() : undefined;
  const message = typeof err?.message === 'string' && err.message.trim() ? err.message.trim() : undefined;
  const cause =
    err?.cause instanceof Error
      ? err.cause.message
      : err?.cause
      ? String(err.cause)
      : undefined;
  let metadata: Record<string, any> | undefined;
  try {
    if (err?.metadata && typeof err.metadata.getMap === 'function') {
      metadata = err.metadata.getMap();
    }
  } catch {
    // Ignore metadata extraction errors
  }

  const baseText = details || message || String(err || 'Unknown Fonoster error');
  const codePrefix = code !== undefined && code !== null ? `[gRPC code=${code}] ` : '';
  const causeSuffix = cause && !baseText.includes(cause) ? ` (cause: ${cause})` : '';
  return {
    summary: `${codePrefix}${baseText}${causeSuffix}`.trim(),
    code,
    details,
    message,
    cause,
    metadata,
  };
}

function buildClientWithTransport(
  workspaceKey: string,
  endpoint: string | undefined,
  mode: FonosterTransportMode
): FonosterSDK.Client {
  if (mode === 'insecure') {
    const client = new FonosterSDK.Client({
      accessKeyId: workspaceKey,
      ...(endpoint ? { endpoint } : {}),
      allowInsecure: true,
    });
    (client as any).__fonosterTransportMode = mode;
    return client;
  }

  const client = new FonosterSDK.Client({
    accessKeyId: workspaceKey,
    ...(endpoint ? { endpoint } : {}),
    allowInsecure: false,
  });
  (client as any).__fonosterTransportMode = mode;

  if (mode === 'tls-no-verify') {
    const grpc = loadGrpcFromSdk();
    if (grpc?.credentials?.createSsl) {
      const relaxedCreds = grpc.credentials.createSsl(null, null, null, {
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
      });
      (client as any).channelCredentials = relaxedCreds;
      if (typeof (client as any).getIdentityClient === 'function') {
        (client as any).identityClient = (client as any).getIdentityClient();
      }
    }
  }

  return client;
}

function extractHostAndPort(endpoint: string, scheme?: string): { host: string; port: number } {
  const cleaned = endpoint.trim();
  const ipv6Match = cleaned.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (ipv6Match) {
    return {
      host: ipv6Match[1],
      port: ipv6Match[2] ? Number(ipv6Match[2]) : scheme === 'http' ? 80 : 443,
    };
  }
  const lastColon = cleaned.lastIndexOf(':');
  if (lastColon > 0) {
    const portNum = Number(cleaned.slice(lastColon + 1));
    if (Number.isFinite(portNum) && portNum > 0 && portNum <= 65535) {
      return { host: cleaned.slice(0, lastColon), port: portNum };
    }
  }
  return { host: cleaned, port: scheme === 'http' ? 80 : 443 };
}

function probeTcpEndpoint(endpoint: string, scheme?: string, timeoutMs = 2500): Promise<string> {
  const { host, port } = extractHostAndPort(endpoint, scheme);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (msg: string) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {}
      resolve(msg);
    };

    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      finish(
        `TCP port ${host}:${port} is reachable, but gRPC/HTTP2 handshake failed (check that FONOSTER_ENDPOINT points to Fonoster's gRPC API port rather than an HTTP/1.1 web UI or non-gRPC proxy).`
      );
    });
    socket.once('timeout', () => {
      finish(`TCP connection to ${host}:${port} timed out after ${timeoutMs}ms (firewall/port unreachable).`);
    });
    socket.once('error', (err: any) => {
      const code = err?.code || err?.message || 'UNKNOWN';
      const dockerHint =
        host === 'localhost' || host === '127.0.0.1'
          ? ' Inside Docker/Coolify, localhost refers to the VoiceDrop container itself—use your server IP, domain, or Docker service name instead.'
          : '';
      finish(`TCP error connecting to ${host}:${port} (${code}).${dockerHint}`);
    });
  });
}

async function loginWithTimeout(
  client: FonosterSDK.Client,
  apiKeyId: string,
  apiKeySecret: string,
  timeoutMs = 7000
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.loginWithApiKey(apiKeyId, apiKeySecret),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const timeoutErr: any = new Error(`Connection timed out after ${timeoutMs}ms`);
          timeoutErr.code = 14;
          reject(timeoutErr);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function buildFonosterStreamUrl(appBaseUrl: string): string {
  const override = (process.env.FONOSTER_STREAM_URL || '').trim();
  if (override) {
    let normalized = override.replace(/\/+$/, '');
    if (normalized.startsWith('https://')) {
      normalized = `wss://${normalized.slice('https://'.length)}`;
    } else if (normalized.startsWith('http://')) {
      normalized = `ws://${normalized.slice('http://'.length)}`;
    } else if (!normalized.startsWith('ws://') && !normalized.startsWith('wss://')) {
      normalized = `wss://${normalized}`;
    }
    if (!normalized.includes('/api/fonoster/stream')) {
      normalized = `${normalized}/api/fonoster/stream`;
    }
    return normalized;
  }

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

export function isCookieGatedPreviewUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    (lower.includes('ais-dev-') || lower.includes('ais-pre-')) &&
    lower.includes('.run.app')
  );
}

function isAuthDeniedError(err: any): boolean {
  const msg = String(err?.details || err?.message || '').toLowerCase();
  return err?.code === 7 || msg.includes('invalid credentials') || msg.includes('permission_denied');
}

function isConnectionError(err: any): boolean {
  const msg = String(err?.details || err?.message || '').toLowerCase();
  return (
    err?.code === 14 ||
    err?.code === 4 ||
    msg.includes('no connection established') ||
    msg.includes('unavailable') ||
    msg.includes('timed out') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('handshake') ||
    msg.includes('ssl') ||
    msg.includes('tls') ||
    msg.includes('cert')
  );
}

function isTcpPortOpen(host: string, port: number, timeoutMs = 900): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {}
      resolve(ok);
    };
    const sock = net.createConnection({ host, port });
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

function extractDynamicCoHosts(appBaseUrl?: string): string[] {
  const hosts: string[] = [];
  if (!appBaseUrl) return hosts;
  try {
    const parsed = new URL(appBaseUrl);
    const hostname = parsed.hostname.toLowerCase();
    // Skip remote managed cloud preview hosts like *.run.app
    if (hostname.endsWith('.run.app')) return hosts;

    // Extract IPv4 from wildcard DNS domains (e.g. app.1.2.3.4.sslip.io or app.1-2-3-4.nip.io)
    const dotIpMatch = hostname.match(/(?:^|\.)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?:\.(?:sslip|nip|xip)\.io)?$/);
    if (dotIpMatch) {
      hosts.push(dotIpMatch[1]);
    } else {
      const dashIpMatch = hostname.match(/(?:^|\.)(\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3})\.(?:sslip|nip|xip)\.io$/);
      if (dashIpMatch) {
        hosts.push(dashIpMatch[1].replace(/-/g, '.'));
      }
    }

    if (hostname !== 'localhost' && hostname !== '127.0.0.1' && !hosts.includes(hostname)) {
      hosts.push(hostname);
    }

    // Standard Docker / Coolify co-host aliases on self-hosted deployments
    hosts.push('host.docker.internal', 'apiserver');
  } catch {
    // Ignore invalid URL
  }
  return Array.from(new Set(hosts));
}

async function discoverOpenCoHostedEndpoints(appBaseUrl?: string): Promise<string[]> {
  const hosts = extractDynamicCoHosts(appBaseUrl);
  if (hosts.length === 0) return [];
  const candidates: Array<{ host: string; port: number }> = [];
  for (const host of hosts) {
    candidates.push({ host, port: 8449 });
    candidates.push({ host, port: 50051 });
  }
  const results = await Promise.all(
    candidates.map(async (c) => ({
      endpoint: `${c.host}:${c.port}`,
      open: await isTcpPortOpen(c.host, c.port, 900),
    }))
  );
  return results.filter((r) => r.open).map((r) => r.endpoint);
}

function hasExplicitPort(endpoint: string): boolean {
  const cleaned = endpoint.trim();
  if (/^\[[^\]]+\]:\d+$/.test(cleaned)) return true;
  const lastColon = cleaned.lastIndexOf(':');
  if (lastColon <= 0) return false;
  const portNum = Number(cleaned.slice(lastColon + 1));
  return Number.isFinite(portNum) && portNum > 0 && portNum <= 65535;
}

export async function createAuthenticatedFonosterClient(
  creds: FonosterCredentials,
  appBaseUrl?: string
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
  const { endpoint, scheme, inferredInsecure } = parseDynamicEndpoint(rawEndpoint);
  const isSelfHostedWorkspaceId = /^WO0{32}$/i.test(workspaceKey);

  // Helper to try authenticating against a single target endpoint across ordered transport modes
  const tryEndpoint = async (
    targetEp: string | undefined,
    modesToTry: FonosterTransportMode[]
  ): Promise<{ client?: FonosterSDK.Client; err?: any; actualEp?: string; triedModes: string[] }> => {
    const triedModes: string[] = [];
    let lastAttemptErr: any = null;
    let actualEp = targetEp;

    for (const mode of modesToTry) {
      const client = buildClientWithTransport(workspaceKey, targetEp, mode);
      actualEp = ((client as any).endpoint as string | undefined) || targetEp;
      triedModes.push(mode);
      try {
        await loginWithTimeout(client, apiKeyId, apiKeySecret);
        (client as any).__fonosterTransportMode = mode;
        (client as any).__fonosterResolvedEndpoint = actualEp;
        console.log(
          `[Fonoster Auth] Connected endpoint=${actualEp || 'default'} transport=${mode} workspace=${workspaceKey.slice(0, 8)}...`
        );
        return { client, actualEp, triedModes };
      } catch (err: any) {
        lastAttemptErr = err;
        if (!isConnectionError(err)) {
          break;
        }
      }
    }
    return { err: lastAttemptErr, actualEp, triedModes };
  };

  const triedEndpoints: string[] = [];
  const allTriedModes: string[] = [];
  let lastErr: any = null;
  let resolvedPrimaryEp = endpoint;

  // 1. If NO explicit endpoint is configured and workspace ID is the default self-hosted WO000...,
  // probe dynamically discovered co-hosted Fonoster ports (e.g. <vps-ip>:8449 / :50051) FIRST!
  if (!endpoint && isSelfHostedWorkspaceId && appBaseUrl) {
    const discovered = await discoverOpenCoHostedEndpoints(appBaseUrl);
    for (const discEp of discovered) {
      triedEndpoints.push(discEp);
      const attempt = await tryEndpoint(discEp, ['tls-no-verify', 'insecure', 'tls']);
      if (attempt.client) return attempt.client;
      if (attempt.err) lastErr = attempt.err;
    }
  }

  // 2. Try configured endpoint (or SDK default cloud endpoint if none configured)
  const modes = getOrderedTransportModes(creds.allowInsecure, inferredInsecure, Boolean(endpoint));
  const primaryAttempt = await tryEndpoint(endpoint, modes);
  if (primaryAttempt.client) return primaryAttempt.client;
  if (primaryAttempt.actualEp && !triedEndpoints.includes(primaryAttempt.actualEp)) {
    triedEndpoints.push(primaryAttempt.actualEp);
  }
  if (!resolvedPrimaryEp && primaryAttempt.actualEp) {
    resolvedPrimaryEp = primaryAttempt.actualEp;
  }
  allTriedModes.push(...primaryAttempt.triedModes);
  lastErr = primaryAttempt.err;

  // 3. If user gave a custom host WITHOUT a port (e.g. "my-vps.com" or "1.2.3.4") and port 443 failed,
  // also automatically try standard Fonoster gRPC ports (:8449, :50051) on that same host.
  if (endpoint && !hasExplicitPort(endpoint) && isConnectionError(lastErr)) {
    for (const port of [8449, 50051]) {
      const withPort = `${endpoint}:${port}`;
      if (await isTcpPortOpen(endpoint, port, 1200)) {
        triedEndpoints.push(withPort);
        const portAttempt = await tryEndpoint(withPort, ['tls-no-verify', 'insecure', 'tls']);
        if (portAttempt.client) return portAttempt.client;
        if (portAttempt.err) lastErr = portAttempt.err;
      }
    }
  }

  // 4. If no explicit endpoint was configured and public cloud rejected credentials:
  // (a) Try sibling .com cloud domain if primary ended in .ai
  if (!endpoint && isAuthDeniedError(lastErr) && resolvedPrimaryEp && /\.ai$/i.test(resolvedPrimaryEp)) {
    const siblingEndpoint = resolvedPrimaryEp.replace(/\.ai$/i, '.com');
    triedEndpoints.push(siblingEndpoint);
    const siblingAttempt = await tryEndpoint(siblingEndpoint, [modes[0] || 'tls']);
    if (siblingAttempt.client) return siblingAttempt.client;
  }

  // (b) If not already probed above, also check co-hosted Fonoster ports on self-hosted deployments
  if (!endpoint && !isSelfHostedWorkspaceId && isAuthDeniedError(lastErr) && appBaseUrl) {
    const discovered = await discoverOpenCoHostedEndpoints(appBaseUrl);
    for (const discEp of discovered) {
      if (triedEndpoints.includes(discEp)) continue;
      triedEndpoints.push(discEp);
      const attempt = await tryEndpoint(discEp, ['tls-no-verify', 'insecure', 'tls']);
      if (attempt.client) return attempt.client;
    }
  }

  if (isAuthDeniedError(lastErr)) {
    const targetSummary = triedEndpoints.length ? triedEndpoints.join(' and ') : 'configured endpoint';
    if (!endpoint) {
      const err: any = new Error(
        `Invalid credentials on ${targetSummary}. Your keys appear to belong to a self-hosted Fonoster server — click "Self-hosted server?" below to enter your Fonoster server address (e.g. your-server-ip:8449), or set FONOSTER_ENDPOINT on your deployment.`
      );
      err.needsSelfHostedEndpoint = true;
      throw err;
    }
    throw new Error(
      `Invalid credentials rejected by ${targetSummary}. Verify your Workspace Access Key ID (WO...), API Key ID (AP...), and API Key Secret match an active key on that server.`
    );
  }

  if (isConnectionError(lastErr)) {
    const targetEp = resolvedPrimaryEp || 'configured endpoint';
    const tcpDiag = resolvedPrimaryEp ? await probeTcpEndpoint(resolvedPrimaryEp, scheme) : '';
    const detail = lastErr?.details || lastErr?.message || 'gRPC connection failed';
    throw new Error(
      `Could not establish gRPC connection to ${targetEp} (tried ${Array.from(new Set(allTriedModes)).join(', ')}). ${tcpDiag || detail}`
    );
  }

  throw lastErr;
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
  console.log(
    `[Fonoster Apps] Found ${existingApps.length} application(s) in workspace (streamUrl=${streamUrl}, canSyncUrl=${canSyncUrl}):`,
    existingApps.map((a) => ({ ref: a.ref, name: a.name, type: a.type, url: a.url }))
  );

  const tryUpdateStreamApp = async (target: any): Promise<boolean> => {
    if (!canSyncUrl) return false;
    const hasSpeechDefaults = Boolean(
      target.speech &&
        (target.speech.voice ||
          target.speech.language ||
          target.speech.sttModel ||
          target.speech.ttsModel)
    );
    const hasAmdEnabled = Boolean(target.amd?.enabled);
    const isTwilioProtocol = String(target.protocol || '').toLowerCase() === 'twilio';

    if (
      target.url === streamUrl &&
      target.recording === recordingPolicy &&
      isTwilioProtocol &&
      !hasSpeechDefaults &&
      !hasAmdEnabled
    ) {
      return false;
    }
    try {
      // Use protocol: 'twilio' and omit `speech`, `amd`, and `audio` so Fonoster completely
      // removes Deepgram / Aura 2 defaults (Speech -> None) and streams raw 8kHz μ-law audio
      // + DTMF directly over standard Twilio Media Streams WebSocket with zero Vendor Keys!
      await appsApi.updateApplication({
        ref: target.ref,
        name: target.name || 'VoiceDrop Stream',
        type: FonosterSDK.ApplicationType.STREAM,
        url: streamUrl,
        protocol: 'twilio',
        recording: recordingPolicy,
      });
      console.log(
        `[Fonoster Apps] Updated Stream app ref=${target.ref} -> ${streamUrl} (protocol=twilio, Speech/Deepgram completely removed)`
      );
      return true;
    } catch (updateErr: any) {
      console.warn(
        `[Fonoster Apps] Full updateApplication failed for ref=${target.ref}, retrying minimal Twilio STREAM update:`,
        formatFonosterError(updateErr)
      );
      try {
        await appsApi.updateApplication({
          ref: target.ref,
          name: target.name || 'VoiceDrop Stream',
          type: FonosterSDK.ApplicationType.STREAM,
          url: streamUrl,
          protocol: 'twilio',
        } as any);
        console.log(
          `[Fonoster Apps] Minimal Twilio updateApplication succeeded for ref=${target.ref}`
        );
        return true;
      } catch (minUpdateErr: any) {
        console.error(
          `[Fonoster Apps] updateApplication failed for ref=${target.ref}:`,
          formatFonosterError(minUpdateErr)
        );
        return false;
      }
    }
  };

  const trimmedPreferred = (preferredAppRef || '').trim();
  if (trimmedPreferred) {
    const matched = existingApps.find((a) => a.ref === trimmedPreferred);
    if (matched) {
      const updated =
        matched.type === FonosterSDK.ApplicationType.STREAM
          ? await tryUpdateStreamApp(matched)
          : false;
      return { appRef: matched.ref, streamUrl, created: false, updated };
    }
    console.warn(
      `[Fonoster Apps] Preferred appRef=${trimmedPreferred} not found in workspace applications; resolving automatically.`
    );
  }

  const managedName = 'VoiceDrop Stream';
  const existingManaged = existingApps.find(
    (a) =>
      a.type === FonosterSDK.ApplicationType.STREAM &&
      (a.name === managedName || (a.url && a.url.endsWith('/api/fonoster/stream')))
  );

  if (existingManaged) {
    const updated = await tryUpdateStreamApp(existingManaged);
    return { appRef: existingManaged.ref, streamUrl, created: false, updated };
  }

  if (!canSyncUrl) {
    const fallbackApp =
      existingApps.find((a) => a.type === FonosterSDK.ApplicationType.STREAM) || existingApps[0];
    if (fallbackApp?.ref) {
      return { appRef: fallbackApp.ref, streamUrl, created: false, updated: false };
    }
    throw new Error(
      'Cannot auto-create a Fonoster Stream Application with a localhost URL. Open the app via its public HTTPS URL or create an application in Fonoster.'
    );
  }

  try {
    // Create Twilio-protocol Stream app so Fonoster has ZERO Deepgram / Speech dependency (Voice: None)
    const createdRes = await appsApi.createApplication({
      name: managedName,
      type: FonosterSDK.ApplicationType.STREAM,
      url: streamUrl,
      protocol: 'twilio',
      recording: recordingPolicy,
    });
    if (!createdRes?.ref) {
      throw new Error('Fonoster createApplication returned an empty application ref.');
    }
    console.log(
      `[Fonoster Apps] Auto-created Stream app ref=${createdRes.ref} url=${streamUrl} (protocol=twilio, Speech/Deepgram removed)`
    );
    return { appRef: createdRes.ref, streamUrl, created: true, updated: false };
  } catch (createErr: any) {
    console.warn(
      '[Fonoster Apps] Full createApplication failed, retrying minimal Twilio STREAM payload:',
      formatFonosterError(createErr)
    );
    try {
      const minimalRes = await appsApi.createApplication({
        name: managedName,
        type: FonosterSDK.ApplicationType.STREAM,
        url: streamUrl,
        protocol: 'twilio',
      } as any);
      if (minimalRes?.ref) {
        console.log(`[Fonoster Apps] Minimal Twilio createApplication succeeded ref=${minimalRes.ref}`);
        return { appRef: minimalRes.ref, streamUrl, created: true, updated: false };
      }
    } catch (minCreateErr: any) {
      console.error(
        '[Fonoster Apps] Minimal createApplication also failed:',
        formatFonosterError(minCreateErr)
      );
    }

    const fallbackStream =
      existingApps.find((a) => a.type === FonosterSDK.ApplicationType.STREAM && a.ref) ||
      existingApps.find((a) => Boolean(a.ref));
    if (fallbackStream?.ref) {
      console.warn(
        `[Fonoster Apps] Falling back to existing workspace app ref=${fallbackStream.ref} name=${fallbackStream.name} type=${fallbackStream.type}`
      );
      return { appRef: fallbackStream.ref, streamUrl, created: false, updated: false };
    }
    throw createErr;
  }
}

export async function verifyFonosterConnection(
  creds: FonosterCredentials,
  appBaseUrl: string,
  syncApp = true
) {
  const client = await createAuthenticatedFonosterClient(creds, appBaseUrl);
  const resolvedEndpoint = (client as any).endpoint as string | undefined;
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

  const warning = isLocalStreamUrl(streamUrl)
    ? 'Server is currently addressed via localhost; Fonoster requires a public wss:// URL to connect back to voice streams.'
    : isCookieGatedPreviewUrl(streamUrl)
    ? 'AI Studio preview URLs require browser login cookies and block external Fonoster WebSockets (HTTP 302). Deploy VoiceDrop to your public server (e.g. Coolify) or set FONOSTER_STREAM_URL so calls stay connected upon pickup.'
    : undefined;

  return {
    ok: true,
    endpoint: resolvedEndpoint,
    streamUrl,
    syncedAppRef,
    appAction,
    applications,
    numbers,
    warning,
  };
}

function normalizeE164Strict(raw: string): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^tel:/i, '')
    .replace(/[\s\-().]/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('+')) return cleaned;
  return `+${cleaned}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const timeoutErr: any = new Error(`${label} timed out after ${timeoutMs}ms`);
          timeoutErr.code = 4; // gRPC DEADLINE_EXCEEDED
          reject(timeoutErr);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const cleanFrom = normalizeE164Strict(params.from || creds.phoneNumber || '');
  const cleanTo = normalizeE164Strict(params.to);

  if (!/^\+\d{7,15}$/.test(cleanFrom)) {
    throw new Error(`Invalid Fonoster Caller ID E.164 phone number: "${params.from}"`);
  }
  if (!/^\+\d{7,15}$/.test(cleanTo)) {
    throw new Error(`Invalid destination E.164 phone number: "${params.to}"`);
  }

  const client = await createAuthenticatedFonosterClient(creds, params.appBaseUrl);
  const resolvedEndpoint =
    ((client as any).__fonosterResolvedEndpoint as string | undefined) ||
    ((client as any).endpoint as string | undefined);
  const transportMode =
    ((client as any).__fonosterTransportMode as FonosterTransportMode | undefined) || 'tls';

  const { appRef, streamUrl, created, updated } = await ensureFonosterVoiceApp(
    client,
    params.appBaseUrl,
    creds.appRef,
    params.recordCall
  );

  const cleanAppRef = String(appRef || '').trim();
  if (!cleanAppRef) {
    throw new Error(
      'Unable to resolve a valid Fonoster Voice Application ref (appRef) in your workspace.'
    );
  }

  const createCallRequest = {
    from: cleanFrom,
    to: cleanTo,
    appRef: cleanAppRef,
    timeout: 45,
    metadata: {
      callId: params.callId,
      deviceId: params.deviceId,
    },
  };

  console.log(
    '[Fonoster CreateCall] Sending gRPC Calls.CreateCall request:',
    JSON.stringify({
      endpoint: resolvedEndpoint || 'default',
      transportMode,
      workspaceId: (creds.projectId || '').trim(),
      from: createCallRequest.from,
      to: createCallRequest.to,
      appRef: createCallRequest.appRef,
      timeout: createCallRequest.timeout,
      metadata: createCallRequest.metadata,
      streamUrl,
    })
  );

  const callsApi = new FonosterSDK.Calls(client);
  let createdCall: Awaited<ReturnType<FonosterSDK.Calls['createCall']>>;
  try {
    createdCall = await withTimeout(
      callsApi.createCall(createCallRequest),
      20000,
      'Fonoster Calls.CreateCall'
    );
  } catch (err: any) {
    const diag = formatFonosterError(err);
    console.error(
      '[Fonoster CreateCall] gRPC Calls.CreateCall FAILED:',
      JSON.stringify({
        endpoint: resolvedEndpoint || 'default',
        transportMode,
        from: createCallRequest.from,
        to: createCallRequest.to,
        appRef: createCallRequest.appRef,
        error: diag,
      })
    );
    const wrapped: any = new Error(
      `Fonoster CreateCall rejected by ${resolvedEndpoint || 'server'}: ${diag.summary}`
    );
    wrapped.code = diag.code;
    wrapped.details = diag.details;
    wrapped.cause = err;
    throw wrapped;
  }

  const callRef = typeof createdCall?.ref === 'string' ? createdCall.ref.trim() : '';
  if (!callRef) {
    console.error(
      '[Fonoster CreateCall] Invalid response — empty call ref:',
      JSON.stringify({
        endpoint: resolvedEndpoint || 'default',
        transportMode,
        response: createdCall ? { ref: createdCall.ref } : null,
      })
    );
    throw new Error(
      `Fonoster server (${resolvedEndpoint || 'default'}) did not return a valid Call Ref from CreateCall.`
    );
  }

  console.log(
    '[Fonoster CreateCall] gRPC Calls.CreateCall ACCEPTED:',
    JSON.stringify({
      endpoint: resolvedEndpoint || 'default',
      transportMode,
      callRef,
      appRef: cleanAppRef,
      from: cleanFrom,
      to: cleanTo,
    })
  );

  const getCallRecord = async (ref: string) => {
    try {
      return await withTimeout(callsApi.getCall(ref), 5000, 'Fonoster Calls.GetCall');
    } catch (cdrErr: any) {
      console.warn(
        `[Fonoster GetCall] Could not fetch CDR for ref=${ref}:`,
        formatFonosterError(cdrErr)
      );
      return null;
    }
  };

  return {
    client,
    ref: callRef,
    statusStream: createdCall.statusStream,
    getCallRecord,
    appRef: cleanAppRef,
    endpoint: resolvedEndpoint,
    transportMode,
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

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function stopFonosterPlayback(callId: string): void {
  const state = activeFonosterCalls.get(callId);
  if (!state) return;
  state.playbackEpoch += 1;
  state.isInterruptible = false;
  if (!state.transport.ended) {
    try {
      state.transport.clearAudio();
    } catch {
      // Ignore clear error on closing socket
    }
  }
}

/**
 * Speaks custom text over a live Fonoster call by synthesizing neural speech locally in VoiceDrop
 * and streaming raw PCMU / PCM16 frames directly over the active WebSocket transport
 * (Twilio Media Streams JSON OR Fonoster Session v1 binary).
 * Completely bypasses Fonoster's Speech layer (Deepgram TTS/STT) and requires zero Vendor Keys!
 */
export async function sayOnFonosterCall(
  callId: string,
  text: string,
  options?: { interruptible?: boolean; preempt?: boolean; voice?: string }
): Promise<boolean> {
  const state = activeFonosterCalls.get(callId);
  const cleanText = String(text || '').trim();
  if (!state || state.transport.ended || !cleanText) return false;

  const preempt = options?.preempt ?? true;
  const interruptible = options?.interruptible ?? true;

  if (preempt) {
    state.playbackEpoch += 1;
    if (state.hasSentAudio) {
      try {
        state.transport.clearAudio();
      } catch {
        // Ignore clear error
      }
    }
  }
  const myEpoch = state.playbackEpoch;
  state.isInterruptible = interruptible;

  const negotiatedCodec: TelephonyCodec = state.transport.codec;
  const negotiatedRate: TelephonyRate = state.transport.sampleRate;

  try {
    const synthesized = await synthesizeTelephonyAudio(cleanText, {
      voice: options?.voice || state.voice,
      codec: negotiatedCodec,
      sampleRate: negotiatedRate,
    });

    if (state.transport.ended || state.playbackEpoch !== myEpoch) {
      return false;
    }

    const bytesPerSample = synthesized.codec === 'pcmu' ? 1 : 2;
    const frameMs = 20;
    const frameBytes = Math.round((synthesized.sampleRate * frameMs) / 1000) * bytesPerSample;
    const audioBuf = synthesized.audio;
    const totalFrames = Math.ceil(audioBuf.length / frameBytes);

    console.log(
      `[Fonoster Audio] Streaming TTS callId=${callId} proto=${state.transport.protocol} engine=${synthesized.engine} voice=${synthesized.voice} cached=${synthesized.cached} codec=${synthesized.codec}/${synthesized.sampleRate}Hz duration=${synthesized.durationMs}ms frames=${totalFrames}`
    );

    // Pre-buffer 4 frames (80ms) for smooth jitter-free playout, then pace steadily every 20ms
    // using incremental non-bursting scheduling so a delayed timer tick NEVER floods Fonoster's jitter buffer!
    const prebufferFrames = 4;
    let nextFrameAt = Date.now();

    for (let i = 0; i < totalFrames; i++) {
      if (state.transport.ended || state.playbackEpoch !== myEpoch) {
        return false;
      }

      const start = i * frameBytes;
      const end = Math.min(start + frameBytes, audioBuf.length);
      let frame = audioBuf.subarray(start, end);
      if (frame.length < frameBytes) {
        const padded = Buffer.alloc(frameBytes, synthesized.codec === 'pcmu' ? 0xff : 0);
        frame.copy(padded);
        frame = padded;
      }

      state.hasSentAudio = true;
      state.transport.sendAudioFrame(frame);

      if (i + 1 >= prebufferFrames) {
        if (i + 1 === prebufferFrames) {
          nextFrameAt = Date.now() + frameMs;
        } else {
          nextFrameAt += frameMs;
        }
        const now = Date.now();
        const waitMs = nextFrameAt - now;
        if (waitMs > 1) {
          await sleepMs(waitMs);
        } else if (waitMs < -60) {
          // Resync clock smoothly instead of burst-dumping frames into the SIP jitter buffer
          nextFrameAt = now;
        }
      }
    }

    if (state.transport.ended || state.playbackEpoch !== myEpoch) {
      return false;
    }

    // Wait for AppBridge playout confirmation via mark (with safe timeout fallback)
    const markName = `tts-${myEpoch}-${Date.now()}`;
    const playoutMarginMs = prebufferFrames * frameMs + 700;
    await Promise.race([
      state.transport.sendMark(markName).catch(() => ({ cleared: false })),
      sleepMs(playoutMarginMs),
    ]);

    if (state.playbackEpoch === myEpoch) {
      state.isInterruptible = false;
    }
    return true;
  } catch (err) {
    console.error(`[Fonoster Audio] Raw TTS stream failed for ${callId}:`, err);
    return false;
  }
}

export async function hangupFonosterCall(callId: string): Promise<boolean> {
  const state = activeFonosterCalls.get(callId);
  if (!state) return false;
  state.playbackEpoch += 1;
  if (state.amdFallbackTimer) {
    clearTimeout(state.amdFallbackTimer);
    state.amdFallbackTimer = undefined;
  }
  if (state.transport.ended) {
    activeFonosterCalls.delete(callId);
    return true;
  }
  try {
    await state.transport.hangup();
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
  onSpeechActivity?: (session: any, speaking: boolean) => void;
  onSpeechTurn: (
    session: any,
    text: string,
    confidence?: number,
    meta?: SpeechTranscriptMeta
  ) => Promise<boolean>;
  onDigitsSubmitted: (
    session: any,
    digits: string,
    submittedViaPound: boolean,
    state: FonosterSessionState
  ) => Promise<void>;
  onLocalRecordingReady?: (
    session: any,
    wavBuffer: Buffer,
    durationSec: number
  ) => Promise<void>;
  onMediaStalled?: (session: any) => void;
  onSessionError?: (session: any, err: { code?: string; message?: string; fatal?: boolean }) => void;
  onSessionEnded: (session: any, reason: string) => Promise<void>;
  getMaxDigits: (numDigits?: number) => number;
}

/**
 * Dual-protocol WebSocket server mounted on `/api/fonoster/stream`.
 * Automatically handles BOTH:
 *   1. Twilio Media Streams (`protocol: 'twilio'`) — zero Deepgram, Speech=None in Fonoster UI, 8kHz μ-law JSON
 *   2. Fonoster Session v1 (`protocol: 'fonoster'`) — backward-compatible binary PCM16/PCMU
 */
export function attachFonosterVoiceServer(
  httpServer: HttpServer,
  hooks: FonosterVoiceBridgeHooks
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname !== '/api/fonoster/stream') return;

    console.log(
      '[Fonoster Voice] Incoming WebSocket upgrade request:',
      JSON.stringify({
        url: req.url,
        host: req.headers.host,
        forwardedHost: req.headers['x-forwarded-host'],
        forwardedProto: req.headers['x-forwarded-proto'],
        protocol: req.headers['sec-websocket-protocol'],
        remoteAddress: req.socket?.remoteAddress,
      })
    );

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleDualProtocolSocket(ws, hooks);
    });
  });

  return wss;
}

function handleDualProtocolSocket(ws: WebSocket, hooks: FonosterVoiceBridgeHooks): void {
  let initialized = false;
  let activeState: FonosterSessionState | null = null;
  let activeSessionObj: any = null;
  let detectedProtocol: 'twilio' | 'fonoster' | null = null;
  let twilioStreamSid = '';
  let negotiatedCodec: TelephonyCodec = 'pcmu';
  let negotiatedRate: TelephonyRate = 8000;
  let connectedAt = Date.now();
  let voiceFramesSeen = 0;
  let silenceAfterVoiceFrames = 0;
  let ended = false;
  let speechTracker: InboundSpeechTracker | null = null;
  let callRecorder: LiveCallRecorder | null = null;
  let seenInboundMedia = false;
  let lastInboundMediaAt = 0;
  let mediaStallPingedAt = 0;

  const markWaiters = new Map<string, Array<(res: { cleared: boolean }) => void>>();

  const resolveMark = (name: string, cleared = false) => {
    const list = markWaiters.get(name);
    const fn = list?.shift();
    if (list && list.length === 0) markWaiters.delete(name);
    fn?.({ cleared });
  };

  const clearAllMarks = () => {
    for (const list of markWaiters.values()) {
      for (const fn of list) fn({ cleared: true });
    }
    markWaiters.clear();
  };

  const sendJson = (payload: Record<string, any>) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  };

  // Fast keepalive + inbound media stall detector so recipient hangup is detected in < 1s
  // even when a reverse proxy (Traefik/Nginx) delays WebSocket TCP FIN!
  let isAlive = true;
  ws.on('pong', () => {
    isAlive = true;
    mediaStallPingedAt = 0;
  });
  const pingTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!isAlive) {
      ws.terminate();
      return;
    }
    isAlive = false;
    try {
      ws.ping();
    } catch {}
  }, 10000);

  const mediaWatchTimer = setInterval(() => {
    if (ended || !initialized || !activeSessionObj || !seenInboundMedia) return;
    if (ws.readyState !== WebSocket.OPEN) {
      finishSession('socket_not_open');
      return;
    }
    const silentMs = Date.now() - lastInboundMediaAt;
    if (silentMs >= 1050) {
      // Inbound 20ms RTP packets stopped arriving — likely recipient hung up!
      // Trigger immediate CDR check + fast WebSocket ping probe.
      hooks.onMediaStalled?.(activeSessionObj);
      if (!mediaStallPingedAt) {
        mediaStallPingedAt = Date.now();
        try {
          ws.ping();
        } catch {
          finishSession('media_stall_ping_error');
        }
      } else if (Date.now() - mediaStallPingedAt >= 900 && silentMs >= 2000) {
        console.warn(
          `[Fonoster Voice] Inbound media stalled for ${silentMs}ms with no pong — closing callId=${activeSessionObj.id}`
        );
        try {
          ws.terminate();
        } catch {}
        finishSession('inbound_media_ended');
      }
    } else {
      mediaStallPingedAt = 0;
    }
  }, 350);

  // Guard against silent connections that never send start/session.start
  const startTimeout = setTimeout(() => {
    if (!initialized && ws.readyState === WebSocket.OPEN) {
      console.warn('[Fonoster Voice] Closing idle WebSocket: no start / session.start within 8s');
      ws.close(1008, 'no start message');
    }
  }, 8000);

  const transport: FonosterStreamTransport = {
    get protocol() {
      return detectedProtocol || 'twilio';
    },
    get codec() {
      return negotiatedCodec;
    },
    get sampleRate() {
      return negotiatedRate;
    },
    get ended() {
      return ended || ws.readyState !== WebSocket.OPEN;
    },
    sendAudioFrame: (frame: Buffer) => {
      if (ended || ws.readyState !== WebSocket.OPEN) return;
      callRecorder?.recordOutbound(frame, negotiatedCodec, negotiatedRate);
      if (detectedProtocol === 'twilio') {
        const payloadObj: Record<string, any> = {
          event: 'media',
          media: {
            payload: frame.toString('base64'),
          },
        };
        if (twilioStreamSid) {
          payloadObj.streamSid = twilioStreamSid;
        }
        sendJson(payloadObj);
      } else {
        ws.send(frame, { binary: true });
      }
    },
    clearAudio: () => {
      if (ended || ws.readyState !== WebSocket.OPEN) return;
      if (detectedProtocol === 'twilio') {
        sendJson({ event: 'clear', streamSid: twilioStreamSid });
      } else {
        sendJson({ type: 'clear' });
      }
    },
    sendMark: (name: string) =>
      new Promise((resolve) => {
        if (ended || ws.readyState !== WebSocket.OPEN) {
          resolve({ cleared: true });
          return;
        }
        const list = markWaiters.get(name) || [];
        list.push(resolve);
        markWaiters.set(name, list);
        if (detectedProtocol === 'twilio') {
          sendJson({
            event: 'mark',
            streamSid: twilioStreamSid,
            mark: { name },
          });
        } else {
          sendJson({ type: 'mark', name });
        }
      }),
    hangup: async () => {
      if (ended) return;
      if (ws.readyState === WebSocket.OPEN) {
        if (detectedProtocol === 'fonoster') {
          sendJson({ type: 'hangup' });
        }
        try {
          ws.close(1000, 'hangup');
        } catch {}
      }
    },
  };

  const triggerGreetingOnce = async (sourceLabel = 'raw_audio_pickup') => {
    if (!activeState || !activeSessionObj || activeState.greetStarted || ended) return;
    if (activeSessionObj.answeredBy === 'voicemail' && !activeSessionObj.humanPickedUpAfterVoicemail) {
      return;
    }
    activeState.greetStarted = true;
    if (activeState.amdFallbackTimer) {
      clearTimeout(activeState.amdFallbackTimer);
      activeState.amdFallbackTimer = undefined;
    }
    if (!activeState.amdResolved) {
      activeState.amdResolved = true;
      await hooks.onAmdResult(activeSessionObj, 'human', sourceLabel);
    }
    await hooks.onStartHumanGreeting(activeSessionObj, activeState);
  };

  const handleInboundAudioFrame = (frame: Buffer) => {
    if (!activeState || ended) return;
    seenInboundMedia = true;
    lastInboundMediaAt = Date.now();
    mediaStallPingedAt = 0;

    // Record recipient's live inbound audio into our synchronized two-way HD call recording
    callRecorder?.recordInbound(frame, negotiatedCodec, negotiatedRate);

    // Continuously feed every inbound recipient audio frame into live streaming STT (before, during, and after prompts!)
    speechTracker?.pushFrame(frame);

    if (activeState.greetStarted) return;
    const elapsed = Date.now() - connectedAt;
    if (elapsed < 220) return;

    const rms = computeFrameRms(frame, negotiatedCodec);
    if (rms >= 0.025) {
      voiceFramesSeen += 1;
      silenceAfterVoiceFrames = 0;
    } else if (voiceFramesSeen >= 4) {
      silenceAfterVoiceFrames += 1;
      if (silenceAfterVoiceFrames >= 9) {
        void triggerGreetingOnce('local_vad_human_pickup');
      }
    }
  };

  const handleDtmfDigit = (rawDigit: string) => {
    if (!activeState || !activeSessionObj || ended) return;
    const key = String(rawDigit || '').trim();
    if (!key) return;

    console.log(`[Fonoster DTMF] callId=${activeSessionObj.id} proto=${detectedProtocol} digit=${key}`);

    if (activeState.isInterruptible) {
      stopFonosterPlayback(activeSessionObj.id);
    }

    if (activeSessionObj.answeredBy === 'voicemail' && !activeSessionObj.humanPickedUpAfterVoicemail) {
      activeSessionObj.humanPickedUpAfterVoicemail = true;
      void hooks
        .onAmdResult(activeSessionObj, 'human', 'dtmf_human_pickup')
        .then(() => triggerGreetingOnce('dtmf_human_pickup'));
    } else if (!activeState.greetStarted) {
      activeState.amdResolved = true;
      void hooks.onAmdResult(activeSessionObj, 'human', 'dtmf_confirmed_human');
    }

    if (key === '#') {
      if (activeState.digitBuffer.length >= 1) {
        const submitted = activeState.digitBuffer;
        activeState.digitBuffer = '';
        void hooks.onDigitsSubmitted(activeSessionObj, submitted, true, activeState);
      }
      return;
    }

    if (/^[0-9*]$/.test(key)) {
      activeState.digitBuffer += key;
      const maxDigits = hooks.getMaxDigits(activeSessionObj.numDigits);
      if (activeState.digitBuffer.length >= maxDigits) {
        const submitted = activeState.digitBuffer.slice(0, maxDigits);
        activeState.digitBuffer = '';
        void hooks.onDigitsSubmitted(activeSessionObj, submitted, false, activeState);
      }
    }
  };

  const startVoiceSession = (meta: {
    protocol: 'twilio' | 'fonoster';
    callId?: string;
    callRef: string;
    from: string;
    to: string;
    codec: TelephonyCodec;
    sampleRate: TelephonyRate;
    streamSid?: string;
  }) => {
    if (initialized) return;
    initialized = true;
    clearTimeout(startTimeout);

    detectedProtocol = meta.protocol;
    twilioStreamSid = meta.streamSid || '';
    negotiatedCodec = meta.codec;
    negotiatedRate = meta.sampleRate;
    connectedAt = Date.now();

    const session = hooks.resolveSession({
      callId: meta.callId,
      callRef: meta.callRef,
      to: meta.to,
    });

    if (!session) {
      console.warn(
        `[Fonoster Voice] Incoming ${meta.protocol} stream for unknown callId=${meta.callId || ''} callRef=${meta.callRef} to=${meta.to}`
      );
      void transport.hangup();
      return;
    }

    activeSessionObj = session;
    console.log(
      `[Fonoster Voice] Stream session connected (protocol=${meta.protocol}, Deepgram bypassed):`,
      JSON.stringify({
        callId: session.id,
        callRef: meta.callRef,
        streamSid: twilioStreamSid || undefined,
        from: meta.from,
        to: meta.to,
        codec: negotiatedCodec,
        sampleRate: negotiatedRate,
      })
    );

    const state: FonosterSessionState = {
      transport,
      callId: session.id,
      voice: session.voice,
      digitBuffer: '',
      greetStarted: Boolean(session.promptsStarted),
      amdResolved: false,
      playbackEpoch: 0,
      isInterruptible: false,
      hasSentAudio: false,
    };

    activeState = state;
    activeFonosterCalls.set(session.id, state);

    // Start real-time dual-leg call audio recorder (records BOTH VoiceDrop prompts & recipient voice smoothly!)
    if (session.recordCall !== false) {
      callRecorder = new LiveCallRecorder(session.id);
    }

    // Attach real-time zero-key built-in local Moonshine Tiny streaming STT tracker (~80ms latency!).
    // Emits instant 40ms speaking indicator + word-by-word partials without interrupting active voice prompts!
    speechTracker = new InboundSpeechTracker({
      callId: session.id,
      codec: negotiatedCodec,
      sampleRate: negotiatedRate,
      onSpeechActivity: (speaking) => {
        if (!activeSessionObj || ended) return;
        hooks.onSpeechActivity?.(activeSessionObj, speaking);
      },
      onTranscript: async (text, confidence, _engine, meta) => {
        if (!activeSessionObj) return;
        const shouldWake = await hooks.onSpeechTurn(activeSessionObj, text, confidence, meta);
        if (shouldWake) {
          await triggerGreetingOnce('speech_human_pickup');
        }
      },
    });

    hooks.onSessionConnected(session, meta.callRef);

    // Crisp fallback: start greeting smoothly at 750ms even if callee answered quietly
    state.amdFallbackTimer = setTimeout(() => {
      if (!state.greetStarted && !ended) {
        void triggerGreetingOnce('immediate_pickup_cadence');
      }
    }, 750);
  };

  const finishSession = (reason: string) => {
    if (ended) return;
    ended = true;
    clearTimeout(startTimeout);
    clearInterval(pingTimer);
    clearInterval(mediaWatchTimer);
    clearAllMarks();
    speechTracker?.flushAndClose();
    const recorded = callRecorder?.finalize() || null;

    if (activeState) {
      activeState.playbackEpoch += 1;
      if (activeState.amdFallbackTimer) {
        clearTimeout(activeState.amdFallbackTimer);
        activeState.amdFallbackTimer = undefined;
      }
      activeFonosterCalls.delete(activeState.callId);
    }

    if (activeSessionObj) {
      const finishedSession = activeSessionObj;
      console.log(
        `[Fonoster Voice] Session ended callId=${finishedSession.id} proto=${detectedProtocol} reason=${reason} recorded=${Boolean(recorded)}`
      );
      // 1. Start background HD MP3 transcode (synchronously marks inFlightLocalRecordings, yields immediately to ffmpeg)
      if (recorded && hooks.onLocalRecordingReady) {
        void hooks
          .onLocalRecordingReady(finishedSession, recorded.wavBuffer, recorded.durationSec)
          .catch((recErr) => {
            console.error(
              `[Fonoster Recorder] Failed to save recording for ${finishedSession.id}:`,
              recErr
            );
          });
      }

      // 2. IMMEDIATELY mark the call ended on the dashboard (< 5ms!) — NEVER waits for ffmpeg transcoding!
      void hooks.onSessionEnded(finishedSession, reason);
    }
  };

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      // Fonoster Session v1 binary audio frame: first byte is trackId, rest is PCM16/PCMU payload
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      if (buf.length > 1) {
        handleInboundAudioFrame(buf.subarray(1));
      }
      return;
    }

    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // --- 1. Twilio Media Streams protocol (`protocol: 'twilio'`) ---
    if (typeof msg.event === 'string') {
      if (msg.event === 'connected') {
        detectedProtocol = 'twilio';
        return;
      }
      if (msg.event === 'start') {
        console.log('[Fonoster Voice] Raw Twilio start message:', JSON.stringify(msg));
        const s = msg.start || {};
        const custom = s.customParameters || msg.customParameters || {};
        const streamSid = String(msg.streamSid || s.streamSid || '');
        const callRef = String(s.callSid || msg.callSid || custom.callRef || '');
        const callId = typeof custom.callId === 'string' ? custom.callId : undefined;
        const from = String(custom.from || s.from || '');
        const to = String(custom.to || s.to || '');
        const encoding = String(s.mediaFormat?.encoding || '').toLowerCase();
        // IMPORTANT: "audio/pcmu" contains "pcm" — only select pcm16 for explicit linear PCM!
        // Twilio Media Streams defaults to 8kHz G.711 mu-law (pcmu).
        const isLinearPcm =
          encoding.includes('pcm16') ||
          encoding.includes('l16') ||
          encoding.includes('linear') ||
          encoding.includes('slin');
        const codec: TelephonyCodec = isLinearPcm ? 'pcm16' : 'pcmu';
        const rawRate = Number(s.mediaFormat?.sampleRate || 8000);
        const sampleRate: TelephonyRate =
          codec === 'pcmu' ? 8000 : rawRate === 16000 || rawRate === 24000 ? (rawRate as TelephonyRate) : 8000;

        startVoiceSession({
          protocol: 'twilio',
          callId,
          callRef,
          from,
          to,
          codec,
          sampleRate,
          streamSid,
        });
        return;
      }
      if (msg.event === 'media') {
        if (!twilioStreamSid && msg.streamSid) {
          twilioStreamSid = String(msg.streamSid);
        }
        const track = String(msg.media?.track || 'inbound').toLowerCase();
        if (track === 'outbound' || track === 'outbound_track') return;
        const b64 = msg.media?.payload;
        if (typeof b64 === 'string' && b64.length > 0) {
          handleInboundAudioFrame(Buffer.from(b64, 'base64'));
        }
        return;
      }
      if (msg.event === 'dtmf') {
        handleDtmfDigit(msg.dtmf?.digit ?? msg.digit ?? '');
        return;
      }
      if (msg.event === 'mark') {
        const name = String(msg.mark?.name || msg.name || '');
        if (name) resolveMark(name, false);
        return;
      }
      if (msg.event === 'stop') {
        finishSession('twilio_stream_stop');
        return;
      }
      return;
    }

    // --- 2. Fonoster Session v1 protocol (`protocol: 'fonoster'`) ---
    if (typeof msg.type === 'string') {
      if (msg.type === 'session.start') {
        const codec: TelephonyCodec = msg.audio?.codec === 'pcmu' ? 'pcmu' : 'pcm16';
        const rawRate = Number(msg.audio?.rate || 16000);
        const sampleRate: TelephonyRate =
          codec === 'pcmu' ? 8000 : rawRate === 8000 || rawRate === 24000 ? (rawRate as TelephonyRate) : 16000;
        const metaCallId = typeof msg.metadata?.callId === 'string' ? msg.metadata.callId : undefined;
        startVoiceSession({
          protocol: 'fonoster',
          callId: metaCallId,
          callRef: String(msg.callRef || ''),
          from: String(msg.from || ''),
          to: String(msg.to || ''),
          codec,
          sampleRate,
        });
        return;
      }
      if (msg.type === 'dtmf') {
        handleDtmfDigit(msg.digit ?? '');
        return;
      }
      if (msg.type === 'mark') {
        if (msg.name) resolveMark(String(msg.name), msg.cleared === true);
        return;
      }
      if (msg.type === 'amd.result' && activeSessionObj && activeState && !activeState.greetStarted) {
        activeState.amdResolved = true;
        if (activeState.amdFallbackTimer) {
          clearTimeout(activeState.amdFallbackTimer);
          activeState.amdFallbackTimer = undefined;
        }
        const rawStatus = String(msg.status || 'unknown').toLowerCase();
        const mapped: 'human' | 'voicemail' | 'fax' | 'unknown' =
          rawStatus === 'human'
            ? 'human'
            : rawStatus === 'voicemail' || rawStatus === 'machine' || rawStatus === 'ivr'
            ? 'voicemail'
            : 'unknown';
        const rawLabel = `fonoster_${rawStatus}${msg.reason ? `_${msg.reason}` : ''}`;
        void hooks.onAmdResult(activeSessionObj, mapped, rawLabel).then(async () => {
          if (mapped === 'human' || (mapped === 'unknown' && activeSessionObj.answeredBy !== 'voicemail')) {
            await triggerGreetingOnce(rawLabel);
          }
        });
        return;
      }
      if (msg.type === 'turn.ended' && activeSessionObj) {
        const text = String(msg.text || '').trim();
        if (text) {
          void hooks.onSpeechTurn(activeSessionObj, text, msg.confidence).then(async (shouldWake) => {
            if (shouldWake) await triggerGreetingOnce('speech_human_pickup');
          });
        }
        return;
      }
      if (msg.type === 'error' && activeSessionObj) {
        console.error(`[Fonoster Voice] Session error (${activeSessionObj.id}):`, msg);
        hooks.onSessionError?.(activeSessionObj, {
          code: msg.code,
          message: msg.message,
          fatal: msg.fatal === true,
        });
        if (msg.fatal === true) {
          finishSession('error');
        }
        return;
      }
      if (msg.type === 'session.end') {
        finishSession(String(msg.reason || 'ended'));
        return;
      }
    }
  });

  ws.on('close', (code, reasonBuf) => {
    const reasonText = reasonBuf?.toString()?.trim();
    finishSession(reasonText ? `closed_${code}_${reasonText}` : `closed_${code}`);
  });

  ws.on('error', (err) => {
    console.error('[Fonoster Voice] WebSocket error:', err);
    finishSession('socket_error');
  });
}
