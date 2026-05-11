// =============================================================================
// Sandbox MCP Server
// Provides tools for AI agents to manipulate files in the sandbox environment
// =============================================================================

import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { emitExecutionLog } from '../socket/emitter';

// Sandbox root directory (isolated from application code)
const SANDBOX_ROOT = process.env.SANDBOX_ROOT || path.join(process.cwd(), 'sandbox');

// Current session ID for logging (set by execute command)
let currentSessionId: string | null = null;

export function setCurrentSessionId(sessionId: string | null): void {
  currentSessionId = sessionId;
}

// -----------------------------------------------------------------------------
// Tool Result Types
// -----------------------------------------------------------------------------

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// -----------------------------------------------------------------------------
// Security: Path validation
// -----------------------------------------------------------------------------

function validatePath(relativePath: string): string {
  // Reject null bytes (path traversal vector)
  if (relativePath.includes('\0')) {
    throw new Error('Access denied: invalid path');
  }

  // Normalize and resolve the path
  const absolutePath = path.resolve(SANDBOX_ROOT, relativePath);

  // Ensure path is within sandbox (use sep to prevent prefix collisions)
  if (!absolutePath.startsWith(SANDBOX_ROOT + path.sep) && absolutePath !== SANDBOX_ROOT) {
    throw new Error('Access denied: path outside sandbox');
  }

  return absolutePath;
}

// -----------------------------------------------------------------------------
// Tool: sandbox_create_file
// -----------------------------------------------------------------------------

export interface CreateFileParams {
  path: string;           // Relative to sandbox root
  content: string;
}

export interface CreateFileResult {
  absolutePath: string;
}

