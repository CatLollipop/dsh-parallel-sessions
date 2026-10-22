import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { makeSessionAlias } from '../lib/core.js';

/** One deliverable live Agent stand-in with the runtime primitives the plugin probes. */
class FakeAgent {
  constructor(id, options = {}) {
    this.id = id;
    this.status = options.status ?? 'idle';
    this.session = {
      id,
      header: {
        version: 1,
        id,
        cwd: options.cwd ?? '/workspace',
        isSeeded: false,
        ...(options.header ?? {}),
      },
      events: [...(options.events ?? [])],
    };
    this.inbox = {
      nextTurn: Array.from({ length: options.queued ?? 0 }, (_, index) => ({ id: `queued-${index}` })),
      nextStep: [],
    };
    this.delivered = [];
    this.calls = [];
    this.cancelled = false;
  }

  followup(message) {
    this.calls.push({ mode: 'followup', message });
    this.delivered.push(message);
  }

  steer(message) {
    this.calls.push({ mode: 'steer', message });
    this.delivered.push(message);
  }

  inject(message) {
    this.calls.push({ mode: 'inject', message });
    this.delivered.push(message);
  }

  cancel(cause, options) {
    this.calls.push({ mode: 'cancel', cause, options });
    this.cancelled = true;
    this.status = 'idle';
    this.inbox.nextTurn = [];
  }
}

/**
 * Build a minimal Cordis-like host with the services the plugin resolves.
 * @param {object} [options] - fixture options.
 */
