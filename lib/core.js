/**
 * Pure helpers for dsh-parallel-sessions.
 *
 * This module imports nothing from the Host so it can be unit-tested without a
 * running DeepSeek Harness. Everything here is deterministic except
 * `makeId`, which is only used for hold identifiers.
 *
 * @module dsh-parallel-sessions/core
 */
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

/**
 * Chat Node `source.kind` used for relayed peer messages. The shipped Chat UI
 * maps this kind to the localized "task message received" turn-trigger label
 * and keeps the durable message classified as injected context, so a waking
 * relay stays visibly attributed instead of masquerading as human input.
 */
export const RELAY_SOURCE_KIND = 'agent-message';

/** Durable marker that lets the Client half recognize this plugin's messages. */
export const PRODUCER = 'parallel-sessions';

/** Legacy alias prefix (older releases of this plugin only). */
export const LEGACY_ALIAS_PREFIX = 'ps_';
/** Shared alias prefix, identical to `dsh-cross-session-approval`. */
export const SHARED_ALIAS_PREFIX = 'cs_';
/** Alias prefix kept for compatibility with existing imports. */
export const ALIAS_PREFIX = SHARED_ALIAS_PREFIX;
/** Pinned salt of the shared alias namespace. */
const SHARED_ALIAS_SALT = 'dsh-cross-session-approval:session-alias:v1:';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a 32-bit hash over UTF-16 code units.
 * @param {string} text - input text.
 * @param {number} [seed] - initial basis.
 * @returns {number} unsigned 32-bit digest.
 */
function fnv1a(text, seed = FNV_OFFSET) {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic short session alias shared with `dsh-cross-session-approval`.
 *
 * The two plugins must address sessions identically: agents regularly mix the
 * `parallel_*` and `cross_session_*` tool families, and a namespace mismatch
 * made one family reject the other's aliases ("session not found"). This is the
 * exact derivation used by that plugin (`cs_` + ten base62 characters, salted
 * 64-bit FNV-1a with a rehash round), so one `cs_` alias works everywhere.
 *
 * The salt is pinned to the v1 namespace of the other plugin. If that plugin
 * ever changes its salt, both sides must be updated together.
 *
 * @param {string} sessionId - real session id.
 * @returns {string} `cs_` plus ten base62 characters.
 */
export function makeSessionAlias(sessionId) {
  const input = SHARED_ALIAS_SALT + String(sessionId ?? '');
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK64 = (1n << 64n) - 1n;
  let hash = FNV_OFFSET;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash ^ BigInt(input.charCodeAt(index))) * FNV_PRIME) & MASK64;
  }
  let body = '';
  let state = hash;
  for (let index = 0; index < 10; index += 1) {
    body += BASE62[Number(state % 62n)];
    state = ((state ^ (state >> 13n)) * FNV_PRIME) & MASK64;
    if (state === 0n) state = hash;
  }
  return `${SHARED_ALIAS_PREFIX}${body}`;
}

/**
 * Legacy `ps_` alias from earlier versions of this plugin. Kept only so old
 * message headers and saved instructions keep resolving; new output always uses
 * the shared `cs_` alias.
 *
 * @param {string} sessionId - real session id.
 * @returns {string} `ps_` plus ten base62 characters.
 */
export function makeLegacyAlias(sessionId) {
  const text = typeof sessionId === 'string' ? sessionId : String(sessionId ?? '');
  const forward = fnv1a(text);
  const backward = fnv1a([...text].reverse().join(''), 0x1000193);
  let value = (BigInt(forward) << 32n) | BigInt(backward);
  const chars = [];
  for (let index = 0; index < 10; index += 1) {
    chars.push(BASE62[Number(value % 62n)]);
    value /= 62n;
  }
  return `${LEGACY_ALIAS_PREFIX}${chars.join('')}`;
}

/**
 * @param {unknown} value - candidate reference.
 * @returns {boolean} whether the value is a shared `cs_` alias.
 */
export function isSharedAlias(value) {
  return typeof value === 'string' && /^cs_[0-9A-Za-z]{10}$/.test(value);
}

/**
 * @param {unknown} value - candidate reference.
 * @returns {boolean} whether the value is a legacy `ps_` alias.
 */
export function isLegacyAlias(value) {
  return typeof value === 'string' && /^ps_[0-9A-Za-z]{10}$/.test(value);
}

/**
 * @param {unknown} value - candidate reference.
 * @returns {boolean} whether the value is any alias this plugin can resolve.
 */
export function isSessionAlias(value) {
  return isSharedAlias(value) || isLegacyAlias(value);
}

const MASKED_PATTERNS = [
  /^session-(?:0{8}|1{8}|x{8}|X{8})-/,
  /^session-<[^>]*>$/,
  /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
];

