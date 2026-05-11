// =============================================================================
// Workspace Store
//
// File-backed per-workspace canvas storage. Each workspace is a directory
// under sandbox/workspaces/{slug}/ with a canvas.json containing the
// nodes/edges that workspace owns. Two team members picking different
// workspaces never collide because they're reading and writing different
// files.
//
// This is intentionally separate from the existing in-memory canvasState
// + sandbox/layout.json plumbing in mcp/canvas/. That state is the
// "execution working buffer" used by the agent SDK runtime; this is the
// "design source of truth" that survives across browsers.
//
// Migration: on first boot, if the legacy sandbox/layout.json exists but
// no workspaces/ directory does, the legacy file is moved into the
// workspaces/default/canvas.json slot so existing canvases aren't lost.
// =============================================================================

import fs from 'fs/promises';
import path from 'path';

const SANDBOX_ROOT = process.env.SANDBOX_ROOT || path.join(process.cwd(), 'sandbox');
const WORKSPACES_ROOT = path.join(SANDBOX_ROOT, 'workspaces');
const LEGACY_LAYOUT_FILE = path.join(SANDBOX_ROOT, 'layout.json');
const DEFAULT_WORKSPACE_SLUG = 'default';

// Slugs that are reserved or unsafe. Tightened to lowercase alphanumeric +
// hyphen so we can't accidentally accept anything that escapes the
// workspaces/ root via path traversal.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface CanvasState {
  nodes: unknown[];
  edges: unknown[];
}

