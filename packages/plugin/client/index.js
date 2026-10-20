// dsh-session-sync 浏览器半边。
//
// - `plugins.bundle.config`：Plugins 页里的自定义设置页（连接、凭据、工作区、同步行为）。
// - `shell.overlay`：首启向导 + 顶部同步气泡。
// - 非敏感字段写 settings；token/passphrase 只写 `ctx.remote.credentials`。
//
// 本文件是手写 JS，不参与 `scripts/build.mjs` 的 TypeScript 转换；加载形态与
// dsh-time-reminder 一致。
window.__ModuleLoader__.load({
  id: 'dsh-session-sync',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useState = React.useState

    var API = '/api/session-sync'
    var SETTINGS_NS = 'session-sync'
    /** 与宿主 src/index.ts 的 CREDENTIAL_REFS 保持一致。 */
    var CREDENTIAL_REFS = {
      token: 'DSH_SESSION_SYNC_TOKEN',
      passphrase: 'DSH_SESSION_SYNC_PASSPHRASE',
    }
    var INTERVALS = [
      { ms: 15000, label: '15 秒' },
      { ms: 30000, label: '30 秒' },
      { ms: 60000, label: '1 分钟' },
      { ms: 300000, label: '5 分钟' },
    ]
    var ONBOARD_DISMISSED = 'dsh-session-sync.onboarding.dismissed'

    var CSS = [
      '.dssync{--dssync-accent:#5686fe;--dssync-accent-soft:rgba(86,134,254,.14);--dssync-line:var(--dsw-alias-border-l2,rgba(127,127,127,.24));--dssync-line-strong:var(--dsw-alias-border-l4,rgba(127,127,127,.42));--dssync-text:var(--dsw-alias-label-primary,inherit);--dssync-muted:var(--dsw-alias-label-secondary,rgba(220,220,230,.7));--dssync-faint:var(--dsw-alias-label-tertiary,rgba(220,220,230,.46));color:var(--dssync-text);font-size:14px;line-height:1.55}',
      '.dssync *{box-sizing:border-box}',
      '.dssync-page{display:flex;flex-direction:column;gap:22px;padding:4px 0 28px}',
      '.dssync-sec{display:flex;flex-direction:column;gap:12px;padding:0 0 20px;border-bottom:1px solid var(--dssync-line)}',
      '.dssync-sec:last-child{border-bottom:0;padding-bottom:0}',
      '.dssync-sechead{display:flex;align-items:baseline;gap:10px}',
      '.dssync-sechead h3{margin:0;font-size:15px;font-weight:600}',
      '.dssync-sechead span{color:var(--dssync-faint);font-size:12px}',
      '.dssync-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}',
      '@media(max-width:640px){.dssync-grid{grid-template-columns:1fr}}',
      '.dssync-field{display:flex;flex-direction:column;gap:5px;min-width:0}',
      '.dssync-field label{font-size:12px;color:var(--dssync-muted)}',
      '.dssync-field input,.dssync-field select{width:100%;height:34px;padding:0 10px;border:1px solid var(--dssync-line-strong);border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.18));color:var(--dssync-text);font:inherit;font-size:13px;outline:none}',
      '.dssync-field input:focus,.dssync-field select:focus{border-color:var(--dssync-accent)}',
      '.dssync-field .hint{font-size:11.5px;color:var(--dssync-faint)}',
      '.dssync-row{display:flex;align-items:center;gap:12px;min-height:34px}',
      '.dssync-rowtext{flex:1;min-width:0}',
      '.dssync-rowtext b{display:block;font-size:13px;font-weight:500}',
      '.dssync-rowtext span{display:block;color:var(--dssync-faint);font-size:12px}',
      '.dssync-pill{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 13px;border:1px solid var(--dssync-line-strong);border-radius:999px;background:transparent;color:var(--dssync-text);font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap}',
      '.dssync-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.dssync-pill.primary{background:var(--dssync-accent);border-color:var(--dssync-accent);color:#fff}',
      '.dssync-pill.primary:hover{filter:brightness(1.06)}',
      '.dssync-pill:disabled{opacity:.5;cursor:default}',
      '.dssync-pill.bad{color:var(--dsw-alias-state-error-primary,#ffb1b1);border-color:rgba(239,68,68,.38)}',
      '.dssync-btnrow{display:flex;align-items:center;gap:9px;flex-wrap:wrap}',
      '.dssync-btnrow .spacer{flex:1 1 auto}',
      '.dssync-note{color:var(--dssync-faint);font-size:12px}',
      '.dssync-note.warn{color:var(--dsw-alias-state-warn-primary,#f0b64a)}',
      '.dssync-note.bad{color:var(--dsw-alias-state-error-primary,#ffb1b1)}',
      '.dssync-wslist{display:flex;flex-direction:column;gap:7px}',
      '.dssync-ws{display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid var(--dssync-line);border-radius:9px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.025))}',
      '.dssync-ws.on{border-color:rgba(86,134,254,.42);background:var(--dssync-accent-soft)}',
      '.dssync-ws input{width:15px;height:15px;accent-color:var(--dssync-accent);flex:0 0 auto}',
      '.dssync-ws-main{min-width:0;flex:1 1 auto}',
      '.dssync-ws-main b{display:block;font-size:12.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dssync-ws-main span{display:block;color:var(--dssync-faint);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dssync-ws-count{color:var(--dssync-faint);font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.dssync-switch{position:relative;display:inline-flex;width:38px;height:22px;flex:0 0 auto}',
      '.dssync-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}',
      '.dssync-switch i{position:absolute;inset:0;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.3));transition:background .16s;pointer-events:none}',
      '.dssync-switch i:after{content:"";position:absolute;left:2px;top:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.28);transition:transform .16s}',
      '.dssync-switch input:checked+i{background:var(--dssync-accent)}',
      '.dssync-switch input:checked+i:after{transform:translateX(16px)}',
      '.dssync-toast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,10px);z-index:2147483001;max-width:min(520px,calc(100vw - 32px));padding:10px 14px;border:1px solid var(--dssync-line-strong);border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(34,34,36,.97));box-shadow:0 16px 40px rgba(0,0,0,.42);color:var(--dssync-text);font-size:12.5px;line-height:1.5;opacity:0;pointer-events:none;transition:opacity .18s,transform .18s}',
      '.dssync-toast.on{opacity:1;transform:translate(-50%,0)}',
      '.dssync-toast.bad{color:#ffb1b1;border-color:rgba(239,68,68,.32)}',
      /* onboarding */
      '.dssync-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:28px;background:rgba(8,8,10,.58);backdrop-filter:blur(7px);animation:dssync-overlay-in .24s ease both}',
      '.dssync-wizard{width:min(680px,100%);max-height:calc(100vh - 56px);overflow:auto;scrollbar-gutter:stable;border:1px solid var(--dssync-line-strong);border-radius:18px;background:var(--dsw-alias-bg-layer-1,#1d1d1f);box-shadow:0 28px 80px rgba(0,0,0,.5);padding:26px 28px 22px;animation:dssync-wizard-in .32s cubic-bezier(.16,1,.3,1) both}',
      '.dssync-wizard-body{display:flex;flex-direction:column;gap:14px;min-height:150px;animation:dssync-step-next .24s cubic-bezier(.16,1,.3,1) both}',
      '.dssync-step-back{animation-name:dssync-step-back}',
      '@keyframes dssync-overlay-in{from{opacity:0}to{opacity:1}}',
      '@keyframes dssync-wizard-in{from{opacity:0;transform:translateY(-14px) scale(.97)}to{opacity:1;transform:none}}',
      '@keyframes dssync-step-next{from{opacity:0;transform:translateX(10px)}to{opacity:1;transform:none}}',
      '@keyframes dssync-step-back{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:none}}',
      '.dssync-wizard-head{display:flex;align-items:flex-start;gap:14px;margin-bottom:20px;position:relative}',
      '.dssync-wizard-icon{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;background:var(--dssync-accent-soft);color:#b9ccff;flex:0 0 auto}',
      '.dssync-wizard h2{margin:0;font-size:22px;line-height:1.25;font-weight:600}',
      '.dssync-wizard p{margin:5px 0 0;color:var(--dssync-muted);font-size:13px}',
      '.dssync-close{position:absolute;right:0;top:0;width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:var(--dssync-muted);cursor:pointer;font-size:18px;line-height:1}',
      '.dssync-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
      '.dssync-steps{display:flex;align-items:center;gap:8px;margin:0 0 22px;list-style:none;padding:0}',
      '.dssync-step{display:flex;align-items:center;gap:7px;flex:1 1 0;min-width:0;color:var(--dssync-faint);font-size:12px;white-space:nowrap}',
      '.dssync-step i{width:23px;height:23px;border-radius:50%;display:grid;place-items:center;border:1px solid var(--dssync-line-strong);font-style:normal;font-size:11px;flex:0 0 auto}',
      '.dssync-step.on{color:var(--dssync-text)}',
      '.dssync-step.on i{border-color:var(--dssync-accent);background:var(--dssync-accent);color:#fff}',
      '.dssync-step.done i{border-color:rgba(34,197,94,.55);color:#7ee2a8}',
      '.dssync-step:not(:last-child):after{content:"";height:1px;background:var(--dssync-line);flex:1 1 auto;min-width:8px}',
      '.dssync-wizard-foot{display:flex;align-items:center;gap:9px;margin-top:22px;padding-top:16px;border-top:1px solid var(--dssync-line)}',
      '.dssync-wizard-foot .spacer{flex:1 1 auto}',
      /* bubble */
      '.dssync-bubble-wrap{position:fixed;top:58px;left:50%;transform:translateX(-50%);z-index:2147483000;width:min(560px,calc(100vw - 32px));transition:width .34s cubic-bezier(.16,1,.3,1)}',
      '.dssync-bubble-wrap.collapsed{width:30px}',
      '.dssync-bubble{width:100%;max-height:56px;overflow:hidden;border:1px solid var(--dssync-line-strong);border-radius:12px;background:var(--dsw-alias-bg-layer-2,rgba(34,34,36,.97));box-shadow:0 18px 44px rgba(0,0,0,.42);backdrop-filter:blur(16px);transition:max-height .32s cubic-bezier(.16,1,.3,1),border-radius .3s,border-color .2s}',
      '.dssync-bubble.open{max-height:500px}',
      '.dssync-bubble.collapsed{max-height:30px;border-radius:9px}',
      '.dssync-bubble.bad{border-color:rgba(239,68,68,.3)}',
      '.dssync-bubble-head{display:flex;align-items:center;gap:9px;height:40px;padding:0 11px;cursor:pointer;user-select:none;transition:padding .34s,height .34s}',
      '.dssync-bubble.collapsed .dssync-bubble-head{height:28px;padding:0;justify-content:flex-start}',
      '.dssync-cloud{width:23px;height:23px;flex:0 0 auto;display:grid;place-items:center;position:relative;border:0;border-radius:7px;padding:0;cursor:pointer;color:#b9ccff;background:transparent;transition:width .34s,height .34s,background .15s}',
      '.dssync-cloud:hover{background:rgba(86,134,254,.14)}',
      '.dssync-cloud svg{width:20px;height:20px}',
      '.dssync-bubble.collapsed .dssync-cloud{width:28px;height:28px}',
      '.dssync-dot{position:absolute;right:1px;bottom:1px;width:6px;height:6px;border-radius:50%;background:var(--dssync-faint);border:1.5px solid #232324}',
      '.dssync-dot.syncing{background:#f0b64a}.dssync-dot.bad{background:#ef4444}.dssync-dot.ok{background:#22c55e}.dssync-dot.warn{background:#f59e0b}',
      '.dssync-label{min-width:0;flex:1 1 auto;max-width:100%;overflow:hidden;transition:max-width .34s,opacity .18s}',
      '.dssync-label b{display:block;font-size:12px;font-weight:500;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dssync-label span{display:block;color:var(--dssync-faint);font-size:10.5px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dssync-count{margin-left:auto;color:#c6d7ff;font-size:11px;font-variant-numeric:tabular-nums;flex:0 0 auto;max-width:80px;overflow:hidden;transition:max-width .34s,opacity .18s}',
      '.dssync-chev{width:20px;height:20px;max-width:20px;display:grid;place-items:center;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dssync-faint);cursor:pointer;overflow:hidden;transition:transform .18s,background .15s,max-width .34s,opacity .18s}',
      '.dssync-chev:hover{background:rgba(255,255,255,.06);color:var(--dssync-text)}',
      '.dssync-bubble.open .dssync-chev{transform:rotate(180deg)}',
      '.dssync-bubble.collapsed .dssync-label{max-width:0;opacity:0}',
      '.dssync-bubble.collapsed .dssync-count,.dssync-bubble.collapsed .dssync-chev{max-width:0;opacity:0}',
      '.dssync-segbar{display:flex;height:6px;margin:0 11px 9px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden;transition:opacity .18s}',
      '.dssync-bubble.collapsed .dssync-segbar{opacity:0}',
      '.dssync-seg{position:relative;flex:1 1 0;min-width:0;overflow:hidden;background:rgba(255,255,255,.06)}',
      '.dssync-seg i{position:absolute;inset:0 auto 0 0;width:0;background:#f0b64a;transition:width .2s linear}',
      '.dssync-seg.run i{background:linear-gradient(90deg,#f0b64a,#ffd27a,#f0b64a);background-size:200% 100%;animation:dssync-flow 1.2s linear infinite}',
      '.dssync-seg.done i{width:100%!important;background:#22c55e}',
      '.dssync-seg.bad i{width:100%!important;background:#ef4444}',
      '@keyframes dssync-flow{to{background-position:-200% 0}}',
      '.dssync-collapse{display:grid;grid-template-rows:0fr;transition:grid-template-rows .3s cubic-bezier(.2,.8,.2,1)}',
      '.dssync-bubble.open .dssync-collapse{grid-template-rows:1fr}',
      '.dssync-collapse-in{min-height:0;overflow:hidden;opacity:0;transform:translateY(-4px);transition:opacity .18s,transform .26s}',
      '.dssync-bubble.open .dssync-collapse-in{opacity:1;transform:none}',
      '.dssync-panel{padding:2px 10px 4px;max-height:250px;overflow:auto}',
      '.dssync-rowline{display:flex;align-items:center;gap:8px;padding:5px 4px;border-radius:6px;font-size:11.5px}',
      '.dssync-rowline .name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dssync-muted)}',
      '.dssync-rowline .name.child{padding-left:12px;color:var(--dssync-faint)}',
      '.dssync-rowline .tag{margin-left:auto;color:var(--dssync-faint);font-size:10px;white-space:nowrap}',
      '.dssync-st{width:6px;height:6px;border-radius:50%;flex:0 0 auto;background:var(--dssync-faint)}',
      '.dssync-st.ok{background:#22c55e}.dssync-st.bad{background:#ef4444}.dssync-st.run{background:#f0b64a}',
      '.dssync-error{margin:0 8px 8px;padding:8px 9px;border:1px solid rgba(239,68,68,.24);border-radius:8px;background:rgba(239,68,68,.09);color:#ffb1b1;font-size:11px;line-height:1.5}',
      '.dssync-foot{display:flex;align-items:center;gap:8px;padding:8px 10px;border-top:1px solid var(--dssync-line);color:var(--dssync-faint);font-size:10.5px}',
      '.dssync-foot .spacer{flex:1 1 auto}',
      '.dssync-mini{height:24px;padding:0 9px;border:1px solid var(--dssync-line-strong);border-radius:999px;background:transparent;color:var(--dssync-text);font:inherit;font-size:10.5px;cursor:pointer}',
      '.dssync-mini:hover{background:rgba(127,127,127,.12)}',
      '.dssync-mini.primary{background:var(--dssync-accent);border-color:var(--dssync-accent);color:#fff}',
      '.dssync-rowmark{width:13px;height:13px;border-radius:50%;display:grid;place-items:center;color:#f0b64a;background:rgba(240,182,74,.14);font-size:9px;line-height:1}',
      '.dssync-rowmark.tail{color:#b9ccff;background:rgba(86,134,254,.14)}',
      '.dssync-hovernote{padding:7px 2px;border-top:1px solid var(--dssync-line);color:var(--dssync-faint);font-size:11px;line-height:1.45}',
      '@media(prefers-reduced-motion:reduce){.dssync *,.dssync *:before,.dssync *:after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}',
    ].join('')

    /* ---------- 小工具 ---------- */

    function formatAgo(ms) {
      if (ms === null || ms === undefined) return '从未'
      var delta = Date.now() - ms
      if (delta < 60000) return '刚刚'
      if (delta < 3600000) return Math.floor(delta / 60000) + ' 分钟前'
      if (delta < 86400000) return Math.floor(delta / 3600000) + ' 小时前'
      return Math.floor(delta / 86400000) + ' 天前'
    }

    function formatInterval(ms) {
      if (ms < 60000) return Math.round(ms / 1000) + ' 秒'
      if (ms < 3600000) return Math.round(ms / 60000) + ' 分钟'
      return Math.round(ms / 3600000) + ' 小时'
    }

    function errorText(error) {
      if (error === null || error === undefined) return ''
      if (typeof error === 'string') return error
      return error.message || String(error)
    }

    function cloudIcon() {
      return h('svg', {
        viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      },
      h('path', { d: 'M7 18h10a4 4 0 0 0 .8-7.92A6 6 0 0 0 6.2 8.6 4.5 4.5 0 0 0 7 18Z' }),
      h('path', { d: 'M12 13v5m0-5 2 2m-2-2-2 2' }))
    }

    function chevronIcon() {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      }, h('path', { d: 'm6 9 6 6 6-6' }))
    }

    function shieldIcon() {
      return h('svg', {
        width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      }, h('path', { d: 'M12 3 5 6v5c0 4.6 2.9 8.2 7 10 4.1-1.8 7-5.4 7-10V6l-7-3Z' }), h('path', { d: 'm9 12 2 2 4-4' }))
    }

    function fetchJson(path, options) {
      var init = Object.assign({ credentials: 'same-origin' }, options || {})
      if (init.body !== undefined && init.headers === undefined) init.headers = { 'content-type': 'application/json' }
      return fetch(API + path, init).then(function (response) {
        return response.json().then(function (body) {
          if (!response.ok || !body || body.ok !== true) {
            var message = body && body.error ? body.error.message : 'HTTP ' + response.status
            var code = body && body.error ? body.error.code : 'http'
            var failure = new Error(message)
            failure.code = code
            throw failure
          }
          return body.value
        }, function () {
          throw new Error('HTTP ' + response.status + ' 响应不是 JSON')
        })
      })
    }

    /* ---------- 共享模型 ---------- */

    function createModel() {
      var snapshot = {
        loading: true, setup: null, status: null, workspaces: null,
        error: null, toast: null,
      }
      var listeners = new Set()
      var pollTimer = null
      var toastTimer = null
      var inflight = null
      var disposed = false

      function getSnapshot() { return snapshot }

      function subscribe(listener) {
        listeners.add(listener)
        return function () { listeners.delete(listener) }
      }

      function patch(next) {
        if (disposed) return
        snapshot = Object.assign({}, snapshot, next)
        listeners.forEach(function (listener) {
          try { listener() } catch (error) { console.error(error) }
        })
      }

      function schedule() {
        if (pollTimer !== null) clearTimeout(pollTimer)
        pollTimer = null
        if (disposed) return
        var status = snapshot.status
        if (status === null) return
        if (!status.running && status.pending === null) return
        pollTimer = setTimeout(function () {
          refreshStatus().finally(schedule)
        }, 1000)
      }

      async function refreshStatus() {
        try {
          var status = await fetchJson('/status')
          patch({ status: status, loading: false })
          return status
        } catch (error) {
          patch({ loading: false, error: errorText(error) })
          return null
        } finally {
          schedule()
        }
      }

      async function refreshSetup() {
        try {
          var setup = await fetchJson('/setup')
          patch({ setup: setup })
          return setup
        } catch (error) {
          patch({ error: errorText(error) })
          return null
        }
      }

      async function refreshWorkspaces() {
        try {
          var workspaces = await fetchJson('/workspaces')
          patch({ workspaces: workspaces })
          return workspaces
        } catch (error) {
          patch({ error: errorText(error) })
          return null
        }
      }

      function refreshAll() {
        if (inflight !== null) return inflight
        inflight = Promise.all([refreshStatus(), refreshSetup()]).then(function (values) {
          inflight = null
          return values
        }, function (error) {
          inflight = null
          patch({ error: errorText(error) })
          return []
        })
        return inflight
      }

      async function syncNow() {
        var result = await fetchJson('/sync', { method: 'POST', body: '{}' })
        await refreshStatus()
        return result
      }

      async function testConnection() {
        return fetchJson('/test', { method: 'POST', body: '{}' })
      }

      function toast(text, bad) {
        if (toastTimer !== null) clearTimeout(toastTimer)
        patch({ toast: { text: text, bad: bad === true, at: Date.now() } })
        toastTimer = setTimeout(function () { patch({ toast: null }) }, 4200)
      }

      function dispose() {
        disposed = true
        if (pollTimer !== null) clearTimeout(pollTimer)
        if (toastTimer !== null) clearTimeout(toastTimer)
        listeners.clear()
      }

      return {
        getSnapshot: getSnapshot,
        subscribe: subscribe,
        refreshAll: refreshAll,
        refreshStatus: refreshStatus,
        refreshSetup: refreshSetup,
        refreshWorkspaces: refreshWorkspaces,
        syncNow: syncNow,
        testConnection: testConnection,
        toast: toast,
        dispose: dispose,
      }
    }

    function useModel(model) {
      var pair = useState(function () { return model.getSnapshot() })
      useEffect(function () {
        return model.subscribe(function () { pair[1](model.getSnapshot()) })
      }, [model])
      return pair[0]
    }

    function useToast(model) {
      var state = useModel(model)
      return state.toast
    }

    function Toast(props) {
      var toast = useToast(props.model)
      return h('div', {
        className: 'dssync dssync-toast' + (toast ? ' on' : '') + (toast && toast.bad ? ' bad' : ''),
        role: 'status', 'aria-live': 'polite',
      }, toast ? toast.text : '')
    }

    function statusDot(status) {
      if (status === null) return 'warn'
      if (status.running) return 'syncing'
      if (status.lastError !== null) return 'bad'
      if (status.configured) return 'ok'
      return 'warn'
    }

    /** 一个会话当前的同步保护状态：正在应用 / 开放尾。 */
    function sessionState(status, sessionId) {
      if (status === null) return { pending: false, tail: false, lag: false }
      var pending = status.pending !== null && status.pending !== undefined && status.pending.sessionId === sessionId
      var tail = false
      var lag = false
      if (Array.isArray(status.sessions)) {
        tail = status.sessions.some(function (view) {
          return view.sessionId === sessionId && view.direction === 'push' && view.tailOpen === true
        })
        lag = status.sessions.some(function (view) {
          return view.sessionId === sessionId && view.direction === 'push' && view.status === 'remote-ahead'
        })
      }
      return { pending: pending, tail: tail, lag: lag }
    }

    function sessionBlockReason(status, sessionId) {
      var state = sessionState(status, sessionId)
      if (state.pending) return '正在应用云端写入，暂不能继续这个会话'
      if (state.tail) return '这个会话有未闭合的同步尾巴，先完成当前轮次再打开'
      if (state.lag) return '这个会话的安全边界还落后于远端，暂不能继续'
      return null
    }

    /* ---------- 设置页 ---------- */

    function fieldsFrom(value, setup) {
      var source = value || {}
      var fallback = setup || {}
      return {
        serverUrl: source.serverUrl !== undefined ? source.serverUrl : (fallback.serverUrl || ''),
        deviceName: source.deviceName !== undefined ? source.deviceName : (fallback.deviceName || ''),
        workspacePath: source.workspacePath !== undefined ? source.workspacePath : (fallback.workspacePath || ''),
        workspaceAllowlist: Array.isArray(source.workspaceAllowlist) ? source.workspaceAllowlist.slice() : ((fallback.workspaceAllowlist || []).slice()),
        autoSync: source.autoSync !== undefined ? source.autoSync !== false : fallback.autoSync !== false,
        intervalMs: source.intervalMs !== undefined ? source.intervalMs : (fallback.intervalMs || 60000),
        includeSubagents: source.includeSubagents !== undefined ? source.includeSubagents !== false : fallback.includeSubagents !== false,
      }
    }

    function Field(props) {
      return h('div', { className: 'dssync-field' },
        h('label', { htmlFor: props.id }, props.label),
        props.children,
        props.hint ? h('div', { className: 'hint' }, props.hint) : null)
    }

    function Switch(props) {
      return h('span', { className: 'dssync-switch' },
        h('input', {
          type: 'checkbox', checked: props.checked, disabled: props.disabled,
          'aria-label': props.label,
          onChange: function (event) { props.onChange(event.target.checked) },
        }),
        h('i'))
    }

    function SyncSettingsPage(props) {
      var model = props.model
      var state = useModel(model)
      var form = props.form || null
      var formTick = useState(0)
      useEffect(function () {
        if (form === null || typeof form.subscribe !== 'function') return undefined
        return form.subscribe(function () { formTick[1](function (value) { return value + 1 }) })
      }, [form])
      var formState = form === null ? null : (form.state || (typeof form.getSnapshot === 'function' ? form.getSnapshot() : null))
      var revision = formState ? formState.revision : undefined
      var initial = fieldsFrom(formState && formState.value, state.setup)
      var fieldsState = useState(initial)
      var fields = fieldsState[0]
      var setFields = fieldsState[1]
      var tokenState = useState('')
      var token = tokenState[0]
      var setToken = tokenState[1]
      var passState = useState('')
      var passphrase = passState[0]
      var setPassphrase = passState[1]
      var busyState = useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]
      var messageState = useState(null)
      var message = messageState[0]
      var setMessage = messageState[1]
      var lastRevision = useRef(revision)
      var loadedWorkspaces = useRef(false)

      useEffect(function () { model.refreshAll() }, [model])
      useEffect(function () {
        if (!loadedWorkspaces.current) {
          loadedWorkspaces.current = true
          if (state.workspaces === null) model.refreshWorkspaces()
        }
      }, [model, state.workspaces])
      useEffect(function () {
        if (revision !== lastRevision.current) {
          lastRevision.current = revision
          setFields(fieldsFrom(formState && formState.value, state.setup))
        }
      }, [revision])

      function set(key, value) {
        setFields(function (previous) {
          var next = Object.assign({}, previous)
          next[key] = value
          return next
        })
      }

      function toggleWorkspace(path) {
        setFields(function (previous) {
          var list = previous.workspaceAllowlist.slice()
          var index = list.indexOf(path)
          if (index >= 0) list.splice(index, 1)
          else list.push(path)
          return Object.assign({}, previous, { workspaceAllowlist: list })
        })
      }

      async function persistFields() {
        if (!form || !formState || formState.status !== 'ready' || !formState.writable) {
          setMessage({ bad: true, text: '设置当前不可写，请稍后再试' })
          return false
        }
        var ops = [
          { op: 'set', path: ['serverUrl'], value: String(fields.serverUrl || '').trim() },
          { op: 'set', path: ['deviceName'], value: String(fields.deviceName || '').trim() },
          { op: 'set', path: ['workspacePath'], value: String(fields.workspacePath || '').trim() },
          { op: 'set', path: ['workspaceAllowlist'], value: fields.workspaceAllowlist.slice() },
          { op: 'set', path: ['autoSync'], value: fields.autoSync === true },
          { op: 'set', path: ['intervalMs'], value: Number(fields.intervalMs) || 60000 },
          { op: 'set', path: ['includeSubagents'], value: fields.includeSubagents === true },
        ]
        var accepted = await form.mutate(ops, revision)
        if (!accepted) {
          setMessage({ bad: true, text: '设置被宿主拒绝，请检查值后重试' })
          return false
        }
        if (String(token).trim() !== '') {
          var tokenResult = await props.setCredential(CREDENTIAL_REFS.token, String(token).trim())
          if (!tokenResult.ok) throw new Error(tokenResult.message)
          setToken('')
        }
        if (String(passphrase).trim() !== '') {
          var passResult = await props.setCredential(CREDENTIAL_REFS.passphrase, String(passphrase).trim())
          if (!passResult.ok) throw new Error(passResult.message)
          setPassphrase('')
        }
        return true
      }

      async function save() {
        setBusy('save')
        setMessage(null)
        try {
          if (!await persistFields()) return
          await model.refreshAll()
          setMessage({ bad: false, text: '设置已保存' })
          model.toast('设置已保存')
        } catch (error) {
          setMessage({ bad: true, text: errorText(error) })
        } finally {
          setBusy('')
        }
      }

      async function test() {
        setBusy('test')
        setMessage(null)
        try {
          // 测试按钮必须测当前输入：先落盘非敏感字段和本次填写的凭据，
          // 再让宿主用它自己的配置发请求。
          if (!await persistFields()) return
          await new Promise(function (resolve) { setTimeout(resolve, 250) })
          var result = await model.testConnection()
          if (result && result.ok) {
            setMessage({ bad: false, text: '服务端可达，token 有效' })
            model.toast('服务端可达，token 有效')
          } else {
            setMessage({ bad: true, text: (result && result.message) || '连接失败' })
          }
          await model.refreshAll()
        } catch (error) {
          setMessage({ bad: true, text: errorText(error) })
        } finally {
          setBusy('')
        }
      }

      async function syncNow() {
        setBusy('sync')
        setMessage(null)
        try {
          var result = await model.syncNow()
          if (!result || result.ok !== true) {
            setMessage({ bad: true, text: (result && (result.message || result.code)) || '同步未执行' })
            return
          }
          setMessage({ bad: false, text: '已触发同步' })
          model.toast('已触发同步')
        } catch (error) {
          setMessage({ bad: true, text: errorText(error) })
        } finally {
          setBusy('')
        }
      }

      if (!form || !formState) {
        return h('div', { className: 'dssync dssync-page' },
          h('div', { className: 'dssync-note' }, '设置暂不可用。'))
      }
      if (props.view === 'summary') {
        var setup = state.setup
        var selected = setup ? setup.workspaceAllowlist.length : fields.workspaceAllowlist.length
        return h('span', null, '自部署同步 · ' + (setup && setup.configured ? '已配置' : '未配置') + ' · ' + selected + ' 个工作区')
      }

      var workspaces = state.workspaces
      var candidates = workspaces ? workspaces.workspaces : []
      var allPaths = candidates.map(function (item) { return item.path })
      var allSelected = allPaths.length > 0 && allPaths.every(function (path) { return fields.workspaceAllowlist.indexOf(path) >= 0 })
      var pullChoices = candidates.filter(function (item) { return fields.workspaceAllowlist.indexOf(item.path) >= 0 })
      if (fields.workspacePath !== '' && !pullChoices.some(function (item) { return item.path === fields.workspacePath })) {
        pullChoices = pullChoices.concat([{ path: fields.workspacePath, title: fields.workspacePath }])
      }
      var setupInfo = state.setup
      var tokenConfigured = setupInfo ? setupInfo.hasToken : false
      var passConfigured = setupInfo ? setupInfo.hasPassphrase : false
      var disabled = busy !== '' || formState.status !== 'ready' || !formState.writable

      return h('div', { className: 'dssync dssync-page' },
        h('section', { className: 'dssync-sec' },
          h('div', { className: 'dssync-sechead' },
            h('h3', null, '连接'),
            h('span', null, '自部署服务端')),
          h('div', { className: 'dssync-grid' },
            h(Field, { id: 'dssync-server', label: '服务端地址', hint: '填写后测试服务端与 token。' },
              h('input', {
                id: 'dssync-server', value: fields.serverUrl, spellCheck: false,
                placeholder: 'http://127.0.0.1:8787',
                onChange: function (event) { set('serverUrl', event.target.value) },
              })),
            h(Field, { id: 'dssync-device', label: '设备名称', hint: '用于日志与设备台账。' },
              h('input', {
                id: 'dssync-device', value: fields.deviceName,
                onChange: function (event) { set('deviceName', event.target.value) },
              }))),
          h(Field, {
            id: 'dssync-wspath',
            label: '拉取会话落到工作区（可选）',
            hint: '远端会话不带本地路径；选一个已选工作区作为落点。留空 = 只推送、不拉取。',
          },
          h('select', {
            id: 'dssync-wspath', value: fields.workspacePath,
            disabled: disabled || fields.workspaceAllowlist.length === 0,
            onChange: function (event) { set('workspacePath', event.target.value) },
          },
          h('option', { value: '' }, fields.workspaceAllowlist.length === 0 ? '先选择上面的同步工作区' : '不拉取（只推送）'),
          pullChoices.map(function (item) {
            return h('option', { value: item.path, key: item.path }, item.title || item.path)
          }))),
          h('div', { className: 'dssync-btnrow' },
            h('button', { className: 'dssync-pill', type: 'button', disabled: disabled || busy === 'test', onClick: test }, busy === 'test' ? '测试中…' : '测试连接'),
            h('span', { className: 'spacer' }),
            setupInfo && setupInfo.configured ? h('span', { className: 'dssync-note' }, '已连接') : h('span', { className: 'dssync-note warn' }, setupInfo && setupInfo.reason ? setupInfo.reason : '尚未配置'))),

        h('section', { className: 'dssync-sec' },
          h('div', { className: 'dssync-sechead' },
            h('h3', null, '凭据'),
            h('span', null, '保存到 DSH 凭据库，不写进普通配置')),
          h('div', { className: 'dssync-grid' },
            h(Field, { id: 'dssync-token', label: '设备 token', hint: tokenConfigured ? '已配置；留空保持不变。' : '由服务端管理台或 CLI 签发。' },
              h('input', {
                id: 'dssync-token', type: 'password', value: token, autoComplete: 'off',
                placeholder: tokenConfigured ? '已配置；留空保持不变' : '粘贴 token',
                onChange: function (event) { setToken(event.target.value) },
              })),
            h(Field, { id: 'dssync-pass', label: '同步口令', hint: passConfigured ? '已配置；留空保持不变。' : '只用于本地派生加密密钥。' },
              h('input', {
                id: 'dssync-pass', type: 'password', value: passphrase, autoComplete: 'new-password',
                placeholder: passConfigured ? '已配置；留空保持不变' : '设置同步口令',
                onChange: function (event) { setPassphrase(event.target.value) },
              }))),
          h('div', { className: 'dssync-note' }, '口令丢失后，云端内容无法解密。凭据引用：' + CREDENTIAL_REFS.token + ' / ' + CREDENTIAL_REFS.passphrase)),

        h('section', { className: 'dssync-sec' },
          h('div', { className: 'dssync-sechead' },
            h('h3', null, '同步范围'),
            h('span', null, '根会话 + 子代理闭包；空 = 暂不同步')),
          h('div', { className: 'dssync-btnrow' },
            h('button', {
              className: 'dssync-pill', type: 'button', disabled: disabled || candidates.length === 0,
              onClick: function () { set('workspaceAllowlist', allSelected ? [] : allPaths.slice()) },
            }, allSelected ? '清空' : '全选'),
            h('span', { className: 'dssync-note' }, '已选 ' + fields.workspaceAllowlist.length + ' 个工作区'),
            h('span', { className: 'spacer' }),
            workspaces === null ? h('span', { className: 'dssync-note' }, '读取工作区…') : null),
          candidates.length === 0 && workspaces !== null
            ? h('div', { className: 'dssync-note warn' }, '还没有可同步的工作区；先打开一个项目。')
            : h('div', { className: 'dssync-wslist' }, candidates.map(function (item) {
              var selected = fields.workspaceAllowlist.indexOf(item.path) >= 0
              return h('label', { className: 'dssync-ws' + (selected ? ' on' : ''), key: item.path },
                h('input', { type: 'checkbox', checked: selected, onChange: function () { toggleWorkspace(item.path) } }),
                h('span', { className: 'dssync-ws-main' },
                  h('b', null, item.title || item.path),
                  h('span', null, item.path)),
                h('span', { className: 'dssync-ws-count' }, item.rootSessions + ' 个会话 · ' + item.subagentSessions + ' 个子代理'))
            })),
          fields.workspaceAllowlist.length === 0
            ? h('div', { className: 'dssync-note warn' }, '没有选择任何工作区时，插件不会推送或拉取。')
            : null),

        h('section', { className: 'dssync-sec' },
          h('div', { className: 'dssync-sechead' },
            h('h3', null, '同步行为'),
            h('span', null, '自动同步与子代理闭包')),
          h('div', { className: 'dssync-row' },
            h('div', { className: 'dssync-rowtext' },
              h('b', null, '自动同步'),
              h('span', null, '按间隔在后台推送并拉取')),
            h(Switch, { checked: fields.autoSync, disabled: disabled, label: '自动同步', onChange: function (value) { set('autoSync', value) } })),
          h('div', { className: 'dssync-row' },
            h('div', { className: 'dssync-rowtext' },
              h('b', null, '同步间隔'),
              h('span', null, '自动同步开启时生效')),
            h('select', {
              value: String(fields.intervalMs), disabled: disabled || !fields.autoSync,
              style: { width: 120, height: 30, border: '1px solid var(--dssync-line-strong)', borderRadius: 8, background: 'transparent', color: 'inherit' },
              onChange: function (event) { set('intervalMs', Number(event.target.value)) },
            }, INTERVALS.map(function (item) { return h('option', { value: String(item.ms), key: item.ms }, item.label) }))),
          h('div', { className: 'dssync-row' },
            h('div', { className: 'dssync-rowtext' },
              h('b', null, '同步子代理会话'),
              h('span', null, '随根会话一起同步全部后代；关闭后只同步根会话')),
            h(Switch, { checked: fields.includeSubagents, disabled: disabled, label: '同步子代理会话', onChange: function (value) { set('includeSubagents', value) } }))),

        h('div', { className: 'dssync-btnrow' },
          h('button', { className: 'dssync-pill primary', type: 'button', disabled: disabled || busy === 'save', onClick: save }, busy === 'save' ? '保存中…' : '保存'),
          h('button', { className: 'dssync-pill', type: 'button', disabled: disabled || busy === 'sync', onClick: syncNow }, busy === 'sync' ? '同步中…' : '立即同步'),
          h('span', { className: 'spacer' }),
          setupInfo && setupInfo.lastSuccess ? null : null,
          message ? h('span', { className: 'dssync-note' + (message.bad ? ' bad' : '') }, message.text) : null),
        h(Toast, { model: model }))
    }

    /* ---------- 首启向导 ---------- */

    function dismissed() {
      try { return sessionStorage.getItem(ONBOARD_DISMISSED) === '1' } catch (ignored) { return false }
    }

    function setDismissed() {
      try { sessionStorage.setItem(ONBOARD_DISMISSED, '1') } catch (ignored) { /* 隐私模式 */ }
    }

    function Onboarding(props) {
      var model = props.model
      var state = useModel(model)
      var setup = state.setup
      var stepState = useState(0)
      var step = stepState[0]
      var setStep = stepState[1]
      var dirState = useState('next')
      var dir = dirState[0]
      var setDir = dirState[1]
      var fieldsState = useState(function () { return fieldsFrom(null, setup) })
      var fields = fieldsState[0]
      var setFields = fieldsState[1]
      var tokenState = useState('')
      var token = tokenState[0]
      var setToken = tokenState[1]
      var passState = useState('')
      var passphrase = passState[0]
      var setPassphrase = passState[1]
      var hiddenState = useState(dismissed)
      var hidden = hiddenState[0]
      var setHidden = hiddenState[1]
      var activeState = useState(false)
      var active = activeState[0]
      var setActive = activeState[1]
      var busyState = useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]
      var messageState = useState(null)
      var message = messageState[0]
      var setMessage = messageState[1]
      var loadedWorkspaces = useRef(false)

      useEffect(function () { model.refreshAll() }, [model])
      useEffect(function () {
        if (setup === null) return
        // 一旦以“未配置”姿态打开，后续步骤保存让 setup 变成已配置时也不能
        // 把向导抽掉；只有首次加载就是已配置才不显示。
        setActive(function (previous) { return previous || !setup.configured })
      }, [setup && setup.configured])
      useEffect(function () {
        if (setup && setup.configured) setDismissed()
      }, [setup && setup.configured])
      useEffect(function () {
        if (!loadedWorkspaces.current) {
          loadedWorkspaces.current = true
          model.refreshWorkspaces()
        }
      }, [model])
      useEffect(function () {
        if (setup && step === 0) setFields(fieldsFrom(null, setup))
      }, [setup && setup.serverUrl])

      if (hidden || setup === null || !active) return null

      function set(key, value) {
        setFields(function (previous) {
          var next = Object.assign({}, previous)
          next[key] = value
          return next
        })
      }

      function toggleWorkspace(path) {
        setFields(function (previous) {
          var list = previous.workspaceAllowlist.slice()
          var index = list.indexOf(path)
          if (index >= 0) list.splice(index, 1)
          else list.push(path)
          return Object.assign({}, previous, { workspaceAllowlist: list })
        })
      }

      async function saveFields() {
        var pullTarget = fields.workspacePath !== '' && fields.workspaceAllowlist.indexOf(fields.workspacePath) >= 0
          ? fields.workspacePath
          : (fields.workspaceAllowlist[0] || '')
        var ops = [
          { op: 'set', path: ['serverUrl'], value: String(fields.serverUrl || '').trim() },
          { op: 'set', path: ['deviceName'], value: String(fields.deviceName || '').trim() },
          { op: 'set', path: ['workspacePath'], value: pullTarget },
          { op: 'set', path: ['workspaceAllowlist'], value: fields.workspaceAllowlist.slice() },
          { op: 'set', path: ['autoSync'], value: fields.autoSync === true },
          { op: 'set', path: ['intervalMs'], value: Number(fields.intervalMs) || 60000 },
          { op: 'set', path: ['includeSubagents'], value: fields.includeSubagents === true },
        ]
        var accepted = await props.writeSettings(ops)
        if (!accepted.ok) throw new Error(accepted.message)
      }

      async function test() {
        setBusy('test')
        setMessage(null)
        try {
          await saveFields()
          await new Promise(function (resolve) { setTimeout(resolve, 250) })
          var result = await model.testConnection()
          if (result && result.ok) {
            setMessage({ bad: false, text: '服务端可达，token 有效' })
            await model.refreshSetup()
          } else {
            setMessage({ bad: true, text: (result && result.message) || '连接失败' })
          }
        } catch (error) {
          setMessage({ bad: true, text: errorText(error) })
        } finally {
          setBusy('')
        }
      }

      async function next() {
        setDir('next')
        setMessage(null)
        if (step === 0) {
          if (String(fields.serverUrl).trim() === '') {
            setMessage({ bad: true, text: '先填写服务端地址' })
            return
          }
          setBusy('save')
          try {
            await saveFields()
            setStep(1)
          } catch (error) {
            setMessage({ bad: true, text: errorText(error) })
          } finally {
            setBusy('')
          }
          return
        }
        if (step === 1) {
          setBusy('save')
          try {
            if (String(token).trim() !== '') {
              var t = await props.setCredential(CREDENTIAL_REFS.token, String(token).trim())
              if (!t.ok) throw new Error(t.message)
              setToken('')
            }
            if (String(passphrase).trim() !== '') {
              var p = await props.setCredential(CREDENTIAL_REFS.passphrase, String(passphrase).trim())
              if (!p.ok) throw new Error(p.message)
              setPassphrase('')
            }
            await model.refreshSetup()
            setStep(2)
          } catch (error) {
            setMessage({ bad: true, text: errorText(error) })
          } finally {
            setBusy('')
          }
          return
        }
        if (step === 2) {
          if (fields.workspaceAllowlist.length === 0) {
            setMessage({ bad: true, text: '至少选择一个工作区；空列表不会同步' })
            return
          }
          setBusy('save')
          try {
            await saveFields()
            await model.refreshSetup()
            setStep(3)
          } catch (error) {
            setMessage({ bad: true, text: errorText(error) })
          } finally {
            setBusy('')
          }
          return
        }
        setBusy('finish')
        try {
          var result = await model.syncNow()
          if (!result || result.ok !== true) {
            setMessage({ bad: true, text: (result && (result.message || result.code)) || '同步未执行' })
            return
          }
          setDismissed()
          setHidden(true)
          model.toast('同步已启动')
        } catch (error) {
          setMessage({ bad: true, text: errorText(error) })
        } finally {
          setBusy('')
        }
      }

      var workspaces = state.workspaces
      var candidates = workspaces ? workspaces.workspaces : []
      var steps = ['连接', '凭据', '范围', '完成']
      var body
      if (step === 0) {
        body = [
          h(Field, { id: 'ob-server', label: '服务端地址', hint: '自部署服务端地址形如 http://127.0.0.1:8787。' },
            h('input', { id: 'ob-server', value: fields.serverUrl, placeholder: 'http://127.0.0.1:8787', onChange: function (e) { set('serverUrl', e.target.value) } })),
          h(Field, { id: 'ob-device', label: '设备名称' },
            h('input', { id: 'ob-device', value: fields.deviceName, onChange: function (e) { set('deviceName', e.target.value) } })),
          h('div', { className: 'dssync-btnrow' },
            h('button', { className: 'dssync-pill', type: 'button', disabled: busy !== '', onClick: test }, busy === 'test' ? '测试中…' : '测试连接'),
            message ? h('span', { className: 'dssync-note' + (message.bad ? ' bad' : '') }, message.text) : null),
        ]
      } else if (step === 1) {
        body = [
          h(Field, { id: 'ob-token', label: '设备 token', hint: setup.hasToken ? '已配置；留空保持不变。' : '由服务端管理台或 CLI 签发。' },
            h('input', { id: 'ob-token', type: 'password', value: token, placeholder: setup.hasToken ? '已配置；留空保持不变' : '粘贴 token', onChange: function (e) { setToken(e.target.value) } })),
          h(Field, { id: 'ob-pass', label: '同步口令', hint: setup.hasPassphrase ? '已配置；留空保持不变。' : '只用于本地派生加密密钥。' },
            h('input', { id: 'ob-pass', type: 'password', value: passphrase, placeholder: setup.hasPassphrase ? '已配置；留空保持不变' : '设置同步口令', onChange: function (e) { setPassphrase(e.target.value) } })),
          h('div', { className: 'dssync-note' }, '凭据保存在 DSH 凭据库（引用 ' + CREDENTIAL_REFS.token + ' / ' + CREDENTIAL_REFS.passphrase + '），不会写入普通配置。'),
          message ? h('div', { className: 'dssync-note' + (message.bad ? ' bad' : '') }, message.text) : null,
        ]
      } else if (step === 2) {
        var allPaths = candidates.map(function (item) { return item.path })
        var selected = fields.workspaceAllowlist
        body = [
          h('div', { className: 'dssync-btnrow' },
            h('button', {
              className: 'dssync-pill', type: 'button',
              onClick: function () { set('workspaceAllowlist', selected.length === allPaths.length ? [] : allPaths.slice()) },
            }, selected.length === allPaths.length && allPaths.length > 0 ? '清空' : '全选'),
            h('span', { className: 'dssync-note' }, '已选 ' + selected.length + ' 个工作区')),
          candidates.length === 0
            ? h('div', { className: 'dssync-note warn' }, '还没有可同步的工作区；可以稍后在 Plugins 设置里选。')
            : h('div', { className: 'dssync-wslist' }, candidates.map(function (item) {
              var on = selected.indexOf(item.path) >= 0
              return h('label', { className: 'dssync-ws' + (on ? ' on' : ''), key: item.path },
                h('input', { type: 'checkbox', checked: on, onChange: function () { toggleWorkspace(item.path) } }),
                h('span', { className: 'dssync-ws-main' }, h('b', null, item.title || item.path), h('span', null, item.path)),
                h('span', { className: 'dssync-ws-count' }, item.rootSessions + ' 会话 · ' + item.subagentSessions + ' 子代理'))
            })),
          h('div', { className: 'dssync-note warn' }, '没有选择工作区时不会同步。'),
          message ? h('div', { className: 'dssync-note' + (message.bad ? ' bad' : '') }, message.text) : null,
        ]
      } else {
        body = [
          h('div', { className: 'dssync-note' }, '配置已就绪。点“开始同步”会立即触发一轮同步，之后在 Plugins 设置页随时调整。'),
          message ? h('div', { className: 'dssync-note' + (message.bad ? ' bad' : '') }, message.text) : null,
        ]
      }

      return h('div', { className: 'dssync dssync-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': '连接会话同步' },
        h('div', { className: 'dssync-wizard' },
          h('div', { className: 'dssync-wizard-head' },
            h('div', { className: 'dssync-wizard-icon' }, shieldIcon()),
            h('div', null, h('h2', null, '连接会话同步'), h('p', null, '把会话端到端加密备份到你自己的服务端。')),
            h('button', {
              className: 'dssync-close', type: 'button', 'aria-label': '稍后配置',
              onClick: function () { setDismissed(); setHidden(true) },
            }, '×')),
          h('ol', { className: 'dssync-steps' }, steps.map(function (label, index) {
            return h('li', { className: 'dssync-step' + (index === step ? ' on' : '') + (index < step ? ' done' : ''), key: label },
              h('i', null, index < step ? '✓' : String(index + 1)), label)
          })),
          h('div', { className: 'dssync-wizard-body dssync-step-' + dir, key: 'step-' + step }, body),
          h('div', { className: 'dssync-wizard-foot' },
            step > 0 ? h('button', { className: 'dssync-pill', type: 'button', onClick: function () { setDir('back'); setStep(step - 1); setMessage(null) } }, '上一步') : null,
            h('button', { className: 'dssync-pill', type: 'button', onClick: function () { setDismissed(); setHidden(true) } }, '稍后'),
            h('span', { className: 'spacer' }),
            h('button', { className: 'dssync-pill primary', type: 'button', disabled: busy !== '', onClick: next },
              busy === 'finish' ? '同步中…' : step === 3 ? '开始同步' : '下一步')),
        ),
        h(Toast, { model: model }))
    }

    /* ---------- 顶部同步气泡 ---------- */

    function Bubble(props) {
      var model = props.model
      var state = useModel(model)
      var setup = state.setup
      var status = state.status
      var visibleState = useState(false)
      var visible = visibleState[0]
      var setVisible = visibleState[1]
      var openState = useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var pinnedState = useState(false)
      var pinned = pinnedState[0]
      var setPinned = pinnedState[1]
      var blurTimer = useRef(null)
      var hideTimer = useRef(null)
      var touched = useRef(false)
      var previousRunning = useRef(false)

      useEffect(function () { model.refreshAll() }, [model])
      useEffect(function () {
        if (status && setup === null) return
        if (setup && !setup.configured && !dismissed()) return
        if (status && (status.running || status.pending !== null || status.lastError !== null) && !visible) {
          setVisible(true)
        }
      }, [status && status.running, status && status.pending, status && status.lastError, setup && setup.configured])

      useEffect(function () {
        function onVisibility() {
          if (document.visibilityState === 'visible') model.refreshStatus()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return function () { document.removeEventListener('visibilitychange', onVisibility) }
      }, [model])

      useEffect(function () {
        var was = previousRunning.current
        previousRunning.current = !!(status && status.running)
        if (!was || (status && status.running) || !visible || pinned) return
        if (status && status.lastError !== null && status.lastError !== undefined) return
        if (hideTimer.current !== null) clearTimeout(hideTimer.current)
        hideTimer.current = setTimeout(function () {
          hideTimer.current = null
          if (!pinned) { setVisible(false); setOpen(false) }
        }, 1000)
      }, [status && status.running, status && status.lastError, visible, pinned])

      useEffect(function () {
        function outside(event) {
          if (!visible || !pinned) return
          var bubble = document.querySelector('.dssync-bubble')
          if (bubble !== null && !bubble.contains(event.target)) scheduleBlur()
        }
        function onWindowBlur() { if (pinned) scheduleBlur() }
        function onWindowFocus() {
          var bubble = document.querySelector('.dssync-bubble')
          if (bubble !== null && bubble.contains(document.activeElement)) clearBlur()
        }
        document.addEventListener('pointerdown', outside, true)
        window.addEventListener('blur', onWindowBlur)
        window.addEventListener('focus', onWindowFocus)
        return function () {
          document.removeEventListener('pointerdown', outside, true)
          window.removeEventListener('blur', onWindowBlur)
          window.removeEventListener('focus', onWindowFocus)
        }
      }, [visible, pinned])

      useEffect(function () {
        return function () {
          if (blurTimer.current !== null) clearTimeout(blurTimer.current)
          if (hideTimer.current !== null) clearTimeout(hideTimer.current)
        }
      }, [])

      if (setup === null || !setup.configured) return h(Toast, { model: model })

      var rawSessions = status === null
        ? []
        : (status.running && Array.isArray(status.live) && status.live.length > 0 ? status.live : status.sessions)
      var sessions = Array.isArray(rawSessions) ? rawSessions.slice() : []
      var total = sessions.length
      var done = sessions.filter(function (session) {
        return session.status !== 'error' && session.status !== 'pulling' && session.status !== 'pushing'
      }).length
      var failed = sessions.some(function (session) { return session.status === 'error' })
      var running = status && status.running
      var title = failed ? '同步失败' : running ? '正在同步' : '同步完成'
      var subtitle = failed ? '有会话未完成，已暂停'
        : running ? (total === 0 ? '连接服务端…' : done + '/' + total + ' 个会话 · 端到端加密')
          : total === 0 ? '还没有同步记录' : done + '/' + total + ' 个会话 · ' + (status.lastSuccess ? formatAgo(status.lastSuccess) : '尚未成功')
      var dot = statusDot(status)
      var segments = sessions.map(function (session, index) {
        var bad = session.status === 'error'
        var active = session.status === 'pulling' || session.status === 'pushing' || (running && !bad && session.status !== 'pulled' && session.status !== 'up-to-date')
        var pct = bad ? 100 : session.status === 'pulled' || session.status === 'up-to-date' ? 100 : active ? 55 : 0
        return h('span', { className: 'dssync-seg' + (bad ? ' bad' : active ? ' run' : pct >= 100 ? ' done' : ''), key: session.sessionId + ':' + session.direction + ':' + index, title: (session.direction === 'push' ? '推送 ' : '拉取 ') + session.sessionId },
          h('i', { style: { width: pct + '%' } }))
      })
      if (segments.length === 0) {
        segments = [h('span', { className: 'dssync-seg' + (running ? ' run' : ''), key: 'empty' }, h('i', { style: { width: running ? '35%' : '0%' } }))]
      }

      function clearBlur() {
        if (blurTimer.current !== null) { clearTimeout(blurTimer.current); blurTimer.current = null }
      }

      function scheduleBlur() {
        if (!visible || !pinned) return
        clearBlur()
        blurTimer.current = setTimeout(function () {
          blurTimer.current = null
          if (!visible) return
          if (document.hasFocus() && document.activeElement && document.querySelector('.dssync-bubble') &&
            document.querySelector('.dssync-bubble').contains(document.activeElement)) return
          setPinned(false)
          setVisible(false)
          setOpen(false)
        }, 5000)
      }

      function expand(pin) {
        touched.current = true
        if (pin !== false) setPinned(true)
        if (hideTimer.current !== null) { clearTimeout(hideTimer.current); hideTimer.current = null }
        clearBlur()
        setVisible(true)
      }

      function collapse() {
        setPinned(false)
        setVisible(false)
        setOpen(false)
        clearBlur()
      }

      function onIcon() {
        if (visible) collapse()
        else expand(true)
      }

      function onHead() {
        if (!visible) { expand(true); return }
        setOpen(function (value) { return !value })
      }

      function onListToggle(event) {
        event.stopPropagation()
        if (!visible) expand(true)
        else setOpen(function (value) { return !value })
      }

      function onPointerDown(event) {
        if (event.target.closest && event.target.closest('.dssync-cloud')) return
        if (hideTimer.current !== null) { clearTimeout(hideTimer.current); hideTimer.current = null }
        clearBlur()
        setPinned(true)
      }

      var collapsed = !visible
      var openClass = open && !collapsed ? ' open' : ''
      var collapsedClass = collapsed ? ' collapsed' : ''
      var badClass = failed ? ' bad' : ''
      var rows = sessions.map(function (session, index) {
        var tag = session.status === 'error' ? '失败'
          : session.status === 'pulled' || session.status === 'up-to-date' || session.status === 'pushed' ? '已完成'
            : session.status === 'pulling' || session.status === 'pushing' || running ? '同步中' : '等待'
        return h('div', { className: 'dssync-rowline', key: session.sessionId + ':' + session.direction + ':' + index },
          h('span', { className: 'dssync-st ' + (session.status === 'error' ? 'bad' : tag === '已完成' ? 'ok' : tag === '同步中' ? 'run' : '') }),
          h('span', { className: 'name' }, (session.direction === 'push' ? '↑ ' : '↓ ') + session.sessionId),
          h('span', { className: 'tag' }, tag))
      })

      var head = h('div', {
        className: 'dssync-bubble-head', role: 'button', tabIndex: 0,
        'aria-expanded': open, 'aria-label': open ? '收起同步会话' : '展开同步会话',
        onClick: onHead,
        onKeyDown: function (event) {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          onHead()
        },
      },
      h('button', {
        className: 'dssync-cloud', type: 'button', title: collapsed ? '展开会话同步' : '收起为图标',
        'aria-label': collapsed ? '展开会话同步' : '收起会话同步',
        onClick: function (event) { event.stopPropagation(); onIcon() },
      }, cloudIcon(), h('span', { className: 'dssync-dot ' + dot })),
      h('div', { className: 'dssync-label' },
        h('b', null, title),
        h('span', null, subtitle)),
      h('span', { className: 'dssync-count' }, done + '/' + total),
      h('button', {
        className: 'dssync-chev', type: 'button', 'aria-label': open ? '收起同步会话列表' : '展开同步会话列表',
        'aria-expanded': open, onClick: onListToggle,
      }, chevronIcon()))

      var panel = h('div', { className: 'dssync-collapse' },
        h('div', { className: 'dssync-collapse-in' },
          h('div', { className: 'dssync-panel' }, rows.length > 0 ? rows : h('div', { className: 'dssync-note' }, '暂无会话记录')),
          status && status.lastError ? h('div', { className: 'dssync-error' }, status.lastError.message + (status.retryCount > 0 ? ' · 已重试 ' + status.retryCount + ' 次' : '')) : null,
          h('div', { className: 'dssync-foot' },
            h('span', null, running ? '正在同步…' : failed ? '已暂停' : '全部完成'),
            h('span', { className: 'spacer' }),
            h('button', { className: 'dssync-mini', type: 'button', onClick: function () {
              model.syncNow().then(function (result) {
                if (!result || result.ok !== true) model.toast((result && (result.message || result.code)) || '同步未执行', true)
              }).catch(function (error) { model.toast(errorText(error), true) })
            } }, '立即同步'),
            h('button', { className: 'dssync-mini', type: 'button', onClick: props.openSettings }, '设置'))))

      var bubble = h('div', { className: 'dssync-bubble' + openClass + collapsedClass + badClass, 'aria-live': 'polite' },
        head,
        h('div', { className: 'dssync-segbar', 'aria-hidden': 'true' }, segments),
        panel)

      var wrap = h('div', {
        className: 'dssync-bubble-wrap' + collapsedClass,
        onPointerEnter: function () { clearBlur() },
        onPointerLeave: function () { scheduleBlur() },
        onFocus: function () { clearBlur() },
        onBlur: function (event) { if (!event.currentTarget.contains(event.relatedTarget)) scheduleBlur() },
        onPointerDown: onPointerDown,
      }, bubble)

      return h('div', { className: 'dssync' }, wrap, h(Toast, { model: model }))
    }

    /* ---------- 客户端防护 ---------- */

    function SyncComposerGuard(props) {
      var state = useModel(props.model)
      var session = props.session
      var sessionId = session && session.sessionId ? String(session.sessionId) : ''
      var reason = sessionId === '' ? null : sessionBlockReason(state.status, sessionId)
      useEffect(function () {
        if (sessionId === '') return undefined
        props.setBlock(sessionId, reason)
        return function () { props.setBlock(sessionId, null) }
      }, [sessionId, reason])
      return null
    }

    function SyncRowMark(props) {
      var state = useModel(props.model)
      var sessionId = props.sessionId ? String(props.sessionId) : ''
      if (sessionId === '') return null
      var sync = sessionState(state.status, sessionId)
      if (!sync.pending && !sync.tail && !sync.lag) return null
      var label = sync.pending ? '正在应用云端写入' : sync.tail ? '有未闭合的同步尾巴' : '安全边界落后于远端'
      return h('span', {
        className: 'dssync-rowmark' + (sync.tail || sync.lag ? ' tail' : ''),
        title: label, 'aria-label': label, role: 'img',
      }, sync.pending ? '…' : sync.tail ? '↻' : '!')
    }

    function SyncRowHover(props) {
      var state = useModel(props.model)
      var sessionId = props.sessionId ? String(props.sessionId) : ''
      if (sessionId === '') return null
      var reason = sessionBlockReason(state.status, sessionId)
      if (reason === null) return null
      return h('div', { className: 'dssync-hovernote' }, '会话同步：', reason)
    }

    /* ---------- 插件入口 ---------- */

    function apply(ctx) {
      var model = createModel()
      var style = document.createElement('style')
      style.dataset.plugin = 'dsh-session-sync'
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(function () { return function () { style.remove() } }, 'dsh-session-sync: styles')
      ctx.effect(function () { return function () { model.dispose() } }, 'dsh-session-sync: model')
      model.refreshAll()

      var credentials = ctx.get('remote.credentials')
      var settings = ctx.get('remote.settings')
      var layout = ctx.get('layout')
      var conversation = ctx.get('conversation')
      var configForms = ctx.get('configForms')
      var configForm = configForms && typeof configForms.get === 'function'
        ? configForms.get(SETTINGS_NS)
        : null

      function setCredential(ref, value) {
        if (!credentials || typeof credentials.set !== 'function') {
          return Promise.resolve({ ok: false, message: '凭据服务不可用' })
        }
        return credentials.set(ref, value).then(function (result) {
          if (result && result.ok) return { ok: true }
          return { ok: false, message: result && result.error ? result.error.message : '凭据写入失败' }
        }, function (error) { return { ok: false, message: errorText(error) } })
      }

      function writeSettings(ops) {
        if (!settings || typeof settings.mutate !== 'function') {
          return Promise.resolve({ ok: false, message: '设置服务不可用' })
        }
        return settings.mutate(SETTINGS_NS, ops, undefined).then(function (result) {
          if (result && result.ok) return { ok: true }
          return { ok: false, message: result && result.error ? result.error.message : '设置写入失败' }
        }, function (error) { return { ok: false, message: errorText(error) } })
      }

      function openSettings() {
        if (layout && typeof layout.selectPanel === 'function') layout.selectPanel('plugins')
        else model.toast('请在 Plugins 页打开会话同步设置')
      }

      function setBlock(sessionId, reason) {
        if (!conversation || !conversation.blocks || typeof conversation.blocks.set !== 'function') return
        conversation.blocks.set(sessionId, reason === null ? undefined : { reason: reason })
      }

      function rowBlockReason(target) {
        if (!target || typeof target.closest !== 'function') return null
        if (target.closest('button, [role="button"], [role="menu"], [role="menuitem"], [data-seat]')) return null
        var row = target.closest('[data-row-key^="session:"]')
        if (row === null) return null
        var key = row.getAttribute('data-row-key') || ''
        var sessionId = key.slice('session:'.length)
        if (sessionId === '') return null
        return sessionBlockReason(model.getSnapshot().status, sessionId)
      }

      function interceptRow(event) {
        var reason = rowBlockReason(event.target)
        if (reason === null) return
        event.preventDefault()
        event.stopImmediatePropagation()
        model.toast(reason, true)
      }

      function interceptKeydown(event) {
        if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
        interceptRow(event)
      }

      ctx.effect(function () {
        document.addEventListener('click', interceptRow, true)
        document.addEventListener('pointerdown', interceptRow, true)
        document.addEventListener('keydown', interceptKeydown, true)
        return function () {
          document.removeEventListener('click', interceptRow, true)
          document.removeEventListener('pointerdown', interceptRow, true)
          document.removeEventListener('keydown', interceptKeydown, true)
        }
      }, 'dsh-session-sync: row interception')

      ctx.slots.inject('conversation.input.dock', function () {
        return ctx.slots.register({
          name: 'conversation.input.dock', id: 'session-sync-guard', order: 90,
          inject: function () { return { model: model, setBlock: setBlock } },
        }, SyncComposerGuard)
      })

      ctx.slots.inject('sidebar.session.row.leading', function () {
        return ctx.slots.register({
          name: 'sidebar.session.row.leading', id: 'session-sync-mark', order: 50,
          inject: function () { return { model: model } },
        }, SyncRowMark)
      })

      ctx.slots.inject('sidebar.session.row.hover', function () {
        return ctx.slots.register({
          name: 'sidebar.session.row.hover', id: 'session-sync-hover', order: 50,
          inject: function () { return { model: model } },
        }, SyncRowHover)
      })

      ctx.slots.inject('plugins.bundle.config', function () {
        return ctx.slots.register({
          name: 'plugins.bundle.config', key: 'dsh-session-sync',
          inject: function () {
            return {
              model: model,
              form: configForm,
              setCredential: setCredential,
              writeSettings: writeSettings,
              openSettings: openSettings,
            }
          },
        }, SyncSettingsPage)
      })

      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register({
          name: 'shell.overlay', id: 'dsh-session-sync-onboarding', order: 20,
          inject: function () { return { model: model, setCredential: setCredential, writeSettings: writeSettings } },
        }, Onboarding)
        yield ctx.slots.register({
          name: 'shell.overlay', id: 'dsh-session-sync-bubble', order: 30,
          inject: function () { return { model: model, openSettings: openSettings } },
        }, Bubble)
      })
    }

    return { inject: ['slots'], apply: apply }
  },
})
