import type { Server as HttpServer } from 'http';
import { createRequire } from 'module';
import net from 'net';
import * as FonosterSDK from '@fonoster/sdk';
import { VoiceServer, type Session as FonosterVoiceSession } from '@fonoster/voice';
import { PCM16_SAMPLE_RATE, synthesizePcm16 } from './tts.ts';
import {
  GoertzelDtmfDetector,
  Pcm16CallRecorder,
  Pcm16VadAmdDetector,
  streamPcm16Frames,
} from './audioDsp.ts';
import { broadcastMonitorAudio, closeMonitorSubscribers } from './audioMonitor.ts';

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

export interface FonosterSessionState {
  voiceSession: FonosterVoiceSession;
  callId: string;
  voice?: string;
  digitBuffer: string;
  greetStarted: boolean;
  amdResolved: boolean;
  amdFallbackTimer?: ReturnType<typeof setTimeout>;
  playbackAbort?: AbortController;
  playbackStartedAt?: number;
  currentPlaybackInterruptible: boolean;
  recorder?: Pcm16CallRecorder;
  recorderFinalized: boolean;
  dtmfDetector: GoertzelDtmfDetector;
  vadAmd: Pcm16VadAmdDetector;
  lastDigit?: { key: string; source: 'rfc2833' | 'inband-pcm16'; at: number };
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

function hasAnySpeechVendorConfig(app: any): boolean {
  if (!app || typeof app !== 'object') return false;
  const s = app.speech;
  if (!s || typeof s !== 'object') return false;
  return Object.values(s).some((val) => {
    if (val === undefined || val === null || val === false || val === '') return false;
    if (typeof val === 'string' && val.trim().toLowerCase() === 'none') return false;
    return true;
  });
}

function buildVoiceDropStreamAppPayload(name: string, url: string) {
  // Speech is intentionally OMITTED so Fonoster enforces Speech Voice = None, Vendor = None, Transcriber = None.
  // VoiceDrop handles 100% of TTS, VAD/AMD, recording, monitoring, and DTMF directly over PCM16 16kHz WebSocket.
  return {
    name: name || 'VoiceDrop Stream',
    type: FonosterSDK.ApplicationType.STREAM,
    url,
    protocol: 'fonoster' as const,
    audio: {
      codec: 'pcm16' as const,
      rate: PCM16_SAMPLE_RATE,
    },
    recording: '' as const,
    amd: { enabled: false },
  };
}

export async function ensureFonosterVoiceApp(
  client: FonosterSDK.Client,
  appBaseUrl: string,
  preferredAppRef?: string,
  _recordCall = true
): Promise<{ appRef: string; streamUrl: string; created: boolean; updated: boolean }> {
  const appsApi = new FonosterSDK.Applications(client);
  const streamUrl = buildFonosterStreamUrl(appBaseUrl);
  const canSyncUrl = !isLocalStreamUrl(streamUrl);

  const listRes = await appsApi.listApplications({ pageSize: 50 });
  const existingApps = Array.isArray(listRes?.items) ? listRes.items : [];
  console.log(
    `[Fonoster Apps] Found ${existingApps.length} application(s) in workspace (streamUrl=${streamUrl}, canSyncUrl=${canSyncUrl}):`,
    existingApps.map((a: any) => ({
      ref: a.ref,
      name: a.name,
      type: a.type,
      url: a.url,
      protocol: a.protocol,
      audio: a.audio,
      hasSpeech: hasAnySpeechVendorConfig(a),
    }))
  );

  const tryUpdateStreamApp = async (target: any): Promise<boolean> => {
    const targetUrl = canSyncUrl ? streamUrl : target.url;
    if (!targetUrl || isLocalStreamUrl(targetUrl)) return false;

    const alreadyClean =
      target.url === targetUrl &&
      target.protocol === 'fonoster' &&
      target.audio?.codec === 'pcm16' &&
      Number(target.audio?.rate) === PCM16_SAMPLE_RATE &&
      !hasAnySpeechVendorConfig(target) &&
      !target.amd?.enabled &&
      (!target.recording || target.recording === 'off');

    if (alreadyClean) {
      return false;
    }

    const fullPayload = {
      ref: target.ref,
      ...buildVoiceDropStreamAppPayload(target.name || 'VoiceDrop Stream', targetUrl),
    };

    try {
      await appsApi.updateApplication(fullPayload);
      console.log(
        `[Fonoster Apps] Synced Stream app ref=${target.ref} -> ${targetUrl} (protocol=fonoster, audio=pcm16@16000, speech=None, amd=local)`
      );
      return true;
    } catch (updateErr: any) {
      console.warn(
        `[Fonoster Apps] Full updateApplication failed for ref=${target.ref}, retrying speech=None PCM16 update:`,
        formatFonosterError(updateErr)
      );
      try {
        await appsApi.updateApplication({
          ref: target.ref,
          name: target.name || 'VoiceDrop Stream',
          type: FonosterSDK.ApplicationType.STREAM,
          url: targetUrl,
          protocol: 'fonoster',
          audio: { codec: 'pcm16', rate: PCM16_SAMPLE_RATE },
        } as any);
        console.log(
          `[Fonoster Apps] Compact updateApplication succeeded for ref=${target.ref} (speech=None, pcm16@16000)`
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
      const updated =
        fallbackApp.type === FonosterSDK.ApplicationType.STREAM
          ? await tryUpdateStreamApp(fallbackApp)
          : false;
      return { appRef: fallbackApp.ref, streamUrl, created: false, updated };
    }
    throw new Error(
      'Cannot auto-create a Fonoster Stream Application with a localhost URL. Open the app via its public HTTPS URL or create an application in Fonoster.'
    );
  }

  try {
    const createdRes = await appsApi.createApplication(
      buildVoiceDropStreamAppPayload(managedName, streamUrl)
    );
    if (!createdRes?.ref) {
      throw new Error('Fonoster createApplication returned an empty application ref.');
    }
    console.log(
      `[Fonoster Apps] Auto-created Stream app ref=${createdRes.ref} url=${streamUrl} (protocol=fonoster, audio=pcm16@16000, speech=None)`
    );
    return { appRef: createdRes.ref, streamUrl, created: true, updated: false };
  } catch (createErr: any) {
    console.warn(
      '[Fonoster Apps] Full createApplication failed, retrying compact speech=None STREAM payload:',
      formatFonosterError(createErr)
    );
    try {
      const minimalRes = await appsApi.createApplication({
        name: managedName,
        type: FonosterSDK.ApplicationType.STREAM,
        url: streamUrl,
        protocol: 'fonoster',
        audio: { codec: 'pcm16', rate: PCM16_SAMPLE_RATE },
      } as any);
      if (minimalRes?.ref) {
        console.log(
          `[Fonoster Apps] Compact createApplication succeeded ref=${minimalRes.ref} (speech=None, pcm16@16000)`
        );
        return { appRef: minimalRes.ref, streamUrl, created: true, updated: false };
      }
    } catch (minCreateErr: any) {
      console.error(
        '[Fonoster Apps] Compact createApplication also failed:',
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

  const applications = (appsRes?.items || []).map((a: any) => ({
    ref: a.ref,
    name: a.name,
    type: a.type,
    url: a.url,
    protocol: a.protocol || 'fonoster',
    audio: a.audio || { codec: 'pcm16', rate: PCM16_SAMPLE_RATE },
    speechVendor: hasAnySpeechVendorConfig(a) ? 'configured' : 'None',
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
    endpoint: resolvedEndpoint,
    streamUrl,
    syncedAppRef,
    appAction,
    audioFormat: `pcm16@${PCM16_SAMPLE_RATE}`,
    speechVendor: 'None',
    applications,
    numbers,
    warning: isLocalStreamUrl(streamUrl)
      ? 'Server is currently addressed via localhost; Fonoster requires a public wss:// URL to connect back to voice streams.'
      : undefined,
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

export function interruptFonosterPlayback(callId: string): void {
  const state = activeFonosterCalls.get(callId);
  if (!state) return;
  if (state.playbackAbort) {
    try {
      state.playbackAbort.abort();
    } catch {}
    state.playbackAbort = undefined;
  }
  state.playbackStartedAt = undefined;
  if (!state.voiceSession.ended) {
    try {
      state.voiceSession.audio.clear();
    } catch {}
  }
}

/**
 * Synthesizes speech with VoiceDrop's built-in PCM16 16kHz TTS engine (zero Deepgram/external Fonoster vendor)
 * and streams 20ms (640-byte) PCM16 frames directly into Fonoster's WebSocket audio stream.
 */
export async function sayOnFonosterCall(
  callId: string,
  text: string,
  options?: { interruptible?: boolean; preempt?: boolean; voice?: string }
): Promise<boolean> {
  const state = activeFonosterCalls.get(callId);
  const cleanText = String(text || '').trim();
  if (!state || state.voiceSession.ended || !cleanText) return false;

  const preempt = options?.preempt ?? true;
  const interruptible = options?.interruptible ?? true;

  if (preempt) {
    interruptFonosterPlayback(callId);
  }

  const controller = new AbortController();
  state.playbackAbort = controller;
  state.currentPlaybackInterruptible = interruptible;
  state.playbackStartedAt = Date.now();

  try {
    const synthesized = await synthesizePcm16(cleanText, {
      voice: options?.voice || state.voice,
    });

    if (controller.signal.aborted || state.voiceSession.ended || synthesized.pcm16.length === 0) {
      return false;
    }

    const result = await streamPcm16Frames(synthesized.pcm16, {
      signal: controller.signal,
      sendFrame: (frame) => {
        if (!state.voiceSession.ended) {
          try {
            state.voiceSession.audio.send(frame);
          } catch {}
        }
      },
      onFrameSent: (frame) => {
        state.recorder?.pushOutbound(frame);
        broadcastMonitorAudio(callId, frame, 0.35);
      },
    });

    return result.framesSent > 0;
  } catch (err) {
    console.error(`[Fonoster PCM16 TTS] Playback failed for ${callId}:`, err);
    return false;
  } finally {
    if (state.playbackAbort === controller) {
      state.playbackAbort = undefined;
      state.playbackStartedAt = undefined;
    }
  }
}

export async function hangupFonosterCall(callId: string): Promise<boolean> {
  const state = activeFonosterCalls.get(callId);
  if (!state) return false;
  interruptFonosterPlayback(callId);
  if (state.amdFallbackTimer) {
    clearTimeout(state.amdFallbackTimer);
    state.amdFallbackTimer = undefined;
  }
  if (state.voiceSession.ended) {
    closeMonitorSubscribers(callId);
    activeFonosterCalls.delete(callId);
    return true;
  }
  try {
    await state.voiceSession.hangup();
    closeMonitorSubscribers(callId);
    activeFonosterCalls.delete(callId);
    return true;
  } catch (err) {
    console.error(`Fonoster hangup failed for ${callId}:`, err);
    closeMonitorSubscribers(callId);
    activeFonosterCalls.delete(callId);
    return false;
  }
}

export interface FonosterVoiceBridgeHooks {
  recordingsDir: string;
  resolveSession: (meta: { callId?: string; callRef: string; to: string }) => any | undefined;
  onSessionConnected: (session: any, callRef: string) => void;
  onAmdResult: (
    session: any,
    status: 'human' | 'voicemail' | 'fax' | 'unknown',
    rawLabel: string
  ) => Promise<void>;
  onStartHumanGreeting: (session: any, state: FonosterSessionState) => Promise<void>;
  onSpeechTurn: (session: any, text: string, confidence?: number) => Promise<boolean>;
  onDigitKeypress?: (
    session: any,
    digit: string,
    currentBuffer: string,
    source: 'rfc2833' | 'inband-pcm16'
  ) => void;
  onDigitsSubmitted: (
    session: any,
    digits: string,
    submittedViaPound: boolean,
    state: FonosterSessionState
  ) => Promise<void>;
  onLocalRecordingReady?: (
    session: any,
    recording: { filePath: string; ext: string; durationSec: number; sizeBytes: number }
  ) => void;
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

    let state!: FonosterSessionState;

    const triggerGreetingOnce = async () => {
      if (!state || state.greetStarted || voiceSession.ended) return;
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

    const handleIncomingDigit = (rawDigit: string, source: 'rfc2833' | 'inband-pcm16') => {
      const key = String(rawDigit || '').trim();
      if (!key || !/^[0-9*#]$/.test(key) || voiceSession.ended) return;

      const now = Date.now();
      // Deduplicate same tone detected by both RFC 2833 and in-band Goertzel within 400ms
      if (
        state.lastDigit &&
        state.lastDigit.key === key &&
        state.lastDigit.source !== source &&
        now - state.lastDigit.at < 400
      ) {
        return;
      }
      state.lastDigit = { key, source, at: now };

      // Immediate barge-in when caller starts keying digits during an interruptible prompt
      if (state.playbackAbort && state.currentPlaybackInterruptible) {
        interruptFonosterPlayback(session.id);
      }

      // Any keypress confirms a live human on the handset
      if (session.answeredBy === 'voicemail' && !session.humanPickedUpAfterVoicemail) {
        session.humanPickedUpAfterVoicemail = true;
        state.amdResolved = true;
        state.vadAmd.markResolvedExternally('human');
        void hooks
          .onAmdResult(session, 'human', `dtmf_human_pickup_${source}`)
          .then(() => triggerGreetingOnce());
      } else if (!state.amdResolved) {
        state.amdResolved = true;
        state.vadAmd.markResolvedExternally('human');
        void hooks.onAmdResult(session, 'human', `dtmf_confirmed_human_${source}`);
      }

      if (key === '#') {
        hooks.onDigitKeypress?.(session, '#', state.digitBuffer, source);
        if (state.digitBuffer.length >= 1) {
          const submitted = state.digitBuffer;
          state.digitBuffer = '';
          void hooks.onDigitsSubmitted(session, submitted, true, state);
        }
        return;
      }

      state.digitBuffer += key;
      hooks.onDigitKeypress?.(session, key, state.digitBuffer, source);

      const maxDigits = hooks.getMaxDigits(session.numDigits);
      if (state.digitBuffer.length >= maxDigits) {
        const submitted = state.digitBuffer.slice(0, maxDigits);
        state.digitBuffer = '';
        void hooks.onDigitsSubmitted(session, submitted, false, state);
      }
    };

    const vadAmd = new Pcm16VadAmdDetector({
      onAmdClassified: (status, reason) => {
        if (state.amdResolved || voiceSession.ended) return;
        state.amdResolved = true;
        if (state.amdFallbackTimer) {
          clearTimeout(state.amdFallbackTimer);
          state.amdFallbackTimer = undefined;
        }
        void hooks.onAmdResult(session, status, reason).then(async () => {
          if (status === 'human') {
            await triggerGreetingOnce();
          }
        });
      },
      onVoiceActivity: (speaking, rms) => {
        // Optional speech barge-in only on strong live caller voice after initial 700ms playback
        if (
          speaking &&
          rms >= 0.085 &&
          state.playbackAbort &&
          state.currentPlaybackInterruptible &&
          state.playbackStartedAt &&
          Date.now() - state.playbackStartedAt > 700 &&
          state.digitBuffer.length > 0
        ) {
          interruptFonosterPlayback(session.id);
        }
      },
      onHumanPickupAfterVoicemail: () => {
        if (voiceSession.ended || session.humanPickedUpAfterVoicemail) return;
        session.humanPickedUpAfterVoicemail = true;
        void hooks
          .onAmdResult(session, 'human', 'pcm16_vad_human_pickup')
          .then(() => triggerGreetingOnce());
      },
    });

    const dtmfDetector = new GoertzelDtmfDetector((digit) => {
      handleIncomingDigit(digit, 'inband-pcm16');
    });

    const recorder = session.recordCall !== false ? new Pcm16CallRecorder(session.id) : undefined;

    state = {
      voiceSession,
      callId: session.id,
      voice: session.voice,
      digitBuffer: '',
      greetStarted: Boolean(session.promptsStarted),
      amdResolved: false,
      currentPlaybackInterruptible: true,
      recorder,
      recorderFinalized: false,
      dtmfDetector,
      vadAmd,
    };

    activeFonosterCalls.set(session.id, state);
    hooks.onSessionConnected(session, voiceSession.callRef);

    // IMPORTANT: We NEVER call voiceSession.listen() or voiceSession.say() so Fonoster never invokes Deepgram.
    // Instead, consume raw bidirectional PCM16 16kHz frames directly from the WebSocket stream.
    voiceSession.audio.onFrame((frame: Buffer) => {
      if (!frame || frame.length === 0 || voiceSession.ended) return;
      state.recorder?.pushInbound(frame);
      broadcastMonitorAudio(session.id, frame, 1.0);
      state.vadAmd.pushPcm16(frame);
      state.dtmfDetector.pushPcm16(frame);
    });

    // Safety fallback: if no audio frames or AMD classification finishes within 3.8s, proceed with live human greeting
    state.amdFallbackTimer = setTimeout(() => {
      if (!state.amdResolved && !state.greetStarted && !voiceSession.ended) {
        if (session.answeredBy !== 'voicemail') {
          state.amdResolved = true;
          state.vadAmd.markResolvedExternally('human');
          void hooks
            .onAmdResult(session, 'human', 'pcm16_timeout_human')
            .then(() => triggerGreetingOnce());
        }
      }
    }, 3800);

    // Still handle native Fonoster RFC 2833 DTMF events (primary) alongside in-band Goertzel backup
    voiceSession.on('dtmf', ({ digit }) => {
      handleIncomingDigit(String(digit || ''), 'rfc2833');
    });

    // Optional passthrough if Fonoster ever emits AMD/turn events without vendor dependency
    voiceSession.on('amd.result', (amd) => {
      if (state.amdResolved) return;
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

      state.vadAmd.markResolvedExternally(mapped === 'voicemail' ? 'voicemail' : 'human');
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

    voiceSession.on('error', (err) => {
      console.error(`[Fonoster Voice] Session error (${session.id}):`, err);
    });

    voiceSession.on('end', ({ reason }) => {
      interruptFonosterPlayback(session.id);
      if (state.amdFallbackTimer) {
        clearTimeout(state.amdFallbackTimer);
        state.amdFallbackTimer = undefined;
      }
      closeMonitorSubscribers(session.id);
      activeFonosterCalls.delete(session.id);

      void (async () => {
        if (state.recorder && !state.recorderFinalized) {
          state.recorderFinalized = true;
          const saved = await state.recorder.finalize(hooks.recordingsDir);
          if (saved) {
            hooks.onLocalRecordingReady?.(session, saved);
          }
        }
        await hooks.onSessionEnded(session, reason || 'ended');
      })();
    });
  });

  return voiceServer;
}