/**
 * Detect the all-zero/all-x style placeholder some display chains substitute
 * for real session ids. Deliberately conservative: a real-looking UUID passes.
 *
 * @param {unknown} value - candidate reference.
 * @returns {boolean} whether the value looks like a masked placeholder.
 */
export function isMaskedPlaceholderId(value) {
  if (typeof value !== 'string') return false;
  if (MASKED_PATTERNS[0].test(value)) return true;
  if (MASKED_PATTERNS[1].test(value)) return true;
  if (/[*…]/.test(value)) return true;
  const match = MASKED_PATTERNS[2].exec(value);
  if (match === null) return false;
  const hex = value.replace(/[^0-9a-f]/gi, '');
  return /^(?:0+|1+|x+)$/i.test(hex);
}

/**
 * Clamp a UTF-8 string to a byte budget without splitting code points.
 * @param {unknown} value - candidate text.
 * @param {number} [maxBytes] - byte budget.
 * @returns {string} clamped text (an ellipsis marks truncation).
 */
export function clampText(value, maxBytes = 32768) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const budget = Math.max(1, maxBytes - 3);
  let out = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > budget) break;
    out += char;
    bytes += size;
  }
  return `${out}…`;
}

/**
 * Collapse whitespace and clamp one-line summaries.
 * @param {unknown} value - candidate text.
 * @param {number} [maxChars] - maximum UTF-16 characters.
 * @returns {string} one-line summary.
 */
export function summarize(value, maxChars = 120) {
  const text = typeof value === 'string' ? value : '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars - 1)}…`;
}

/**
 * Normalize a working directory for cross-platform string comparison.
 * @param {unknown} path - directory path.
 * @returns {string} normalized path.
 */