export async function sandbox_create_file(
  params: CreateFileParams
): Promise<ToolResult<CreateFileResult>> {
  try {
    const absolutePath = validatePath(params.path);

    // Ensure directory exists
    const dir = path.dirname(absolutePath);
    await fs.mkdir(dir, { recursive: true });

    // Write file
    await fs.writeFile(absolutePath, params.content, 'utf-8');

    return {
      success: true,
      data: { absolutePath },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// -----------------------------------------------------------------------------
// Tool: sandbox_read_file
// -----------------------------------------------------------------------------

export interface ReadFileParams {
  path: string;           // Relative to sandbox root
}

export interface ReadFileResult {
  content: string;
}

export async function sandbox_read_file(
  params: ReadFileParams
): Promise<ToolResult<ReadFileResult>> {
  try {
    const absolutePath = validatePath(params.path);

    const content = await fs.readFile(absolutePath, 'utf-8');

    return {
      success: true,
      data: { content },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        success: false,
        error: `File not found: ${params.path}`,
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// -----------------------------------------------------------------------------
// Tool: sandbox_list_directory
// -----------------------------------------------------------------------------

export interface ListDirectoryParams {
  path?: string;          // Relative to sandbox root, defaults to root
}

export interface DirectoryEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
}

export interface ListDirectoryResult {
  entries: DirectoryEntry[];
  path: string;
}

export async function sandbox_list_directory(
  params: ListDirectoryParams
): Promise<ToolResult<ListDirectoryResult>> {
  try {
    const relativePath = params.path || '.';
    const absolutePath = validatePath(relativePath);

    // Ensure directory exists
    try {
      await fs.access(absolutePath);
    } catch {
      // Create sandbox root if it doesn't exist
      if (relativePath === '.' || relativePath === '') {
        await fs.mkdir(absolutePath, { recursive: true });
      } else {
        return {
          success: false,
          error: `Directory not found: ${params.path}`,
        };
      }
    }

    const entries: DirectoryEntry[] = [];
    const dirEntries = await fs.readdir(absolutePath, { withFileTypes: true });

    for (const entry of dirEntries) {
      const entryPath = path.join(absolutePath, entry.name);
      let size: number | undefined;

      if (entry.isFile()) {
        const stats = await fs.stat(entryPath);
        size = stats.size;
      }

      entries.push({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        size,
      });
    }

    return {
      success: true,
      data: { entries, path: relativePath },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// -----------------------------------------------------------------------------
// Tool: sandbox_delete_file
// -----------------------------------------------------------------------------

export interface DeleteFileParams {
  path: string;           // Relative to sandbox root
}

export async function sandbox_delete_file(
  params: DeleteFileParams
): Promise<ToolResult<void>> {
  try {
    const absolutePath = validatePath(params.path);

    await fs.unlink(absolutePath);

    return { success: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        success: false,
        error: `File not found: ${params.path}`,
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// -----------------------------------------------------------------------------
// Tool: sandbox_create_directory
// -----------------------------------------------------------------------------

export interface CreateDirectoryParams {
  path: string;           // Relative to sandbox root
}

export async function sandbox_create_directory(
  params: CreateDirectoryParams
): Promise<ToolResult<void>> {
  try {
    const absolutePath = validatePath(params.path);

    await fs.mkdir(absolutePath, { recursive: true });

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// -----------------------------------------------------------------------------
// Tool: sandbox_file_exists
// -----------------------------------------------------------------------------

export interface FileExistsParams {
  path: string;           // Relative to sandbox root
}

export interface FileExistsResult {
  exists: boolean;
  type?: 'file' | 'directory';
}

export async function sandbox_file_exists(
  params: FileExistsParams
): Promise<ToolResult<FileExistsResult>> {
  try {
    const absolutePath = validatePath(params.path);

    try {
      const stats = await fs.stat(absolutePath);
      return {
        success: true,
        data: {
          exists: true,
          type: stats.isDirectory() ? 'directory' : 'file',
        },
      };
    } catch {
      return {
        success: true,
        data: { exists: false },
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// -----------------------------------------------------------------------------
// Tool: sandbox_execute_command
// -----------------------------------------------------------------------------

export interface ExecuteCommandParams {
  command: string;
  cwd?: string;           // Relative to sandbox root, defaults to sandbox root
  sessionId?: string;     // For streaming output
  source?: 'workflow' | 'fixer'; // Route output to correct terminal tab
}

export interface ExecuteCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function sandbox_execute_command(
  params: ExecuteCommandParams
): Promise<ToolResult<ExecuteCommandResult>> {
  return new Promise((resolve) => {
    try {
      // Validate and resolve working directory
      const workDir = params.cwd
        ? validatePath(params.cwd)
        : SANDBOX_ROOT;

      // Reject commands with absolute paths outside the sandbox
      const absolutePathPattern = /(?:^|\s|["'=])(\/(?!dev\/null)[^\s"']*)/g;
      let match;
      while ((match = absolutePathPattern.exec(params.command)) !== null) {
        const absPath = match[1];
        if (!absPath.startsWith(SANDBOX_ROOT)) {
          resolve({
            success: false,
            error: `Blocked: command references absolute path outside sandbox: ${absPath}. Use relative paths instead.`,
            data: { exitCode: -1, stdout: '', stderr: '' },
          });
          return;
        }
      }

      // Set session ID for streaming
      const sessionId = params.sessionId || currentSessionId;

      // Spawn child process — cwd is always within sandbox
      // Strip CLAUDECODE from env so spawned claude processes don't think they're nested
      const { CLAUDECODE: _, ...cleanEnv } = process.env;
      const child = spawn('sh', ['-c', params.command], {
        cwd: workDir,
        env: { ...cleanEnv, HOME: SANDBOX_ROOT },
      });

      let stdout = '';
      let stderr = '';

      // Stream stdout
      child.stdout.on('data', (data: Buffer) => {
        const output = data.toString();
        stdout += output;

        // Stream to socket if session ID is available
        if (sessionId) {
          emitExecutionLog(sessionId, output, 'stdout', params.source);
        }
      });

      // Stream stderr
      child.stderr.on('data', (data: Buffer) => {
        const output = data.toString();
        stderr += output;

        // Stream to socket if session ID is available
        if (sessionId) {
          emitExecutionLog(sessionId, output, 'stderr', params.source);
        }
      });

      // Handle completion
      child.on('close', (code) => {
        resolve({
          success: code === 0,
          data: {
            exitCode: code || 0,
            stdout,
            stderr,
          },
          error: code !== 0 ? `Command exited with code ${code}` : undefined,
        });
      });

      // Handle error
      child.on('error', (error) => {
        resolve({
          success: false,
          error: error.message,
          data: {
            exitCode: -1,
            stdout,
            stderr,
          },
        });
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        child.kill();
        resolve({
          success: false,
          error: 'Command timed out after 5 minutes',
          data: {
            exitCode: -1,
            stdout,
            stderr,
          },
        });
      }, 5 * 60 * 1000);
    } catch (error) {
      resolve({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
}

// -----------------------------------------------------------------------------
// Initialize sandbox directory structure
// -----------------------------------------------------------------------------

export async function initializeSandbox(): Promise<void> {
  const directories = [
    'agents',
    'config',
    '.claude/skills',
    '.claude/hooks',
    '.claude/commands',
  ];

  for (const dir of directories) {
    await fs.mkdir(path.join(SANDBOX_ROOT, dir), { recursive: true });
  }

  console.log(`[Sandbox] Initialized at ${SANDBOX_ROOT}`);
}

// -----------------------------------------------------------------------------
// Tool Registry (for Builder agent)
// -----------------------------------------------------------------------------

export const SANDBOX_TOOLS = {
  sandbox_create_file: {
    name: 'sandbox_create_file',
    description: 'Create a file in the sandbox environment',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to sandbox root',
        },
        content: {
          type: 'string',
          description: 'File content',
        },
      },
      required: ['path', 'content'],
    },
    handler: sandbox_create_file,
  },

  sandbox_read_file: {
    name: 'sandbox_read_file',
    description: 'Read a file from the sandbox environment',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to sandbox root',
        },
      },
      required: ['path'],
    },
    handler: sandbox_read_file,
  },

  sandbox_list_directory: {
    name: 'sandbox_list_directory',
    description: 'List contents of a directory in the sandbox',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to sandbox root (defaults to root)',
        },
      },
    },
    handler: sandbox_list_directory,
  },

  sandbox_delete_file: {
    name: 'sandbox_delete_file',
    description: 'Delete a file from the sandbox',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to sandbox root',
        },
      },
      required: ['path'],
    },
    handler: sandbox_delete_file,
  },

  sandbox_create_directory: {
    name: 'sandbox_create_directory',
    description: 'Create a directory in the sandbox',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to sandbox root',
        },
      },
      required: ['path'],
    },
    handler: sandbox_create_directory,
  },

  sandbox_file_exists: {
    name: 'sandbox_file_exists',
    description: 'Check if a file or directory exists in the sandbox',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to sandbox root',
        },
      },
      required: ['path'],
    },
    handler: sandbox_file_exists,
  },

  sandbox_execute_command: {
    name: 'sandbox_execute_command',
    description: 'Execute a shell command in the sandbox environment. Output is streamed to the UI.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute',
        },
        cwd: {
          type: 'string',
          description: 'Working directory relative to sandbox root (defaults to sandbox root)',
        },
      },
      required: ['command'],
    },
    handler: sandbox_execute_command,
  },
};

export { SANDBOX_ROOT };
