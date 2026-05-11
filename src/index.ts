import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import fs from 'fs/promises';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import {
  scanInventory,
  getInventoryRoot,
  buildSearchIndex,
  searchInventory,
  FlattenedItem,
} from '../services/inventory';
import { initSocketEmitter, TypedSocketServer } from '../socket/emitter';
import { setupSocketHandlers, flushSessions } from '../socket/handlers';
import { initMetricsEmitter, destroyMetricsEmitter } from '../socket/metrics-emitter';
import {
  ServerToClientEvents,
  ClientToServerEvents,
  InterServerEvents,
  SocketData,
} from '../shared/socket-events';
import { initializeSandbox } from '../mcp/sandbox-mcp';
import { loadPersistedLayout } from '../mcp/canvas';
import { startSkillWatcher, capabilityRegistry } from '../watcher/skill-watcher';
import { createSupervisorAgent } from '../agents/supervisor';
import { getSession } from '../socket/handlers';
import { getPoolStatus } from '../lib/anthropic-client';
import { analyzeWorkflow, analyzeNodeConfig } from '../services/configuration-analyzer';
import { handleLogStreamUpgrade } from '../services/log-stream';
import { pool, runMigrations } from '../db';
import { shutdownRedisPublisher } from '../lib/redis';
import { runOptimizationAgent } from '../services/optimization-agent';
import { getSystemStats, getGlobalStats } from '../services/execution-metrics';
import { registerMonitorCron } from '../services/system-monitor';
import { initCronScheduler, destroyCronScheduler, getScheduleStatus } from '../services/cron-scheduler';
import { listProcesses } from '../services/pm2-manager';
import Redis from 'ioredis';
import { startSlackBot } from '../services/slack-bot';
import { initAlertService, destroyAlertService } from '../services/alert-service';
import { loadCustomProviders } from '../services/custom-provider-store';
import { loadCustomDiscoverItems } from '../services/discover-store';
import { initializeWorkspaces } from '../services/workspace-store';

// Routes
import { systemsRouter } from '../routes/systems';
import { deployRouter } from '../routes/deploy';
import { operatorsRouter } from '../routes/operators';
import { templatesRouter } from '../routes/templates';
import { schedulesRouter } from '../routes/schedules';
import { credentialsRouter } from '../routes/credentials';
import { discoverRouter } from '../routes/discover';
import { workspacesRouter } from '../routes/workspaces';

// Middleware
import { requestLogger } from './middleware/request-logger';
import { errorHandler, notFoundHandler, AppError } from './middleware/error-handler';
import {
  validateQuery,
  validateBody,
  componentContentQuerySchema,
  inventorySearchQuerySchema,
  capabilitiesQuerySchema,
  chatBodySchema,
  configureWorkflowBodySchema,
  configureNodeBodySchema,
} from './middleware/validation';
import { apiKeyAuth } from './middleware/auth';
import { slidingWindowRateLimiter } from './middleware/rate-limiter';
import { webhookVerify } from './middleware/webhook-verify';

// =============================================================================
// Server Configuration
// =============================================================================

const app = express();
const httpServer = createServer(app);
const PORT = parseInt(process.env.PORT || '3001', 10);

// Allowed CORS origins (configurable via env)
const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
  : ['http://localhost:5173', 'http://localhost:3000'];

// Initialize Socket.io with locked-down CORS
const io: TypedSocketServer = new SocketServer<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>(httpServer, {
  cors: {
    origin: CORS_ORIGINS,
    methods: ['GET', 'POST'],
  },
});

// Initialize socket emitter, handlers, and metrics forwarder
initSocketEmitter(io);
setupSocketHandlers(io);
initMetricsEmitter();
initAlertService();

// WebSocket upgrade handler for live log streaming (/api/systems/:slug/stream).
// Must be registered before Socket.io's own upgrade handler so it gets first
// crack at non-Socket.io upgrade requests.
httpServer.on('upgrade', (req, socket, head) => {
  // Let Socket.io handle its own upgrade path (default: /socket.io/)
  if (req.url?.startsWith('/socket.io')) return;

  const handled = handleLogStreamUpgrade(req, socket, head);
  if (!handled) {
    socket.destroy();
  }
});