export function normalizeCwd(path) {
  if (typeof path !== 'string' || path === '') return '';
  const trimmed = path.length > 1 && (path.endsWith('/') || path.endsWith('\\'))
    ? path.slice(0, -1)
    : path;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/**
 * Create one hold id.
 * @returns {string} `hold_` plus an opaque id.
 */
export function makeHoldId() {
  return `hold_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * @param {string} left - first session id.
 * @param {string} right - second session id.
 * @returns {string} direction-independent pair key.
 */
export function pairKey(left, right) {
  return [String(left), String(right)].sort().join('\u0000');
}

/**
 * Bounded per-pair delivery accounting: a rolling window that limits how many
 * messages one pair of sessions may exchange, protecting both agents from a
 * coordination loop.
 */
export class PairLimiter {
  /**
   * @param {number} limit - maximum deliveries per window.
   * @param {number} windowMs - rolling window length.
   */
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    /** @type {Map<string, number[]>} */
    this.entries = new Map();
  }

  /**
   * Reserve one delivery, or throw when the window is exhausted.
   * @param {string} from - sender session id.
   * @param {string} to - target session id.
   * @returns {() => void} rollback for a delivery that then failed.
   */
  reserve(from, to) {
    const key = pairKey(from, to);
    const now = Date.now();
    const recent = (this.entries.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.entries.set(key, recent);
      const oldest = recent[0] ?? now;
      const retryAfter = Math.max(1, Math.ceil((this.windowMs - (now - oldest)) / 1000));
      throw new Error(`同一对会话 ${Math.round(this.windowMs / 1000)} 秒内最多投递 ${this.limit} 条消息；请约 ${retryAfter} 秒后重试。`);
    }
    const stamp = now;
    recent.push(stamp);
    this.entries.set(key, recent);
    return () => {
      const current = this.entries.get(key);
      if (current === undefined) return;
      const index = current.lastIndexOf(stamp);
      if (index !== -1) current.splice(index, 1);
      if (current.length === 0) this.entries.delete(key);
    };
  }

  /** Drop stale windows so the map cannot grow without bound. */
  prune() {
    const now = Date.now();
    for (const [key, list] of this.entries) {
      const recent = list.filter((at) => now - at < this.windowMs);
      if (recent.length === 0) this.entries.delete(key);
      else this.entries.set(key, recent);
    }
  }
}

/**
 * Intent vocabulary carried in the durable message source.
 * @typedef {'info'|'guide'|'handoff'|'hold'|'release'|'ack'} PeerIntent
 */

/**
 * Human label for one intent (model-facing text stays Chinese like the
 * reference plugins; the receiving model reads the tag).
 * @param {PeerIntent} intent - intent value.
 * @returns {string} label.
 */
export function intentLabel(intent) {
  switch (intent) {
    case 'guide': return 'guide（设计方向指导）';
    case 'handoff': return 'handoff（任务交接/阶段衔接）';
    case 'hold': return 'hold（暂停通知）';
    case 'release': return 'release（恢复通知）';
    case 'ack': return 'ack（确认）';
    case 'info':
    default: return 'info（信息同步）';
  }
}

/**
 * Build the durable source fields that make the receiving UI attribute the
 * message to its sender. `senderSessionId` and `form: 'relay'` are the two
 * fields the shipped Chat relay renderer reads.
 *
 * @param {object} input - attribution inputs.
 * @param {string} input.senderSessionId - sender session id.
 * @param {string} input.senderTitle - sender display title.
 * @param {string} input.senderAlias - sender short alias.
 * @param {string} input.targetSessionId - target session id.
 * @param {PeerIntent} input.intent - intent.
 * @param {string} [input.summary] - one-line summary for the client dock.
 * @param {string} [input.holdId] - related hold id.
 * @returns {object} lossless JSON source object.
 */
export function buildRelaySource(input) {
  const source = {
    kind: RELAY_SOURCE_KIND,
    form: 'relay',
    producer: PRODUCER,
    protocolVersion: 1,
    senderSessionId: input.senderSessionId,
    senderTitle: input.senderTitle,
    senderAlias: input.senderAlias,
    targetSessionId: input.targetSessionId,
    intent: input.intent,
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    // Concise human-facing text for the in-chat bubble; the model-facing body
    // may carry extra coordination lines the UI must not repeat.
    ...(input.display === undefined ? {} : { display: input.display }),
    // Sender-side tool call identity, used by the deep link that opens the
    // sender session at the exact send action.
    ...(input.senderCallId === undefined ? {} : { senderCallId: input.senderCallId }),
    ...(input.holdId === undefined ? {} : { holdId: input.holdId }),
  };
  return source;
}

/**
 * Model-facing body of a peer message. The first line states sender identity so
 * the receiving model can reply without guessing; the Client card adds the
 * structured "from session" field from the source.
 *
 * @param {object} input - rendering inputs.
 * @param {string} input.senderTitle - sender title.
 * @param {string} input.senderAlias - sender alias.
 * @param {string} input.senderSessionId - sender session id.
 * @param {PeerIntent} input.intent - intent.
 * @param {string} input.message - message body.
 * @returns {string} model-facing text.
 */
export function formatPeerMessageText(input) {
  return [
    `【跨会话消息 · 来自「${input.senderTitle}」 ${input.senderAlias}】`,
    `意图：${intentLabel(input.intent)}`,
    `回信请用 parallel_message，session_id = ${input.senderAlias}（cs_ 别名同时适用于 cross_session_* 工具）。`,
    '',
    input.message,
  ].join('\n');
}

/**
 * Pause notice delivered to a session that another task just suspended.
 *
 * @param {object} input - hold details.
 * @param {string} input.holderTitle - holder title.
 * @param {string} input.holderAlias - holder alias.
 * @param {string} input.reason - why the hold exists.
 * @param {string} [input.impact] - affected phase.
 * @param {number} [input.clearedQueue] - queued inputs dropped by the cancel.
 * @param {boolean} input.autoRelease - whether the holder releases on turn end.
 * @returns {string} model-facing text.
 */
export function formatHoldText(input) {
  const cleared = input.clearedQueue > 0
    ? `你的当前回合已被停止，队列中 ${input.clearedQueue} 条待处理输入已清空。`
    : '你的当前回合已被停止。';
  return [
    `【暂停通知 · 来自「${input.holderTitle}」 ${input.holderAlias}】`,
    `原因：${input.reason}`,
    ...(input.impact ? [`影响阶段：${input.impact}`] : []),
    cleared,
    '请保留已完成的工作、不要开始新任务，等待恢复通知。',
    input.autoRelease
      ? `发起方本轮任务结束后会自动恢复你；也可以使用 parallel_message 向 ${input.holderAlias} 同步必要的已知信息。`
      : `发起方完成其任务后会调用 parallel_release 恢复你；期间如需同步信息，可用 parallel_message 向 ${input.holderAlias} 发送。`,
  ].join('\n');
}

/**
 * Resume notice delivered when a hold is released.
 *
 * @param {object} input - release details.
 * @param {string} input.holderTitle - holder title.
 * @param {string} input.holderAlias - holder alias.
 * @param {string} input.reason - original hold reason.
 * @param {string} [input.note] - change summary supplied by the holder.
 * @param {boolean} input.auto - whether the release was automatic.
 * @returns {string} model-facing text.
 */
export function formatReleaseText(input) {
  return [
    `【恢复通知 · 来自「${input.holderTitle}」 ${input.holderAlias}】`,
    `${input.auto ? '发起方本轮任务已结束' : '发起方已完成相关工作'}${input.note ? `，变更摘要：${input.note}` : '。'}`,
    `此前暂停原因：${input.reason}`,
    '现在可以继续之前的工作。继续前请检查依赖内容是否已经变化。',
  ].join('\n');
}

/**
 * Validate/repair one enum parameter.
 * @template {string} T
 * @param {unknown} value - candidate value.
 * @param {readonly T[]} allowed - allowed values.
 * @param {T} fallback - default.
 * @returns {T} normalized value.
 */
export function pickEnum(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}
