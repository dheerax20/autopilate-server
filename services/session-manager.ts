// =============================================================================
// Session Manager — Maintains context across a system's execution lifecycle.
// After a system produces output, the session stays open for the messaging
// thread. If the user responds with feedback (e.g. "the hero section is too
// cramped"), the session manager recognizes it as referring to the most recent
// execution and routes it as a revision brief rather than a new system trigger.
//
// Uses Redis for session storage with a 24-hour TTL.
// =============================================================================

import Redis from 'ioredis';
import type Anthropic from '@anthropic-ai/sdk';
import { smartGenerate } from '../lib/anthropic-client';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type SessionStatus = 'gathering' | 'executing' | 'delivered' | 'revising';

export interface SessionData {
  sessionId: string;
  channelId: string;
  systemSlug: string;
  systemName: string;
  status: SessionStatus;
  inputs: Record<string, string>;
  /** Most recent execution output summary (used for revision context). */
  lastOutput: string | null;
  /** Number of revision rounds completed. */
  revisionCount: number;
  createdAt: number;
  updatedAt: number;
}

/** A revision brief wraps user feedback with the session context. */
export interface RevisionBrief {
  sessionId: string;
  systemSlug: string;
  systemName: string;
  originalInputs: Record<string, string>;
  lastOutput: string;
  feedback: string;
  revisionNumber: number;
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export class SessionManagerError extends Error {
  constructor(
    message: string,
    public readonly step?: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'SessionManagerError';
  }
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const SESSION_KEY_PREFIX = 'autopilate:session:';
const CHANNEL_KEY_PREFIX = 'autopilate:channel:';
const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 hours

// -----------------------------------------------------------------------------
// LLM: Feedback Classification (isolated for test mocking)
// -----------------------------------------------------------------------------

const FEEDBACK_CLASSIFICATION_SYSTEM = `You classify whether a user message is revision feedback on a recent AI system output, or an unrelated new request.

You receive:
- The system that produced the output
- A summary of the last output
- The user's new message

Return ONLY valid JSON (no markdown fences):
{"isRevision": true/false, "confidence": 0.0-1.0, "reasoning": "one-line explanation"}`;

interface FeedbackClassification {
  isRevision: boolean;
  confidence: number;
  reasoning: string;
}

export async function classifyFeedback(
  systemName: string,
  lastOutput: string,
  userMessage: string
): Promise<FeedbackClassification> {
  const userContent = [
    `System: ${systemName}`,
    `Last output summary: ${lastOutput}`,
    '',
    `User message: ${userMessage}`,
  ].join('\n');

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userContent },
  ];

  const response = await smartGenerate(
    'BUILDER',
    FEEDBACK_CLASSIFICATION_SYSTEM,
    messages
  );

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  try {
    const parsed = JSON.parse(text) as FeedbackClassification;
    parsed.confidence = Math.max(0, Math.min(1, parsed.confidence));
    return parsed;
  } catch (err) {
    throw new SessionManagerError(
      `Failed to parse feedback classification: ${text.slice(0, 200)}`,
      'classify-feedback',
      err
    );
  }
}

// -----------------------------------------------------------------------------
// Redis Client Factory
// -----------------------------------------------------------------------------

function createRedisClient(): Redis {
  return new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
}

// -----------------------------------------------------------------------------
// Session Manager Class
// -----------------------------------------------------------------------------

const REVISION_CONFIDENCE_THRESHOLD = 0.6;

export class SessionManager {
  private redis: Redis;
  private connected: boolean = false;

  constructor(redisClient?: Redis) {
    this.redis = redisClient ?? createRedisClient();
  }

  /** Ensure the Redis connection is active. */
  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.redis.connect();
      this.connected = true;
    }
  }

  /**
   * Create a new session for a system execution on a messaging channel.
   */
  async createSession(
    sessionId: string,
    channelId: string,
    systemSlug: string,
    systemName: string,
    inputs: Record<string, string>
  ): Promise<SessionData> {
    await this.ensureConnected();

    const now = Date.now();
    const session: SessionData = {
      sessionId,
      channelId,
      systemSlug,
      systemName,
      status: 'executing',
      inputs,
      lastOutput: null,
      revisionCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    const key = `${SESSION_KEY_PREFIX}${sessionId}`;
    const channelKey = `${CHANNEL_KEY_PREFIX}${channelId}`;

    // Store session data and map the channel to this session
    await this.redis
      .pipeline()
      .set(key, JSON.stringify(session), 'EX', SESSION_TTL_SECONDS)
      .set(channelKey, sessionId, 'EX', SESSION_TTL_SECONDS)
      .exec();

    return session;
  }

  /**
   * Retrieve a session by its ID. Returns null if expired or not found.
   */
  async getSession(sessionId: string): Promise<SessionData | null> {
    await this.ensureConnected();

    const key = `${SESSION_KEY_PREFIX}${sessionId}`;
    const raw = await this.redis.get(key);
    if (!raw) return null;

    return JSON.parse(raw) as SessionData;
  }

  /**
   * Retrieve the active session for a messaging channel.
   * Returns null if no active session exists for this channel.
   */
  async getSessionByChannel(channelId: string): Promise<SessionData | null> {
    await this.ensureConnected();

    const channelKey = `${CHANNEL_KEY_PREFIX}${channelId}`;
    const sessionId = await this.redis.get(channelKey);
    if (!sessionId) return null;

    return this.getSession(sessionId);
  }

  /**
   * Update an existing session with partial data.
   * Refreshes the TTL on each update to keep active sessions alive.
   */
  async updateSession(
    sessionId: string,
    updates: Partial<Pick<SessionData, 'status' | 'lastOutput' | 'revisionCount' | 'inputs'>>
  ): Promise<SessionData> {
    await this.ensureConnected();

    const existing = await this.getSession(sessionId);
    if (!existing) {
      throw new SessionManagerError(
        `Session not found: ${sessionId}`,
        'update-session'
      );
    }

    const updated: SessionData = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    };

    const key = `${SESSION_KEY_PREFIX}${sessionId}`;
    await this.redis.set(key, JSON.stringify(updated), 'EX', SESSION_TTL_SECONDS);

    return updated;
  }

  /**
   * Determine whether a message on a channel is revision feedback for the
   * most recent execution, or an unrelated new request.
   *
   * Returns a RevisionBrief if the message is feedback, null otherwise.
   */
  async isRevisionFeedback(
    channelId: string,
    message: string
  ): Promise<RevisionBrief | null> {
    const session = await this.getSessionByChannel(channelId);

    // No active session or session hasn't delivered output yet
    if (!session || session.status !== 'delivered' || !session.lastOutput) {
      return null;
    }

    const classification = await classifyFeedback(
      session.systemName,
      session.lastOutput,
      message
    );

    if (!classification.isRevision || classification.confidence < REVISION_CONFIDENCE_THRESHOLD) {
      return null;
    }

    // Mark session as revising
    const revisionNumber = session.revisionCount + 1;
    await this.updateSession(session.sessionId, {
      status: 'revising',
      revisionCount: revisionNumber,
    });

    return {
      sessionId: session.sessionId,
      systemSlug: session.systemSlug,
      systemName: session.systemName,
      originalInputs: session.inputs,
      lastOutput: session.lastOutput,
      feedback: message,
      revisionNumber,
    };
  }

  /**
   * Gracefully close the Redis connection.
   */
  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.redis.quit();
      this.connected = false;
    }
  }
}