// =============================================================================
// Middleware Stack
// =============================================================================

// Security headers
app.use(helmet());

// CORS — locked to known origins
app.use(
  cors({
    origin: CORS_ORIGINS,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Webhook-Signature'],
  })
);

// Body parsing with size limit
app.use(express.json({ limit: '1mb' }));

// Request logging
app.use(requestLogger);

// Rate limiting — sliding window, 100 req/min per IP
app.use('/api/', slidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 100 }));

// API key authentication — all /api/ routes except /api/health
app.use('/api/', apiKeyAuth);

// Stricter rate limit for AI-powered endpoints (30/min supports wizards with many nodes)
const aiLimiter = slidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 30 });

// =============================================================================
// Search Index Cache
// =============================================================================

let searchIndex: FlattenedItem[] | null = null;
let searchIndexPromise: Promise<FlattenedItem[]> | null = null;

async function getSearchIndex(): Promise<FlattenedItem[]> {
  if (searchIndex) return searchIndex;
  if (searchIndexPromise) return searchIndexPromise;

  searchIndexPromise = (async () => {
    const inventory = await scanInventory();
    searchIndex = buildSearchIndex(inventory);
    return searchIndex;
  })();

  return searchIndexPromise;
}

// =============================================================================
// Routes
// =============================================================================

app.get('/', (_req, res) => {
  res.json({ name: 'Visual Agent Builder API', status: 'running' });
});

// --- Inventory ---

app.get('/api/inventory', async (_req, res, next) => {
  try {
    const inventory = await scanInventory();
    res.json(inventory);
  } catch (error) {
    next(error);
  }
});

// --- Component Content (hardened path traversal protection) ---

app.get(
  '/api/component-content',
  validateQuery(componentContentQuerySchema),
  async (req, res, next) => {
    try {
      const filePath = req.query.path as string;
      const inventoryRoot = getInventoryRoot();

      // Reject null bytes
      if (filePath.includes('\0')) {
        throw new AppError(400, 'Invalid path');
      }

      // Resolve and normalize — always resolve relative to inventory root
      const normalizedPath = path.resolve(inventoryRoot, filePath);

      // Ensure the resolved path is within the inventory root
      if (!normalizedPath.startsWith(inventoryRoot + path.sep) && normalizedPath !== inventoryRoot) {
        throw new AppError(403, 'Access denied: path outside inventory root');
      }

      const content = await fs.readFile(normalizedPath, 'utf-8');
      res.json({ content });
    } catch (err) {
      if (err instanceof AppError) {
        return next(err);
      }
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return next(new AppError(404, 'File not found'));
      }
      next(err);
    }
  }
);

// --- Inventory Search ---

