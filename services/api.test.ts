import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';

// =============================================================================
// API Endpoint Tests
// Tests the Express route handlers defined in server/src/index.ts
// =============================================================================

// Mock data
const mockInventory = [
  {
    id: 'agents',
    name: 'agents',
    path: 'agents',
    type: 'folder',
    children: [
      {
        id: '/mock/path/test-agent.md',
        name: 'test-agent',
        path: '/mock/path/test-agent.md',
        type: 'file',
        category: 'AGENT',
        description: 'A test agent',
        repo: 'repo1',
      },
    ],
  },
];

const mockFlattenedItems = [
  {
    id: '/mock/path/test-agent.md',
    name: 'test-agent',
    path: '/mock/path/test-agent.md',
    nodeType: 'AGENT',
    description: 'A test agent',
    repo: 'repo1',
    searchText: 'test-agent a test agent repo1',
    buckets: ['development'],
    subcategories: [],
    isBundle: false,
  },
];

// Mocked function references (declared before createTestApp uses them)
const mockScanInventory = vi.fn().mockResolvedValue(mockInventory);
const mockBuildSearchIndex = vi.fn().mockReturnValue(mockFlattenedItems);
const mockSearchInventory = vi.fn().mockReturnValue({
  items: mockFlattenedItems,
  total: 1,
  limit: 100,
  offset: 0,
  facets: { types: ['AGENT'], repos: ['repo1'], buckets: ['development'], subcategories: [] },
});
const mockGetPoolStatus = vi.fn().mockReturnValue({
  available: 2,
  busy: 0,
  total: 2,
});
const mockAnalyzeWorkflow = vi.fn().mockReturnValue({
  issues: [],
  suggestions: [],
});
const mockReadFile = vi.fn().mockImplementation((filePath: string) => {
  if (filePath === '/mock/path/test-agent.md') {
    return Promise.resolve('# Test Agent\nA test agent description');
  }
  return Promise.reject(new Error('File not found'));
});

const MOCK_INVENTORY_ROOT = '/mock/path';

// Build a minimal Express app that mimics the routes in index.ts
function createTestApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  let searchIndex: unknown[] | null = null;

  async function getSearchIndex() {
    if (searchIndex) return searchIndex;
    const inventory = await mockScanInventory();
    searchIndex = mockBuildSearchIndex(inventory);
    return searchIndex;
  }

  app.get('/', (_req, res) => {
    res.send('Visual Agent Builder API');
  });

  app.get('/api/inventory', async (_req, res) => {
    try {
      const inventory = await mockScanInventory();
      res.json(inventory);
    } catch (_error) {
      res.status(500).json({ error: 'Failed to fetch inventory' });
    }
  });

  app.get('/api/component-content', async (req, res) => {
    const filePath = req.query.path as string;
    if (!filePath) {
      return res.status(400).json({ error: 'path query parameter is required' });
    }
    const normalizedPath = path.resolve(filePath);
    if (!normalizedPath.startsWith(MOCK_INVENTORY_ROOT)) {
      return res.status(403).json({ error: 'Access denied: path outside inventory root' });
    }
    try {
      const content = await mockReadFile(normalizedPath, 'utf-8');
      res.json({ content });
    } catch (_err) {
      res.status(404).json({ error: 'File not found' });
    }
  });

  app.get('/api/inventory/search', async (req, res) => {
    try {
      const { q, types, repos, buckets, limit, offset } = req.query;
      const parseList = (val: unknown): string[] | undefined => {
        if (!val || typeof val !== 'string') return undefined;
        return val.split(',').map((s) => s.trim()).filter(Boolean);
      };
      const index = await getSearchIndex();
      const result = mockSearchInventory(
        index,
        typeof q === 'string' ? q : undefined,
        { types: parseList(types), repos: parseList(repos), buckets: parseList(buckets) },
        { limit: limit ? parseInt(limit as string, 10) : 100, offset: offset ? parseInt(offset as string, 10) : 0 }
      );
      res.json(result);
    } catch (_error) {
      res.status(500).json({ error: 'Failed to search inventory' });
    }
  });

  app.get('/api/inventory/bucket-counts', async (_req, res) => {
    try {
      const index = await getSearchIndex();
      const counts: Record<string, number> = {};
      for (const item of index as any[]) {
        for (const bucket of item.buckets) {
          counts[bucket] = (counts[bucket] || 0) + 1;
        }
      }
      res.json({ counts });
    } catch (_error) {
      res.status(500).json({ error: 'Failed to fetch bucket counts' });
    }
  });

  app.get('/api/health', (_req, res) => {
    const poolStatus = mockGetPoolStatus();
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      inventoryRoot: MOCK_INVENTORY_ROOT,
      pools: poolStatus,
    });
  });

  app.post('/api/configure-workflow', async (req, res) => {
    try {
      const { nodes, edges } = req.body;
      if (!nodes || !edges) {
        return res.status(400).json({ error: 'nodes and edges are required' });
      }
      const analysis = mockAnalyzeWorkflow(nodes, edges);
      res.json(analysis);
    } catch (_error) {
      res.status(500).json({ error: 'Failed to analyze workflow' });
    }
  });

  return app;
}