function createHost(options = {}) {
  const live = new Map();
  for (const agent of options.live ?? []) live.set(agent.id, agent);
  const titles = new Map(Object.entries(options.titles ?? {}));
  const records = options.records ?? [...live.values()].map((agent) => ({
    header: agent.session.header,
    live: true,
    persisted: true,
  }));
  const archived = new Set(options.archived ?? []);
  const tools = new Map();
  const effects = [];
  const listeners = new Map();
  const warnings = [];
  const sections = [];

  const agents = {
    list: () => [...live.values()],
    get: (id) => live.get(id),
    resume: async (resumeOptions) => {
      const id = resumeOptions.resumeSessionId;
      const record = records.find((entry) => entry.header.id === id);
      const agent = new FakeAgent(id, {
        status: 'idle',
        cwd: record?.header?.cwd ?? '/workspace',
        header: record?.header ?? {},
      });
      live.set(id, agent);
      effects.push(() => {
        live.delete(id);
      });
      return { agent, dispose: async () => { live.delete(id); } };
    },
  };

  const sessionQuery = {
    listSessions: async () => records,
    readTitleSnapshots: async (ids) => ids.map((id) => ({
      status: 'fulfilled',
      value: { session: { id }, title: { title: titles.get(id) ?? '' } },
    })),
    readSession: async (id) => {
      const record = records.find((entry) => entry.header.id === id);
      if (record === undefined) throw new Error(`SESSION_QUERY_SESSION_NOT_FOUND: ${id}`);
      return { session: record.header, events: [] };
    },
  };

  const services = {
    workspaceRegistry: { archivedSessionIds: [...archived] },
    sessionTitle: {
      get: (session) => ({ title: titles.get(session.id) ?? '' }),
    },
    workingDirectory: { get: (session) => session.header.cwd },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
    agentPresets: { mount: async () => {} },
    systemPrompt: {
      section: (section) => {
        sections.push(section);
        return () => {};
      },
    },
  };

  const ctx = {
    agents,
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    sessionQuery,
    logger: { warn: (message) => warnings.push(String(message)) },
    get: (name) => services[name],
    effect: (callback) => {
      const disposer = callback();
      if (typeof disposer === 'function') effects.push(disposer);
      return () => {};
    },
    on: (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => {};
    },
    interval: () => () => {},
    emit(event) {
      const args = [...arguments].slice(1);
      for (const handler of listeners.get(event) ?? []) handler(...args);
    },
  };

  apply(ctx, options.config ?? {});

  return {
    ctx,
    live,
    tools,
    warnings,
    sections,
    effects,
    async execute(name, args, callerId) {
      const tool = tools.get(name);
      assert.ok(tool, `tool ${name} should be registered`);
      const caller = live.get(callerId);
      assert.ok(caller, `caller ${callerId} should exist`);
      return tool.execute(args, { agent: caller, signal: undefined, callId: 'call-test' });
    },
    emitSessionEvent(sessionId, event) {
      ctx.emit('session/event', { id: sessionId }, event);
    },
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

function turnEvent(type, data) {
  return { type, seq: 1, time: Date.now(), data };
}

test('parallel_sessions lists live and cold sessions in the same workspace with aliases', async () => {
  const caller = new FakeAgent('session-caller', { status: 'running', cwd: '/workspace' });
  const peer = new FakeAgent('session-peer', { status: 'idle', cwd: '/workspace' });
  const cold = new FakeAgent('session-cold', { status: 'offline', cwd: '/workspace' });
  const otherWorkspace = new FakeAgent('session-other', { status: 'idle', cwd: '/elsewhere' });
  const subagent = new FakeAgent('session-child', {
    status: 'idle',
    cwd: '/workspace',
    header: { origin: 'subagent', delegationDepth: 1, parentSession: 'session-caller' },
  });
  const archived = new FakeAgent('session-archived', { status: 'idle', cwd: '/workspace' });
  const host = createHost({
    live: [caller, peer, otherWorkspace, subagent, archived],
    records: [caller, peer, cold, otherWorkspace, subagent, archived].map((agent) => ({
      header: agent.session.header,
      live: agent.status !== 'offline',
      persisted: true,
    })),
    archived: ['session-archived'],
    titles: {
      'session-caller': '主会话',
      'session-peer': '设计评审',
      'session-cold': '旧任务',
    },
  });

  const value = await host.execute('parallel_sessions', {}, 'session-caller');
  assert.equal(value.parallel, true);
  const ids = value.sessions.map((row) => row.sessionId).sort();
  assert.deepEqual(ids, ['session-caller', 'session-cold', 'session-peer']);
  const peerRow = value.sessions.find((row) => row.sessionId === 'session-peer');
  assert.equal(peerRow.title, '设计评审');
  assert.equal(peerRow.alias, makeSessionAlias('session-peer'));
  assert.equal(peerRow.status, 'idle');
  assert.equal(value.self.alias, makeSessionAlias('session-caller'));
});

test('parallel_message delivers an attributed relay card and steers a running target', async () => {
  const caller = new FakeAgent('session-caller', { status: 'running' });
  const peer = new FakeAgent('session-peer', { status: 'running' });
  const host = createHost({
    live: [caller, peer],
    titles: { 'session-caller': '接口组', 'session-peer': '设计评审' },
  });

  const value = await host.execute('parallel_message', {
    session_id: makeSessionAlias('session-peer'),
    message: '请把登录返回结构统一成 Result 包装',
    intent: 'guide',
  }, 'session-caller');

  assert.equal(value.accepted, true);
  assert.equal(value.mode, 'steer');
  assert.equal(peer.calls.length, 1);
  assert.equal(peer.calls[0].mode, 'steer');
  const message = peer.delivered[0];
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, 'agent-message');
  assert.equal(message.source.form, 'relay');
  assert.equal(message.source.senderSessionId, 'session-caller');
  assert.equal(message.source.senderTitle, '接口组');
  assert.equal(message.source.senderAlias, makeSessionAlias('session-caller'));
  assert.equal(message.source.intent, 'guide');
  assert.equal(message.source.display, '请把登录返回结构统一成 Result 包装');
  assert.equal(message.source.senderCallId, 'call-test');
  assert.match(message.content[0].text, /来自「接口组」/);
  assert.match(message.content[0].text, /设计方向指导/);
  assert.equal(typeof value.messageId, 'string');
  assert.equal(value.message, '请把登录返回结构统一成 Result 包装');
  const meta = host.tools.get('parallel_message').output.presentationMeta({}, value);
  assert.equal(meta.targetTitle, '设计评审');
  assert.equal(meta.targetAlias, makeSessionAlias('session-peer'));
  assert.equal(meta.message, value.message);
  assert.equal(meta.messageId, undefined);
});

test('parallel_message delivers directly to an idle target by default (no queue)', async () => {
  const caller = new FakeAgent('session-caller', { status: 'running' });
  const peer = new FakeAgent('session-peer', { status: 'idle' });
  const host = createHost({
    live: [caller, peer],
    titles: { 'session-caller': '接口组', 'session-peer': '设计评审' },
  });

  const value = await host.execute('parallel_message', {
    session_id: makeSessionAlias('session-peer'),
    message: '请统一返回结构',
  }, 'session-caller');

  assert.equal(value.accepted, true);
  assert.equal(value.mode, 'steer', 'default is immediate steer delivery, not followup queueing');
  assert.deepEqual(peer.calls.map((call) => call.mode), ['steer']);
});

test('parallel_message refuses self-targets, masked placeholders, and unknown aliases', async () => {
  const caller = new FakeAgent('session-caller', { status: 'running' });
  const host = createHost({ live: [caller], titles: { 'session-caller': '主会话' } });
  await assert.rejects(
    host.execute('parallel_message', { session_id: 'session-caller', message: 'hi' }, 'session-caller'),
    /不能给自己/,
  );
  await assert.rejects(
    host.execute('parallel_message', { session_id: 'session-00000000-0000-4000-8000-000000000000', message: 'hi' }, 'session-caller'),
    /占位符/,
  );
  await assert.rejects(
    host.execute('parallel_message', { session_id: 'ps_ZZZZZZZZZZ', message: 'hi' }, 'session-caller'),
    /找不到别名/,
  );
});

test('parallel_message cold-delivers by resuming the target session', async () => {
  const caller = new FakeAgent('session-caller', { status: 'running' });
  const coldHeader = {
    version: 1,
    id: 'session-cold',
    cwd: '/workspace',
    isSeeded: false,
    agentPreset: 'standard',
  };
  const host = createHost({
    live: [caller],
    records: [{ header: coldHeader, live: false, persisted: true }],
    titles: { 'session-caller': '主会话', 'session-cold': '旧任务' },
  });

  const value = await host.execute('parallel_message', {
    session_id: makeSessionAlias('session-cold'),
    message: '继续之前的任务',
  }, 'session-caller');

  assert.equal(value.accepted, true);
  assert.equal(value.resumed, true);
  assert.equal(value.mode, 'steer');
  const resumed = host.live.get('session-cold');
  assert.ok(resumed);
  assert.equal(resumed.delivered.length, 1);
  assert.equal(resumed.delivered[0].source.intent, 'info');
  assert.equal(resumed.delivered[0].source.display, '继续之前的任务');
});

test('parallel_hold stops the target turn and auto-releases on the holder turn end', async () => {
  const caller = new FakeAgent('session-caller', {
    status: 'running',
    events: [turnEvent('turn/start', { turn: 3 }), turnEvent('step/start', { turn: 3, step: 1 })],
  });
  const peer = new FakeAgent('session-peer', { status: 'running', queued: 2 });
  const host = createHost({
    live: [caller, peer],
    titles: { 'session-caller': '接口组', 'session-peer': '前端联调' },
  });

  const value = await host.execute('parallel_hold', {
    session_id: makeSessionAlias('session-peer'),
    reason: '我把登录接口返回结构改成 Result 包装',
    impact: '联调阶段',
  }, 'session-caller');

  assert.equal(value.held, true);
  assert.equal(value.canceled, true);
  assert.equal(value.clearedQueue, 2);
  assert.equal(value.until, 'holder-turn-end');
  assert.equal(peer.cancelled, true);
  assert.equal(peer.calls[0].mode, 'cancel');
  assert.equal(peer.calls[1].mode, 'followup');
  assert.equal(peer.delivered[0].source.intent, 'hold');
  assert.equal(peer.delivered[0].source.display, '我把登录接口返回结构改成 Result 包装 · 联调阶段');
  assert.equal(peer.delivered[0].source.senderCallId, 'call-test');
  assert.match(peer.delivered[0].content[0].text, /暂停通知/);

  const beforeRelease = await host.execute('parallel_sessions', {}, 'session-caller');
  assert.equal(beforeRelease.holds.length, 1);
  const peerRow = beforeRelease.sessions.find((row) => row.sessionId === 'session-peer');
  assert.equal(peerRow.pausedBy.title, '接口组');

  host.emitSessionEvent('session-caller', turnEvent('turn/end', { turn: 3, reason: { kind: 'completed' } }));
  await settle();

  assert.equal(peer.delivered.length, 2);
  assert.equal(peer.delivered[1].source.intent, 'release');
  assert.match(peer.delivered[1].content[0].text, /恢复通知/);
  const afterRelease = await host.execute('parallel_sessions', {}, 'session-caller');
  assert.equal(afterRelease.holds.length, 0);
});

test('parallel_hold with until=manual waits for parallel_release and only the holder may release', async () => {
  const caller = new FakeAgent('session-caller', {
    status: 'running',
    events: [turnEvent('turn/start', { turn: 2 })],
  });
  const peer = new FakeAgent('session-peer', { status: 'running' });
  const outsider = new FakeAgent('session-outsider', { status: 'idle' });
  const host = createHost({
    live: [caller, peer, outsider],
    titles: { 'session-caller': '接口组', 'session-peer': '前端联调', 'session-outsider': '旁观者' },
  });

  const hold = await host.execute('parallel_hold', {
    session_id: makeSessionAlias('session-peer'),
    reason: '阶段性改动',
    until: 'manual',
  }, 'session-caller');
  assert.equal(hold.until, 'manual');

  host.emitSessionEvent('session-caller', turnEvent('turn/end', { turn: 2, reason: { kind: 'completed' } }));
  await settle();
  assert.equal(peer.delivered.length, 1, 'manual hold must not auto-release');

  await assert.rejects(
    host.execute('parallel_release', { session_id: makeSessionAlias('session-peer') }, 'session-outsider'),
    /只有发起方可以恢复/,
  );

  const released = await host.execute('parallel_release', {
    session_id: makeSessionAlias('session-peer'),
    note: '接口已改完，请重新拉取',
  }, 'session-caller');
  assert.equal(released.released, true);
  assert.equal(released.delivered, true);
  assert.equal(peer.delivered.length, 2);
  assert.match(peer.delivered[1].content[0].text, /接口已改完/);
});

test('a second hold on the same target is rejected while a hold is active', async () => {
  const caller = new FakeAgent('session-caller', { status: 'running' });
  const peer = new FakeAgent('session-peer', { status: 'idle' });
  const host = createHost({
    live: [caller, peer],
    titles: { 'session-caller': '接口组', 'session-peer': '前端联调' },
  });

  await host.execute('parallel_hold', {
    session_id: makeSessionAlias('session-peer'),
    reason: '第一次暂停',
  }, 'session-caller');
  await assert.rejects(
    host.execute('parallel_hold', {
      session_id: makeSessionAlias('session-peer'),
      reason: '第二次暂停',
    }, 'session-caller'),
    /已被会话/,
  );
});

test('the pair limiter blocks a message flood between two sessions', async () => {
  const caller = new FakeAgent('session-caller', { status: 'running' });
  const peer = new FakeAgent('session-peer', { status: 'idle' });
  const host = createHost({
    live: [caller, peer],
    titles: { 'session-caller': 'A', 'session-peer': 'B' },
  });

  for (let index = 0; index < 10; index += 1) {
    await host.execute('parallel_message', {
      session_id: makeSessionAlias('session-peer'),
      message: `消息 ${index}`,
    }, 'session-caller');
  }
  await assert.rejects(
    host.execute('parallel_message', {
      session_id: makeSessionAlias('session-peer'),
      message: '第 11 条',
    }, 'session-caller'),
    /最多投递 10 条/,
  );
});

test('the guidance section is registered and only contributes when parallel sessions exist', async () => {
  const caller = new FakeAgent('session-caller', { status: 'running' });
  const peer = new FakeAgent('session-peer', { status: 'idle' });
  const host = createHost({
    live: [caller, peer],
    titles: { 'session-caller': '主会话', 'session-peer': '设计评审' },
  });
  assert.equal(host.sections.length, 1);
  const section = host.sections[0];
  assert.equal(section.name, 'parallel-sessions:coordination');
  const withPeer = section.text({ agent: caller });
  assert.match(withPeer, /并行会话协调/);
  assert.match(withPeer, /设计评审/);

  const soloHost = createHost({
    live: [new FakeAgent('session-solo', { status: 'running' })],
    titles: { 'session-solo': '单独会话' },
  });
  assert.equal(soloHost.sections[0].text({ agent: soloHost.live.get('session-solo') }), '');
});