app.get(
  '/api/inventory/search',
  validateQuery(inventorySearchQuerySchema),
  async (req, res, next) => {
    try {
      const { q, types, repos, categories, buckets, subcategories, limit, offset } = req.query;

      const parseList = (val: unknown): string[] | undefined => {
        if (!val || typeof val !== 'string') return undefined;
        return val.split(',').map((s) => s.trim()).filter(Boolean);
      };

      const index = await getSearchIndex();

      const result = searchInventory(
        index,
        typeof q === 'string' ? q : undefined,
        {
          types: parseList(types),
          repos: parseList(repos),
          categories: parseList(categories),
          buckets: parseList(buckets),
          subcategories: parseList(subcategories),
        },
        {
          limit: typeof limit === 'number' ? limit : 100,
          offset: typeof offset === 'number' ? offset : 0,
        }
      );

      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

// --- Bucket Counts ---

app.get('/api/inventory/bucket-counts', async (_req, res, next) => {
  try {
    const index = await getSearchIndex();

    const counts: Record<string, number> = {};
    for (const item of index) {
      for (const bucket of item.buckets) {
        counts[bucket] = (counts[bucket] || 0) + 1;
      }
    }

    res.json({ counts });
  } catch (error) {
    next(error);
  }
});

// --- Capabilities ---

app.get(
  '/api/capabilities',
  validateQuery(capabilitiesQuerySchema),
  (req, res) => {
    const type = req.query.type as string | undefined;
    const capabilities = type
      ? capabilityRegistry.getByType(type as 'skill' | 'hook' | 'command')
      : capabilityRegistry.getAll();

    res.json({
      count: capabilities.length,
      capabilities: capabilities.map((cap) => ({
        name: cap.name,
        type: cap.type,
        triggers: cap.triggers,
        loadedAt: cap.loadedAt,
      })),
    });
  }
);

// --- Chat (AI-rate-limited) ---

app.post(
  '/api/chat',
  aiLimiter,
  validateBody(chatBodySchema),
  async (req, res, next) => {
    try {
      const { message, sessionId } = req.body;

      const session = getSession(sessionId);
      if (!session) {
        throw new AppError(404, 'Session not found. Start a session via Socket.io first.');
      }

      const supervisor = createSupervisorAgent(sessionId);
      await supervisor.processMessage(message, session);

      res.json({
        success: true,
        sessionId,
        message: 'Message processed. Check Socket.io for real-time updates.',
      });
    } catch (error) {
      next(error);
    }
  }
);

// --- Configure Workflow ---

app.post(
  '/api/configure-workflow',
  validateBody(configureWorkflowBodySchema),
  async (req, res, next) => {
    try {
      const { nodes, edges } = req.body;
      const analysis = analyzeWorkflow(nodes, edges);
      res.json(analysis);
    } catch (error) {
      next(error);
    }
  }
);

// --- Configure Node (SSE streaming, AI-rate-limited) ---

app.post(
  '/api/configure-node',
  aiLimiter,
  validateBody(configureNodeBodySchema),
  async (req, res) => {
    try {
      const { node, workflowContext } = req.body;

      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const suggestion = await analyzeNodeConfig(
        node,
        workflowContext || {
          nodeCount: 1,
          edgeCount: 0,
          connectedNodes: [],
          workflowName: 'Workflow',
        },
        (chunk: string) => {
          res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
        }
      );

      res.write(`data: ${JSON.stringify({ type: 'result', suggestion })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (error) {
      console.error('[Configure] Node analysis error:', error);
      if (res.headersSent) {
        res.write(
          `data: ${JSON.stringify({ type: 'error', message: 'Analysis failed' })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.status(500).json({ error: 'Failed to analyze node configuration' });
      }
    }
  }
);

// --- Metrics ---

app.get('/api/metrics', async (req, res, next) => {
  try {
    const slug = req.query.slug as string | undefined;
    const hours = parseInt(req.query.hours as string, 10) || 24;

    if (slug) {
      const stats = await getSystemStats(slug, hours);
      res.json(stats);
    } else {
      const stats = await getGlobalStats(hours);
      res.json(stats);
    }
  } catch (error) {
    next(error);
  }
});

// --- Health Check ---

app.get('/api/health', async (_req, res) => {
  const services: Record<string, unknown> = {};
  let downCount = 0;
  let dbDown = false;

  const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('Health check timeout')), ms)
      ),
    ]);

  // 1. Database
  try {
    const start = Date.now();
    await withTimeout(pool.query('SELECT 1'), 3000);
    services.database = { status: 'healthy', latencyMs: Date.now() - start };
  } catch {
    services.database = { status: 'unhealthy' };
    downCount++;
    dbDown = true;
  }

  // 2. Redis
  let redisClient: Redis | null = null;
  try {
    const start = Date.now();
    redisClient = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
      lazyConnect: true,
      connectTimeout: 3000,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });
    await withTimeout(redisClient.connect().then(() => redisClient!.ping()), 3000);
    services.redis = { status: 'healthy', latencyMs: Date.now() - start };
  } catch {
    services.redis = { status: 'unhealthy' };
    downCount++;
  } finally {
    redisClient?.disconnect();
  }

  // 3. PM2 (optional)
  try {
    const procs = await withTimeout(listProcesses(), 3000);
    services.pm2 = { status: 'running', processes: procs.length };
  } catch {
    services.pm2 = { status: 'unavailable' };
  }

  // 5. Cron schedules
  try {
    const schedules = getScheduleStatus();
    const activeCount = schedules.filter((s) => s.enabled).length;
    services.schedules = { status: 'ok', total: schedules.length, active: activeCount };
  } catch {
    services.schedules = { status: 'unavailable' };
  }

  // Determine overall status
  let status: 'healthy' | 'degraded' | 'unhealthy';
  if (dbDown || downCount >= 2) {
    status = 'unhealthy';
  } else if (downCount >= 1) {
    status = 'degraded';
  } else {
    status = 'healthy';
  }

  const poolStatus = getPoolStatus();
  const statusCode = status === 'unhealthy' ? 503 : 200;

  res.status(statusCode).json({
    status,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '1.0.0',
    services,
    pools: poolStatus,
  });
});

