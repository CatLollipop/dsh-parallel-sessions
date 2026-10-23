/**
 * dsh-parallel-sessions — cross-session coordination for parallel tasks.
 *
 * Host half. Four tools are registered into the shared `tools` registry:
 *
 *   - parallel_sessions  detect parallel sessions (aliases, titles, status,
 *                        hold relations) so an agent can decide to coordinate;
 *   - parallel_message   deliver one attributed relay message (the receiving
 *                        Chat renders the sender from the durable source and
 *                        the Client dock names the sender);
 *   - parallel_hold      declare that this task will change another task's
 *                        phase, stop that session's running turn, and wait for
 *                        release;
 *   - parallel_release   resume a paused session and deliver the continuation
 *                        notice with the change summary.
 *
 * A hold with `until: 'holder-turn-end'` is released automatically when the
 * holder's current turn ends through `session/event` (`turn/end`), which is the
 * "wait for this task to finish, then tell the other session to continue"
 * behavior. `until: 'manual'` waits for `parallel_release`.
 *
 * Delivery uses the runtime Agent delivery primitives (`followup`, `steer`,
 * `inject`) and, for a cold target, the public `agents.resume` path. The
 * plugin never fakes an Inbox event: every message is a real durable
 * `user/message` built with a stable identity, and the target's own turn
 * machinery claims it.
 *
 * @module dsh-parallel-sessions
 */
import { randomUUID } from 'node:crypto';
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
  makeHoldId,
  makeLegacyAlias,
  makeSessionAlias,
  normalizeCwd,
  pickEnum,
  summarize,
} from './core.js';

/** Plugin runtime name. */
export const name = 'dsh-parallel-sessions';

/**
 * Hard dependencies. Optional services (`workspaceRegistry`, `sessionTitle`,
 * `systemPrompt`, `agentDefaultModel`, `agentPresets`, `workingDirectory`) are
 * resolved with `ctx.get()` so the plugin still loads in lean compositions.
 */
export const inject = ['tools', 'agents', 'sessionQuery'];

const DEFAULTS = {
  /** Register the concise coordination guidance section when parallel sessions exist. */
  guide: true,
  /** Release `holder-turn-end` holds when the holder's turn ends. */
  autoReleaseOnTurnEnd: true,
  /** Cancel a running target turn when it is paused. */
  holdCancel: true,
  /** Maximum recorded holds per process. */
  maxHolds: 8,
  /** Pair delivery window limit. */
  pairMessageLimit: 10,
  /** Pair delivery window. */
  pairWindowMs: 60_000,
  /** Maximum UTF-8 bytes of one message body. */
  maxTextBytes: 32 * 1024,
};

const INTENTS = ['info', 'guide', 'handoff'];
const MESSAGE_MODES = ['steer', 'queue', 'inject'];
const HOLD_UNTIL = ['holder-turn-end', 'manual'];

/** Eagerly freeze a message so later mutation cannot fork the durable value. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * Build one durable user message. Mirrors `createUserMessage` from
 * `@deepseek-ai/dsh-llm` without a static import: a link/bundle without the
 * host package on its resolution path must still load.
 * @param {{ content: Array<{type: 'text', text: string}>, source: object }} input - role payload.
 * @returns {object} frozen user message with a fresh identity.
 */
function makeUserMessage(input) {
  return deepFreeze(structuredClone({ ...input, id: randomUUID(), role: 'user' }));
}

/**
 * @param {object} ctx - Cordis plugin context.
 * @param {object} [config] - bundle row config.
 */