// Simple HTTP request helper (avoids supertest dependency)
function request(app: express.Express) {
  async function makeRequest(
    method: string,
    urlPath: string,
    body?: unknown
  ): Promise<{ status: number; body: unknown; text: string }> {
    return new Promise((resolve, reject) => {
      const server = app.listen(0, async () => {
        try {
          const addr = server.address();
          const port = typeof addr === 'object' && addr ? addr.port : 0;
          const url = `http://localhost:${port}${urlPath}`;
          const options: RequestInit = {
            method,
            headers: { 'Content-Type': 'application/json' },
          };
          if (body) {
            options.body = JSON.stringify(body);
          }
          const response = await fetch(url, options);
          const text = await response.text();
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
          server.close();
          resolve({ status: response.status, body: parsed, text });
        } catch (err) {
          server.close();
          reject(err);
        }
      });
    });
  }

  return {
    get: (urlPath: string) => makeRequest('GET', urlPath),
    post: (urlPath: string, body?: unknown) => makeRequest('POST', urlPath, body),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('API Endpoints', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
  });

  // ---------------------------------------------------------------------------
  // GET /
  // ---------------------------------------------------------------------------

  describe('GET /', () => {
    it('should return welcome message', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.text).toBe('Visual Agent Builder API');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/inventory
  // ---------------------------------------------------------------------------

  describe('GET /api/inventory', () => {
    it('should return inventory tree', async () => {
      const res = await request(app).get('/api/inventory');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const body = res.body as any[];
      expect(body[0].id).toBe('agents');
      expect(body[0].children.length).toBe(1);
    });

    it('should handle scan errors gracefully', async () => {
      mockScanInventory.mockRejectedValueOnce(new Error('Scan failed'));

      const res = await request(app).get('/api/inventory');
      expect(res.status).toBe(500);
      expect((res.body as any).error).toBe('Failed to fetch inventory');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/component-content
  // ---------------------------------------------------------------------------

  describe('GET /api/component-content', () => {
    it('should return 400 when path is missing', async () => {
      const res = await request(app).get('/api/component-content');
      expect(res.status).toBe(400);
      expect((res.body as any).error).toBe('path query parameter is required');
    });

    it('should return 403 for path outside inventory root', async () => {
      const res = await request(app).get('/api/component-content?path=/etc/passwd');
      expect(res.status).toBe(403);
      expect((res.body as any).error).toContain('Access denied');
    });

    it('should return file content for valid path', async () => {
      const res = await request(app).get('/api/component-content?path=/mock/path/test-agent.md');
      expect(res.status).toBe(200);
      expect((res.body as any).content).toContain('Test Agent');
    });

    it('should return 404 for non-existent file', async () => {
      const res = await request(app).get('/api/component-content?path=/mock/path/nonexistent.md');
      expect(res.status).toBe(404);
      expect((res.body as any).error).toBe('File not found');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/inventory/search
  // ---------------------------------------------------------------------------

  describe('GET /api/inventory/search', () => {
    it('should return search results', async () => {
      const res = await request(app).get('/api/inventory/search?q=test');
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.items).toBeDefined();
      expect(body.total).toBeDefined();
      expect(body.facets).toBeDefined();
    });

    it('should pass filter parameters correctly', async () => {
      await request(app).get('/api/inventory/search?q=test&types=AGENT&repos=repo1&limit=10&offset=5');

      expect(mockSearchInventory).toHaveBeenCalledWith(
        expect.any(Array),
        'test',
        expect.objectContaining({
          types: ['AGENT'],
          repos: ['repo1'],
        }),
        { limit: 10, offset: 5 }
      );
    });

    it('should handle search without query', async () => {
      const res = await request(app).get('/api/inventory/search');
      expect(res.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/inventory/bucket-counts
  // ---------------------------------------------------------------------------

  describe('GET /api/inventory/bucket-counts', () => {
    it('should return bucket counts', async () => {
      const res = await request(app).get('/api/inventory/bucket-counts');
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.counts).toBeDefined();
      expect(body.counts.development).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/health
  // ---------------------------------------------------------------------------

  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.status).toBe('ok');
      expect(body.inventoryRoot).toBe('/mock/path');
      expect(body.pools).toBeDefined();
      expect(body.timestamp).toBeDefined();
      expect(body.uptime).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/configure-workflow
  // ---------------------------------------------------------------------------

  describe('POST /api/configure-workflow', () => {
    it('should return 400 when nodes or edges are missing', async () => {
      const res = await request(app).post('/api/configure-workflow', { nodes: [] });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toBe('nodes and edges are required');
    });

    it('should return analysis for valid input', async () => {
      const res = await request(app).post('/api/configure-workflow', {
        nodes: [{ id: 'n1', type: 'AGENT', label: 'Agent 1' }],
        edges: [],
      });
      expect(res.status).toBe(200);
    });
  });
});
