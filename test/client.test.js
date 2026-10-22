import test from 'node:test';
import assert from 'node:assert/strict';

/** Minimal React surface: definitions are pure; the bubble only needs hooks. */
const reactMock = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useState(initial) {
    return [initial, () => {}];
  },
  useRef(initial) {
    return { current: initial };
  },
  useEffect() {},
  useSyncExternalStore() {
    return { active: 'zh', revision: 1 };
  },
  memo(component) {
    return component;
  },
};

function installDom() {
  const created = [];
  const head = {
    children: [],
    appendChild(node) {
      this.children.push(node);
    },
  };
  globalThis.document = {
    head,
    body: {
      appendChild() {},
    },
    createElement(tagName) {
      const node = {
        tagName,
        style: {},
        textContent: '',
        setAttribute() {},
        appendChild() {},
        remove() {},
      };
      created.push(node);
      return node;
    },
    querySelector() {
      return null;
    },
    execCommand() {
      return true;
    },
  };
  return { head, created };
}

async function loadClient() {
  let captured;
  globalThis.window = {
    __ModuleLoader__: {
      load(info) {
        captured = info;
      },
    },
  };
  await import('../client.js?client-test=' + Math.random().toString(36).slice(2));
  assert.ok(captured, 'client bundle should call the module loader');
  assert.equal(captured.id, 'dsh-parallel-sessions');
  return captured.factory((name) => {
    if (name === 'react') return reactMock;
    throw new Error(`unexpected module: ${name}`);
  });
}

function createHost() {
  const state = { renderers: [], definitions: [], touchedInjectKeys: [], opened: [] };
  const host = {
    ctx: {
      effect(callback) {
        const disposer = callback();
        return typeof disposer === 'function' ? disposer : () => {};
      },
      locale: {
        register() {
          return () => {};
        },
        subscribe() {
          return () => {};
        },
        getSnapshot() {
          return { active: 'zh', revision: 1 };
        },
        bind() {
          return (key) => key;
        },
      },
      slots: {
        inject(key, callback) {
          state.touchedInjectKeys.push(key);
          const disposer = callback();
          return typeof disposer === 'function' ? disposer : () => {};
        },
        register(options, component) {
          state.renderers.push({ options, component });
          return () => {};
        },
      },
      uiConversation: {
        events: {
          register(definition) {
            state.definitions.push(definition);
            return () => {};
          },
        },
      },
      uiWorkspace: {
        openSession(sessionId) {
          state.opened.push(sessionId);
        },
      },
    },
    state,
  };
  return host;
}

function relayEvent(overrides = {}) {
  return {
    type: 'user/message',
    seq: 10,
    time: 1000,
    data: {
      id: 'message-1',
      content: [{
        type: 'text',
        text: [
          '【跨会话消息 · 来自「设计评审」 ps_abcdefghij】',
          '意图：guide（设计方向指导）',
          '回信请用 parallel_message，session_id = ps_abcdefghij（接收方 UI 另行显示完整发起会话）。',
          '',
          '请把新模块的返回结构统一为 Result 包装。',
        ].join('\n'),
      }],
      source: {
        kind: 'agent-message',
        form: 'relay',
        producer: 'parallel-sessions',
        senderSessionId: 'session-sender',
        senderTitle: '设计评审',
        senderAlias: 'ps_abcdefghij',
        targetSessionId: 'session-target',
        intent: 'guide',
        summary: '请把新模块的返回结构统一为 Result 包装。',
        display: '请把新模块的返回结构统一为 Result 包装。',
        senderCallId: 'call-sender-1',
      },
    },
    ...overrides,
  };
}

function contextOf(definition, event, reader) {
  const match = { event, role: 'start', location: { kind: 'session' } };
  const context = {
    key: 'context-1',
    kind: definition.kind,
    id: 'message-1',
    matches: [match],
    start: match,
    state: undefined,
    current: new Map(),
  };
  const state = definition.start(context, match, reader);
  return { ...context, state };
}

function walk(node, visit) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  if (typeof node !== 'object') return;
  visit(node);
  walk(node.children, visit);
}

function textsOf(tree) {
  const out = [];
  walk(tree, (node) => {
    if (node.props && typeof node.children[0] === 'string') out.push(node.children[0]);
    if (node.props && typeof node.children[0] === 'object') {
      for (const child of node.children) if (typeof child === 'string') out.push(child);
    }
  });
  return out.join(' ');
}

function rendererOf(host, key) {
  const entry = host.state.renderers.find((renderer) => renderer.options.key === key);
  assert.ok(entry, `renderer ${key} should be registered`);
  return entry.component;
}

function findElement(tree, predicate) {
  let found = null;
  walk(tree, (node) => {
    if (found === null && predicate(node)) found = node;
  });
  return found;
}

test('client registers a compact in-chat bubble renderer and no composer dock', async () => {
  installDom();
  const client = await loadClient();
  const host = createHost();
  client.apply(host.ctx);

  const keys = host.state.renderers.map((renderer) => renderer.options.key);
  assert.ok(keys.includes('parallel-session-card'), 'receiver bubble renderer');
  assert.ok(keys.includes('parallel_message'), 'sender-side sent block renderer');
  assert.ok(!host.state.touchedInjectKeys.includes('conversation.input.dock'),
    'the fixed bottom dock must be gone');
  assert.equal(host.state.definitions.length, 1);
  assert.ok(host.state.touchedInjectKeys.includes('conversation.chat.node'));
  assert.ok(host.state.touchedInjectKeys.includes('tool.call.toolview'));
});

