import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock Redis and Anthropic client before importing session-manager
// ---------------------------------------------------------------------------

const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisConnect = vi.fn().mockResolvedValue(undefined);
const mockRedisQuit = vi.fn().mockResolvedValue(undefined);
const mockPipelineSet = vi.fn().mockReturnThis();
const mockPipelineExec = vi.fn().mockResolvedValue([]);

const mockRedisInstance = {
  connect: mockRedisConnect,
  quit: mockRedisQuit,
  get: mockRedisGet,
  set: mockRedisSet,
  pipeline: vi.fn().mockReturnValue({
    set: mockPipelineSet,
    exec: mockPipelineExec,
  }),
};

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => mockRedisInstance),
}));

const mockSmartGenerate = vi.fn();
vi.mock('../../lib/anthropic-client', () => ({
  smartGenerate: (...args: unknown[]) => mockSmartGenerate(...args),
}));

import {
  SessionManager,
  classifyFeedback,
  SessionManagerError,
  type SessionData,
} from '../../services/session-manager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockLlmTextResponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

function createMockSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    sessionId: 'sess-001',
    channelId: 'ch-whatsapp-123',
    systemSlug: 'web-design-studio',
    systemName: 'Web Design Studio',
    status: 'delivered',
    inputs: { business_name: 'Acme Corp', target_audience: 'developers' },
    lastOutput: 'Here is your landing page with a hero section and CTA.',
    revisionCount: 0,
    createdAt: Date.now() - 60000,
    updatedAt: Date.now() - 30000,
    ...overrides,
  };
}

