// =============================================================================
// Skill Hot-Reload Watcher
// Watches .claude/skills/ directory for changes and hot-reloads capabilities
// =============================================================================

import chokidar, { FSWatcher } from 'chokidar';
import fs from 'fs/promises';
import path from 'path';
import { SANDBOX_ROOT } from '../mcp/sandbox-mcp';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface RegisteredCapability {
  name: string;
  type: 'skill' | 'hook' | 'command';
  path: string;
  content: string;
  triggers?: string[];
  loadedAt: number;
}

// -----------------------------------------------------------------------------
// Capability Registry
// -----------------------------------------------------------------------------

class CapabilityRegistry {
  private capabilities = new Map<string, RegisteredCapability>();
  private listeners: Array<(event: 'add' | 'change' | 'remove', capability: RegisteredCapability) => void> = [];

  register(capability: RegisteredCapability): void {
    this.capabilities.set(capability.path, capability);
    this.notifyListeners('add', capability);
  }

  update(capability: RegisteredCapability): void {
    this.capabilities.set(capability.path, capability);
    this.notifyListeners('change', capability);
  }

  remove(filePath: string): void {
    const capability = this.capabilities.get(filePath);
    if (capability) {
      this.capabilities.delete(filePath);
      this.notifyListeners('remove', capability);
    }
  }

  get(filePath: string): RegisteredCapability | undefined {
    return this.capabilities.get(filePath);
  }

  getAll(): RegisteredCapability[] {
    return Array.from(this.capabilities.values());
  }

  getByType(type: RegisteredCapability['type']): RegisteredCapability[] {
    return this.getAll().filter((cap) => cap.type === type);
  }

  onCapabilityChange(
    listener: (event: 'add' | 'change' | 'remove', capability: RegisteredCapability) => void
  ): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notifyListeners(
    event: 'add' | 'change' | 'remove',
    capability: RegisteredCapability
  ): void {
    for (const listener of this.listeners) {
      try {
        listener(event, capability);
      } catch (error) {
        console.error('[SkillWatcher] Listener error:', error);
      }
    }
  }
}

// Global registry instance
export const capabilityRegistry = new CapabilityRegistry();

// -----------------------------------------------------------------------------
// File Parsing
// -----------------------------------------------------------------------------

function inferCapabilityType(filePath: string): RegisteredCapability['type'] {
  const relativePath = path.relative(SANDBOX_ROOT, filePath);

  if (relativePath.includes('skills')) return 'skill';
  if (relativePath.includes('hooks')) return 'hook';
  if (relativePath.includes('commands')) return 'command';

  // Fallback based on extension
  const ext = path.extname(filePath);
  if (ext === '.json') return 'hook';
  return 'skill';
}

function extractCapabilityName(filePath: string): string {
  const basename = path.basename(filePath);
  // Remove extension
  return basename.replace(/\.(md|json|yaml|yml)$/i, '');
}

