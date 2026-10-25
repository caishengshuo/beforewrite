/**
 * BeforeWrite · 时间轴界面（Client half）
 *
 * 纯 JS，无构建步骤：window.__ModuleLoader__.load({ id, factory })。
 * 挂在 shell.overlay 上 —— 那是「浮在整个界面之上、默认点击穿透」的一层，
 * 只有我们自己画的按钮和面板接管鼠标事件，不会挡住对话。
 *
 * 数据全部来自宿主半边的同源接口 /beforewrite/api/*：
 *   GET /sessions              每个会话一行（首句台词 + 快照数）
 *   GET /timeline?sid=SID      该会话时间轴（用户台词 / 工具动作 / 文件快照）
 *   GET /diff?id=N             某个快照与当前文件的差异
 *   GET /restore?id=N          把文件回滚到该快照
 */

window.__ModuleLoader__.load({
  // 这个 id 必须与 package.json 的 name 完全一致 —— 装载器按包名核对注册结果，
  // 不一致就会报 "loaded without registering ... via __ModuleLoader__.load"，
  // 并连带让整个 bundle（连宿主半边）都激活失败。
  id: 'dsh-beforewrite',

  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/beforewrite/api'
    const FRAGMENT = React.Fragment ? React.Fragment : 'div'

    /** 浏览器里看不到控制台，就把关键节点写回宿主日志（/beforewrite/api/client-log）。 */
    function slog(m) {
      try {
        fetch(API + '/client-log?m=' + encodeURIComponent(String(m)), { cache: 'no-store' })
      } catch (error) {
        /* 日志通道不通不影响功能 */
      }
    }

    const CSS = [
      '.bw-launch{position:fixed;right:18px;top:66px;z-index:2147482999;pointer-events:auto;',
      'display:flex;align-items:center;gap:6px;padding:8px 14px;border-radius:999px;cursor:pointer;',
      'font:600 13px/1 var(--font-sans,system-ui);color:#e9e9f0;',
      'background:#191a20;border:1px solid rgba(255,255,255,.2);',
      'box-shadow:0 6px 24px rgba(0,0,0,.55)}',
      '.bw-launch:hover{border-color:#5b8cff}',
      '.bw-mask{position:fixed;inset:0;z-index:2147483000;pointer-events:auto;display:flex;',
      'align-items:center;justify-content:center;background:rgba(6,7,10,.82);backdrop-filter:blur(3px)}',
      '.bw-panel{width:min(1040px,94vw);height:min(660px,88vh);display:flex;overflow:hidden;',
      'border-radius:14px;background:#14151a;color:#e9e9f0;',
      'border:1px solid rgba(255,255,255,.16);box-shadow:0 24px 64px rgba(0,0,0,.7);',
      'font:13px/1.5 var(--font-sans,system-ui);isolation:isolate}',
      '.bw-side{width:264px;flex:0 0 264px;border-right:1px solid rgba(255,255,255,.1);',
      'display:flex;flex-direction:column;overflow:hidden}',
      '.bw-side h4{margin:0;padding:14px 14px 8px;font:600 12px/1 var(--font-sans,system-ui);',
      'letter-spacing:.08em;color:var(--text-secondary,#9aa)}',
      '.bw-sessions{overflow:auto;padding:0 8px 10px}',
      '.bw-session{padding:8px 10px;border-radius:9px;cursor:pointer;margin-bottom:4px}',
      '.bw-session:hover{background:rgba(255,255,255,.06)}',
      '.bw-session.on{background:rgba(91,140,255,.18)}',
      '.bw-session b{display:block;font-weight:600;white-space:nowrap;overflow:hidden;',
      'text-overflow:ellipsis;font-size:12.5px}',
      '.bw-session span{display:block;color:var(--text-secondary,#9aa);font-size:11px;margin-top:2px}',
      '.bw-main{flex:1;display:flex;flex-direction:column;overflow:hidden}',
      '.bw-head{display:flex;align-items:center;gap:10px;padding:12px 16px;',
      'border-bottom:1px solid rgba(255,255,255,.1)}',
      '.bw-head .bw-title{font-weight:600;font-size:13.5px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.bw-x{border:0;background:transparent;color:var(--text-secondary,#9aa);cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;border-radius:6px}',
      '.bw-x:hover{background:rgba(255,255,255,.08);color:#fff}',
      '.bw-note{padding:8px 16px;font-size:12px;color:var(--text-secondary,#9aa);border-bottom:1px solid rgba(255,255,255,.06);white-space:pre-wrap}',
      '.bw-rows{flex:1;overflow:auto;padding:10px 16px 24px}',
      '.bw-row{display:flex;gap:10px;padding:7px 0;border-bottom:1px dashed rgba(255,255,255,.06)}',
      '.bw-time{flex:0 0 62px;color:var(--text-tertiary,#788);font-size:11px;padding-top:2px}',
      '.bw-badge{flex:0 0 46px;text-align:center;font-size:10.5px;border-radius:5px;height:18px;',
      'line-height:18px;align-self:flex-start;font-weight:600}',
      '.bw-b-says{background:rgba(91,140,255,.2);color:#9ec1ff}',
      '.bw-b-action{background:rgba(255,180,80,.16);color:#ffc978}',
      '.bw-b-snap{background:rgba(80,220,150,.16);color:#7fe3b0}',
      '.bw-b-other{background:rgba(255,255,255,.08);color:#aab}',
      '.bw-text{flex:1;min-width:0;word-break:break-word;white-space:pre-wrap;font-size:12.5px}',
      '.bw-act{flex:0 0 auto;display:flex;gap:6px;align-items:flex-start}',
      '.bw-btn{border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.05);',
      'color:#eee;border-radius:7px;padding:3px 9px;font:600 11.5px/1.5 var(--font-sans,system-ui);cursor:pointer}',
      '.bw-btn:hover{border-color:#5b8cff;color:#fff}',
      '.bw-btn[disabled]{opacity:.45;cursor:default}',
      '.bw-empty{padding:40px 16px;text-align:center;color:var(--text-secondary,#9aa);font-size:12.5px}',
    ].join('')

    function pad(n) {
      return String(n).padStart(2, '0')
    }
    function clock(ts) {
      if (!ts) return ''
      const d = new Date(ts)
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    }
    function shortSid(sid) {
      const s = String(sid || '')
      const m = s.match(/([0-9a-f]{8})/)
      return m ? m[1] : s.slice(-8)
    }
    function badgeOf(row) {
      if (row.kind === 'says') return ['says', '说过']
      if (row.kind === 'action') return ['action', '动作']
      if (row.kind === 'snap') return ['snap', '快照']
      if (row.kind === 'turn') return ['other', '回合']
      if (row.kind === 'result') return ['other', '结果']
      return ['other', String(row.kind || '事件')]
    }
    function errText(error) {
      return String(error && error.message ? error.message : error)
    }
    async function getJson(url) {
      const res = await fetch(url, { credentials: 'same-origin' })
      return res.json()
    }

    function SessionItem(props) {
      const s = props.row
      return h('div', {
        className: 'bw-session' + (s.sid === props.activeSid ? ' on' : ''),
        onClick: props.onPick,
      },
        h('b', null, s.first || '（这个会话还没说话）'),
        h('span', null, shortSid(s.sid) + ' · 台词 ' + (s.says || 0) + ' · 快照 ' + (s.snaps || 0))
      )
    }

    function Row(props) {
      const row = props.row
      const badge = badgeOf(row)
      const canRestore = row.kind === 'snap' && row.sha && !row.absent && !row.binary && !row.tooLarge
      const body = row.kind === 'snap'
        ? h('code', null, '#' + row.id + ' ' + String(row.text || ''))
        : String(row.text || '')
      return h('div', { className: 'bw-row' },
        h('div', { className: 'bw-time' }, clock(row.at)),
        h('div', { className: 'bw-badge bw-b-' + badge[0] }, badge[1]),
        h('div', { className: 'bw-text' }, body),
        h('div', { className: 'bw-act' },
          canRestore
            ? h('button', { className: 'bw-btn', disabled: props.busy, onClick: props.onRestore }, '回档')
            : null
        )
      )
    }

    function Dock() {
      const [open, setOpen] = React.useState(false)
      const [sessions, setSessions] = React.useState([])
      const [sid, setSid] = React.useState('')
      const [rows, setRows] = React.useState([])
      const [note, setNote] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [cut, setCut] = React.useState(0)

      // 自检：面板到底有没有真的画出来、有没有被压在对话下面。
      if (React.useEffect) {
        React.useEffect(function () {
          if (!open) return undefined
          const timer = setTimeout(function () {
            try {
              const el = document.querySelector('.bw-mask')
              const r = el ? el.getBoundingClientRect() : null
              const top = document.elementFromPoint(
                Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2))
              slog('open mask=' + (r
                ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join('/')
                : 'none') + ' top=' + (top ? String(top.className || top.tagName).slice(0, 40) : 'null'))
            } catch (error) {
              slog('diag err ' + errText(error))
            }
          }, 400)
          return function () { clearTimeout(timer) }
        }, [open])
      }

      React.useEffect(function () {
        if (!open) return undefined
        let alive = true
        getJson(API + '/sessions').then(function (data) {
          if (!alive) return
          const list = Array.isArray(data && data.sessions) ? data.sessions : []
          setSessions(list)
          if (list.length === 0) setNote('还没有会话记录。跟 dsh 说一句话、让它动一下文件，这里就会长出来。')
          setSid(function (prev) { return prev || (list.length > 0 ? list[0].sid : '') })
        }).catch(function (error) {
          if (alive) setNote('取会话列表失败：' + errText(error))
        })
        return function () { alive = false }
      }, [open])

      React.useEffect(function () {
        if (!open || !sid) return undefined
        let alive = true
        getJson(API + '/timeline?sid=' + encodeURIComponent(sid)).then(function (data) {
          if (!alive) return
          setRows(Array.isArray(data && data.rows) ? data.rows : [])
          const cut = data && data.truncated
          setCut(cut ? Number(data.total || 0) - (data.rows ? data.rows.length : 0) : 0)
        }).catch(function (error) {
          if (alive) setNote('取时间轴失败：' + errText(error))
        })
        return function () { alive = false }
      }, [open, sid])

      function restore(row) {
        if (busy) return
        setBusy(true)
        setNote('正在回档 #' + row.id + ' …')
        fetch(API + '/restore?id=' + encodeURIComponent(row.id), {
          method: 'POST',
          credentials: 'same-origin',
        }).then(function (res) { return res.json() }).then(function (data) {
          setNote(String((data && data.text) || '已回档。'))
          return getJson(API + '/timeline?sid=' + encodeURIComponent(sid))
        }).then(function (again) {
          if (again && Array.isArray(again.rows)) setRows(again.rows)
        }).catch(function (error) {
          setNote('回档失败：' + errText(error))
        }).then(function () {
          setBusy(false)
        })
      }

      const launch = h('div', {
        className: 'bw-launch',
        onClick: function () { slog('launch clicked'); setOpen(true) },
        title: 'BeforeWrite · 文件时光机',
      }, h('span', null, '⏱'), h('span', null, '时光机'))

      if (!open) return h(FRAGMENT, null, launch)

      const sessionList = sessions.length === 0
        ? h('div', { className: 'bw-empty' }, '还没有记录')
        : sessions.map(function (s) {
            return h(SessionItem, {
              key: s.sid,
              row: s,
              activeSid: sid,
              onPick: function () { setNote(''); setSid(s.sid) },
            })
          })

      const body = rows.length === 0
        ? h('div', { className: 'bw-empty' }, '这个会话还没有可显示的事件。')
        : rows.map(function (row, index) {
            return h(Row, {
              key: String(row.kind) + '-' + index,
              row: row,
              busy: busy,
              onRestore: function () { restore(row) },
            })
          })

      const side = h('div', { className: 'bw-side' },
        h('h4', null, '会话'),
        h('div', { className: 'bw-sessions' }, sessionList)
      )

      const main = h('div', { className: 'bw-main' },
        h('div', { className: 'bw-head' },
          h('div', { className: 'bw-title' }, sid ? shortSid(sid) + ' 的时间轴' : '时间轴'),
          h('button', { className: 'bw-x', onClick: function () { setOpen(false) }, title: '关闭' }, '×')
        ),
        note ? h('div', { className: 'bw-note' }, note) : null,
        cut > 0
          ? h('div', { className: 'bw-note' }, '时间轴太长，只显示最近 ' + rows.length + ' 条（更早的 ' + cut + ' 条没画出来；要回档更早的版本，直接用编号调接口或用工具）。')
          : null,
        h('div', { className: 'bw-rows' }, body)
      )

      const panel = h('div', {
        className: 'bw-panel',
        style: {
          width: 'min(1040px,94vw)', height: 'min(660px,88vh)', display: 'flex', overflow: 'hidden',
          borderRadius: '14px', background: '#14151a', color: '#e9e9f0',
          border: '1px solid rgba(255,255,255,.16)', boxShadow: '0 24px 64px rgba(0,0,0,.7)',
        },
      }, side, main)

      const mask = h('div', {
        className: 'bw-mask',
        style: {
          position: 'fixed', left: 0, top: 0, right: 0, bottom: 0, zIndex: 2147483000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(6,7,10,.86)', pointerEvents: 'auto',
        },
        onMouseDown: function (event) {
          if (event.target === event.currentTarget) setOpen(false)
        },
      }, panel)

      return h(FRAGMENT, null, launch, mask)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 样式走 DOM 注入：实测宿主里 require('styles') 拿不到，只靠它整块面板会变成
        // 无样式的裸文字盖在对话上（半透明、看不清）。DOM 注入是主路径，styles 服务顺带试一下。
        try {
          const styles = require('styles')
          if (styles && typeof styles.insert === 'function') {
            ctx.effect(function () { return styles.insert(CSS) }, 'beforewrite-styles')
          }
        } catch (error) {
          /* 服务不可用无所谓，下面这份一定生效 */
        }
        ctx.effect(function () {
          const el = document.createElement('style')
          el.setAttribute('data-beforewrite', '1')
          el.textContent = CSS
          document.head.appendChild(el)
          return function () {
            if (el.parentNode) el.parentNode.removeChild(el)
          }
        }, 'beforewrite-styles-dom')
        slog('apply done, styleTags=' + document.querySelectorAll('style[data-beforewrite]').length + ', cssLen=' + CSS.length)
        ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register({ name: 'shell.overlay', id: 'beforewrite-timeline', order: 60 }, Dock)
        })
      },
    }
  },
})
