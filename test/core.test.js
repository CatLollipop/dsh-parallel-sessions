import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PairLimiter,
  buildRelaySource,
  clampText,
  formatHoldText,
  formatPeerMessageText,
  formatReleaseText,
  intentLabel,
  isMaskedPlaceholderId,
  isSessionAlias,
  makeLegacyAlias,
  makeSessionAlias,
  normalizeCwd,
  summarize,
} from '../lib/core.js';

test('session aliases are deterministic, distinct, and display-safe', () => {
  const first = makeSessionAlias('session-a4435ee0-6d1d-4a26-b471-ab45a515f789');
  const second = makeSessionAlias('session-a4435ee0-6d1d-4a26-b471-ab45a515f789');
  assert.equal(first, second);
  assert.match(first, /^cs_[0-9A-Za-z]{10}$/);
  assert.ok(isSessionAlias(first));
  assert.notEqual(first, makeSessionAlias('session-ffffffff-6d1d-4a26-b471-ab45a515f789'));
  // Must stay byte-identical with dsh-cross-session-approval so one alias works
  // for both tool families (reference taken from the live cross_session_list).
  assert.equal(first, 'cs_IgeMbLi2ku');
  const legacy = makeLegacyAlias('session-a4435ee0-6d1d-4a26-b471-ab45a515f789');
  assert.match(legacy, /^ps_[0-9A-Za-z]{10}$/);
  assert.notEqual(legacy, first);
  assert.equal(isSessionAlias(first), true);
  assert.equal(isSessionAlias(legacy), true);
});

test('masked placeholder ids are rejected while ordinary ids pass', () => {
  assert.equal(isMaskedPlaceholderId('session-00000000-0000-4000-8000-000000000000'), true);
  assert.equal(isMaskedPlaceholderId('session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'), true);
  assert.equal(isMaskedPlaceholderId('session-<masked>'), true);
  assert.equal(isMaskedPlaceholderId('session-a4435ee0-6d1d-4a26-b471-ab45a515f789'), false);
  assert.equal(isMaskedPlaceholderId('plain-id'), false);
});

test('clampText bounds UTF-8 bytes without breaking code points', () => {
  const text = '中文🙂'.repeat(100);
  const clamped = clampText(text, 50);
  assert.ok(Buffer.byteLength(clamped, 'utf8') <= 50);
  assert.equal(clamped.endsWith('…'), true);
  assert.equal(clampText('short', 100), 'short');
});

test('summarize collapses whitespace and truncates', () => {
  assert.equal(summarize('  a\n\n b  '), 'a b');
  assert.equal(summarize('x'.repeat(200), 20).length, 20);
});

test('normalizeCwd strips trailing separators', () => {
  assert.equal(normalizeCwd('/Users/a/project/'), '/Users/a/project');
  assert.equal(normalizeCwd('/Users/a/project'), '/Users/a/project');
  assert.equal(normalizeCwd(''), '');
});

test('relay source carries sender attribution fields the Chat relay renderer reads', () => {
  const source = buildRelaySource({
    senderSessionId: 'session-a',
    senderTitle: '设计评审',
    senderAlias: 'cs_abcdefghij',
    targetSessionId: 'session-b',
    intent: 'guide',
    summary: '接口调整',
    display: '请统一返回结构',
    senderCallId: 'call-1',
  });
  assert.equal(source.kind, 'agent-message');
  assert.equal(source.form, 'relay');
  assert.equal(source.producer, 'parallel-sessions');
  assert.equal(source.senderSessionId, 'session-a');
  assert.equal(source.senderTitle, '设计评审');
  assert.equal(source.intent, 'guide');
  assert.equal(source.display, '请统一返回结构');
  assert.equal(source.senderCallId, 'call-1');
});

test('peer message text names the sender and the reply alias', () => {
  const text = formatPeerMessageText({
    senderTitle: '设计评审',
    senderAlias: 'cs_abcdefghij',
    senderSessionId: 'session-a',
    intent: 'guide',
    message: '请把返回结构改成 Result 包装',
  });
  assert.match(text, /来自「设计评审」 cs_abcdefghij/);
  assert.match(text, /guide/);
  assert.match(text, /parallel_message/);
  assert.match(text, /Result 包装/);
});

test('hold and release notices carry holder attribution and next action', () => {
  const hold = formatHoldText({
    holderTitle: '接口重构',
    holderAlias: 'cs_holder0000',
    reason: '重构登录接口',
    impact: '联调阶段',
    clearedQueue: 2,
    autoRelease: true,
  });
  assert.match(hold, /暂停通知/);
  assert.match(hold, /接口重构/);
  assert.match(hold, /2 条待处理输入已清空/);
  assert.match(hold, /自动恢复/);
  const release = formatReleaseText({
    holderTitle: '接口重构',
    holderAlias: 'cs_holder0000',
    reason: '重构登录接口',
    note: '返回结构已改为 Result',
    auto: true,
  });
  assert.match(release, /恢复通知/);
  assert.match(release, /返回结构已改为 Result/);
  assert.equal(intentLabel('handoff'), 'handoff（任务交接/阶段衔接）');
});

test('PairLimiter enforces the rolling window and supports rollback', () => {
  const limiter = new PairLimiter(2, 60_000);
  const rollback = limiter.reserve('a', 'b');
  limiter.reserve('a', 'b');
  assert.throws(() => limiter.reserve('b', 'a'), /最多投递 2 条/);
  rollback();
  assert.doesNotThrow(() => limiter.reserve('b', 'a'));
});
