// =============================================================================
// Live Log Stream Service
// Handles WebSocket upgrade for /api/systems/:slug/stream, subscribes to the
// Redis pub/sub channel for that system, and forwards messages to the client.
// =============================================================================

import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import Redis from 'ioredis';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const REDIS_CHANNEL_PREFIX = 'autopilate:logs:';
const HEARTBEAT_INTERVAL_MS = 30_000;
const SLUG_PATTERN = /^\/api\/systems\/([a-z0-9-]+)\/stream$/;

// -----------------------------------------------------------------------------
// WebSocket Server (shared instance, no HTTP server — uses upgrade only)
// -----------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Attempt to handle an HTTP upgrade request for live log streaming.
 * Returns true if the URL matched and the upgrade was handled, false otherwise.
 */
export function handleLogStreamUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
): boolean {
  const url = req.url;
  if (!url) return false;

  // Strip query string before matching
  const pathname = url.split('?')[0];
  const match = pathname.match(SLUG_PATTERN);
  if (!match) return false;

  const slug = match[1];

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
    attachRedisSubscriber(ws, slug);
  });

  return true;
}

// -----------------------------------------------------------------------------
// Internal: Per-connection Redis subscriber
// -----------------------------------------------------------------------------

function attachRedisSubscriber(ws: WebSocket, slug: string): void {
  const channel = `${REDIS_CHANNEL_PREFIX}${slug}`;

  // Separate Redis connection for subscribing (subscriber connections cannot
  // be used for other commands — see CLAUDE.md gotchas).
  const subscriber = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });

  let alive = true;

  // Heartbeat to detect broken connections
  const heartbeat = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, HEARTBEAT_INTERVAL_MS);

  ws.on('pong', () => {
    alive = true;
  });

  // Connect and subscribe
  subscriber
    .connect()
    .then(() => subscriber.subscribe(channel))
    .then(() => {
      console.log(`[log-stream] Subscribed to ${channel}`);
      // Notify client that streaming has started
      safeSend(ws, JSON.stringify({ type: 'connected', slug, channel }));
    })
    .catch((err) => {
      console.error(`[log-stream] Redis subscribe failed for ${channel}:`, err);
      safeSend(ws, JSON.stringify({ type: 'error', message: 'Failed to subscribe to log channel' }));
      ws.close(1011, 'Redis subscription failed');
    });

  // Forward Redis messages to WebSocket client
  subscriber.on('message', (receivedChannel: string, message: string) => {
    if (receivedChannel !== channel) return;
    safeSend(ws, message);
  });

  // Handle Redis errors without crashing
  subscriber.on('error', (err) => {
    console.error(`[log-stream] Redis subscriber error for ${slug}:`, err.message);
  });

  // Clean up on WebSocket close
  ws.on('close', () => {
    cleanup(subscriber, heartbeat, slug);
  });

  ws.on('error', (err) => {
    console.error(`[log-stream] WebSocket error for ${slug}:`, err.message);
    cleanup(subscriber, heartbeat, slug);
  });
}

// -----------------------------------------------------------------------------
// Internal: Helpers
// -----------------------------------------------------------------------------

function safeSend(ws: WebSocket, data: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(data);
  }
}

function cleanup(
  subscriber: Redis,
  heartbeat: ReturnType<typeof setInterval>,
  slug: string
): void {
  clearInterval(heartbeat);
  subscriber
    .quit()
    .catch((err) => {
      console.error(`[log-stream] Redis cleanup error for ${slug}:`, err.message);
    });
  console.log(`[log-stream] Cleaned up subscriber for ${slug}`);
}