export interface WorkspaceMeta {
  slug: string;
  /** Display label — defaults to the slug if no label.json is present. */
  label: string;
  /** When the workspace's canvas.json was last modified, in ISO format. */
  updatedAt: string | null;
  /** Quick stats for the switcher dropdown. */
  nodeCount: number;
  edgeCount: number;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function workspaceDir(slug: string): string {
  return path.join(WORKSPACES_ROOT, slug);
}

function canvasFile(slug: string): string {
  return path.join(workspaceDir(slug), 'canvas.json');
}

function labelFile(slug: string): string {
  return path.join(workspaceDir(slug), 'label.json');
}

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Initialization + migration
// -----------------------------------------------------------------------------

/**
 * Ensure the workspaces directory exists and at least the "default" workspace
 * is initialized. If the legacy sandbox/layout.json file exists from before
 * the workspace migration, copy its contents into workspaces/default/canvas.json
 * so the existing canvas survives the upgrade.
 *
 * Idempotent — safe to call on every server boot.
 */
export async function initializeWorkspaces(): Promise<void> {
  await fs.mkdir(WORKSPACES_ROOT, { recursive: true });

  const defaultDir = workspaceDir(DEFAULT_WORKSPACE_SLUG);
  if (!(await pathExists(defaultDir))) {
    await fs.mkdir(defaultDir, { recursive: true });
  }

  const defaultCanvas = canvasFile(DEFAULT_WORKSPACE_SLUG);
  if (!(await pathExists(defaultCanvas))) {
    if (await pathExists(LEGACY_LAYOUT_FILE)) {
      try {
        const legacy = await fs.readFile(LEGACY_LAYOUT_FILE, 'utf-8');
        // sandbox/layout.json uses { nodes: [...], edges: [...] } with
        // canvas-MCP-shaped entries, not React Flow shapes. The frontend's
        // workspace loader handles either shape, so just copy verbatim.
        await fs.writeFile(defaultCanvas, legacy, 'utf-8');
        console.log('[workspaces] Migrated legacy sandbox/layout.json → workspaces/default/canvas.json');
      } catch (err) {
        console.warn('[workspaces] Failed to migrate legacy layout.json:', err);
        await fs.writeFile(defaultCanvas, JSON.stringify({ nodes: [], edges: [] }, null, 2), 'utf-8');
      }
    } else {
      await fs.writeFile(defaultCanvas, JSON.stringify({ nodes: [], edges: [] }, null, 2), 'utf-8');
    }
  }

  console.log(`[workspaces] Ready at ${WORKSPACES_ROOT}`);
}

// -----------------------------------------------------------------------------
// CRUD
// -----------------------------------------------------------------------------

export async function listWorkspaces(): Promise<WorkspaceMeta[]> {
  await fs.mkdir(WORKSPACES_ROOT, { recursive: true });
  const entries = await fs.readdir(WORKSPACES_ROOT, { withFileTypes: true });
  const slugs = entries
    .filter((e) => e.isDirectory() && isValidSlug(e.name))
    .map((e) => e.name)
    .sort();

  const out: WorkspaceMeta[] = [];
  for (const slug of slugs) {
    out.push(await readWorkspaceMeta(slug));
  }
  return out;
}

async function readWorkspaceMeta(slug: string): Promise<WorkspaceMeta> {
  let label = slug;
  let updatedAt: string | null = null;
  let nodeCount = 0;
  let edgeCount = 0;

  // Label override
  try {
    const raw = await fs.readFile(labelFile(slug), 'utf-8');
    const parsed = JSON.parse(raw) as { label?: string };
    if (parsed.label) label = parsed.label;
  } catch {
    // No label file — fall back to slug
  }

  // Canvas stats + updatedAt
  try {
    const stat = await fs.stat(canvasFile(slug));
    updatedAt = stat.mtime.toISOString();
    const raw = await fs.readFile(canvasFile(slug), 'utf-8');
    const parsed = JSON.parse(raw) as CanvasState;
    nodeCount = Array.isArray(parsed.nodes) ? parsed.nodes.length : 0;
    edgeCount = Array.isArray(parsed.edges) ? parsed.edges.length : 0;
  } catch {
    // Canvas file missing — counts stay 0
  }

  return { slug, label, updatedAt, nodeCount, edgeCount };
}

export async function getWorkspaceCanvas(slug: string): Promise<CanvasState> {
  if (!isValidSlug(slug)) {
    throw new Error(`Invalid workspace slug: ${slug}`);
  }
  try {
    const raw = await fs.readFile(canvasFile(slug), 'utf-8');
    const parsed = JSON.parse(raw) as CanvasState;
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes.map(normalizeNode) : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges.map(normalizeEdge) : [],
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { nodes: [], edges: [] };
    }
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Legacy → React Flow shape normalization
// -----------------------------------------------------------------------------
//
// The original canvas state was persisted by the MCP canvas tools using a flat
// shape with top-level `type` and `label` fields:
//
//   { id, type: 'agent', label: 'Foo', position: {...}, parentId? }
//
// React Flow's renderer in this app expects:
//
//   { id, type: 'customNode', position, parentId?, data: { label, type: 'AGENT', ... } }
//
// Same goes for edges:
//
//   legacy: { id, sourceId, targetId, edgeType? }
//   reactflow: { id, source, target, type?, data? }
//
// `normalizeNode` / `normalizeEdge` accept either shape and emit the React
// Flow shape, so the frontend's Zustand store can hand them straight to React
// Flow without crashing on undefined `data`.
//
// Already-normalized inputs (those with a `data` object on a node, or a
// `source` field on an edge) pass through untouched — this is idempotent and
// safe on every read.

function normalizeNode(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const n = raw as Record<string, unknown>;

  // Already React Flow shape (has a `data` object) — pass through
  if (n.data && typeof n.data === 'object') {
    return n;
  }

  // Legacy MCP shape — synthesize the React Flow shape
  const legacyType = typeof n.type === 'string' ? n.type : 'agent';
  return {
    id: n.id,
    type: 'customNode',
    position: (n.position as { x: number; y: number }) ?? { x: 0, y: 0 },
    parentId: n.parentId,
    data: {
      label: (n.label as string) ?? (n.id as string),
      // Convert lowercase / hyphenated type to SCREAMING_SNAKE that the
      // CustomNode component switches on.
      type: legacyType.toUpperCase().replace(/-/g, '_'),
    },
  };
}

function normalizeEdge(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const e = raw as Record<string, unknown>;

  // Already React Flow shape (has `source`)
  if (typeof e.source === 'string') {
    return e;
  }

  // Legacy shape — remap sourceId/targetId
  return {
    id: e.id,
    source: (e.sourceId as string) ?? '',
    target: (e.targetId as string) ?? '',
    type: e.edgeType ?? e.type,
    data: e.data,
  };
}

export async function saveWorkspaceCanvas(slug: string, canvas: CanvasState): Promise<void> {
  if (!isValidSlug(slug)) {
    throw new Error(`Invalid workspace slug: ${slug}`);
  }
  await fs.mkdir(workspaceDir(slug), { recursive: true });
  await fs.writeFile(
    canvasFile(slug),
    JSON.stringify({ nodes: canvas.nodes ?? [], edges: canvas.edges ?? [] }, null, 2),
    'utf-8'
  );
}

export async function createWorkspace(slug: string, label?: string): Promise<WorkspaceMeta> {
  if (!isValidSlug(slug)) {
    throw new Error(
      `Invalid workspace slug: must be lowercase alphanumeric + hyphens, 1-64 chars`
    );
  }
  const dir = workspaceDir(slug);
  if (await pathExists(dir)) {
    throw new Error(`Workspace "${slug}" already exists`);
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(canvasFile(slug), JSON.stringify({ nodes: [], edges: [] }, null, 2), 'utf-8');
  if (label && label !== slug) {
    await fs.writeFile(labelFile(slug), JSON.stringify({ label }, null, 2), 'utf-8');
  }
  return readWorkspaceMeta(slug);
}

export async function deleteWorkspace(slug: string): Promise<void> {
  if (!isValidSlug(slug)) {
    throw new Error(`Invalid workspace slug: ${slug}`);
  }
  if (slug === DEFAULT_WORKSPACE_SLUG) {
    throw new Error('Cannot delete the default workspace');
  }
  const dir = workspaceDir(slug);
  if (!(await pathExists(dir))) {
    throw new Error(`Workspace "${slug}" not found`);
  }
  await fs.rm(dir, { recursive: true, force: true });
}
