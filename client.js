window.__ModuleLoader__.load({
  id: 'dsh-parallel-sessions',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');

    const name = 'dsh-parallel-sessions-client';
    const inject = ['slots', 'locale'];
    const NS = 'parallel-sessions';
    const PRODUCER = 'parallel-sessions';
    /** Renderer key contributed to the Chat node slot (never a shipped key). */
    const NODE_KIND = 'parallel-session-card';
    /** Definition kind registered in the Conversation event registry. */
    const DEFINITION_KIND = 'parallel-session-message';

    const DICT_ZH = {
      'card.from': '来自会话「{title}」',
      'card.unknown': '未知会话',
      'card.open': '打开发送方会话',
      'card.intent.info': '信息同步',
      'card.intent.guide': '设计方向指导',
      'card.intent.handoff': '阶段交接',
      'card.intent.hold': '已暂停 · 等待继续',
      'card.intent.release': '已恢复 · 可以继续',
      'card.intent.ack': '已确认',
      'card.copy': '复制',
      'card.copied': '已复制',
    };
    const DICT_EN = {
      'card.from': 'From session “{title}”',
      'card.unknown': 'Unknown session',
      'card.open': 'Open sender session',
      'card.intent.info': 'Info',
      'card.intent.guide': 'Design guidance',
      'card.intent.handoff': 'Handoff',
      'card.intent.hold': 'Paused · waiting to continue',
      'card.intent.release': 'Resumed · can continue',
      'card.intent.ack': 'Acknowledged',
      'card.copy': 'Copy',
      'card.copied': 'Copied',
    };

    const INTENT_KEYS = ['info', 'guide', 'handoff', 'hold', 'release', 'ack'];

    const ZH_LABELS = {
      info: '信息同步',
      guide: '设计方向指导',
      handoff: '阶段交接',
      hold: '已暂停 · 等待继续',
      release: '已恢复 · 可以继续',
      ack: '已确认',
    };
    const EN_LABELS = {
      info: 'Info',
      guide: 'Design guidance',
      handoff: 'Handoff',
      hold: 'Paused · waiting to continue',
      release: 'Resumed · can continue',
      ack: 'Acknowledged',
    };

    const CSS = [
      '.ps-card-row{display:flex;flex-direction:column;align-items:flex-end;gap:6px;width:100%;}',
      '.ps-card-stack{display:flex;flex-direction:column;align-items:flex-end;gap:8px;min-width:0;max-width:min(calc(var(--dsh-chat-content-width,748px) * .702),82%);}',
      '.ps-card-bubble{background:var(--dsw-specific-bubble,var(--dsw-alias-bg-layer-2));border-radius:var(--dsw-radius-xl,16px);max-width:100%;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;padding:10px 16px;}',
      '.ps-card-meta{display:flex;align-items:center;gap:8px;height:calc(28px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));max-width:100%;min-width:0;}',
      '.ps-card-sender{appearance:none;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;padding:0;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:min(320px,46vw);text-align:left;}',
      '.ps-card-sender:hover{text-decoration:underline;text-underline-offset:3px;}',
      '.ps-card-sender:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;}',
      '.ps-card-status{flex:none;display:inline-flex;align-items:center;gap:5px;white-space:nowrap;}',
      '.ps-card-status::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);}',
      '.ps-card-status[data-intent="hold"]::before{background:var(--dsw-alias-state-warn-primary);}',
      '.ps-card-status[data-intent="release"]::before{background:var(--dsw-alias-state-success-primary);}',
      '.ps-card-status[data-intent="guide"]::before{background:var(--dsw-alias-brand-primary);}',
      '.ps-card-time{flex:none;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);white-space:nowrap;}',
      '.ps-card-copy{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm,6px);color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;display:inline-flex;align-items:center;justify-content:center;padding:6px;flex:none;}',
      '.ps-card-copy:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);}',
      '.ps-card-copy svg{width:15px;height:15px;}',
    ].join('');

    function CopyIcon() {
      return React.createElement('svg', {
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        React.createElement('rect', { x: 8, y: 8, width: 11, height: 11, rx: 2 }),
        React.createElement('path', { d: 'M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2' }));
    }

    function CheckIcon() {
      return React.createElement('svg', {
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }, React.createElement('path', { d: 'M5 12.5 10 17l9-10' }));
    }

    /** Remove the sender header lines from the durable message body. */
    function bodyOf(text) {
      if (typeof text !== 'string') return '';
      const split = text.indexOf('\n\n');
      if (split !== -1) return text.slice(split + 2).trim();
      const lines = text.split('\n');
      while (lines.length > 0 && /^(【|意图：|回信请用)/.test(lines[0])) lines.shift();
      return lines.join('\n').trim();
    }

    /** Extract the plain text of one durable message. */
    function textOfContent(content) {
      if (!Array.isArray(content)) return '';
      const parts = [];
      for (const block of content) {
        if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
        }
      }
      return parts.join('\n');
    }

    function stateOf(event, waking) {
      const message = event && event.data ? event.data : {};
      const source = message.source !== null && typeof message.source === 'object' ? message.source : {};
      const text = textOfContent(message.content);
      const intent = typeof source.intent === 'string' && INTENT_KEYS.indexOf(source.intent) !== -1
        ? source.intent
        : 'info';
      return {
        seq: typeof event.seq === 'number' ? event.seq : 0,
        time: typeof event.time === 'number' ? event.time : 0,
        waking: waking === true,
        intent,
        title: typeof source.senderTitle === 'string' && source.senderTitle !== ''
          ? source.senderTitle
          : (typeof source.senderAlias === 'string' && source.senderAlias !== ''
            ? source.senderAlias
            : (typeof source.senderSessionId === 'string' ? source.senderSessionId : '')),
        alias: typeof source.senderAlias === 'string' ? source.senderAlias : '',
        senderSessionId: typeof source.senderSessionId === 'string' ? source.senderSessionId : '',
        summary: typeof source.summary === 'string' ? source.summary : '',
        body: bodyOf(text),
      };
    }

    function buildDefinition() {
      return {
        kind: DEFINITION_KIND,
        target: 'chat',
        match(event) {
          if (event === null || typeof event !== 'object' || event.type !== 'user/message') return null;
          const source = event.data && event.data.source;
          if (source === null || typeof source !== 'object' || source.producer !== PRODUCER) return null;
          if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return null;
          const id = event.data && event.data.id;
          if (typeof id !== 'string' || id === '') return null;
          // Claim the event so the shipped generic context/turn-trigger row
          // does not render a second, less attributed row for the same message.
          return { id, role: 'start', exclusive: true };
        },
        start(_context, match, reader) {
          let waking = false;
          try {
            const previous = reader.previous('inbox-next-turn');
            const inbox = previous && previous.state;
            waking = Boolean(inbox && inbox.currentClaimed && typeof inbox.currentClaimed.has === 'function'
              && inbox.currentClaimed.has(String(match.event.data.id)));
          } catch (_) {
            waking = false;
          }
          return stateOf(match.event, waking);
        },
        update(context) {
          return context.state;
        },
        publication() {
          return 'immediate';
        },
        buildViewNode(context) {
          const state = context.state;
          if (state === undefined || state === null) return null;
          const start = context.start;
          return {
            key: context.key,
            kind: NODE_KIND,
            id: context.id,
            target: 'chat',
            anchorSeq: state.seq,
            location: start !== undefined && start.location !== undefined
              ? start.location
              : (context.matches[0] !== undefined ? context.matches[0].location : { kind: 'unresolved' }),
            visibility: 'visible',
            groupTree: state.waking ? 'input' : undefined,
            data: state,
          };
        },
      };
    }

    /** Clipboard write with a legacy fallback; resolves false when both fail. */
    async function writeClipboard(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (_) {
        /* fall through to the legacy path */
      }
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.focus();
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
      } catch (_) {
        return false;
      }
    }

    function clockText(time, snapshot) {
      try {
        const date = new Date(typeof time === 'number' ? time : 0);
        const zh = String((snapshot && snapshot.active) || '').toLowerCase().indexOf('zh') === 0;
        return date.toLocaleTimeString(zh ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      } catch (_) {
        return '';
      }
    }

    function apply(ctx) {
      if (ctx.locale !== undefined && typeof ctx.locale.register === 'function') {
        try {
          ctx.effect(() => ctx.locale.register(NS, 'zh', DICT_ZH));
          ctx.effect(() => ctx.locale.register(NS, 'en', DICT_EN));
        } catch (_) {
          /* localization is cosmetic; inline fallbacks keep the card readable */
        }
      }

      // The card reuses the shipped user-bubble tokens; styles live in one
      // plugin-owned tag removed with the plugin.
      try {
        const tag = document.createElement('style');
        tag.setAttribute('data-plugin', 'dsh-parallel-sessions');
        tag.textContent = CSS;
        document.head.appendChild(tag);
        ctx.effect(() => () => {
          tag.remove();
        });
      } catch (_) {
        /* styling degraded, content still renders */
      }

      function subscribeLocale(listener) {
        try {
          return ctx.locale.subscribe(listener);
        } catch (_) {
          return function () {};
        }
      }
      function localeSnapshot() {
        try {
          return ctx.locale.getSnapshot();
        } catch (_) {
          return undefined;
        }
      }
      let boundTranslate = null;
      function translate(key, params) {
        try {
          if (boundTranslate === null) boundTranslate = ctx.locale.bind(NS);
          return boundTranslate(key, params);
        } catch (_) {
          return undefined;
        }
      }
      function prefersChinese(snapshot) {
        return String((snapshot && snapshot.active) || '').toLowerCase().indexOf('zh') === 0;
      }
      function text(snapshot, key, params, zhFallback, enFallback) {
        const translated = translate(key, params);
        if (typeof translated === 'string' && translated !== '' && translated !== key) return translated;
        return prefersChinese(snapshot) ? zhFallback : enFallback;
      }
      function openSession(sessionId) {
        try {
          if (ctx.uiWorkspace !== undefined && typeof ctx.uiWorkspace.openSession === 'function') {
            ctx.uiWorkspace.openSession(sessionId);
            return true;
          }
        } catch (_) {
          /* opening a session is best-effort */
        }
        return false;
      }

      function ReceiverBubble(props) {
        const snapshot = React.useSyncExternalStore(subscribeLocale, localeSnapshot);
        const data = (props.node && props.node.data) || {};
        const [copied, setCopied] = React.useState(false);
        const timer = React.useRef(null);

        React.useEffect(() => () => {
          if (timer.current !== null) clearTimeout(timer.current);
        }, []);

        if (typeof data.intent !== 'string') return null;

        const title = typeof data.title === 'string' && data.title !== ''
          ? data.title
          : text(snapshot, 'card.unknown', {}, '未知会话', 'Unknown session');
        const intent = data.intent;
        const label = text(snapshot, 'card.intent.' + intent, {},
          ZH_LABELS[intent] || '跨会话消息', EN_LABELS[intent] || 'Cross-session message');
        const from = text(snapshot, 'card.from', { title: title }, '来自会话「' + title + '」', 'From session “' + title + '”');
        const body = typeof data.body === 'string' && data.body !== ''
          ? data.body
          : (typeof data.summary === 'string' ? data.summary : '');
        const canOpen = typeof data.senderSessionId === 'string' && data.senderSessionId !== '';
        const time = clockText(data.time, snapshot);

        function onCopy() {
          const value = body !== '' ? body : from;
          writeClipboard(value).then((ok) => {
            if (!ok) return;
            setCopied(true);
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(() => {
              timer.current = null;
              setCopied(false);
            }, 1200);
          });
        }

        return React.createElement('div', {
          className: 'ps-card-row',
          'data-parallel-session-card': intent,
          'data-chat-flow-kind': 'parallel-session',
        },
          React.createElement('div', { className: 'ps-card-stack' },
            body !== ''
              ? React.createElement('div', { className: 'ps-card-bubble' }, body)
              : null,
            React.createElement('div', { className: 'ps-card-meta' },
              React.createElement('button', {
                type: 'button',
                className: 'ps-card-sender',
                disabled: !canOpen,
                title: from + (canOpen ? ' · ' + text(snapshot, 'card.open', {}, '打开发送方会话', 'Open sender session') : '') + (data.alias !== '' ? ' · ' + data.alias : ''),
                'aria-label': from,
                onClick: function () { if (canOpen) openSession(data.senderSessionId); },
              }, from),
              React.createElement('span', {
                className: 'ps-card-status',
                'data-intent': intent,
                title: label,
              }, label),
              time !== '' ? React.createElement('span', { className: 'ps-card-time' }, time) : null,
              React.createElement('button', {
                type: 'button',
                className: 'ps-card-copy',
                'aria-label': copied
                  ? text(snapshot, 'card.copied', {}, '已复制', 'Copied')
                  : text(snapshot, 'card.copy', {}, '复制', 'Copy'),
                title: copied
                  ? text(snapshot, 'card.copied', {}, '已复制', 'Copied')
                  : text(snapshot, 'card.copy', {}, '复制', 'Copy'),
                onClick: onCopy,
              }, copied ? React.createElement(CheckIcon) : React.createElement(CopyIcon)))));
      }

      // Renderer first: the inject callback runs when the Chat node slot is
      // live. If that registration does not succeed, do not claim the event, so
      // the shipped relay row remains the visible fallback.
      const Card = typeof React.memo === 'function' ? React.memo(ReceiverBubble) : ReceiverBubble;
      let rendererRegistered = false;
      try {
        ctx.slots.inject('conversation.chat.node', () => {
          const disposer = ctx.slots.register({
            name: 'conversation.chat.node',
            key: NODE_KIND,
            locale: NS,
          }, Card);
          rendererRegistered = true;
          return disposer;
        });
      } catch (_) {
        rendererRegistered = false;
      }
      if (!rendererRegistered) return;
      try {
        const conversation = ctx.uiConversation;
        if (conversation === undefined || conversation === null
          || conversation.events === undefined || typeof conversation.events.register !== 'function') {
          return;
        }
        conversation.events.register(buildDefinition());
      } catch (_) {
        /* keep the shipped relay rows when the custom definition cannot register */
      }
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