// --- Systems (deployment registry) ---

app.use('/api/systems', systemsRouter);
app.use('/api/deploy', deployRouter);
app.use('/api/operators', operatorsRouter);
app.use('/api/schedules', schedulesRouter);
app.use('/api/credentials', credentialsRouter);
app.use('/api/discover', discoverRouter);
app.use('/api/workspaces', workspacesRouter);
// Schedule mutation routes mounted under /api/systems/:slug/schedule
app.use('/api/systems', schedulesRouter);
app.use('/api/templates', templatesRouter);

// Manual trigger for optimization agent (outside the router since it's registered at startup)
app.post('/api/operators/optimization/trigger', aiLimiter, async (_req, res, next) => {
  try {
    const report = await runOptimizationAgent();
    res.json(report);
  } catch (error) {
    next(error);
  }
});

// =============================================================================
// Error Handling (must be after routes)
// =============================================================================

app.use(notFoundHandler);
app.use(errorHandler);

// =============================================================================
// Optimization Agent — Weekly Cron (Sunday midnight)
// =============================================================================

let monitorCronHandle: { stop: () => void } | null = null;
let slackBotHandle: { stop: () => Promise<void> } | null = null;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
let optimizationTimer: ReturnType<typeof setTimeout> | null = null;

function msUntilNextSundayMidnight(): number {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sunday
  const daysUntilSunday = dayOfWeek === 0 ? 7 : 7 - dayOfWeek;
  const nextSunday = new Date(now);
  nextSunday.setDate(now.getDate() + daysUntilSunday);
  nextSunday.setHours(0, 0, 0, 0);
  return nextSunday.getTime() - now.getTime();
}

async function executeOptimizationCron(): Promise<void> {
  console.log('[OptimizationCron] Starting weekly optimization analysis...');
  try {
    const report = await runOptimizationAgent();
    console.log(
      `[OptimizationCron] Complete — ${report.totalExecutions} executions analyzed, ` +
        `${report.recommendations.length} recommendations (${report.autoAppliedCount} auto-applied, ` +
        `${report.pendingApprovalCount} pending approval), cost: $${report.totalCostUsd.toFixed(2)}`
    );
  } catch (err) {
    console.error('[OptimizationCron] Failed:', err);
  }
}

function scheduleOptimizationCron(): void {
  const delayMs = msUntilNextSundayMidnight();
  const delayHours = (delayMs / 3_600_000).toFixed(1);
  console.log(`[OptimizationCron] Registered — next run in ${delayHours}h (Sunday midnight)`);

  optimizationTimer = setTimeout(() => {
    executeOptimizationCron();
    // After first aligned run, repeat every 7 days
    optimizationTimer = setInterval(() => {
      executeOptimizationCron();
    }, WEEK_MS) as unknown as ReturnType<typeof setTimeout>;
  }, delayMs);
}

// =============================================================================
// Graceful Shutdown
// =============================================================================

