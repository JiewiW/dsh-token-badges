// dsh-token-badges 客户端半边：在聊天流里渲染两种只读的 token 徽章。
//
// 1) user-token —— 每条 user/message 一条，右对齐的漂浮小药丸，显示这条
//    消息输入到模型请求中的 token 数（数据来自 host 端
//    /plugins/token-badges/tokens，即 token-meter 服务对该消息的定价）。
//    分两类：人类提问那条强制留在根级、紧贴气泡下方；插件/运行时注入的
//    那些（cot-anchor 提醒、runtime-context、skill-catalog、agent-
//    instructions 等）落在 turn/step 内，随「Agent 工作流」折叠一起收起。
//    它们每步注入 1~2 条，若都留在根级就会在「已完成，用时 …」下面堆成
//    一长串「输入 N tokens」标签，收不回去。
// 2) turn-token —— 常驻在模型回答流的最下方，累计该回合所有
//    assistant/message 事件携带的 usage.outputTokens，随每次模型调用结算
//    实时增长；turn/end 后显示最终值。
//
// 位置机制（关键，踩过坑）：
//   ui-chat 有一套「Agent 工作流折叠」机制，它按写死的白名单
//   TURN_PROCESS_INDEPENDENT_KINDS 判断哪些 kind 不参与折叠；插件无法向该
//   白名单追加自己的 kind。location 落在 turn/step 上的节点会被判为
//   processMember，折叠时一并隐藏；location 为 { kind: 'unresolved' } 的
//   节点则被 rootEntries() 当作**根级条目**渲染，永远不折叠。
//   于是本插件按「该不该跟着折叠」分别选择 location：
//   · 注入类徽章 —— 用事件自己的 turn/step（eventLocation()），随过程收起；
//   · 人类提问徽章 + turn-token —— 固定 unresolved，常驻可见。
//
// 格式说明：dsh 的 web client 模块必须手写 window.__ModuleLoader__.load({
// id, factory }) 壳。打包器把各插件的 client.js 原样拼进 /plugins/?? combo，
// 不会再补函数壳；若在文件顶层直接 `return {...}`，拼进 bundle 后会落在
// 脚本顶层作用域 → SyntaxError: Illegal return statement → 整个 client
// bundle 解析失败 → 页面「Failed to load plugins」。故此处必须保持 shell 形态。
window.__ModuleLoader__.load({
  id: 'dsh-token-badges',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    // ---- 主题变量（跟随 dsh 官方变量，带深色兜底） ----
    var TEXT_MUTED = 'var(--dsw-alias-label-tertiary, #7d8391)'
    var TEXT_SOFT = 'var(--dsw-alias-label-secondary, #9aa0ac)'
    var ACCENT = 'var(--dsw-alias-brand-primary, #4a9eff)'
    var PILL_BG = 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))'
    var PILL_BORDER = 'var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.22))'

    // ---- 常量 ----
    var TOKENS_ROUTE = '/plugins/token-badges/tokens'
    var USER_TOKEN_OFFSET = 0.15   // 紧跟用户消息之后（小于下一条事件的整数 seq）
    var TURN_TOKEN_OFFSET = 0.2    // 排在回合内最后一条事件之后
    var CACHE_TTL_MS = 8000        // host 度量结果按会话缓存时长
    var MAX_NODES = 4000           // host 返回的节点数上限（防御性）
    var UNRESOLVED = { kind: 'unresolved' }

    // ---- 模块级 token 表缓存（sessionId -> { at, seqToTokens }） ----
    var tokenCache = new Map()

    function cacheGet(sessionId) {
      var entry = tokenCache.get(sessionId)
      if (entry === undefined) return undefined
      if (Date.now() - entry.at > CACHE_TTL_MS) {
        tokenCache.delete(sessionId)
        return undefined
      }
      return entry
    }

    function cachePut(sessionId, seqToTokens) {
      if (tokenCache.size > 64) tokenCache.clear()
      tokenCache.set(sessionId, { at: Date.now(), seqToTokens: seqToTokens })
    }

    /** 从 host 端拉取该会话的每条消息 token 定价表（seq -> tokens）。 */
    function fetchTokenTable(sessionId) {
      return fetch(
        TOKENS_ROUTE + '?sessionId=' + encodeURIComponent(sessionId),
        { credentials: 'same-origin' }
      )
        .then(function (resp) {
          if (!resp.ok) throw new Error('http ' + resp.status)
          return resp.json()
        })
        .then(function (data) {
          var seqToTokens = new Map()
          var nodes = Array.isArray(data && data.nodes) ? data.nodes : []
          var count = Math.min(nodes.length, MAX_NODES)
          for (var i = 0; i < count; i++) {
            var node = nodes[i]
            if (
              node &&
              typeof node.seq === 'number' &&
              typeof node.tokens === 'number' &&
              node.tokens >= 0
            ) {
              seqToTokens.set(node.seq, node.tokens)
            }
          }
          cachePut(sessionId, seqToTokens)
          return seqToTokens
        })
    }

    // ---- 数字格式化：<1000 原样，>=1000 压缩为 1.2K / 517K / 1.2M ----
    function formatTokens(value) {
      if (typeof value !== 'number' || !isFinite(value) || value < 0) {
        return null
      }
      var n = Math.round(value)
      if (n < 1000) return String(n)
      if (n < 1e6) {
        var k = (n / 1000).toFixed(1)
        if (k.slice(-2) === '.0') k = k.slice(0, -2)
        return k + 'K'
      }
      var m = (n / 1e6).toFixed(1)
      if (m.slice(-2) === '.0') m = m.slice(0, -2)
      return m + 'M'
    }

    /** 漂浮小药丸样式：弱底、细边、小字，视觉上像挂在消息旁的计数器。 */
    function pillStyle(align) {
      return {
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        alignSelf: align === 'end' ? 'flex-end' : 'flex-start',
        maxWidth: '100%',
        padding: '2px 8px',
        borderRadius: '999px',
        border: '1px solid ' + PILL_BORDER,
        background: PILL_BG,
        color: TEXT_MUTED,
        fontSize: 11,
        lineHeight: '16px',
        whiteSpace: 'nowrap',
        userSelect: 'none'
      }
    }

    /** 行容器：让药丸贴到气泡那一侧（用户气泡靠右）。 */
    function rowStyle(align) {
      return {
        display: 'flex',
        justifyContent: align === 'end' ? 'flex-end' : 'flex-start',
        // 抵消聊天流相邻条目的默认间距，让徽章紧贴上方消息。
        marginTop: -2,
        minWidth: 0
      }
    }

    /** 圆点标记。 */
    function dotStyle(accent) {
      return {
        width: 5,
        height: 5,
        borderRadius: '50%',
        background: accent,
        flex: '0 0 auto'
      }
    }

    // ============================================================
    // Definition 1：user-token —— 每条 user/message 的输入 token 计数器
    // ============================================================
    /**
     * 取出事件所在位置（turn/step），供注入类徽章参与 ui-chat 的工作流折叠。
     *
     * `context.start` / `context.matches[0]` 上的 location 由事件引擎按事件
     * 所在的 turn/step 填好，这正是 ui-chat 自身 Definition 的取值方式。
     * 拿不到（如 turn 外的事件）时退回 unresolved，让节点留在根级渲染。
     */
    function eventLocation(context) {
      var start = context.start
      if (start !== undefined && start.location !== undefined) {
        return start.location
      }
      var matches = context.matches
      if (matches !== undefined && matches.length > 0 && matches[0].location !== undefined) {
        return matches[0].location
      }
      return UNRESOLVED
    }

    /**
     * 是否是人类自己敲进去的提问。
     *
     * ui-chat 的 messageDefinition 用 `event.data.source.kind === 'user'` +
     * append 表面事件区分「人类输入」与「注入上下文」。实测会话日志
     * （session-89fd…）：turn/start 在 seq=4，人类提问在 seq=8，紧随其后
     * seq=9/10/11 才是 agent-instructions / runtime-context / skill-catalog，
     * 之后每步注入 1~2 条 cot-anchor 提醒。也就是说人类提问本身**也在
     * turn 窗口内**，只按 location 判断会连它一起折进去，故必须显式区分。
     */
    function isHumanPrompt(event) {
      var source = event.data && event.data.source
      return (
        event.type === 'user/message' &&
        event.surfaceOp === 'append' &&
        source !== undefined &&
        source.kind === 'user'
      )
    }

    var userTokenDefinition = {
      kind: 'user-token',
      target: 'chat',
      // 所有 user/message 都出徽章：人类提问那枚留在气泡下方；插件/运行时
      // 注入的那些（cot-anchor 提醒、runtime-context、skill-catalog…）随
      // 工作流折叠一起收起，不再在「已完成，用时 …」下面堆成长串。
      match: function (event) {
        if (event.type !== 'user/message') return null
        return {
          id: String(event.seq),
          role: 'start',
          human: isHumanPrompt(event)
        }
      },
      start: function (context, match) {
        return { seq: match.event.seq, human: match.human }
      },
      update: function (context, match) {
        return context.state
      },
      publication: function () {
        return 'immediate'
      },
      buildViewNode: function (context) {
        var state = context.state
        if (state === undefined) return null
        return {
          key: context.key,
          kind: 'user-token',
          id: context.id,
          target: 'chat',
          anchorSeq: state.seq + USER_TOKEN_OFFSET,
          // 人类提问：unresolved → rootEntries() 作根级条目渲染，永远贴在
          // 气泡下方、不随折叠消失。
          // 注入类：带自己的 turn/step。TURN_PROCESS_INDEPENDENT_KINDS 不含
          // 本 kind，于是被判为 processMember，随过程折叠一起隐藏。
          location: state.human ? UNRESOLVED : eventLocation(context),
          visibility: 'visible',
          data: { seq: state.seq, human: state.human }
        }
      }
    }

    /**
     * 单条消息的输入 token 徽章。
     *
     * 人类提问（human=true）紧贴气泡右侧、常驻；注入类消息（human=false）
     * 靠左、随工作流折叠收起，因此文案区分成「输入 N tokens」与
     * 「本条注入 N tokens」，避免折叠内一堆标签看起来像是用户在说话。
     */
    function UserTokenNodeView(props) {
      var node = props.node
      var sessionId = props.sessionId
      var seq = node.data.seq
      var human = node.data.human === true
      var state = React.useState(null)
      var tokens = state[0]
      var setTokens = state[1]

      React.useEffect(function () {
        if (!sessionId) return undefined
        var cancelled = false
        var cached = cacheGet(sessionId)
        if (cached) {
          var immediate = cached.seqToTokens.get(seq)
          if (immediate !== undefined) setTokens(immediate)
        }
        fetchTokenTable(sessionId)
          .then(function (table) {
            if (cancelled) return
            var found = table.get(seq)
            if (found !== undefined) setTokens(found)
          })
          .catch(function () {
            /* 静默：加载失败就不显示徽章 */
          })
        return function () {
          cancelled = true
        }
      }, [sessionId, seq])

      var text = formatTokens(tokens)
      if (text === null) return null
      var align = human ? 'end' : 'start'
      var label = human ? '输入 ' + text + ' tokens' : '本条注入 ' + text + ' tokens'
      var hint = human
        ? '本次输入 ' + Math.round(tokens) + ' tokens'
        : '本条注入内容输入 ' + Math.round(tokens) + ' tokens'
      return h(
        'div',
        { className: 'dsh-token-badges-user', style: rowStyle(align) },
        h(
          'span',
          {
            className: 'dsh-token-badges-pill',
            style: pillStyle(align),
            title: hint
          },
          h('span', { style: dotStyle(human ? ACCENT : TEXT_SOFT) }),
          h('span', null, label)
        )
      )
    }

    // ============================================================
    // Definition 2：turn-token —— 回合输出 token，常驻回答流最下方
    // ============================================================
    function turnOfEvent(event) {
      var data = event.data
      if (data && typeof data.turn === 'number') return data.turn
      return undefined
    }

    /** 事件类型里带回合坐标的，都属于 turn-token 的更新范围。 */
    function isTurnScoped(event) {
      var type = event.type
      return (
        type === 'step/start' ||
        type === 'step/end' ||
        type === 'assistant/message' ||
        type === 'assistant/attempt' ||
        type === 'llm/retry' ||
        type === 'llm/retry-started' ||
        type === 'tool/call' ||
        type === 'tool/result' ||
        type === 'user/message'
      )
    }

    var turnTokenDefinition = {
      kind: 'turn-token',
      target: 'chat',
      match: function (event) {
        if (event.type === 'turn/start') {
          return { id: String(event.data.turn), role: 'start' }
        }
        if (event.type === 'turn/end') {
          return { id: String(event.data.turn), role: 'update' }
        }
        if (isTurnScoped(event)) {
          var turn = turnOfEvent(event)
          if (turn === undefined) return null
          return { id: String(turn), role: 'update' }
        }
        return null
      },
      start: function (context, match) {
        return {
          turn: match.event.data.turn,
          outputTokens: 0,
          attempts: 0,
          ended: false,
          latestSeq: match.event.seq
        }
      },
      update: function (context, match) {
        var state = context.state
        var event = match.event
        if (event.type === 'turn/end') {
          return {
            turn: state.turn,
            outputTokens: state.outputTokens,
            attempts: state.attempts,
            ended: true,
            latestSeq: Math.max(state.latestSeq, event.seq)
          }
        }
        var outputTokens = state.outputTokens
        var attempts = state.attempts
        if (event.type === 'assistant/message') {
          var usage = event.data.usage
          if (usage && typeof usage.outputTokens === 'number' && usage.outputTokens >= 0) {
            outputTokens += usage.outputTokens
            attempts += 1
          }
        }
        return {
          turn: state.turn,
          outputTokens: outputTokens,
          attempts: attempts,
          ended: false,
          latestSeq: Math.max(state.latestSeq, event.seq)
        }
      },
      publication: function () {
        return 'immediate'
      },
      buildViewNode: function (context) {
        if (context.state === undefined) return null
        return {
          key: context.key,
          kind: 'turn-token',
          id: context.id,
          target: 'chat',
          anchorSeq: context.state.latestSeq + TURN_TOKEN_OFFSET,
          // 同样不归属 turn/step：避免被吸进工作流折叠块而随折叠隐藏。
          location: UNRESOLVED,
          visibility: 'visible',
          data: {
            turn: context.state.turn,
            outputTokens: context.state.outputTokens,
            attempts: context.state.attempts,
            ended: context.state.ended
          }
        }
      }
    }

    /** 回合输出 token 徽章：进行中显示累计值，结束显示最终值。 */
    function TurnTokenNodeView(props) {
      var node = props.node
      var data = node.data
      var text = formatTokens(data.outputTokens)
      if (text === null) return null
      var label
      if (data.ended) {
        label = '本回合共输出 ' + text + ' tokens'
      } else {
        label = '本回合输出 ' + text + ' tokens（进行中）'
      }
      return h(
        'div',
        { className: 'dsh-token-badges-turn', style: rowStyle('start') },
        h(
          'span',
          {
            className: 'dsh-token-badges-pill',
            style: pillStyle('start'),
            title: '本回合累计输出 ' + Math.round(data.outputTokens) + ' tokens'
          },
          h('span', { style: dotStyle(data.ended ? TEXT_SOFT : ACCENT) }),
          h('span', null, label)
        )
      )
    }

    // ---- apply：注册 Definition 与渲染器 ----
    function apply(ctx) {
      ctx.uiConversation.events.register(userTokenDefinition)
      ctx.uiConversation.events.register(turnTokenDefinition)
      ctx.slots.inject('conversation.chat.node', function () {
        return ctx.slots.register(
          { name: 'conversation.chat.node', key: 'user-token' },
          UserTokenNodeView
        )
      })
      ctx.slots.inject('conversation.chat.node', function () {
        return ctx.slots.register(
          { name: 'conversation.chat.node', key: 'turn-token' },
          TurnTokenNodeView
        )
      })
    }

    exports.inject = ['uiConversation', 'slots']
    exports.apply = apply
    return module.exports
  }
})
