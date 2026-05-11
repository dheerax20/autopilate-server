// =============================================================================
// File-Based Session Store
// Persists sessions to a JSON file so they survive server restarts.
// Arch review item #7: "In-memory sessions are lost on restart"
// =============================================================================

import fs from 'fs';
import path from 'path';
import { Session, SessionStore } from '../types/session';
import { SessionState, SessionMessage } from '../shared/socket-events';

const DEFAULT_SESSIONS_PATH = path.resolve(__dirname, '../../data/sessions.json');
const SESSIONS_PATH = process.env.SESSIONS_PATH || DEFAULT_SESSIONS_PATH;

// Debounce writes — avoid hammering disk on rapid updates
const WRITE_DEBOUNCE_MS = 500;

export class FileSessionStore implements SessionStore {
  private sessions: Map<string, Session>;
  private filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private writeInProgress = false;

  constructor(filePath?: string) {
    this.filePath = filePath || SESSIONS_PATH;
    this.sessions = new Map();
    this.loadSync();
  }

  /** Load sessions from disk (synchronous, used only at startup) */
  private loadSync(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed: Record<string, Session> = JSON.parse(raw);
        for (const [id, session] of Object.entries(parsed)) {
          this.sessions.set(id, session);
        }
        console.log(`[SessionStore] Loaded ${this.sessions.size} session(s) from ${this.filePath}`);
      }
    } catch (err) {
      console.warn('[SessionStore] Failed to load sessions from disk, starting fresh:', err);
      this.sessions = new Map();
    }
  }

  /** Schedule a debounced write to disk */
  private schedulePersist(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }
    this.writeTimer = setTimeout(() => {
      this.persistToDisk();
    }, WRITE_DEBOUNCE_MS);
  }

  /** Write all sessions to disk */
  private persistToDisk(): void {
    if (this.writeInProgress) {
      // Re-schedule if a write is already in progress
      this.schedulePersist();
      return;
    }
    this.writeInProgress = true;

    const data: Record<string, Session> = {};
    for (const [id, session] of this.sessions) {
      data[id] = session;
    }

    const dir = path.dirname(this.filePath);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Write atomically: write to tmp file, then rename
      const tmpPath = this.filePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.error('[SessionStore] Failed to persist sessions:', err);
    } finally {
      this.writeInProgress = false;
    }
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  set(sessionId: string, session: Session): void {
    this.sessions.set(sessionId, session);
    this.schedulePersist();
  }

  delete(sessionId: string): boolean {
    const result = this.sessions.delete(sessionId);
    if (result) {
      this.schedulePersist();
    }
    return result;
  }

  updateState(sessionId: string, state: SessionState): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = state;
      session.updatedAt = Date.now();
      this.schedulePersist();
    }
  }

  addMessage(sessionId: string, message: SessionMessage): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.messages.push(message);
      session.updatedAt = Date.now();
      this.schedulePersist();
    }
  }

  setVariable(sessionId: string, key: string, value: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.variables[key] = value;
      session.updatedAt = Date.now();
      this.schedulePersist();
    }
  }

  getVariable(sessionId: string, key: string): string | undefined {
    const session = this.sessions.get(sessionId);
    return session?.variables[key];
  }

  /** Flush pending writes immediately (useful for shutdown) */
  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.persistToDisk();
  }

  /** Get total session count (for health checks / debugging) */
  get size(): number {
    return this.sessions.size;
  }
}

// Singleton instance
let store: FileSessionStore | null = null;

export function getSessionStore(filePath?: string): FileSessionStore {
  if (!store) {
    store = new FileSessionStore(filePath);
  }
  return store;
}

/** Reset singleton (for testing) */
export function resetSessionStore(): void {
  store = null;
}
