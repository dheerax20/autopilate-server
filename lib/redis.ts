// =============================================================================
// Shared Redis Publisher Singleton
// Single lazy-initialized Redis publisher connection used by all services
// that need to publish to Redis pub/sub channels.
// =============================================================================

import Redis from 'ioredis';

let redisPublisher: Redis | null = null;

export function getRedisPublisher(): Redis {
  if (!redisPublisher) {
    redisPublisher = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    redisPublisher.connect().catch((err) => {
      console.error('[redis] Publisher connection failed:', err);
    });
  }
  return redisPublisher;
}

/**
 * General-purpose Redis client used by services that need read/write
 * commands (e.g. auth lockouts, session tokens). Reuses the same lazy
 * connection as the publisher — ioredis clients are full duplex unless
 * placed in subscribe mode, so a single instance is fine.
 */
export function getRedisClient(): Redis {
  return getRedisPublisher();
}

export async function shutdownRedisPublisher(): Promise<void> {
  if (redisPublisher) {
    await redisPublisher.quit();
    redisPublisher = null;
  }
}
