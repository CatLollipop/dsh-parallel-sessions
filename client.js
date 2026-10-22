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
    const HOLD_INTENTS = ['hold', 'release'];

    const DICT_ZH = {
      'dock.from': '来自会话「{title}」',
      'dock.paused': '已暂停 · 等待「{title}」完成任务',
      'dock.open': '打开发送方会话',
      'dock.intent.info': '信息同步',
      'dock.intent.guide': '设计方向指导',
      'dock.intent.handoff': '阶段交接',
      'dock.intent.release': '恢复通知',
      'dock.label': '并行会话协调',
    };
    const DICT_EN = {
      'dock.from': 'From session “{title}”',
      'dock.paused': 'Paused · waiting for “{title}” to finish',
      'dock.open': 'Open sender session',
      'dock.intent.info': 'Info',
      'dock.intent.guide': 'Design guidance',
      'dock.intent.handoff': 'Handoff',
      'dock.intent.release': 'Released',
      'dock.label': 'Parallel sessions',
    };

    function apply(ctx) {
      if (ctx.locale !== undefined && typeof ctx.locale.register === 'function') {
        try {
          ctx.effect(() => ctx.locale.register(NS, 'zh', DICT_ZH));
          ctx.effect(() => ctx.locale.register(NS, 'en', DICT_EN));
        } catch (_) {
          /* locale dictionaries are cosmetic; the inline fallbacks still render */
        }
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
        var active = String((snapshot && snapshot.active) || '').toLowerCase();
        return active.indexOf('zh') === 0;
      }

      function text(snapshot, key, params, zhFallback, enFallback) {
        var translated = translate(key, params);
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
          /* fall through */
        }
        return false;
      }

      /** Latest relay source of any intent, by durable seq. */
      function selectLatestIncoming(snapshot) {
        return selectRelaySource(snapshot, false);
      }

      /** Latest relay source whose intent is hold/release. */
      function selectLatestHoldEvent(snapshot) {
        return selectRelaySource(snapshot, true);
      }

      function selectRelaySource(chatSnapshot, holdOnly) {
        try {
          const nodes = chatSnapshot && chatSnapshot.nodes;
          if (nodes === undefined || typeof nodes.values !== 'function') return null;
          const list = nodes.values();
          var best = null;
          var bestSeq = -1;
          for (var index = 0; index < list.length; index += 1) {
            const node = list[index];
            const data = node && node.data;
            const source = data && data.source;
            if (source === null || typeof source !== 'object') continue;
            if (source.producer !== PRODUCER) continue;
            if (holdOnly && HOLD_INTENTS.indexOf(source.intent) === -1) continue;
            const seq = typeof data.seq === 'number'
              ? data.seq
              : (typeof node.anchorSeq === 'number' ? node.anchorSeq : 0);
            if (best === null || seq > bestSeq) {
              bestSeq = seq;
              best = source;
            }
          }
          return best;
        } catch (_) {
          return null;
        }
      }

      function Dock(props) {
        const localeTick = React.useSyncExternalStore(subscribeLocale, localeSnapshot);
        const useChat = typeof props.useChat === 'function' ? props.useChat : function () { return null; };
        const latest = useChat(selectLatestIncoming);
        const holdEvent = useChat(selectLatestHoldEvent);
        const paused = holdEvent !== null && holdEvent !== undefined && holdEvent.intent === 'hold';
        const info = paused ? holdEvent : (latest || holdEvent);
        if (info === null || info === undefined) return null;

        const alias = typeof info.senderAlias === 'string' ? info.senderAlias : '';
        const sessionId = typeof info.senderSessionId === 'string' ? info.senderSessionId : '';
        const title = typeof info.senderTitle === 'string' && info.senderTitle !== ''
          ? info.senderTitle
          : (alias || 'session');

        const summary = typeof info.summary === 'string' ? info.summary : '';
        const shortSummary = summary.length > 90 ? summary.slice(0, 89) + '…' : summary;
        const intent = typeof info.intent === 'string' ? info.intent : 'info';

        var headline;
        var tone;
        if (paused) {
          headline = text(localeTick, 'dock.paused', { title: title },
            '已暂停 · 等待「' + title + '」完成任务',
            'Paused · waiting for “' + title + '” to finish');
          tone = 'warn';
        } else {
          headline = text(localeTick, 'dock.from', { title: title },
            '来自会话「' + title + '」',
            'From session “' + title + '”');
          tone = 'normal';
        }

        const intentLabel = intent !== 'hold' && intent !== 'release'
          ? text(localeTick, 'dock.intent.' + intent, {},
            { info: '信息同步', guide: '设计方向指导', handoff: '阶段交接' }[intent] || '',
            { info: 'Info', guide: 'Design guidance', handoff: 'Handoff' }[intent] || '')
          : (intent === 'release'
            ? text(localeTick, 'dock.intent.release', {}, '恢复通知', 'Released')
            : '');

        const openLabel = text(localeTick, 'dock.open', {}, '打开发送方会话', 'Open sender session');
        const detail = shortSummary !== '' ? shortSummary : (alias !== '' ? alias : sessionId);

        const dotStyle = {
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          flex: 'none',
          background: tone === 'warn'
            ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-brand-primary)',
        };
        const containerStyle = {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          width: '100%',
          boxSizing: 'border-box',
          padding: '7px 12px',
          borderRadius: '12px',
          border: '0.5px solid ' + (tone === 'warn'
            ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-border-l1)'),
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-secondary)',
          fontSize: '12px',
          lineHeight: '1.5',
          minWidth: 0,
        };
        const bodyStyle = {
          flex: '1 1 auto',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        };
        const buttonStyle = {
          flex: 'none',
          padding: '3px 8px',
          borderRadius: '8px',
          border: '0.5px solid var(--dsw-alias-border-l1)',
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          fontSize: '11px',
          lineHeight: '1.4',
          cursor: 'pointer',
        };

        return React.createElement('div', {
          className: 'parallel-sessions-dock',
          style: containerStyle,
          'data-parallel-sessions': tone,
          title: (alias ? alias + ' · ' : '') + (sessionId || ''),
          'aria-label': headline + (shortSummary ? ' · ' + shortSummary : ''),
        },
          React.createElement('span', { style: dotStyle, 'aria-hidden': true }),
          React.createElement('span', { style: bodyStyle },
            React.createElement('span', { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } }, headline),
            intentLabel !== '' ? React.createElement('span', {
              style: { marginLeft: '8px', color: 'var(--dsw-alias-label-secondary)' },
            }, intentLabel) : null,
            detail !== '' ? React.createElement('span', {
              style: { marginLeft: '8px', color: 'var(--dsw-alias-label-secondary)' },
            }, '· ' + detail) : null),
          sessionId !== '' ? React.createElement('button', {
            type: 'button',
            style: buttonStyle,
            onClick: function () { openSession(sessionId); },
            title: openLabel,
            'aria-label': openLabel,
          }, openLabel) : null);
      }

      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'parallel-sessions',
        order: 15,
        label: () => '并行会话协调',
      }, Dock));
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
