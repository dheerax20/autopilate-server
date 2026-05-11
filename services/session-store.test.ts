import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { FileSessionStore } from './session-store';
import { Session } from '../types/session';

function tmpSessionPath(): string {
  return path.join(os.tmpdir(), `vab-test-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function makeSession(id: string, overrides?: Partial<Session>): Session {
  return {
    id,
    state: 'idle',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    variables: {},
    ...overrides,
  };
}

describe('FileSessionStore', () => {
  let filePath: string;
  let store: FileSessionStore;

  beforeEach(() => {
    filePath = tmpSessionPath();
    store = new FileSessionStore(filePath);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      if (fs.existsSync(filePath + '.tmp')) fs.unlinkSync(filePath + '.tmp');
    } catch {
      // cleanup best-effort
    }
  });

  it('should store and retrieve a session', () => {
    const session = makeSession('s1');
    store.set('s1', session);
    expect(store.get('s1')).toEqual(session);
  });

  it('should return undefined for unknown session', () => {
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('should delete a session', () => {
    const session = makeSession('s1');
    store.set('s1', session);
    expect(store.delete('s1')).toBe(true);
    expect(store.get('s1')).toBeUndefined();
    expect(store.delete('s1')).toBe(false);
  });

  it('should update session state', () => {
    const session = makeSession('s1');
    store.set('s1', session);
    store.updateState('s1', 'executing');
    expect(store.get('s1')?.state).toBe('executing');
  });

  it('should add messages to session', () => {
    const session = makeSession('s1');
    store.set('s1', session);
    store.addMessage('s1', {
      id: 'm1',
      role: 'user',
      content: 'hello',
      timestamp: Date.now(),
    });
    expect(store.get('s1')?.messages).toHaveLength(1);
    expect(store.get('s1')?.messages[0].content).toBe('hello');
  });

  it('should set and get variables', () => {
    const session = makeSession('s1');
    store.set('s1', session);
    store.setVariable('s1', 'nodeId', 'abc123');
    expect(store.getVariable('s1', 'nodeId')).toBe('abc123');
    expect(store.getVariable('s1', 'missing')).toBeUndefined();
  });

  it('should report correct size', () => {
    expect(store.size).toBe(0);
    store.set('s1', makeSession('s1'));
    store.set('s2', makeSession('s2'));
    expect(store.size).toBe(2);
    store.delete('s1');
    expect(store.size).toBe(1);
  });

  it('should persist to disk and reload', () => {
    store.set('s1', makeSession('s1', { state: 'executing' }));
    store.set('s2', makeSession('s2'));
    store.flush();

    // Create a new store pointing at the same file — simulates restart
    const store2 = new FileSessionStore(filePath);
    expect(store2.size).toBe(2);
    expect(store2.get('s1')?.state).toBe('executing');
    expect(store2.get('s2')?.state).toBe('idle');
  });

  it('should handle missing file gracefully', () => {
    const missingPath = tmpSessionPath();
    const freshStore = new FileSessionStore(missingPath);
    expect(freshStore.size).toBe(0);
  });

  it('should handle corrupt file gracefully', () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'not-valid-json!!!', 'utf-8');
    const corruptStore = new FileSessionStore(filePath);
    expect(corruptStore.size).toBe(0);
  });

  it('should not persist ops on unknown sessions', () => {
    store.updateState('ghost', 'executing');
    store.addMessage('ghost', { id: 'm', role: 'user', content: '', timestamp: 0 });
    store.setVariable('ghost', 'k', 'v');
    expect(store.getVariable('ghost', 'k')).toBeUndefined();
  });
});
