import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EventBus } from '@earendil-works/pi-coding-agent';
import { BackgroundTaskRegistry, type BackgroundTaskContext } from '../../src/core/registry.js';
import * as extensionApi from '../../src/core/extension-api.js';

const V2_REQUEST_CHANNEL = 'pi-background-tasks:external-request:v2';
const V2_RESPONSE_CHANNEL = 'pi-background-tasks:external-response:v2';
const V2_CANCEL_CHANNEL = 'pi-background-tasks:external-cancel:v2';
const V2_TERMINAL_CHANNEL = 'pi-background-tasks:external-terminal:v2';
const V2_REQUEST_SCHEMA = 'pi-background-tasks.external-request.v2';
const V2_RESPONSE_SCHEMA = 'pi-background-tasks.external-response.v2';
const V2_CANCEL_SCHEMA = 'pi-background-tasks.external-cancel.v2';
const V2_TERMINAL_SCHEMA = 'pi-background-tasks.external-terminal.v2';

class MemoryEventBus implements EventBus {
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();

  emit(channel: string, data: unknown): void {
    for (const listener of [...(this.listeners.get(channel) ?? [])]) listener(data);
  }

  on(channel: string, handler: (data: unknown) => void): () => void {
    let listeners = this.listeners.get(channel);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(channel, listeners);
    }
    listeners.add(handler);
    return () => listeners?.delete(handler);
  }
}

interface V2Response {
  schema_version: typeof V2_RESPONSE_SCHEMA;
  request_id: string;
  operation: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), label);
  return value as Record<string, unknown>;
}

function isV2Response(value: unknown): value is V2Response {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return (
    response['schema_version'] === V2_RESPONSE_SCHEMA &&
    typeof response['request_id'] === 'string' &&
    typeof response['operation'] === 'string' &&
    typeof response['ok'] === 'boolean'
  );
}