async function parseCapabilityFile(filePath: string): Promise<RegisteredCapability | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const name = extractCapabilityName(filePath);
    const type = inferCapabilityType(filePath);

    // Extract triggers from content (basic implementation)
    const triggers: string[] = [];

    // For markdown files, look for trigger patterns
    if (filePath.endsWith('.md')) {
      const triggerMatch = content.match(/triggers?:\s*\[([^\]]+)\]/i);
      if (triggerMatch) {
        triggers.push(...triggerMatch[1].split(',').map((t) => t.trim().replace(/["']/g, '')));
      }

      // Also look for keyword patterns
      const keywordMatch = content.match(/keywords?:\s*\[([^\]]+)\]/i);
      if (keywordMatch) {
        triggers.push(...keywordMatch[1].split(',').map((t) => t.trim().replace(/["']/g, '')));
      }
    }

    // For JSON files (hooks), extract from JSON
    if (filePath.endsWith('.json')) {
      try {
        const json = JSON.parse(content);
        if (json.triggers) {
          triggers.push(...(Array.isArray(json.triggers) ? json.triggers : [json.triggers]));
        }
        if (json.matcher) {
          triggers.push(json.matcher);
        }
      } catch {
        // Ignore JSON parse errors
      }
    }

    return {
      name,
      type,
      path: filePath,
      content,
      triggers: triggers.length > 0 ? triggers : undefined,
      loadedAt: Date.now(),
    };
  } catch (error) {
    console.error(`[SkillWatcher] Failed to parse ${filePath}:`, error);
    return null;
  }
}

// -----------------------------------------------------------------------------
// Watcher Implementation
// -----------------------------------------------------------------------------

let watcher: FSWatcher | null = null;

export async function startSkillWatcher(): Promise<void> {
  // Directories to watch
  const watchPaths = [
    path.join(SANDBOX_ROOT, '.claude', 'skills'),
    path.join(SANDBOX_ROOT, '.claude', 'hooks'),
    path.join(SANDBOX_ROOT, '.claude', 'commands'),
  ];

  // Ensure directories exist
  for (const watchPath of watchPaths) {
    await fs.mkdir(watchPath, { recursive: true });
  }

  console.log('[SkillWatcher] Starting watcher for:', watchPaths);

  // Initialize watcher
  watcher = chokidar.watch(watchPaths, {
    persistent: true,
    ignoreInitial: false,  // Process existing files on startup
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
    ignored: [
      /(^|[\/\\])\../,     // Ignore dotfiles
      /node_modules/,       // Ignore node_modules
    ],
  });

  // Handle file events
  watcher.on('add', async (filePath: string) => {
    console.log(`[SkillWatcher] File added: ${filePath}`);
    const capability = await parseCapabilityFile(filePath);
    if (capability) {
      capabilityRegistry.register(capability);
      console.log(`[SkillWatcher] Registered ${capability.type}: ${capability.name}`);
    }
  });

  watcher.on('change', async (filePath: string) => {
    console.log(`[SkillWatcher] File changed: ${filePath}`);
    const capability = await parseCapabilityFile(filePath);
    if (capability) {
      capabilityRegistry.update(capability);
      console.log(`[SkillWatcher] Updated ${capability.type}: ${capability.name}`);
    }
  });

  watcher.on('unlink', (filePath: string) => {
    console.log(`[SkillWatcher] File removed: ${filePath}`);
    capabilityRegistry.remove(filePath);
  });

  watcher.on('error', (error: unknown) => {
    console.error('[SkillWatcher] Error:', error);
  });

  watcher.on('ready', () => {
    const count = capabilityRegistry.getAll().length;
    console.log(`[SkillWatcher] Ready. Watching for changes. ${count} capabilities loaded.`);
  });
}

export async function stopSkillWatcher(): Promise<void> {
  if (watcher) {
    await watcher.close();
    watcher = null;
    console.log('[SkillWatcher] Stopped.');
  }
}

// -----------------------------------------------------------------------------
// Capability Registration Tool
// -----------------------------------------------------------------------------

export interface RegisterCapabilityParams {
  name: string;
  type: 'skill' | 'hook' | 'command';
  content: string;
  triggers?: string[];
}

export async function registerCapability(
  params: RegisterCapabilityParams
): Promise<{ success: boolean; path?: string; error?: string }> {
  try {
    // Determine file extension
    const ext = params.type === 'hook' ? '.json' : '.md';

    // Build file path
    const relativePath = `.claude/${params.type}s/${params.name}${ext}`;
    const absolutePath = path.join(SANDBOX_ROOT, relativePath);

    // Ensure directory exists
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });

    // Write file (chokidar will pick up the change)
    await fs.writeFile(absolutePath, params.content, 'utf-8');

    console.log(`[SkillWatcher] Capability registered via tool: ${params.name}`);

    return { success: true, path: relativePath };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}

// -----------------------------------------------------------------------------
// Tool Definition for Builder Agent
// -----------------------------------------------------------------------------

export const CAPABILITY_TOOLS = {
  register_capability: {
    name: 'register_capability',
    description: 'Register a new skill, hook, or command capability that will be automatically hot-reloaded',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the capability (used as filename)',
        },
        type: {
          type: 'string',
          enum: ['skill', 'hook', 'command'],
          description: 'Type of capability',
        },
        content: {
          type: 'string',
          description: 'Content of the capability file (Markdown for skills/commands, JSON for hooks)',
        },
        triggers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords or patterns that trigger this capability',
        },
      },
      required: ['name', 'type', 'content'],
    },
    handler: registerCapability,
  },
};