describe('Session Manager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    // Pass mock redis client via constructor
    manager = new SessionManager(mockRedisInstance as never);
  });

  // -------------------------------------------------------------------------
  // createSession
  // -------------------------------------------------------------------------
  describe('createSession', () => {
    it('stores session data and channel mapping in Redis pipeline', async () => {
      const session = await manager.createSession(
        'sess-001',
        'ch-whatsapp-123',
        'web-design-studio',
        'Web Design Studio',
        { business_name: 'Acme Corp' }
      );

      expect(session.sessionId).toBe('sess-001');
      expect(session.channelId).toBe('ch-whatsapp-123');
      expect(session.systemSlug).toBe('web-design-studio');
      expect(session.status).toBe('executing');
      expect(session.inputs).toEqual({ business_name: 'Acme Corp' });
      expect(session.lastOutput).toBeNull();
      expect(session.revisionCount).toBe(0);

      // Pipeline should have been called with session key and channel key
      expect(mockPipelineSet).toHaveBeenCalledTimes(2);
      expect(mockPipelineExec).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // getSession
  // -------------------------------------------------------------------------
  describe('getSession', () => {
    it('retrieves session by ID', async () => {
      const stored = createMockSession();
      mockRedisGet.mockResolvedValue(JSON.stringify(stored));

      const session = await manager.getSession('sess-001');

      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe('sess-001');
      expect(session!.systemSlug).toBe('web-design-studio');
    });

    it('returns null for non-existent session', async () => {
      mockRedisGet.mockResolvedValue(null);

      const session = await manager.getSession('non-existent');
      expect(session).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // getSessionByChannel
  // -------------------------------------------------------------------------
  describe('getSessionByChannel', () => {
    it('looks up session ID from channel key then retrieves session', async () => {
      const stored = createMockSession();

      // First call: channel key lookup returns session ID
      // Second call: session key lookup returns session data
      mockRedisGet
        .mockResolvedValueOnce('sess-001')
        .mockResolvedValueOnce(JSON.stringify(stored));

      const session = await manager.getSessionByChannel('ch-whatsapp-123');

      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe('sess-001');
      expect(mockRedisGet).toHaveBeenCalledTimes(2);
    });

    it('returns null when no channel mapping exists', async () => {
      mockRedisGet.mockResolvedValue(null);

      const session = await manager.getSessionByChannel('ch-unknown');
      expect(session).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // updateSession
  // -------------------------------------------------------------------------
  describe('updateSession', () => {
    it('merges updates and refreshes TTL', async () => {
      const stored = createMockSession({ status: 'executing' });
      mockRedisGet.mockResolvedValue(JSON.stringify(stored));
      mockRedisSet.mockResolvedValue('OK');

      const updated = await manager.updateSession('sess-001', {
        status: 'delivered',
        lastOutput: 'Built a landing page.',
      });

      expect(updated.status).toBe('delivered');
      expect(updated.lastOutput).toBe('Built a landing page.');
      expect(updated.updatedAt).toBeGreaterThanOrEqual(stored.updatedAt);

      // Should write back with TTL
      expect(mockRedisSet).toHaveBeenCalledWith(
        expect.stringContaining('sess-001'),
        expect.any(String),
        'EX',
        86400 // 24 hours
      );
    });

    it('throws SessionManagerError when session not found', async () => {
      mockRedisGet.mockResolvedValue(null);

      await expect(
        manager.updateSession('non-existent', { status: 'delivered' })
      ).rejects.toThrow(SessionManagerError);
    });
  });

  // -------------------------------------------------------------------------
  // isRevisionFeedback
  // -------------------------------------------------------------------------
  describe('isRevisionFeedback', () => {
    it('returns RevisionBrief for post-delivery feedback', async () => {
      const stored = createMockSession({
        status: 'delivered',
        lastOutput: 'Here is your landing page with hero section.',
      });

      // Channel lookup → session ID, session lookup → session data
      mockRedisGet
        .mockResolvedValueOnce('sess-001')
        .mockResolvedValueOnce(JSON.stringify(stored));

      // classifyFeedback LLM returns revision=true
      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse(JSON.stringify({
          isRevision: true,
          confidence: 0.85,
          reasoning: 'User is commenting on the hero section output',
        }))
      );

      // updateSession needs to read again then write
      mockRedisGet.mockResolvedValueOnce(JSON.stringify(stored));
      mockRedisSet.mockResolvedValue('OK');

      const result = await manager.isRevisionFeedback(
        'ch-whatsapp-123',
        'the hero section is too cramped, make it bigger'
      );

      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('sess-001');
      expect(result!.systemSlug).toBe('web-design-studio');
      expect(result!.feedback).toBe('the hero section is too cramped, make it bigger');
      expect(result!.revisionNumber).toBe(1);
      expect(result!.lastOutput).toContain('hero section');
    });

    it('returns null for unrelated new messages', async () => {
      const stored = createMockSession({
        status: 'delivered',
        lastOutput: 'Here is your landing page.',
      });

      mockRedisGet
        .mockResolvedValueOnce('sess-001')
        .mockResolvedValueOnce(JSON.stringify(stored));

      // classifyFeedback returns not-revision
      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse(JSON.stringify({
          isRevision: false,
          confidence: 0.15,
          reasoning: 'Completely unrelated new request',
        }))
      );

      const result = await manager.isRevisionFeedback(
        'ch-whatsapp-123',
        'write me a blog post about AI'
      );

      expect(result).toBeNull();
    });

    it('returns null when no active session exists', async () => {
      mockRedisGet.mockResolvedValue(null);

      const result = await manager.isRevisionFeedback(
        'ch-unknown',
        'change the colors'
      );

      expect(result).toBeNull();
    });

    it('returns null when session status is not "delivered"', async () => {
      const stored = createMockSession({ status: 'executing' });

      mockRedisGet
        .mockResolvedValueOnce('sess-001')
        .mockResolvedValueOnce(JSON.stringify(stored));

      const result = await manager.isRevisionFeedback(
        'ch-whatsapp-123',
        'change the hero section'
      );

      expect(result).toBeNull();
      // Should not call the LLM since we exit early
      expect(mockSmartGenerate).not.toHaveBeenCalled();
    });

    it('returns null when confidence is below threshold', async () => {
      const stored = createMockSession({
        status: 'delivered',
        lastOutput: 'Here is your page.',
      });

      mockRedisGet
        .mockResolvedValueOnce('sess-001')
        .mockResolvedValueOnce(JSON.stringify(stored));

      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse(JSON.stringify({
          isRevision: true,
          confidence: 0.3, // below 0.6 threshold
          reasoning: 'Ambiguous',
        }))
      );

      const result = await manager.isRevisionFeedback(
        'ch-whatsapp-123',
        'hmm interesting'
      );

      expect(result).toBeNull();
    });

    it('returns null when lastOutput is null', async () => {
      const stored = createMockSession({
        status: 'delivered',
        lastOutput: null,
      });

      mockRedisGet
        .mockResolvedValueOnce('sess-001')
        .mockResolvedValueOnce(JSON.stringify(stored));

      const result = await manager.isRevisionFeedback(
        'ch-whatsapp-123',
        'change the colors'
      );

      expect(result).toBeNull();
      expect(mockSmartGenerate).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // classifyFeedback — LLM wrapper
  // -------------------------------------------------------------------------
  describe('classifyFeedback', () => {
    it('parses a valid feedback classification', async () => {
      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse(JSON.stringify({
          isRevision: true,
          confidence: 0.9,
          reasoning: 'Direct reference to output',
        }))
      );

      const result = await classifyFeedback(
        'Web Design Studio',
        'Landing page with hero',
        'make the hero bigger'
      );

      expect(result.isRevision).toBe(true);
      expect(result.confidence).toBe(0.9);
    });

    it('clamps confidence to [0, 1]', async () => {
      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse(JSON.stringify({
          isRevision: false,
          confidence: -0.5,
          reasoning: 'negative confidence',
        }))
      );

      const result = await classifyFeedback('System', 'output', 'message');
      expect(result.confidence).toBe(0);
    });

    it('throws SessionManagerError on malformed JSON', async () => {
      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse('not json')
      );

      await expect(
        classifyFeedback('System', 'output', 'message')
      ).rejects.toThrow(SessionManagerError);
    });
  });

  // -------------------------------------------------------------------------
  // disconnect
  // -------------------------------------------------------------------------
  describe('disconnect', () => {
    it('quits Redis connection', async () => {
      // Force a connect first
      await manager.createSession('s', 'c', 'slug', 'name', {});
      await manager.disconnect();

      expect(mockRedisQuit).toHaveBeenCalled();
    });
  });
});