function waitForResponse(bus: EventBus, requestId: string): Promise<V2Response> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for v2 response ${requestId}`));
    }, 300);
    const off = bus.on(V2_RESPONSE_CHANNEL, (value) => {
      assert.ok(isV2Response(value), 'v2 response');
      const response = value;
      if (response.request_id !== requestId) return;
      clearTimeout(timeout);
      off();
      resolve(response);
    });
  });
}

async function request(
  bus: EventBus,
  requestId: string,
  operation: string,
  payload: Record<string, unknown>,
): Promise<V2Response> {
  const response = waitForResponse(bus, requestId);
  bus.emit(V2_REQUEST_CHANNEL, {
    schema_version: V2_REQUEST_SCHEMA,
    request_id: requestId,
    operation,
    payload,
  });
  return response;
}

async function waitForTerminalCount(
  terminals: readonly Record<string, unknown>[],
  count: number,
): Promise<void> {
  const deadline = Date.now() + 500;
  while (terminals.length < count && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(terminals.length, count);
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-external-v2-'));
  const cwd = join(root, 'project');
  await mkdir(cwd, { recursive: true });
  const bus = new MemoryEventBus();
  let id = 0;
  let service: ReturnType<typeof extensionApi.installBackgroundTaskExtensionApi>;
  const registry = new BackgroundTaskRegistry({
    makeTaskId: () => `bexternal${String(++id)}`,
    sendCompletionNotification: () => {},
    publishTerminal: (task) => service.publishTerminal(task),
    stopWaitMs: 500,
  });
  const ctx: BackgroundTaskContext = {
    cwd,
    sessionId: 'external-v2',
    modelRegistry: { getAll: () => [] },
    model: undefined,
  };
  service = extensionApi.installBackgroundTaskExtensionApi({
    events: bus,
    registry,
    getContext: () => ctx,
    isShuttingDown: () => registry.isShuttingDown(),
  });
  return { root, bus, registry, service };
}

function ownerPayload(handshake: Record<string, unknown>): Record<string, unknown> {
  return {
    service_id: handshake['service_id'],
    owner_id: handshake['owner_id'],
    owner_token: handshake['owner_token'],
  };
}

async function handshake(bus: EventBus, ownerId: string): Promise<Record<string, unknown>> {
  const response = await request(bus, `handshake-${ownerId}`, 'handshake', {
    protocol_version: 2,
    owner_id: ownerId,
  });
  assert.equal(response.ok, true, response.error);
  const result = record(response.result, 'handshake result');
  assert.equal(result['api_version'], 2);
  assert.equal(result['owner_id'], ownerId);
  assert.equal(typeof result['service_id'], 'string');
  assert.equal(typeof result['owner_token'], 'string');
  return result;
}

void describe('domain-neutral external task EventBus v2', () => {
  void it('exports one closed v2 service and drives register/log/update/cancel/ack/settle/status/logs/terminal ordering', async () => {
    assert.equal(Reflect.get(extensionApi, 'BG_EXTERNAL_REQUEST_CHANNEL'), V2_REQUEST_CHANNEL);
    assert.equal(Reflect.get(extensionApi, 'BG_EXTERNAL_RESPONSE_CHANNEL'), V2_RESPONSE_CHANNEL);
    assert.equal(Reflect.get(extensionApi, 'BG_EXTERNAL_CANCEL_CHANNEL'), V2_CANCEL_CHANNEL);
    assert.equal(Reflect.get(extensionApi, 'BG_EXTERNAL_TERMINAL_CHANNEL'), V2_TERMINAL_CHANNEL);

    const h = await harness();
    const order: string[] = [];
    const terminals: Record<string, unknown>[] = [];
    const offResponses = h.bus.on(V2_RESPONSE_CHANNEL, (value) => {
      const response = record(value, 'response');
      order.push(`response:${String(response['request_id'])}`);
    });
    const offTerminals = h.bus.on(V2_TERMINAL_CHANNEL, (value) => {
      const terminal = record(value, 'terminal');
      assert.equal(terminal['schema_version'], V2_TERMINAL_SCHEMA);
      terminals.push(terminal);
      order.push('terminal');
    });
    try {
      const owner = await handshake(h.bus, 'owner-a');
      const auth = ownerPayload(owner);
      const registered = await request(h.bus, 'register', 'register', {
        ...auth,
        owner_ref: 'work-1',
        name: 'External work',
        description: 'generic external task',
        capabilities: { cancellable: true, rerunnable: false },
        notify_on_completion: false,
        trigger_on_completion: false,
      });
      assert.equal(registered.ok, true, registered.error);
      const registerResult = record(registered.result, 'register result');
      const task = record(registerResult['task'], 'registered task');
      const taskId = String(task['id']);
      assert.equal(task['status'], 'running');
      assert.deepEqual(task['owner'], { id: 'owner-a', ref: 'work-1' });
      assert.deepEqual(task['capabilities'], { cancellable: true, rerunnable: false });
      for (const forbidden of ['delegate', 'fusion', 'model', 'route', 'evidence', 'result', 'attestation']) {
        assert.equal(Object.hasOwn(task, forbidden), false, `snapshot leaked ${forbidden}`);
      }

      const logged = await request(h.bus, 'log-1', 'log', {
        ...auth,
        task_id: taskId,
        sequence: 1,
        text: 'phase one\n',
      });
      assert.equal(logged.ok, true, logged.error);
      const updated = await request(h.bus, 'update-2', 'update', {
        ...auth,
        task_id: taskId,
        sequence: 2,
        name: 'External work renamed',
        description: 'generic progress',
        capabilities: { cancellable: true, rerunnable: true },
      });
      assert.equal(updated.ok, true, updated.error);

      let cancellationWorkflow: Promise<void> | undefined;
      const offCancel = h.bus.on(V2_CANCEL_CHANNEL, (value) => {
        const cancel = record(value, 'cancel frame');
        assert.equal(cancel['schema_version'], V2_CANCEL_SCHEMA);
        assert.equal(cancel['task_id'], taskId);
        assert.equal(cancel['owner_id'], 'owner-a');
        assert.equal(cancel['owner_ref'], 'work-1');
        order.push('cancel');
        cancellationWorkflow = (async () => {
          const ack = await request(h.bus, 'ack-3', 'cancel_ack', {
            ...auth,
            task_id: taskId,
            sequence: 3,
            cancel_id: cancel['cancel_id'],
          });
          assert.equal(ack.ok, true, ack.error);
          const settled = await request(h.bus, 'settle-4', 'settle', {
            ...auth,
            task_id: taskId,
            sequence: 4,
            status: 'killed',
          });
          assert.equal(settled.ok, true, settled.error);
        })();
      });

      const killed = await request(h.bus, 'kill', 'kill', { ...auth, task_id: taskId });
      assert.equal(killed.ok, true, killed.error);
      await cancellationWorkflow;
      offCancel();
      await waitForTerminalCount(terminals, 1);
      const terminalTask = record(terminals[0]?.['task'], 'terminal task');
      assert.equal(terminalTask['id'], taskId);
      assert.equal(terminalTask['status'], 'killed');
      assert.ok(order.indexOf('cancel') < order.indexOf('response:ack-3'));
      assert.ok(order.indexOf('response:ack-3') < order.indexOf('response:settle-4'));
      assert.ok(order.indexOf('response:settle-4') < order.indexOf('response:kill'));
      assert.ok(order.indexOf('response:kill') < order.indexOf('terminal'));

      const status = await request(h.bus, 'status', 'status', { ...auth, task_id: taskId });
      assert.equal(status.ok, true, status.error);
      const statusTasks = record(status.result, 'status result')['tasks'];
      assert.ok(Array.isArray(statusTasks));
      assert.equal(record(statusTasks[0], 'status task')['status'], 'killed');

      const logs = await request(h.bus, 'logs', 'logs', {
        ...auth,
        task_id: taskId,
        max_bytes: 1024,
        tail: true,
      });
      assert.equal(logs.ok, true, logs.error);
      assert.match(String(record(logs.result, 'logs result')['text']), /phase one/);
    } finally {
      offResponses();
      offTerminals();
      h.service.beginShutdown();
      await h.service.drainRequests();
      h.service.close();
      await rm(h.root, { recursive: true, force: true });
    }
  });

  void it('rejects duplicate, unknown-owner, stale, out-of-order, malformed, and domain-bearing frames without mutation', async () => {
    const h = await harness();
    try {
      const owner = await handshake(h.bus, 'owner-b');
      const auth = ownerPayload(owner);
      const domainBearing = await request(h.bus, 'domain-register', 'register', {
        ...auth,
        owner_ref: 'bad',
        name: 'Bad',
        capabilities: { cancellable: true, rerunnable: false },
        notify_on_completion: false,
        trigger_on_completion: false,
        model: 'forbidden',
      });
      assert.equal(domainBearing.ok, false);
      assert.match(domainBearing.error ?? '', /unknown key model/);
      assert.equal(h.registry.allTasks().length, 0);

      const registered = await request(h.bus, 'register-good', 'register', {
        ...auth,
        owner_ref: 'good',
        name: 'Good',
        capabilities: { cancellable: true, rerunnable: false },
        notify_on_completion: false,
        trigger_on_completion: false,
      });
      assert.equal(registered.ok, true, registered.error);
      const taskId = String(record(record(registered.result, 'result')['task'], 'task')['id']);
      const before = h.registry.snapshot(h.registry.resolveTask(taskId));

      const duplicate = await request(h.bus, 'register-duplicate', 'register', {
        ...auth,
        owner_ref: 'good',
        name: 'Duplicate',
        capabilities: { cancellable: true, rerunnable: false },
        notify_on_completion: false,
        trigger_on_completion: false,
      });
      assert.equal(duplicate.ok, false);
      assert.match(duplicate.error ?? '', /already registered/);

      const outOfOrder = await request(h.bus, 'bad-sequence', 'log', {
        ...auth,
        task_id: taskId,
        sequence: 2,
        text: 'must not append',
      });
      assert.equal(outOfOrder.ok, false);
      assert.match(outOfOrder.error ?? '', /expected sequence 1/);

      const unknownOwner = await request(h.bus, 'unknown-owner', 'update', {
        ...auth,
        owner_id: 'missing-owner',
        task_id: taskId,
        sequence: 1,
        name: 'must not apply',
      });
      assert.equal(unknownOwner.ok, false);
      assert.match(unknownOwner.error ?? '', /unknown owner/);

      const stale = await request(h.bus, 'stale-service', 'update', {
        ...auth,
        service_id: 'stale-service',
        task_id: taskId,
        sequence: 1,
        name: 'must not apply',
      });
      assert.equal(stale.ok, false);
      assert.match(stale.error ?? '', /service_id mismatch/);

      const malformed = await request(h.bus, 'malformed-update', 'update', {
        ...auth,
        task_id: taskId,
        sequence: 1,
      });
      assert.equal(malformed.ok, false);
      assert.match(malformed.error ?? '', /at least one update field/);

      assert.deepEqual(h.registry.snapshot(h.registry.resolveTask(taskId)), before);
    } finally {
      h.service.beginShutdown();
      await h.service.drainRequests();
      h.service.close();
      await rm(h.root, { recursive: true, force: true });
    }
  });

  void it('keeps multiple external owners in one service, task namespace, and registry', async () => {
    const h = await harness();
    try {
      const ownerOne = await handshake(h.bus, 'owner-one');
      const ownerTwo = await handshake(h.bus, 'owner-two');
      assert.equal(ownerOne['service_id'], ownerTwo['service_id']);

      const registered: Array<{ owner: Record<string, unknown>; taskId: string }> = [];
      for (const [index, owner] of [ownerOne, ownerTwo].entries()) {
        const response = await request(h.bus, `multi-register-${String(index)}`, 'register', {
          ...ownerPayload(owner),
          owner_ref: `work-${String(index)}`,
          name: `External owner ${String(index)}`,
          capabilities: { cancellable: true, rerunnable: false },
          notify_on_completion: false,
          trigger_on_completion: false,
        });
        assert.equal(response.ok, true, response.error);
        const task = record(record(response.result, 'register result')['task'], 'registered task');
        registered.push({ owner, taskId: String(task['id']) });
      }

      assert.notEqual(registered[0]?.taskId, registered[1]?.taskId);
      assert.equal(h.registry.allTasks().length, 2);
      assert.deepEqual(
        h.registry.allTasks().map((task) => task.owner?.id).sort(),
        ['owner-one', 'owner-two'],
      );

      for (const [index, entry] of registered.entries()) {
        const settled = await request(h.bus, `multi-settle-${String(index)}`, 'settle', {
          ...ownerPayload(entry.owner),
          task_id: entry.taskId,
          sequence: 1,
          status: 'completed',
        });
        assert.equal(settled.ok, true, settled.error);
      }
      await h.registry.waitForTerminalPublications();
    } finally {
      h.service.beginShutdown();
      await h.service.drainRequests();
      h.service.close();
      await rm(h.root, { recursive: true, force: true });
    }
  });

  void it('enforces one service claim and keeps owner acknowledgement/settlement available during shutdown', async () => {
    const h = await harness();
    try {
      assert.throws(
        () =>
          extensionApi.installBackgroundTaskExtensionApi({
            events: h.bus,
            registry: h.registry,
            getContext: () => undefined,
            isShuttingDown: () => false,
          }),
        /already installed/,
      );

      const owner = await handshake(h.bus, 'owner-shutdown');
      const auth = ownerPayload(owner);
      const registered = await request(h.bus, 'shutdown-register', 'register', {
        ...auth,
        owner_ref: 'shutdown-work',
        name: 'Shutdown work',
        capabilities: { cancellable: true, rerunnable: false },
        notify_on_completion: false,
        trigger_on_completion: false,
      });
      assert.equal(registered.ok, true, registered.error);
      const taskId = String(record(record(registered.result, 'result')['task'], 'task')['id']);

      let ownerSettlement: Promise<void> | undefined;
      const offCancel = h.bus.on(V2_CANCEL_CHANNEL, (value) => {
        const cancel = record(value, 'shutdown cancel');
        ownerSettlement = (async () => {
          const ack = await request(h.bus, 'shutdown-ack', 'cancel_ack', {
            ...auth,
            task_id: taskId,
            sequence: 1,
            cancel_id: cancel['cancel_id'],
          });
          assert.equal(ack.ok, true, ack.error);
          const settle = await request(h.bus, 'shutdown-settle', 'settle', {
            ...auth,
            task_id: taskId,
            sequence: 2,
            status: 'killed',
          });
          assert.equal(settle.ok, true, settle.error);
        })();
      });

      h.registry.setShuttingDown(true);
      h.service.beginShutdown();
      await h.registry.stopTask(
        h.registry.resolveTask(taskId),
        'shutdown',
        'Killed during Pi session shutdown/reload',
      );
      await ownerSettlement;
      offCancel();
      await h.service.drainRequests();
      await h.registry.waitForTerminalPublications();
      h.service.close();
      assert.equal(h.registry.resolveTask(taskId).status, 'killed');
    } finally {
      await rm(h.root, { recursive: true, force: true });
    }
  });
});