function gracefulShutdown(signal: string): void {
  console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);

  // Stop optimization cron
  if (optimizationTimer) {
    clearTimeout(optimizationTimer);
    optimizationTimer = null;
  }

  // Shutdown shared Redis publisher
  shutdownRedisPublisher().catch(() => {});

  // Stop metrics emitter + alerting
  destroyMetricsEmitter();
  destroyAlertService();

  // Stop Slack bot
  if (slackBotHandle) {
    slackBotHandle.stop().catch(() => {});
    slackBotHandle = null;
  }

  // Stop operator crons
  monitorCronHandle?.stop();
  destroyCronScheduler();
  if (optimizationTimer) clearTimeout(optimizationTimer);

  // Flush session data to disk before exiting
  flushSessions();

  httpServer.close(() => {
    console.log('[Server] HTTP server closed');
    io.close(() => {
      console.log('[Server] Socket.io server closed');
      process.exit(0);
    });
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    console.error('[Server] Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// =============================================================================
// Server Startup
// =============================================================================

async function startServer(): Promise<void> {
  try {
    // Validate critical env vars
    if (!process.env.ENCRYPTION_KEY) {
      console.error('[Server] FATAL: ENCRYPTION_KEY is not set.');
      console.error('[Server] Cannot start with unencrypted secret storage.');
      console.error('[Server] Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
      process.exit(1);
    }

    // Claude Code CLI preflight — the @anthropic-ai/claude-agent-sdk spawns
    // the `claude` binary as a subprocess for every agent execution. If it's
    // not on PATH, every workflow run dies with a cryptic "exit code 1" from
    // the SDK long before any usable error surfaces. Warn loudly on boot so
    // operators see the gap immediately — but don't refuse to start, because
    // Discover/Vault/Systems/Credentials all work fine without it.
    try {
      const { execSync } = await import('child_process');
      const version = execSync('claude --version', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      console.log(`[Server] Claude Code CLI detected: ${version}`);
    } catch {
      console.warn('');
      console.warn('═══════════════════════════════════════════════════════════');
      console.warn('⚠  WARNING: Claude Code CLI not found on PATH');
      console.warn('═══════════════════════════════════════════════════════════');
      console.warn('Agent execution (workflow runs, Test Lab, Slack triggers)');
      console.warn('will fail with "Claude code process exited with code 1"');
      console.warn('because the Claude Agent SDK cannot spawn its subprocess.');
      console.warn('');
      console.warn('Install it with:');
      console.warn('  npm install -g @anthropic-ai/claude-code');
      console.warn('');
      console.warn('Everything else (Discover, Vault, Systems, Credentials)');
      console.warn('works without it — this is only a runtime requirement for');
      console.warn('actually executing deployed systems.');
      console.warn('═══════════════════════════════════════════════════════════');
      console.warn('');
    }

    // Run database migrations
    console.log('[Server] Running database migrations...');
    await runMigrations();

    // Preload custom provider definitions into memory so getProviderAny
    // lookups in credential-vault / deploy-bridge stay synchronous.
    await loadCustomProviders();

    // Same pattern for discover items (marketplace catalog).
    await loadCustomDiscoverItems();

    // Per-workspace canvas storage: ensures sandbox/workspaces/default/ exists
    // and migrates legacy sandbox/layout.json into it on first boot.
    await initializeWorkspaces();

    await initializeSandbox();
    await loadPersistedLayout();
    await startSkillWatcher();

    // Register system monitor cron (every 5 minutes)
    monitorCronHandle = registerMonitorCron();

    // Initialize cron scheduler (polls every 60s for cron-enabled systems)
    await initCronScheduler();

    // Schedule weekly optimization agent (Sunday midnight)
    scheduleOptimizationCron();

    // Start Slack bot (non-blocking — warn if tokens not configured)
    if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
      startSlackBot()
        .then((handle) => {
          slackBotHandle = handle;
          console.log('[Server] Slack bot connected — Router Agent listening for messages');
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[Server] Slack bot failed to start: ${msg}`);
          console.warn('[Server] Continuing without Slack integration');
        });
    } else {
      console.log('[Server] Slack bot disabled — SLACK_BOT_TOKEN / SLACK_APP_TOKEN not set');
    }

    httpServer.listen(PORT, () => {
      console.log(`[Server] Running on http://localhost:${PORT}`);
      console.log(`[Server] Socket.io enabled for real-time canvas updates`);
      console.log(`[Server] Skill hot-reload watcher active`);
      console.log(`[Server] CORS origins: ${CORS_ORIGINS.join(', ')}`);
      console.log(`[Server] Inventory root: ${getInventoryRoot()}`);
    });
  } catch (error) {
    console.error('[Server] Failed to start:', error);
    process.exit(1);
  }
}

startServer();

// Export for testing
export { app, httpServer };
