import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  emitExecutionProgress,
  onExecutionProgress,
  type ExecutionProgressEvent,
} from '../services/execution-events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all events for an execution ID into an array. */
function collectEvents(executionId: string): {
  events: ExecutionProgressEvent[];
  unsub: () => void;
} {
  const events: ExecutionProgressEvent[] = [];
  const unsub = onExecutionProgress(executionId, (e) => events.push(e));
  return { events, unsub };
}

// ---------------------------------------------------------------------------
// Tests — Event types
// ---------------------------------------------------------------------------

describe('Execution heartbeat events', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('agent-started event contains agentName and phaseIndex', () => {
    const { events, unsub } = collectEvents('exec-1');

    emitExecutionProgress({
      executionId: 'exec-1',
      type: 'agent-started',
      agentName: 'Researcher',
      phaseIndex: 0,
      totalPhases: 3,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'agent-started',
      agentName: 'Researcher',
      phaseIndex: 0,
      totalPhases: 3,
    });

    unsub();
  });

  it('agent-completed event contains agentName and durationSeconds', () => {
    const { events, unsub } = collectEvents('exec-2');

    emitExecutionProgress({
      executionId: 'exec-2',
      type: 'agent-completed',
      agentName: 'Writer',
      phaseIndex: 1,
      durationSeconds: 45,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'agent-completed',
      agentName: 'Writer',
      durationSeconds: 45,
    });

    unsub();
  });

  it('heartbeat event contains agentName and elapsedSeconds', () => {
    const { events, unsub } = collectEvents('exec-3');

    emitExecutionProgress({
      executionId: 'exec-3',
      type: 'heartbeat',
      agentName: 'Analyst',
      phaseIndex: 0,
      elapsedSeconds: 15,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'heartbeat',
      agentName: 'Analyst',
      elapsedSeconds: 15,
    });

    unsub();
  });

  it('heartbeat fires every 15s during a simulated long-running agent', () => {
    const { events, unsub } = collectEvents('exec-hb');

    // Simulate what runAgent() does: emit heartbeat on a 15s interval
    const startTime = Date.now();
    const interval = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      emitExecutionProgress({
        executionId: 'exec-hb',
        type: 'heartbeat',
        agentName: 'SlowAgent',
        phaseIndex: 0,
        elapsedSeconds: elapsed,
      });
    }, 15_000);

    // No heartbeats yet at t=0
    expect(events).toHaveLength(0);

    // Advance 15s → first heartbeat
    vi.advanceTimersByTime(15_000);
    expect(events).toHaveLength(1);
    expect(events[0].elapsedSeconds).toBe(15);

    // Advance another 15s → second heartbeat
    vi.advanceTimersByTime(15_000);
    expect(events).toHaveLength(2);
    expect(events[1].elapsedSeconds).toBe(30);

    // Advance another 15s → third heartbeat
    vi.advanceTimersByTime(15_000);
    expect(events).toHaveLength(3);
    expect(events[2].elapsedSeconds).toBe(45);

    // Advance 10s (not a full interval) → still 3
    vi.advanceTimersByTime(10_000);
    expect(events).toHaveLength(3);

    clearInterval(interval);
    unsub();
  });

  it('agent-started fires before agent-completed in sequence', () => {
    const { events, unsub } = collectEvents('exec-seq');

    // Simulate the executeWorkflow pattern: started → completed
    emitExecutionProgress({
      executionId: 'exec-seq',
      type: 'agent-started',
      agentName: 'Agent1',
      phaseIndex: 0,
      totalPhases: 2,
    });

    emitExecutionProgress({
      executionId: 'exec-seq',
      type: 'agent-completed',
      agentName: 'Agent1',
      phaseIndex: 0,
      durationSeconds: 10,
    });

    emitExecutionProgress({
      executionId: 'exec-seq',
      type: 'agent-started',
      agentName: 'Agent2',
      phaseIndex: 1,
      totalPhases: 2,
    });

    emitExecutionProgress({
      executionId: 'exec-seq',
      type: 'agent-completed',
      agentName: 'Agent2',
      phaseIndex: 1,
      durationSeconds: 20,
    });

    expect(events.map((e) => e.type)).toEqual([
      'agent-started',
      'agent-completed',
      'agent-started',
      'agent-completed',
    ]);
    expect(events.map((e) => e.agentName)).toEqual([
      'Agent1',
      'Agent1',
      'Agent2',
      'Agent2',
    ]);

    unsub();
  });
});

