import type { Server as HttpServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { PCM16_SAMPLE_RATE } from './tts.ts';

const MONITOR_PATH = '/api/call/audio-monitor';
const subscribersByCall = new Map<string, Set<WebSocket>>();

export function attachAudioMonitorServer(
  httpServer: HttpServer,
  authorize: (callId: string, deviceId: string) => boolean
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const rawUrl = req.url || '';
    const pathname = rawUrl.split('?')[0];
    if (pathname !== MONITOR_PATH) return;

    try {
      const parsed = new URL(rawUrl, 'http://localhost');
      const callId = (parsed.searchParams.get('callId') || '').trim();
      const deviceId = (parsed.searchParams.get('deviceId') || '').trim();

      if (!callId || !deviceId || !authorize(callId, deviceId)) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        let set = subscribersByCall.get(callId);
        if (!set) {
          set = new Set();
          subscribersByCall.set(callId, set);
        }
        set.add(ws);

        // Notify browser player of exact PCM16 stream parameters
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'audio.format',
              codec: 'pcm16',
              sampleRate: PCM16_SAMPLE_RATE,
              channels: 1,
              callId,
            })
          );
        }

        const cleanup = () => {
          const group = subscribersByCall.get(callId);
          if (group) {
            group.delete(ws);
            if (group.size === 0) subscribersByCall.delete(callId);
          }
        };

        ws.on('close', cleanup);
        ws.on('error', cleanup);
      });
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
  });

  return wss;
}

/**
 * Broadcasts a live PCM16 16kHz mono audio frame to all connected operator browsers monitoring this call.
 */
export function broadcastMonitorAudio(callId: string, pcm16Frame: Buffer, gain = 1.0): void {
  const group = subscribersByCall.get(callId);
  if (!group || group.size === 0 || !pcm16Frame || pcm16Frame.length === 0) return;

  let payload = pcm16Frame;
  if (gain !== 1.0) {
    payload = Buffer.allocUnsafe(pcm16Frame.length);
    const samples = pcm16Frame.length >> 1;
    for (let i = 0; i < samples; i++) {
      const scaled = Math.round(pcm16Frame.readInt16LE(i * 2) * gain);
      payload.writeInt16LE(Math.max(-32768, Math.min(32767, scaled)), i * 2);
    }
  }

  for (const ws of group) {
    // Drop frames if client socket has >32KB queued so live audio never falls behind real time
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 32768) {
      ws.send(payload, { binary: true });
    }
  }
}

export function closeMonitorSubscribers(callId: string): void {
  const group = subscribersByCall.get(callId);
  if (!group) return;
  for (const ws of group) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'audio.end', callId }));
        ws.close(1000);
      }
    } catch {}
  }
  subscribersByCall.delete(callId);
}
