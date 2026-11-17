const DEVICE_ID_STORAGE_KEY = 'voicedrop_device_id';

function generateSecureDeviceId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(24);
      crypto.getRandomValues(bytes);
      const hex = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return `dev_${hex}`;
    }
  } catch {
    // Fallback below
  }
  return `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random()
    .toString(36)
    .slice(2)}`;
}

export function getDeviceId(): string {
  if (typeof window === 'undefined') return 'dev_ssr_placeholder';
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (existing && /^[a-zA-Z0-9_-]{16,128}$/.test(existing)) {
      return existing;
    }
    const created = generateSecureDeviceId();
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return generateSecureDeviceId();
  }
}

export function resetDeviceSessionStorage(): string {
  const nextId = generateSecureDeviceId();
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, nextId);
      window.localStorage.removeItem('voicedrop_twilio_config');
      window.localStorage.removeItem('voicedrop_carriers_config');
    } catch {
      // Ignore storage errors
    }
  }
  return nextId;
}

export function getDeviceHeaders(): Record<string, string> {
  return {
    'X-Device-Id': getDeviceId(),
  };
}

export function withDeviceParam(url: string): string {
  if (!url) return url;
  const deviceId = getDeviceId();
  if (url.includes('deviceId=')) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}deviceId=${encodeURIComponent(deviceId)}`;
}

export function getDeviceShortLabel(deviceId?: string): string {
  const id = deviceId || getDeviceId();
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}...${id.slice(-4)}`;
}