export function apply(ctx, config) {
  const cfg = { ...DEFAULTS };
  if (config !== null && typeof config === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      const value = config[key];
      if (value === undefined) continue;
      if (typeof value === typeof DEFAULTS[key] && typeof value !== 'object') cfg[key] = value;
    }
  }
  const pairLimiter = new PairLimiter(cfg.pairMessageLimit, cfg.pairWindowMs);
  /** @type {Map<string, object>} holdId -> hold */
  const holds = new Map();
  /** @type {Map<string, string>} targetSessionId -> holdId */
  const holdByTarget = new Map();
  let disposed = false;

  const agents = ctx.agents;
  const tools = ctx.tools;
  const sessionQuery = ctx.sessionQuery;

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`[dsh-parallel-sessions] ${message}`);
    } catch {
      /* logging must never break a turn */
    }
  };

  ctx.effect(() => async () => {
    // Best effort: never leave a target paused because this plugin unloaded or
    // reloaded. Delivery is synchronous here; a cold target keeps the hold
    // notice it already received and is resumed by its user manually.
    for (const hold of [...holds.values()]) {
      try {
        const live = agents.get(hold.targetId);
        if (live !== undefined && typeof live.followup === 'function') {
          const text = formatReleaseText({
            holderTitle: hold.holderTitle,
            holderAlias: hold.holderAlias,
            reason: hold.reason,
            note: '并行会话协调插件已卸载/重载，暂停自动解除',
            auto: true,
          });
          live.followup(makeUserMessage({
            content: [{ type: 'text', text }],
            source: buildRelaySource({
              senderSessionId: hold.holderId,
              senderTitle: hold.holderTitle,
              senderAlias: hold.holderAlias,
              targetSessionId: hold.targetId,
              intent: 'release',
              summary: '插件卸载，暂停自动解除',
              display: '并行会话协调插件已卸载/重载，暂停自动解除',
            }),
          }));
        }
      } catch (error) {
        warn(`卸载时解除暂停失败：${String(error)}`);
      }
    }
    holds.clear();
    holdByTarget.clear();
    disposed = true;
  }, 'dsh-parallel-sessions: teardown');

  ctx.on('agent/disposed', ({ agent } = {}) => {
    const id = typeof agent?.id === 'string' ? agent.id : '';
    if (id !== '') handleAgentGone(id);
  });

  ctx.on('session/disposed', (session) => {
    const id = typeof session?.id === 'string' ? session.id : '';
    if (id !== '') handleAgentGone(id);
  });

  ctx.on('session/event', (session, event) => {
    if (disposed || cfg.autoReleaseOnTurnEnd !== true) return;
    if (event?.type !== 'turn/end') return;
    const sessionId = typeof session?.id === 'string' ? session.id : '';
    if (sessionId === '') return;
    const turn = typeof event.data?.turn === 'number' ? event.data.turn : Number.POSITIVE_INFINITY;
    for (const hold of [...holds.values()]) {
      if (hold.until !== 'holder-turn-end') continue;
      if (hold.holderId !== sessionId) continue;
      if (hold.holderTurn !== undefined && turn < hold.holderTurn) continue;
      void releaseHold(hold, { auto: true, note: '' }).catch((error) => {
        warn(`自动恢复会话失败：${String(error)}`);
      });
    }
  });

  // ── workspace / session helpers ──────────────────────────────────────────

  /** @param {unknown} session - live Session. @returns {object|undefined} header. */
  function headerOfSession(session) {
    const header = session?.header;
    return header !== null && typeof header === 'object' ? header : undefined;
  }

  /** @param {unknown} header - session header. @returns {boolean} */
  function isSubagentSession(header) {
    return header?.origin === 'subagent'
      || (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0);
  }

  /** @returns {Set<string>} archived session ids, when the registry is present. */
  function archivedIds() {
    try {
      const registry = ctx.get('workspaceRegistry');
      const list = registry?.archivedSessionIds;
      return Array.isArray(list) ? new Set(list.map((id) => String(id))) : new Set();
    } catch {
      return new Set();
    }
  }

  /** @param {object} agent - caller agent. @returns {string} effective working directory. */
  function cwdOf(agent) {
    try {
      const header = headerOfSession(agent?.session);
      if (typeof header?.cwd === 'string' && header.cwd !== '') return header.cwd;
    } catch {
      /* fall through */
    }
    try {
      const workingDirectory = ctx.get('workingDirectory');
      if (workingDirectory !== undefined && agent?.session !== undefined) {
        const directory = workingDirectory.get(agent.session);
        if (typeof directory === 'string' && directory !== '') return directory;
      }
    } catch {
      /* fall through */
    }
    return '';
  }

  /** @param {object} agent - live agent. @returns {string} display title. */
  function titleOf(agent) {
    try {
      const titles = ctx.get('sessionTitle');
      const snapshot = titles?.get?.(agent.session);
      const title = typeof snapshot === 'string' ? snapshot : snapshot?.title;
      if (typeof title === 'string' && title.trim() !== '') return title.trim();
    } catch {
      /* fall through */
    }
    const id = typeof agent?.id === 'string' ? agent.id : '';
    return id === '' ? '(未命名会话)' : `会话 ${makeSessionAlias(id)}`;
  }

  /**
   * Current turn number from the caller's session log, used to bound automatic
   * release to the turn that created the hold.
   * @param {unknown} session - live Session.
   * @returns {number|undefined} turn number.
   */
  function currentTurnOf(session) {
    const events = session?.events;
    if (!Array.isArray(events)) return undefined;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type === 'turn/start' && typeof event.data?.turn === 'number') return event.data.turn;
    }
    return undefined;
  }

  /** @param {unknown} session - live Session. @returns {number} pending inbox message count. */
  function pendingCountOf(agent) {
    try {
      const inbox = agent?.inbox;
      const nextTurn = Array.isArray(inbox?.nextTurn) ? inbox.nextTurn.length : 0;
      const nextStep = Array.isArray(inbox?.nextStep) ? inbox.nextStep.length : 0;
      return nextTurn + nextStep;
    } catch {
      return 0;
    }
  }

  /** @param {object} agent - caller agent. @returns {string} caller session id. */
  function requireCaller(exec) {
    const agent = exec?.agent;
    if (agent === undefined || agent === null || typeof agent.id !== 'string' || agent.id === '') {
      throw new Error('无法确定调用者会话：exec.agent 缺失。');
    }
    if (isSubagentSession(headerOfSession(agent.session))) {
      throw new Error('子代理会话不能使用并行会话协调工具；请由顶层会话协调。');
    }
    return agent;
  }

  /**
   * Enumerate live and persisted sessions for alias resolution.
   * @returns {Promise<Map<string, {header?: object, live?: object}>>} id -> record.
   */
  async function collectSessionIndex() {
    const index = new Map();
    for (const agent of agents.list()) {
      if (typeof agent?.id !== 'string') continue;
      index.set(agent.id, { ...(index.get(agent.id) ?? {}), live: agent, header: headerOfSession(agent.session) });
    }
    try {
      const records = await sessionQuery.listSessions();
      for (const record of records ?? []) {
        const header = record?.header ?? record;
        const id = header?.id;
        if (typeof id !== 'string' || id === '') continue;
        const existing = index.get(id) ?? {};
        index.set(id, { ...existing, header: existing.header ?? header });
      }
    } catch (error) {
      warn(`会话列表读取失败，别名解析退化为当前活动会话：${String(error)}`);
    }
    return index;
  }

  /**
   * Resolve one tool-supplied session reference and enforce the coordination
   * contract: top-level, not archived, in the caller's workspace.
   *
   * @param {object} caller - caller agent.
   * @param {unknown} rawRef - alias or real session id.
   * @returns {Promise<{id: string, alias: string, title: string, status: string, live?: object, header?: object}>} target.
   */
  async function resolveTarget(caller, rawRef) {
    if (typeof rawRef !== 'string' || rawRef.trim() === '') throw new Error('session_id 不能为空。');
    const ref = rawRef.trim();
    if (isMaskedPlaceholderId(ref)) {
      throw new Error('该 session_id 看起来是显示链路遮蔽后的占位符；请改用 parallel_sessions 返回的 cs_ 别名。');
    }
    const index = await collectSessionIndex();
    let id = ref;
    if (isSessionAlias(ref)) {
      // cs_ is the shared namespace with dsh-cross-session-approval; ps_ is the
      // legacy namespace of earlier releases of this plugin only.
      const legacy = ref.startsWith('ps_');
      const matches = [...index.keys()].filter((candidate) => (
        legacy ? makeLegacyAlias(candidate) : makeSessionAlias(candidate)
      ) === ref);
      if (matches.length === 0) {
        throw new Error(`找不到别名 ${ref} 对应的会话；请先调用 parallel_sessions 获取最新 cs_ 别名（旧 ps_ 别名仅本插件接受，不能用于 cross_session_* 工具）。`);
      }
      if (matches.length > 1) throw new Error(`别名 ${ref} 存在歧义（${matches.length} 个会话）；请使用真实会话 ID。`);
      id = matches[0];
    }
    const entry = index.get(id);
    const live = entry?.live ?? agents.get(id);
    let header = entry?.header ?? headerOfSession(live?.session);
    if (header === undefined) {
      try {
        const snapshot = await sessionQuery.readSession(id);
        header = snapshot?.session;
      } catch {
        throw new Error(`会话不存在或无法读取：${ref}`);
      }
    }
    if (isSubagentSession(header)) throw new Error('目标会话是子代理，不能用于并行会话协调。');
    if (archivedIds().has(id)) throw new Error('目标会话已归档；请先取消归档（用户操作）后再协调。');
    const callerCwd = normalizeCwd(cwdOf(caller));
    const targetCwd = normalizeCwd(header?.cwd ?? cwdOf(live));
    if (callerCwd !== '' && targetCwd !== '' && callerCwd !== targetCwd) {
      throw new Error(`目标会话位于其他工作区（${targetCwd}），本插件只协调同一工作区内的并行会话。`);
    }
    return {
      id,
      alias: makeSessionAlias(id),
      title: live !== undefined ? titleOf(live) : await titleOfCold(id, header),
      status: live === undefined ? 'offline' : String(live.status ?? 'idle'),
      ...(live === undefined ? {} : { live }),
      ...(header === undefined ? {} : { header }),
    };
  }

  /**
   * Title for a session that is not live; never throws.
   * @param {string} id - session id.
   * @param {object} [header] - known header.
   * @returns {Promise<string>} title.
   */
  async function titleOfCold(id, header) {
    try {
      const results = await sessionQuery.readTitleSnapshots([id]);
      const result = Array.isArray(results) ? results[0] : undefined;
      const value = result?.status === 'rejected' ? undefined : result?.value;
      const title = typeof value?.title === 'string' ? value.title : value?.title?.title;
      if (typeof title === 'string' && title.trim() !== '') return title.trim();
    } catch {
      /* fall through */
    }
    return `会话 ${makeSessionAlias(id)}`;
  }

  /**
   * Resolve the delivery agent for one target.
   *
   * Deliberately strict: this plugin never creates, resumes, or wakes a
   * session. Only sessions that are live right now (running or idle) can be
   * addressed; an offline session must be opened by the user first.
   *
   * @param {{id: string, live?: object, header?: object}} target - resolved target.
   * @param {AbortSignal|undefined} signal - caller cancellation.
   * @returns {{agent: object, resumed: boolean}} delivery agent.
   */
  function ensureDeliveryAgent(target, signal) {
    if (signal?.aborted === true) throw new Error('调用已取消，未投递消息。');
    if (target.live === undefined) {
      throw new Error('目标会话当前未活动（offline）。本插件不创建、不唤醒会话，只能与正在运行的会话沟通；请先在界面中打开该会话。');
    }
    if (typeof target.live.followup !== 'function') {
      throw new Error('目标 Agent 未暴露投递原语，无法投递消息。');
    }
    // Never resume/wake: delivery primitives are used on the live agent only.
    return { agent: target.live, resumed: false };
  }

  /**
   * Deliver one built message with the requested mode.
   * @param {object} agent - target agent.
   * @param {object} message - frozen user message.
   * @param {'followup'|'steer'|'inject'} mode - delivery mode.
   * @returns {'followup'|'steer'|'inject'} mode actually used.
   */
  function deliverNow(agent, message, mode) {
    if (mode === 'inject') {
      if (typeof agent.inject !== 'function') throw new Error('目标 Agent 不支持 inject；请改用 queue。');
      agent.inject(message);
      return 'inject';
    }
    if (mode === 'steer') {
      if (typeof agent.steer !== 'function') throw new Error('目标 Agent 不支持 steer；请改用 queue。');
      agent.steer(message);
      return 'steer';
    }
    if (typeof agent.followup !== 'function') throw new Error('目标 Agent 不支持 followup，无法投递消息。');
    agent.followup(message);
    return 'followup';
  }

  /**
   * Build and deliver one relay message.
   *
   * @param {object} options - delivery options.
   * @param {object} options.caller - sender agent.
   * @param {{id: string, alias: string, title: string, status: string, live?: object, header?: object}} options.target - target.
   * @param {string} options.text - model-facing body.
   * @param {string} options.intent - intent tag.
   * @param {'auto'|'followup'|'steer'|'inject'} options.mode - delivery mode.
   * @param {AbortSignal|undefined} options.signal - caller cancellation.
   * @returns {Promise<{mode: string, messageId: string, resumed: boolean}>} delivery receipt.
   */
  async function deliverRelay(options) {
    const { caller, target, text, intent, signal } = options;
    const senderId = String(caller.id);
    const senderAlias = makeSessionAlias(senderId);
    const senderTitle = titleOf(caller);
    const source = buildRelaySource({
      senderSessionId: senderId,
      senderTitle,
      senderAlias,
      targetSessionId: target.id,
      intent,
      summary: typeof options.summary === 'string' && options.summary !== ''
        ? summarize(options.summary, 120)
        : summarize(text.replace(/^【[^\n]*】\n?/, ''), 120),
      ...(typeof options.display === 'string' && options.display !== ''
        ? { display: clampText(options.display, 4000) }
        : {}),
      ...(typeof options.senderCallId === 'string' && options.senderCallId !== ''
        ? { senderCallId: options.senderCallId }
        : {}),
    });
    const message = makeUserMessage({
      content: [{ type: 'text', text }],
      source,
    });
    const rollback = pairLimiter.reserve(senderId, target.id);
    try {
      const delivery = ensureDeliveryAgent(target, signal);
      let mode = options.mode;
      if (mode === 'auto') mode = target.status === 'running' ? 'steer' : 'followup';
      const used = deliverNow(delivery.agent, message, mode);
      return { mode: used, messageId: String(message.id), resumed: delivery.resumed };
    } catch (error) {
      rollback();
      throw error;
    }
  }

  /**
   * Release one hold and notify the target to continue. Idempotent and safe to
   * call from the turn/end listener: the hold leaves the maps before delivery.
   *
   * @param {object} hold - hold record.
   * @param {object} options - release options.
   * @param {string} [options.note] - change summary.
   * @param {boolean} options.auto - automatic release.
   * @returns {Promise<object>} release receipt.
   */
  async function releaseHold(hold, options) {
    if (holds.get(hold.id) !== hold) return { released: false, holdId: hold.id };
    holds.delete(hold.id);
    holdByTarget.delete(hold.targetId);
    const receipt = {
      released: true,
      holdId: hold.id,
      target: { sessionId: hold.targetId, alias: hold.targetAlias, title: hold.targetTitle },
      delivered: false,
      resumed: false,
      error: '',
    };
    if (disposed) {
      receipt.error = '插件已卸载，未投递恢复通知。';
      return receipt;
    }
    try {
      const text = formatReleaseText({
        holderTitle: hold.holderTitle,
        holderAlias: hold.holderAlias,
        reason: hold.reason,
        note: options.note ?? '',
        auto: options.auto === true,
      });
      const liveTarget = agents.get(hold.targetId);
      const target = {
        id: hold.targetId,
        alias: hold.targetAlias,
        title: liveTarget === undefined ? hold.targetTitle : titleOf(liveTarget),
        status: liveTarget === undefined ? 'offline' : String(liveTarget.status ?? 'idle'),
        ...(liveTarget === undefined ? {} : { live: liveTarget }),
        ...(hold.targetHeader === undefined ? {} : { header: hold.targetHeader }),
      };
      const display = options.note !== undefined && options.note !== ''
        ? options.note
        : `暂停已解除：${hold.reason}`;
      const delivery = await deliverRelay({
        caller: hold.holderAgent,
        target,
        text,
        intent: 'release',
        mode: 'followup',
        signal: undefined,
        summary: display,
        display,
        senderCallId: options.senderCallId,
      });
      receipt.delivered = true;
      receipt.mode = delivery.mode;
    } catch (error) {
      receipt.error = String(error?.message ?? error);
      warn(`恢复会话 ${hold.targetAlias} 失败：${receipt.error}`);
    }
    return receipt;
  }

  /**
   * Drop/release every hold owned by a disposed agent, drop holds targeting
   * it, and dispose its cached handle.
   * @param {string} sessionId - disposed agent/session id.
   */
  function handleAgentGone(sessionId) {
    for (const hold of [...holds.values()]) {
      if (hold.holderId === sessionId) {
        void releaseHold(hold, { auto: true, note: '发起会话已结束' }).catch((error) => {
          warn(`发起会话结束时恢复目标失败：${String(error)}`);
        });
      } else if (hold.targetId === sessionId) {
        holds.delete(hold.id);
        holdByTarget.delete(hold.targetId);
      }
    }
  }

  // ── tools ────────────────────────────────────────────────────────────────

  /**
   * Raw object schema helper (the registry accepts this JSON Schema subset).
   * @param {Record<string, object>} properties - property schemas.
   * @param {string[]} required - required property names.
   * @returns {object} raw parameter schema.
   */
  function params(properties, required) {
    return {
      type: 'object',
      properties,
      ...(required.length === 0 ? {} : { required }),
    };
  }

  /**
   * Canonical-value contract: unconstrained JSON, rendered as text.
   * @param {(value: object) => string} renderText - pure text projection.
   * @returns {object} output declaration.
   */
  function output(renderText) {
    return {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: renderText(value) }],
    };
  }

  /**
   * Extract the latest snapshot of one session in one line for the session list.
   * @param {object} row - peer row.
   * @returns {string} display line.
   */
  function peerLine(row) {
    const tags = [];
    if (row.self === true) tags.push('你');
    if (row.status === 'running') tags.push('运行中');
    else if (row.status === 'idle') tags.push('空闲');
    else tags.push('未加载');
    if (row.pausedBy !== undefined) tags.push(`被「${row.pausedBy.title}」暂停`);
    if (row.holding !== undefined) tags.push(`暂停了「${row.holding.title}」`);
    return `- ${row.alias} 「${row.title}」 ${tags.join(' · ')}`;
  }

  // Tool bodies need the real execution context, so build them with closures
  // over `ctx` instead of defining placeholder methods above.
  const sessionsTool = {
    name: 'parallel_sessions',
    description:
      '检测当前进程中与你在同一工作区并行运行或曾运行过的顶层会话（别名/标题/运行状态/暂停关系），用于决定是否需要跨会话协调。' +
      '返回 cs_ 别名后，用 parallel_message 沟通、parallel_hold 暂停、parallel_release 恢复。cs_ 别名与 cross_session_* 工具通用；旧版 ps_ 别名仅本插件接受。' +
      '硬限制：本插件不创建新会话、不恢复/唤醒离线会话，只能与当前正在活动的会话（running/idle）沟通。' +
      '默认仅同一工作区、排除归档会话与子代理；include_offline=false 只看已加载会话。',
    parameters: params({
      include_offline: { type: 'boolean', description: '是否列出未加载的离线会话（仅供查看，不可沟通）。默认 false。' },
      all_workspaces: { type: 'boolean', description: '是否跨工作区列出。默认 false；跨工作区会话不可被协调工具操作。' },
    }, []),
    output: output((value) => {
      const lines = [`并行会话检测：共 ${value.total} 个顶层会话，其中 ${value.liveCount} 个已加载${value.parallel ? '（存在并行会话）' : '（当前没有其他活动会话）'}。`];
      for (const row of value.sessions) lines.push(peerLine(row));
      if (value.holds.length > 0) {
        lines.push('暂停关系：');
        for (const hold of value.holds) {
          lines.push(`- ${hold.holderAlias} 「${hold.holderTitle}」 ⇢ ${hold.targetAlias} 「${hold.targetTitle}」：${hold.reason}（${hold.until === 'manual' ? '手动恢复' : '发起方本轮结束后自动恢复'}）`);
        }
      }
      lines.push('提示：接收方会话内会显示消息发起方；需要暂停其他任务时使用 parallel_hold。本插件不会创建或唤醒会话，只能与已加载的活动会话沟通；离线会话需先在界面打开。cs_ 别名同时适用于 parallel_* 与 cross_session_* 工具，旧版 ps_ 别名仅 parallel_* 接受。');
      return lines.join('\n');
    }),
    presentCall: () => ({ card: 'generic', title: '检测并行会话', kind: 'other' }),
    presentResult: () => ({ card: 'generic', title: '并行会话检测' }),
    async execute(args, exec) {
      const caller = requireCaller(exec);
      const includeOffline = args?.include_offline === true;
      const allWorkspaces = args?.all_workspaces === true;
      const archived = archivedIds();
      const callerCwd = normalizeCwd(cwdOf(caller));
      const index = await collectSessionIndex();
      const rows = [];
      const titleIds = [];
      for (const [id, entry] of index) {
        if (archived.has(id)) continue;
        const live = entry.live;
        const header = entry.header ?? headerOfSession(live?.session);
        if (isSubagentSession(header)) continue;
        const status = live === undefined ? 'offline' : String(live.status ?? 'idle');
        if (!includeOffline && status === 'offline') continue;
        const recordCwd = normalizeCwd(header?.cwd ?? (live === undefined ? '' : cwdOf(live)));
        if (!allWorkspaces && callerCwd !== '' && recordCwd !== '' && recordCwd !== callerCwd) continue;
        const self = id === caller.id;
        const holdId = holdByTarget.get(id);
        const hold = holdId === undefined ? undefined : holds.get(holdId);
        const holderHold = [...holds.values()].find((candidate) => candidate.holderId === id);
        const row = {
          sessionId: id,
          alias: makeSessionAlias(id),
          title: live !== undefined ? titleOf(live) : '',
          status,
          cwd: header?.cwd ?? '',
          self,
          ...(hold === undefined ? {} : { pausedBy: { title: hold.holderTitle, alias: hold.holderAlias } }),
          ...(holderHold === undefined ? {} : { holding: { title: holderHold.targetTitle, alias: holderHold.targetAlias } }),
        };
        if (row.title === '') titleIds.push(row);
        rows.push(row);
      }
      if (titleIds.length > 0) {
        try {
          const results = await sessionQuery.readTitleSnapshots(titleIds.map((row) => row.sessionId));
          const byId = new Map();
          for (const result of results ?? []) {
            if (result?.status === 'rejected') continue;
            const value = result?.value;
            const id = value?.session?.id ?? value?.session?.sessionId;
            const title = typeof value?.title === 'string' ? value.title : value?.title?.title;
            if (typeof id === 'string' && typeof title === 'string' && title !== '') byId.set(id, title);
          }
          for (const row of titleIds) {
            const title = byId.get(row.sessionId);
            row.title = typeof title === 'string' && title !== '' ? title : `会话 ${row.alias}`;
          }
        } catch (error) {
          warn(`批量读取标题失败：${String(error)}`);
          for (const row of titleIds) row.title = `会话 ${row.alias}`;
        }
      }
      rows.sort((left, right) => {
        const rank = (row) => (row.status === 'running' ? 0 : row.status === 'idle' ? 1 : 2);
        const delta = rank(left) - rank(right);
        if (delta !== 0) return delta;
        return left.title < right.title ? -1 : left.title > right.title ? 1 : 0;
      });
      const others = rows.filter((row) => row.self !== true);
      const holdList = [...holds.values()].map((hold) => ({
        holdId: hold.id,
        holderSessionId: hold.holderId,
        holderAlias: hold.holderAlias,
        holderTitle: hold.holderTitle,
        targetSessionId: hold.targetId,
        targetAlias: hold.targetAlias,
        targetTitle: hold.targetTitle,
        reason: hold.reason,
        until: hold.until,
        createdAt: hold.createdAt,
      }));
      return {
        self: { sessionId: caller.id, alias: makeSessionAlias(caller.id), title: titleOf(caller), cwd: cwdOf(caller) },
        parallel: others.some((row) => row.status !== 'offline'),
        total: rows.length,
        liveCount: rows.filter((row) => row.status !== 'offline').length,
        sessions: rows,
        holds: holdList,
      };
    },
  };

  const messageTool = {
    name: 'parallel_message',
    description:
      '向另一个并行会话投递一条消息。默认 mode=steer，直接把内容投递到对方会话（运行中在下一步边界立即插入，空闲时立即开启一轮），不排队；' +
      '只有确实要让对方先做完当前整轮再读时，才显式使用 mode=queue。inject 只补充上下文、不唤醒。' +
      '接收方会看到「来自会话 {你的标题}」的气泡，发送方也会在对话里看到「发给会话 {对方标题}」的发送块。' +
      '用于信息同步、设计方向指导（intent=guide）、阶段交接（intent=handoff）。' +
      '发送方与目标必须是同一工作区的顶层会话；同一对会话 60 秒内最多 10 条。' +
      '硬限制：不会创建或唤醒会话，目标必须当前已加载（running/idle）；离线会话会直接拒绝，请先在界面打开。',
    parameters: params({
      session_id: { type: 'string', description: '目标会话：parallel_sessions 返回的 cs_ 别名（与 cross_session_* 通用，也接受旧 ps_ 别名）或真实会话 ID。' },
      message: { type: 'string', description: '要转达的正文（接收方气泡内只显示这段内容，不显示头部信息）。' },
      intent: { type: 'string', enum: INTENTS, description: '意图：info=信息同步，guide=设计方向指导，handoff=阶段交接。默认 info。' },
      mode: { type: 'string', enum: MESSAGE_MODES, description: '默认 steer=立即投递；queue=等对方当前整轮结束后再投递；inject=不唤醒只补充上下文。' },
    }, ['session_id', 'message']),
    output: {
      schema: {},
      render: (_args, value) => [{
        type: 'text',
        text: value.accepted
          ? `已投递到会话「${value.target.title}」 ${value.target.alias}（模式 ${value.mode}${value.resumed ? '，目标会话已被唤醒' : ''}）。\nmessageId: ${value.messageId}\n接收方会看到来自「${value.senderTitle}」 ${value.senderAlias} 的归属信息。`
          : '未投递。',
      }],
      presentationMeta: (_args, value) => ({
        acquired: value.accepted === true,
        targetTitle: value.target && typeof value.target.title === 'string' ? value.target.title : '',
        targetAlias: value.target && typeof value.target.alias === 'string' ? value.target.alias : '',
        intent: value.intent,
        mode: value.mode,
        message: typeof value.message === 'string' ? value.message : '',
      }),
    },
    presentCall: (args) => ({ card: 'generic', title: '发送跨会话消息', kind: 'other', rawInput: args }),
    presentResult: () => ({ card: 'generic', title: '跨会话消息' }),
    async execute(args, exec) {
      const caller = requireCaller(exec);
      const target = await resolveTarget(caller, args?.session_id);
      if (target.id === caller.id) throw new Error('不能给自己发送跨会话消息。');
      const body = clampText(typeof args?.message === 'string' ? args.message : '', cfg.maxTextBytes);
      if (body.trim() === '') throw new Error('message 不能为空。');
      const intent = pickEnum(args?.intent, INTENTS, 'info');
      const mode = pickEnum(args?.mode, MESSAGE_MODES, 'steer');
      if (target.status === 'offline') {
        throw new Error('目标会话当前未活动（offline）。本插件不创建、不唤醒会话，只能与正在运行的会话沟通；请先在界面中打开该会话，或改用 parallel_sessions 选择其他活动会话。');
      }
      if (mode === 'inject' && target.status !== 'running') {
        throw new Error('inject 只能投递给正在运行的会话（下一步边界插入）；请改用 steer 或 queue。');
      }
      const senderTitle = titleOf(caller);
      const senderAlias = makeSessionAlias(caller.id);
      const text = formatPeerMessageText({
        senderTitle,
        senderAlias,
        senderSessionId: caller.id,
        intent,
        message: body,
      });
      const delivery = await deliverRelay({
        caller,
        target,
        text,
        intent,
        mode,
        signal: exec?.signal,
        summary: body,
        display: body,
        senderCallId: exec?.callId,
      });
      return {
        accepted: true,
        senderTitle,
        senderAlias,
        target: { sessionId: target.id, alias: target.alias, title: target.title, status: target.status },
        intent: intentLabel(intent),
        mode: delivery.mode,
        messageId: delivery.messageId,
        message: body,
        resumed: delivery.resumed,
      };
    },
  };

  const holdTool = {
    name: 'parallel_hold',
    description:
      '当你的任务会影响到另一个并行会话的阶段时，暂停它：停止它当前运行的回合、清空其待处理队列（数量会报告），并投递一条带发起方归属的暂停通知。' +
      'until=holder-turn-end（默认）在你本轮任务结束后自动恢复对方并投递「继续」通知；until=manual 需要你调用 parallel_release。' +
      '只用于同一工作区、已加载（running/idle）的顶层会话；暂停是真实停止，不是仅发消息。',
    parameters: params({
      session_id: { type: 'string', description: '要暂停的会话：cs_ 别名（与 cross_session_* 通用，也接受旧 ps_ 别名）或真实会话 ID。' },
      reason: { type: 'string', description: '为什么暂停（你的哪项任务/改动会影响它的哪个阶段）。会写进对方的暂停通知。' },
      impact: { type: 'string', description: '可选：受影响的阶段/范围，写进对方的暂停通知。' },
      until: { type: 'string', enum: HOLD_UNTIL, description: 'holder-turn-end=你本轮结束自动恢复（默认）；manual=需要 parallel_release。' },
    }, ['session_id', 'reason']),
    output: output((value) => {
      if (value.held !== true) return value.message ?? '未暂停。';
      const parts = [
        `已暂停会话「${value.target.title}」 ${value.target.alias}（hold ${value.holdId}）。`,
        value.cancelError
          ? `暂停登记已建立，但未能停止对方运行中的回合：${value.cancelError}。`
          : value.canceled
            ? `对方运行中的回合已停止${value.clearedQueue > 0 ? `，队列中 ${value.clearedQueue} 条待处理输入已清空` : ''}。`
            : '对方当前空闲，已进入暂停状态。',
        value.noticeDelivered ? '暂停通知已投递，对方会看到来自你的归属信息。' : `暂停通知未投递（${value.noticeError || '未知原因'}）；恢复时会再次通知。`,
        value.until === 'manual' ? '你需要在完成后调用 parallel_release 恢复对方。' : '你本轮任务结束后会自动恢复对方并发送「继续」通知。',
      ];
      return parts.join('\n');
    }),
    presentCall: (args) => ({ card: 'generic', title: '暂停并行会话', kind: 'other', rawInput: args }),
    presentResult: () => ({ card: 'generic', title: '并行会话已暂停' }),
    async execute(args, exec) {
      const caller = requireCaller(exec);
      const target = await resolveTarget(caller, args?.session_id);
      if (target.id === caller.id) throw new Error('不能暂停自己。');
      const reason = clampText(typeof args?.reason === 'string' ? args.reason.trim() : '', 2000);
      if (reason === '') throw new Error('reason 不能为空：请说明你的任务会影响对方的哪个阶段。');
      const impact = clampText(typeof args?.impact === 'string' ? args.impact.trim() : '', 1000);
      const until = pickEnum(args?.until, HOLD_UNTIL, 'holder-turn-end');
      const existing = holdByTarget.get(target.id);
      if (existing !== undefined) {
        throw new Error(`会话「${existing.targetTitle}」已被会话「${existing.holderTitle}」暂停（${existing.id}）；请等待其恢复或与对方沟通。`);
      }
      if (holds.size >= cfg.maxHolds) throw new Error(`活动暂停数已达上限 ${cfg.maxHolds}；请先恢复其他会话。`);
      if (target.live === undefined) {
        throw new Error('目标会话当前未活动（offline），不可暂停。本插件只与活动会话沟通，且不会创建/唤醒会话；请先在界面中打开该会话。');
      }
      const holderAgent = caller;
      const hold = {
        id: makeHoldId(),
        holderId: caller.id,
        holderTitle: titleOf(caller),
        holderAlias: makeSessionAlias(caller.id),
        holderAgent,
        holderTurn: currentTurnOf(caller.session),
        targetId: target.id,
        targetAlias: target.alias,
        targetTitle: target.title,
        targetHeader: target.header,
        reason,
        impact,
        until,
        createdAt: Date.now(),
      };
      holds.set(hold.id, hold);
      holdByTarget.set(target.id, hold.id);
      const statusBefore = target.status;
      const clearedQueue = cfg.holdCancel ? pendingCountOf(target.live) : 0;
      let canceled = false;
      let cancelError = '';
      if (cfg.holdCancel && statusBefore === 'running') {
        try {
          if (typeof target.live.cancel !== 'function') {
            cancelError = '目标 Agent 未暴露 cancel，无法停止运行中的回合';
          } else {
            target.live.cancel({ kind: 'user' });
            canceled = true;
          }
        } catch (error) {
          cancelError = String(error?.message ?? error);
          warn(`停止目标回合失败：${cancelError}`);
        }
      }
      let noticeDelivered = false;
      let noticeError = '';
      try {
        const text = formatHoldText({
          holderTitle: hold.holderTitle,
          holderAlias: hold.holderAlias,
          reason,
          impact,
          clearedQueue: canceled ? clearedQueue : 0,
          autoRelease: until === 'holder-turn-end',
        });
        await deliverRelay({
          caller,
          target,
          text,
          intent: 'hold',
          mode: 'followup',
          signal: exec?.signal,
          summary: `${reason}${impact === '' ? '' : `；影响：${impact}`}`,
          display: `${reason}${impact === '' ? '' : ` · ${impact}`}`,
          senderCallId: exec?.callId,
        });
        noticeDelivered = true;
      } catch (error) {
        noticeError = String(error?.message ?? error);
      }
      return {
        held: true,
        holdId: hold.id,
        target: { sessionId: target.id, alias: target.alias, title: target.title },
        targetStatusBefore: statusBefore,
        canceled,
        cancelError,
        clearedQueue,
        until,
        noticeDelivered,
        noticeError,
      };
    },
  };

  const releaseTool = {
    name: 'parallel_release',
    description:
      '恢复一个被 parallel_hold 暂停的会话：清除暂停登记，并投递带发起方归属的「继续」通知（含变更摘要）。' +
      '只有暂停的发起方会话能恢复；手动（until=manual）暂停必须调用本工具，自动暂停会在发起方回合结束时自动恢复。',
    parameters: params({
      session_id: { type: 'string', description: '要恢复的会话：cs_ 别名（与 cross_session_* 通用，也接受旧 ps_ 别名）或真实会话 ID。' },
      note: { type: 'string', description: '可选：给对方的变更摘要（你改了什么、它需要复核什么）。' },
    }, ['session_id']),
    output: output((value) => {
      if (value.released !== true) return value.message ?? '没有找到暂停登记。';
      const parts = [
        `已恢复会话「${value.target.title}」 ${value.target.alias}。`,
        value.delivered ? '「继续」通知已投递（含发起方归属与变更摘要）。' : `恢复登记已清除，但通知投递失败：${value.error}`,
      ];
      return parts.join('\n');
    }),
    presentCall: (args) => ({ card: 'generic', title: '恢复并行会话', kind: 'other', rawInput: args }),
    presentResult: () => ({ card: 'generic', title: '并行会话已恢复' }),
    async execute(args, exec) {
      const caller = requireCaller(exec);
      const target = await resolveTarget(caller, args?.session_id);
      const holdId = holdByTarget.get(target.id);
      const hold = holdId === undefined ? undefined : holds.get(holdId);
      if (hold === undefined) {
        return {
          released: false,
          message: `会话「${target.title}」 ${target.alias} 当前没有被暂停的登记。`,
          target: { sessionId: target.id, alias: target.alias, title: target.title },
        };
      }
      if (hold.holderId !== caller.id) {
        throw new Error(`该会话由「${hold.holderTitle}」暂停，只有发起方可以恢复。`);
      }
      const note = clampText(typeof args?.note === 'string' ? args.note.trim() : '', 2000);
      const receipt = await releaseHold(hold, { auto: false, note, senderCallId: exec?.callId });
      return {
        ...receipt,
        target: { sessionId: target.id, alias: target.alias, title: target.title },
      };
    },
  };

  for (const tool of [sessionsTool, messageTool, holdTool, releaseTool]) {
    ctx.effect(() => tools.register(tool), `dsh-parallel-sessions: ${tool.name}`);
  }

  // ── model guidance ───────────────────────────────────────────────────────

  /** @param {object|undefined} assembleContext - prompt assembly context. */
  function agentOfAssembleContext(assembleContext) {
    const candidate = assembleContext?.agent;
    if (candidate !== undefined && candidate !== null && typeof candidate.id === 'string') return candidate;
    return undefined;
  }

  /** @returns {object[]} live top-level agents in the same workspace as one agent. */
  function parallelAgentsOf(agent) {
    const cwd = normalizeCwd(cwdOf(agent));
    const rows = [];
    for (const candidate of agents.list()) {
      if (typeof candidate?.id !== 'string' || candidate.id === agent.id) continue;
      const header = headerOfSession(candidate.session);
      if (isSubagentSession(header)) continue;
      const candidateCwd = normalizeCwd(header?.cwd ?? cwdOf(candidate));
      if (cwd !== '' && candidateCwd !== '' && candidateCwd !== cwd) continue;
      rows.push(candidate);
    }
    return rows;
  }

  const COORDINATION_GUIDE = [
    '【并行会话协调 parallel-sessions】',
    '同一进程中可能有多个独立会话与你并行工作。检测到并行会话后，你可以（且应在任务需要时）跨会话协调：',
    '- parallel_sessions：列出并行会话（cs_ 别名、标题、运行状态、暂停关系）；cs_ 别名与同一进程的 cross_session_* 工具通用。',
    '硬限制：本插件不创建新会话、不会恢复/唤醒离线会话；只能与当前正在活动的会话（running/idle）沟通。目标离线时直接报错，请让用户先打开该会话。',
    '- parallel_message：给目标会话发消息；接收方会看到「来自会话 <你的标题/别名>」的归属信息。intent=guide 用于指导对方的设计方向。',
    '- parallel_hold：当你的改动会影响另一任务的阶段时，暂停该会话（停止其当前回合）；until=holder-turn-end 时你本轮结束会自动恢复它并通知继续。',
    '- parallel_release：手动恢复被暂停的会话，并附上变更摘要。',
    '收到【跨会话消息】时，发送方与意图已写在消息头部；需要回复时用 parallel_message 回复该 cs_ 别名。若消息来自 cross-session 插件的任务会话，用 cross_session_reply 回复时也用同一个 cs_ 别名；不要使用旧版 ps_ 别名去调用 cross_session_* 工具（会报会话不存在）。仅在同一工作区的顶层会话之间协调；不要给归档会话或子代理发消息。',
  ].join('\n');

  try {
    const systemPrompt = ctx.get('systemPrompt');
    if (cfg.guide && systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
      ctx.effect(() => systemPrompt.section({
        name: 'parallel-sessions:coordination',
        order: 650,
        text: (assembleContext) => {
          try {
            const agent = agentOfAssembleContext(assembleContext);
            if (agent === undefined) return '';
            const peers = parallelAgentsOf(agent);
            if (peers.length === 0) return '';
            const lines = [COORDINATION_GUIDE, '', '当前并行会话：'];
            for (const peer of peers) {
              lines.push(`- ${makeSessionAlias(peer.id)} 「${titleOf(peer)}」 ${peer.status === 'running' ? '运行中' : '空闲'}`);
            }
            return lines.join('\n');
          } catch (error) {
            warn(`生成并行会话指引失败：${String(error)}`);
            return '';
          }
        },
        interpolate: false,
      }), 'dsh-parallel-sessions: guidance');
    }
  } catch (error) {
    warn(`注册系统提示分区失败：${String(error)}`);
  }

  // Prune stale delivery windows periodically; disposed with the plugin fiber.
  try {
    if (typeof ctx.interval === 'function') {
      ctx.effect(() => ctx.interval(() => pairLimiter.prune(), 60_000), 'dsh-parallel-sessions: limiter prune');
    }
  } catch {
    /* timer service absent: map pruning is not required for correctness */
  }
}