test('the definition claims only this plugin relay messages', async () => {
  installDom();
  const client = await loadClient();
  const host = createHost();
  client.apply(host.ctx);
  const definition = host.state.definitions[0];

  assert.equal(definition.target, 'chat');
  assert.deepEqual(definition.match(relayEvent()), {
    id: 'message-1',
    role: 'start',
    exclusive: true,
  });
  assert.equal(definition.match({ ...relayEvent(), type: 'assistant/message' }), null);
  assert.equal(definition.match({
    ...relayEvent(),
    data: { ...relayEvent().data, source: { ...relayEvent().data.source, producer: 'other-plugin' } },
  }), null);
  const replaced = relayEvent();
  replaced.surfaceOp = { op: 'replace', startSeq: 1, endSeq: 2 };
  assert.equal(definition.match(replaced), null);
});

test('the view node is a bubble-like context card that keeps sender attribution', async () => {
  installDom();
  const client = await loadClient();
  const host = createHost();
  client.apply(host.ctx);
  const definition = host.state.definitions[0];
  const reader = { previous: () => undefined };

  const node = definition.buildViewNode(contextOf(definition, relayEvent(), reader));
  assert.equal(node.kind, 'parallel-session-card');
  assert.equal(node.target, 'chat');
  assert.equal(node.anchorSeq, 10);
  assert.equal(node.groupTree, undefined);
  assert.equal(node.data.title, '设计评审');
  assert.equal(node.data.intent, 'guide');
  assert.equal(node.data.alias, 'ps_abcdefghij');
  assert.equal(node.data.body, '请把新模块的返回结构统一为 Result 包装。');
  assert.equal(node.data.display, '请把新模块的返回结构统一为 Result 包装。');
  assert.equal(node.data.senderCallId, 'call-sender-1');
  assert.equal(node.data.waking, false);
});

test('a follow-up message that woke the session is placed as Turn input', async () => {
  installDom();
  const client = await loadClient();
  const host = createHost();
  client.apply(host.ctx);
  const definition = host.state.definitions[0];
  const reader = {
    previous(kind) {
      if (kind !== 'inbox-next-turn') return undefined;
      return { state: { currentClaimed: new Set(['message-1']) } };
    },
  };
  const node = definition.buildViewNode(contextOf(definition, relayEvent(), reader));
  assert.equal(node.data.waking, true);
  assert.equal(node.groupTree, 'input');
});

test('the bubble renders body, sender link, continue status, time and copy button', async () => {
  installDom();
  const client = await loadClient();
  const host = createHost();
  client.apply(host.ctx);
  const definition = host.state.definitions[0];
  const node = definition.buildViewNode(contextOf(definition, relayEvent(), { previous: () => undefined }));
  const component = host.state.renderers[0].component;
  const tree = component({ node });

  const text = textsOf(tree);
  assert.match(text, /请把新模块的返回结构统一为 Result 包装/, 'bubble body');
  assert.match(text, /来自会话「设计评审」/, 'sender attribution');
  assert.match(text, /设计方向指导/, 'status label');

  const sender = findElement(tree, (element) => element.props && element.props.className === 'ps-card-sender');
  assert.ok(sender, 'sender element should exist');
  sender.props.onClick();
  assert.deepEqual(host.state.opened, ['session-sender'], 'sender click opens that session');

  const copy = findElement(tree, (element) => element.props && element.props.className === 'ps-card-copy');
  assert.ok(copy, 'copy button should sit after the sender row');
  assert.equal(copy.props['aria-label'], '复制');
  assert.ok(findElement(tree, (element) => element.props && element.props.className === 'ps-card-bubble'));
});

test('hold and release messages show whether the session continues', async () => {
  installDom();
  const client = await loadClient();
  const host = createHost();
  client.apply(host.ctx);
  const definition = host.state.definitions[0];
  const component = host.state.renderers[0].component;

  const cases = [
    ['hold', '已暂停 · 等待继续'],
    ['release', '已恢复 · 可以继续'],
    ['info', '信息同步'],
  ];
  for (const [intent, label] of cases) {
    const event = relayEvent();
    event.data.source = { ...event.data.source, intent };
    const node = definition.buildViewNode(contextOf(definition, event, { previous: () => undefined }));
    const text = textsOf(component({ node }));
    assert.match(text, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('the sender side renders a sent block with recipient and content only', async () => {
  installDom();
  const client = await loadClient();
  const host = createHost();
  client.apply(host.ctx);
  const SenderBlock = rendererOf(host, 'parallel_message');

  assert.equal(SenderBlock({ phase: 'start', block: {} }), null);
  const tree = SenderBlock({
    phase: 'result',
    block: {
      time: 1000,
      isError: false,
      meta: {
        acquired: true,
        targetTitle: '设计评审',
        targetAlias: 'ps_abcdefghij',
        intent: '信息同步',
        mode: 'steer',
        message: '请把新模块的返回结构统一为 Result 包装。',
      },
    },
  });
  const text = textsOf(tree);
  assert.match(text, /发给会话「设计评审」/);
  assert.match(text, /请把新模块的返回结构统一为 Result 包装/);
  assert.match(text, /已送达/);
  assert.doesNotMatch(text, /messageId|MESSAGE|已投递到会话/);

  const failed = SenderBlock({
    phase: 'result',
    block: { time: 1000, isError: true, meta: null },
  });
  assert.match(textsOf(failed), /跨会话消息发送失败/);
});