// ---------------------------------------------------------------------------
// Tests — Message bridge heartbeat throttling
// ---------------------------------------------------------------------------

describe('Message bridge heartbeat throttling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throttles heartbeat messages to max 1 per 30 seconds', () => {
    const sentMessages: string[] = [];
    const HEARTBEAT_THROTTLE_MS = 30_000;
    let lastHeartbeatSentAt = 0;

    // Simulate the message bridge handler
    const handler = (event: ExecutionProgressEvent) => {
      if (event.type === 'agent-started') {
        sentMessages.push(`Running agent: ${event.agentName}...`);
      } else if (event.type === 'heartbeat') {
        const now = Date.now();
        if (now - lastHeartbeatSentAt >= HEARTBEAT_THROTTLE_MS) {
          lastHeartbeatSentAt = now;
          sentMessages.push(
            `Still working on ${event.agentName} (${event.elapsedSeconds}s)...`
          );
        }
      }
    };

    const unsub = onExecutionProgress('exec-throttle', handler);

    // agent-started always goes through
    emitExecutionProgress({
      executionId: 'exec-throttle',
      type: 'agent-started',
      agentName: 'SlowBot',
      phaseIndex: 0,
      totalPhases: 1,
    });
    expect(sentMessages).toHaveLength(1);

    // Heartbeat at t=15s — first heartbeat, should go through
    vi.advanceTimersByTime(15_000);
    emitExecutionProgress({
      executionId: 'exec-throttle',
      type: 'heartbeat',
      agentName: 'SlowBot',
      phaseIndex: 0,
      elapsedSeconds: 15,
    });
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[1]).toContain('Still working on SlowBot (15s)');

    // Heartbeat at t=30s — only 15s since last heartbeat message, should be throttled
    vi.advanceTimersByTime(15_000);
    emitExecutionProgress({
      executionId: 'exec-throttle',
      type: 'heartbeat',
      agentName: 'SlowBot',
      phaseIndex: 0,
      elapsedSeconds: 30,
    });
    expect(sentMessages).toHaveLength(2); // still 2, throttled

    // Heartbeat at t=45s — 30s since last heartbeat message, should go through
    vi.advanceTimersByTime(15_000);
    emitExecutionProgress({
      executionId: 'exec-throttle',
      type: 'heartbeat',
      agentName: 'SlowBot',
      phaseIndex: 0,
      elapsedSeconds: 45,
    });
    expect(sentMessages).toHaveLength(3);
    expect(sentMessages[2]).toContain('Still working on SlowBot (45s)');

    // Heartbeat at t=60s — only 15s since last, throttled
    vi.advanceTimersByTime(15_000);
    emitExecutionProgress({
      executionId: 'exec-throttle',
      type: 'heartbeat',
      agentName: 'SlowBot',
      phaseIndex: 0,
      elapsedSeconds: 60,
    });
    expect(sentMessages).toHaveLength(3); // throttled

    // Heartbeat at t=75s — 30s since last heartbeat message, should go through
    vi.advanceTimersByTime(15_000);
    emitExecutionProgress({
      executionId: 'exec-throttle',
      type: 'heartbeat',
      agentName: 'SlowBot',
      phaseIndex: 0,
      elapsedSeconds: 75,
    });
    expect(sentMessages).toHaveLength(4);

    unsub();
  });
});
