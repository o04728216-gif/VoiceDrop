import type { Server as HttpServer } from 'http';
import { createRequire } from 'module';
import net from 'net';
import * as FonosterSDK from '@fonoster/sdk';
import { VoiceServer, type Session as FonosterVoiceSession } from '@fonoster/voice';

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
  digitBuffer: string;
  greetStarted: boolean;
  amdResolved: boolean;
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

function buildClientWithTransport(
  workspaceKey: string,
  endpoint: string | undefined,
  mode: FonosterTransportMode
): FonosterSDK.Client {
  if (mode === 'insecure') {
    return new FonosterSDK.Client({
      accessKeyId: workspaceKey,
      ...(endpoint ? { endpoint } : {}),
      allowInsecure: true,
    });
  }

  const client = new FonosterSDK.Client({
    accessKeyId: workspaceKey,
    ...(endpoint ? { endpoint } : {}),
    allowInsecure: false,
  });

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

  return {
    ok: true,
    endpoint: resolvedEndpoint,
    streamUrl,
    syncedAppRef,
    appAction,
    applications,
    numbers,
    warning: isLocalStreamUrl(streamUrl)
      ? 'Server is currently addressed via localhost; Fonoster requires a public wss:// URL to connect back to voice streams.'
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
  const client = await createAuthenticatedFonosterClient(creds, params.appBaseUrl);
  const resolvedEndpoint = (client as any).endpoint as string | undefined;
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
    endpoint: resolvedEndpoint,
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
