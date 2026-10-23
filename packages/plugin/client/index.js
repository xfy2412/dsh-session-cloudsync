// dsh-session-cloudsync 浏览器半边。
//
// - `plugins.bundle.config`：Plugins 页里的自定义设置页（连接、凭据、工作区、同步行为）。
// - `shell.overlay`：首启向导 + 顶部同步气泡。
// - 非敏感字段写 settings；token/passphrase 只写 `ctx.remote.credentials`。
//
// 本文件是手写 JS，不参与 `scripts/build.mjs` 的 TypeScript 转换；加载形态与
// dsh-time-reminder 一致。
window.__ModuleLoader__.load({
  id: 'dsh-session-cloudsync',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useState = React.useState

    var API = '/api/session-cloudsync'
    var SETTINGS_NS = 'session-cloudsync'
    /** 与宿主 src/index.ts 的 CREDENTIAL_REFS 保持一致。 */
    var CREDENTIAL_REFS = {
      token: 'DSH_SESSION_CLOUDSYNC_TOKEN',
      passphrase: 'DSH_SESSION_CLOUDSYNC_PASSPHRASE',
    }
    var INTERVALS = [
      { ms: 15000, label: '15 秒' },
      { ms: 30000, label: '30 秒' },
      { ms: 60000, label: '1 分钟' },
      { ms: 300000, label: '5 分钟' },
    ]
    var ONBOARD_DISMISSED = 'dsh-session-cloudsync.onboarding.dismissed'

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
      '.dssync-bindlist,.dssync-maplist{display:flex;flex-direction:column;gap:7px;margin-top:8px}',
      '.dssync-bindrow,.dssync-maprow{display:flex;align-items:center;gap:9px;padding:8px 10px;border:1px solid var(--dssync-line);border-radius:9px;flex-wrap:wrap}',
      '.dssync-bindrow b,.dssync-maprow b{font-size:12px;font-weight:600}',
      '.dssync-bindrow code{font-size:10.5px;color:var(--dssync-faint)}',
      '.dssync-mapkey{display:flex;flex-direction:column;gap:2px;min-width:150px;font:11px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dssync-muted)}',
      '.dssync-mapkey b{font:12px/1.35 var(--dssync-font,system-ui);font-weight:600;color:var(--dssync-text)}',
      '.dssync-mapkey span{font:10.5px var(--dssync-font,system-ui);color:var(--dssync-faint)}',
      '.dssync-maprow select{flex:1 1 220px;height:28px;border:1px solid var(--dssync-line-strong);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#1d1d1f);color:inherit;font:inherit;font-size:11px}',
      '.dssync-ws{display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid var(--dssync-line);border-radius:9px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.025))}',
      '.dssync-ws.on{border-color:rgba(86,134,254,.42);background:var(--dssync-accent-soft)}',
      '.dssync-ws input{width:15px;height:15px;accent-color:var(--dssync-accent);flex:0 0 auto}',
      '.dssync-ws-main{min-width:0;flex:1 1 auto}',
      '.dssync-ws-main b{display:block;font-size:12.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dssync-ws-main span{display:block;color:var(--dssync-faint);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dssync-ws-count{color:var(--dssync-faint);font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.dssync-sessionlist{display:flex;flex-direction:column;gap:8px}',
      '.dssync-sessiongroup{border:1px solid var(--dssync-line);border-radius:9px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.02))}',
      '.dssync-sessiongroup-head{display:flex;align-items:center;gap:8px;padding:7px 9px;border-bottom:1px solid var(--dssync-line);background:rgba(255,255,255,.025)}',
      '.dssync-sessiongroup-head b{min-width:0;color:var(--dssync-muted);font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dssync-sessiongroup-head span{min-width:0;color:var(--dssync-faint);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dssync-sessiongroup-head span:last-child{margin-left:auto;flex:0 0 auto;font-variant-numeric:tabular-nums}',
      '.dssync-session{display:flex;align-items:center;gap:8px;padding:7px 9px;border-bottom:1px solid rgba(255,255,255,.045);cursor:pointer;transition:opacity .15s,background .15s}',
      '.dssync-session:last-child{border-bottom:0}',
      '.dssync-session:hover{background:rgba(255,255,255,.025)}',
      '.dssync-session.off{opacity:.5}',
      '.dssync-session input{width:14px;height:14px;accent-color:var(--dssync-accent);flex:0 0 auto}',
      '.dssync-session-check{display:none}',
      '.dssync-session-main{min-width:0;flex:1 1 auto;display:flex;flex-direction:column;gap:1px}',
      '.dssync-session-main b{font:10.5px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace;font-weight:500;color:var(--dssync-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dssync-session-main span{color:var(--dssync-faint);font-size:10px}',
      '.dssync-session-meta{flex:0 0 auto;display:flex;align-items:center;gap:7px;color:var(--dssync-faint);font-size:10px}',
      '.dssync-session-status{padding:1px 6px;border-radius:999px;background:rgba(34,197,94,.12);color:#9ce8bc}',
      '.dssync-session-status.off{background:rgba(240,182,74,.12);color:#f0c87a}',
      '.dssync-maprow.suggested{border-color:rgba(240,182,74,.28);background:rgba(240,182,74,.035)}',
      '.dssync-mapconfirm{display:flex;align-items:center;gap:8px;flex:1 1 100%;flex-wrap:wrap;padding-top:7px;border-top:1px dashed var(--dssync-line)}',
      '.dssync-mapconfirm .dssync-note{flex:1 1 220px}',
      '.dssync-switch{position:relative;display:inline-flex;width:38px;height:22px;flex:0 0 auto}',
      '.dssync-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}',
      '.dssync-switch i{position:absolute;inset:0;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.3));transition:background .16s;pointer-events:none}',
      '.dssync-switch i:after{content:"";position:absolute;left:2px;top:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.28);transition:transform .16s}',
      '.dssync-switch input:checked+i{background:var(--dssync-accent)}',
      '.dssync-switch input:checked+i:after{transform:translateX(16px)}',
      '.dssync-toast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,10px);z-index:2147483001;max-width:min(520px,calc(100vw - 32px));padding:10px 14px;border:1px solid var(--dssync-line-strong);border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(34,34,36,.97));box-shadow:0 16px 40px rgba(0,0,0,.42);color:var(--dssync-text);font-size:12.5px;line-height:1.5;opacity:0;pointer-events:none;transition:opacity .18s,transform .18s}',
      '.dssync-toast.on{opacity:1;transform:translate(-50%,0)}',
      '.dssync-toast.bad{color:#ffb1b1;border-color:rgba(239,68,68,.32)}',
      '.dssync-warn{color:var(--dsw-alias-state-warn-primary,#f0b64a);font-size:10.5px;line-height:1;border:1px solid rgba(240,182,74,.35);border-radius:999px;padding:3px 6px;white-space:nowrap}',
      '.dssync-events{color:var(--dssync-faint);font-size:10px;line-height:1;white-space:nowrap;font-variant-numeric:tabular-nums}',
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
      '.dssync-mini.dssync-mini-danger{color:#f0b64a;border-color:rgba(240,182,74,.55)}',
      '.dssync-replace-warning{padding:10px 12px;border:1px solid rgba(240,182,74,.35);border-radius:10px;background:rgba(240,182,74,.09);color:var(--dssync-text);font-size:12px;line-height:1.6}',
      '.dssync-replace-steps{margin:0;padding-left:20px;color:var(--dssync-muted);font-size:12px;line-height:1.7}',
      '.dssync-replace-code{margin-top:2px;padding:10px 12px;border:1px solid var(--dssync-line);border-radius:10px;background:rgba(127,127,127,.08);font:11.5px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all;color:var(--dssync-text)}',
      '.dssync-replace-meta{color:var(--dssync-faint);font-size:11px;line-height:1.5;word-break:break-all}',
      '.dssync-replace-actions{display:flex;align-items:center;gap:8px;margin-top:2px}',
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
        error: null, toast: null, replacePlan: null,
      }
      var listeners = new Set()
      var pollTimer = null
      var streamTimer = null
      var streamAbort = null
      var streamFailedUntil = 0
      var lastVersion = -1
      var hidden = false
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

      function statusActive(status) {
        return status !== null && (status.running === true || status.pending !== null)
      }

      function acceptStatus(status) {
        if (status === null || typeof status !== 'object') return false
        if (typeof status.statusVersion === 'number' && status.statusVersion < lastVersion) return false
        if (typeof status.statusVersion === 'number') lastVersion = status.statusVersion
        patch({ status: status, loading: false })
        return true
      }

      function consumeSse(text) {
        var index = text.indexOf('\n\n')
        while (index !== -1) {
          var frame = text.slice(0, index)
          text = text.slice(index + 2)
          var data = []
          frame.split('\n').forEach(function (line) {
            if (line.indexOf('data:') === 0) data.push(line.slice(5).trimStart())
          })
          if (data.length > 0) {
            try { handleStreamStatus(JSON.parse(data.join('\n'))) } catch (error) { /* 忽略坏帧 */ }
          }
          index = text.indexOf('\n\n')
        }
        return text
      }

      function handleStreamStatus(status) {
        if (disposed) return
        if (!acceptStatus(status)) return
        if (statusActive(status)) {
          if (streamTimer !== null) {
            clearTimeout(streamTimer)
            streamTimer = null
          }
          return
        }
        if (streamTimer !== null) clearTimeout(streamTimer)
        streamTimer = setTimeout(function () {
          streamTimer = null
          closeStream()
        }, 2500)
      }

      function closeStream() {
        if (streamTimer !== null) {
          clearTimeout(streamTimer)
          streamTimer = null
        }
        if (streamAbort !== null) {
          var controller = streamAbort
          streamAbort = null
          controller.abort()
        }
        schedule()
      }

      function openStream() {
        if (disposed || streamAbort !== null) return
        var controller = new AbortController()
        streamAbort = controller
        function fail(error) {
          if (streamAbort !== controller) return
          streamAbort = null
          streamFailedUntil = Date.now() + 3000
          schedule()
        }
        fetch(API + '/events?until=idle', {
          credentials: 'same-origin',
          headers: { accept: 'text/event-stream' },
          signal: controller.signal,
        }).then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status)
          if (response.body === null || typeof response.body.getReader !== 'function') {
            throw new Error('SSE 不可用')
          }
          streamFailedUntil = 0
          var reader = response.body.getReader()
          var decoder = new TextDecoder()
          var buffer = ''
          function pump() {
            return reader.read().then(function (result) {
              if (streamAbort !== controller) return
              if (result.done) {
                streamAbort = null
                if (statusActive(snapshot.status)) streamFailedUntil = Date.now() + 3000
                schedule()
                return
              }
              buffer += decoder.decode(result.value, { stream: true })
              buffer = consumeSse(buffer)
              return pump()
            }, function (error) {
              fail(error)
            })
          }
          return pump()
        }).catch(function (error) {
          if (controller.signal.aborted) return
          fail(error)
        })
      }

      function schedule() {
        if (pollTimer !== null) clearTimeout(pollTimer)
        pollTimer = null
        if (disposed || hidden) return
        var status = snapshot.status
        if (status === null) return
        if (statusActive(status)) {
          if (streamAbort === null) {
            if (Date.now() < streamFailedUntil) {
              pollTimer = setTimeout(function () { refreshStatus() }, 1000)
            } else {
              openStream()
            }
          }
          return
        }
        if (streamAbort !== null) {
          if (streamTimer === null) {
            streamTimer = setTimeout(function () {
              streamTimer = null
              closeStream()
            }, 1000)
          }
          return
        }
        var scheduler = status.scheduler || {}
        if (scheduler.autoSync !== true) return
        var interval = typeof scheduler.intervalMs === 'number' ? scheduler.intervalMs : 60000
        var now = Date.now()
        var next = typeof scheduler.nextRunAt === 'number' ? scheduler.nextRunAt : now + interval
        var delay = Math.max(1000, Math.min(next - 1500 - now, interval - 5000))
        pollTimer = setTimeout(function () {
          refreshStatus()
        }, delay)
      }

      async function refreshStatus() {
        try {
          var status = await fetchJson('/status')
          acceptStatus(status)
          return status
        } catch (error) {
          patch({ loading: false, error: errorText(error) })
          return null
        } finally {
          schedule()
        }
      }

      function onVisibilityChange() {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          hidden = true
          closeStream()
          if (pollTimer !== null) {
            clearTimeout(pollTimer)
            pollTimer = null
          }
          return
        }
        hidden = false
        refreshStatus()
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
        openStream()
        var result = await fetchJson('/sync', { method: 'POST', body: '{}' })
        if (result && result.status) acceptStatus(result.status)
        else await refreshStatus()
        return result
      }

      async function testConnection(serverUrl) {
        return fetchJson('/test', { method: 'POST', body: JSON.stringify({ serverUrl: serverUrl }) })
      }

      async function correctCwd(sessionId, action) {
        var result = await fetchJson('/cwd', {
          method: 'POST',
          body: JSON.stringify({ sessionId: sessionId, action: action || 'fix' }),
        })
        await refreshStatus()
        return result
      }

      async function resolveBlocked(sessionId, action, createdAt, formatVersion) {
        var result = await fetchJson('/blocked', {
          method: 'POST',
          body: JSON.stringify({
            sessionId: sessionId,
            action: action,
            ...createdAt === undefined ? {} : { createdAt: createdAt },
            ...formatVersion === undefined ? {} : { formatVersion: formatVersion },
          }),
        })
        await refreshStatus()
        return result
      }

      async function prepareReplace(sessionId) {
        var result = await fetchJson('/replace', {
          method: 'POST',
          body: JSON.stringify({ sessionId: sessionId }),
        })
        if (result && result.ok === true) patch({ replacePlan: result.value })
        return result
      }

      function dismissReplace() {
        patch({ replacePlan: null })
      }

      async function bindWorkspace(workspaceKey, localPath) {
        var value = await fetchJson('/workspaces/bind', {
          method: 'POST',
          body: JSON.stringify({ workspaceKey: workspaceKey, localPath: localPath }),
        })
        await refreshWorkspaces()
        await refreshStatus()
        return { ok: true, value: value }
      }

      function toast(text, bad) {
        if (toastTimer !== null) clearTimeout(toastTimer)
        patch({ toast: { text: text, bad: bad === true, at: Date.now() } })
        toastTimer = setTimeout(function () { patch({ toast: null }) }, 4200)
      }

      function dispose() {
        disposed = true
        if (pollTimer !== null) clearTimeout(pollTimer)
        if (streamTimer !== null) clearTimeout(streamTimer)
        if (streamAbort !== null) {
          var controller = streamAbort
          streamAbort = null
          controller.abort()
        }
        if (toastTimer !== null) clearTimeout(toastTimer)
        listeners.clear()
      }

      return {
        getSnapshot: getSnapshot,
        subscribe: subscribe,
        refreshAll: refreshAll,
        refreshStatus: refreshStatus,
        onVisibilityChange: onVisibilityChange,
        refreshSetup: refreshSetup,
        refreshWorkspaces: refreshWorkspaces,
        syncNow: syncNow,
        testConnection: testConnection,
        correctCwd: correctCwd,
        resolveBlocked: resolveBlocked,
        prepareReplace: prepareReplace,
        dismissReplace: dismissReplace,
        bindWorkspace: bindWorkspace,
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
      var sessions = Array.isArray(status.sessions) ? status.sessions : []
      if (sessions.some(function (session) { return session.phase === 'failed' || session.phase === 'blocked' })) return 'bad'
      if (sessions.some(function (session) {
        return session.phase === 'deferred' || session.cwdPending === true
          || (session.lease && (session.lease.state === 'foreign' || session.lease.state === 'lost'))
      })) return 'warn'
      if (sessions.some(function (session) { return session.decision })) return 'warn'
      if (status.configured) return 'ok'
      return 'warn'
    }

    /** 取一个会话的聚合视图。 */
    function findSession(status, sessionId) {
      if (status === null || !Array.isArray(status.sessions)) return null
      return status.sessions.find(function (session) { return session && session.sessionId === sessionId }) || null
    }

    /** 一个会话当前的同步保护状态：正在应用 / 开放尾 / 待 cwd 决策 / 已分叉 / 租约。 */
    function sessionState(status, sessionId) {
      if (status === null) return {
        pending: false, tail: false, lag: false, cwd: false, blocked: false,
        blockedReason: '', unmapped: false, live: false, leaseState: null, leaseError: '',
      }
      var session = findSession(status, sessionId)
      var pending = status.pending !== null && status.pending !== undefined && status.pending.sessionId === sessionId
      return {
        pending: pending,
        tail: session ? session.tailOpen === true : false,
        lag: session ? session.remoteAhead === true : false,
        cwd: session ? session.cwdPending === true : false,
        blocked: session ? session.blocked !== undefined && session.blocked !== null : false,
        blockedReason: session && session.blocked && session.blocked.message ? session.blocked.message : '',
        unmapped: session ? session.unmapped !== undefined : false,
        live: session ? session.live === true : false,
        leaseState: session && session.lease ? session.lease.state : null,
        leaseError: session && session.lease && session.lease.error ? String(session.lease.error) : '',
      }
    }

    /**
     * 会话为什么不能继续操作；row=true 时用于列表行（live 会话允许打开/切换，
     * 只由 composer 拦输入），否则用于输入框。
     */
    function sessionBlockReason(status, sessionId, row) {
      var state = sessionState(status, sessionId)
      if (row === true && state.live) return null
      if (state.blocked) return '这个会话的本地与远端历史已分叉，已阻止继续写入；请先人工处理'
      if (state.unmapped) return '这个远端会话的工作区尚未映射到本机，请先在设置里建立一次性映射'
      if (state.leaseState === 'foreign') return '另一台设备正在编辑这个会话；本机已暂停写入'
      if (state.leaseState === 'lost') return '会话租约已丢失；本机已暂停写入，等待重新获取'
      if (state.pending) return '正在应用云端写入，暂不能继续这个会话'
      if (state.tail) return '这个会话有未闭合的同步尾巴，先完成当前轮次再打开'
      if (state.lag) return '这个会话的安全边界还落后于远端，暂不能继续'
      if (state.cwd) return '这个会话最后 cwd 在工作区外，请先在同步气泡中修正或选择仍然导入'
      return null
    }

    /* ---------- 设置页 ---------- */

    function fieldsFrom(value, setup) {
      var source = value || {}
      var fallback = setup || {}
      return {
        serverUrl: source.serverUrl !== undefined ? source.serverUrl : (fallback.serverUrl || ''),
        deviceName: source.deviceName !== undefined ? source.deviceName : (fallback.deviceName || ''),
        excludedSessionIds: Array.isArray(source.excludedSessionIds)
          ? source.excludedSessionIds.slice()
          : (Array.isArray(fallback.excludedSessionIds) ? fallback.excludedSessionIds.slice() : []),
        autoBindSamePath: source.autoBindSamePath !== undefined ? source.autoBindSamePath === true : fallback.autoBindSamePath === true,
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

    function WorkspaceMappingRow(props) {
      var model = props.model
      var options = props.options
      var suggested = props.suggestedPath
      var key = props.workspaceKey
      var boundPaths = props.boundPaths || []
      var usable = options.filter(function (item) {
        return boundPaths.indexOf(item.path) === -1 || item.workspaceKey === key
      })
      var hasSuggestion = typeof suggested === 'string' && usable.some(function (item) { return item.path === suggested })
      var choiceState = useState(hasSuggestion ? suggested : '')
      var choice = choiceState[0]
      var setChoice = choiceState[1]
      var busyState = useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var confirmState = useState(false)
      var confirming = confirmState[0]
      var setConfirming = confirmState[1]
      var selected = usable.find(function (item) { return item.path === choice })
      var selectedTitle = selected ? (selected.title || selected.path) : choice

      function bindNow() {
        if (key === null || choice === '') return
        setBusy(true)
        model.bindWorkspace(key, choice).then(function (result) {
          if (!result || result.ok !== true) {
            model.toast((result && result.error && result.error.message) || '绑定失败', true)
            return
          }
          model.toast('已建立工作区映射；不能改绑')
          setConfirming(false)
        }).catch(function (error) { model.toast(errorText(error), true) })
          .finally(function () { setBusy(false) })
      }

      var controls
      if (usable.length === 0) {
        controls = [h('span', { className: 'dssync-note warn' }, '没有可用的本地工作区；已绑定的不能改绑，先注册一个新工作区')]
      } else if (confirming) {
        controls = [
          h('div', { className: 'dssync-mapconfirm', role: 'group', 'aria-label': '确认工作区映射' },
            h('span', { className: 'dssync-note warn' },
              '绑定不可撤销：把 ' + (props.label || (key === null ? '未知工作区' : key.slice(0, 12) + '…'))
              + ' 永久绑定到「' + selectedTitle + '」？'),
            h('button', {
              className: 'dssync-pill', type: 'button', disabled: busy,
              onClick: function () { setConfirming(false) },
            }, '取消'),
            h('button', {
              className: 'dssync-pill primary', type: 'button', disabled: busy,
              onClick: bindNow,
            }, busy ? '绑定中…' : '确认绑定')),
        ]
      } else {
        controls = [
          h('select', {
            value: choice,
            onChange: function (event) { setChoice(event.target.value) },
          }, h('option', { value: '' }, '选择本地工作区…'), usable.map(function (item) {
            return h('option', { value: item.path, key: item.path }, item.title || item.path)
          })),
          h('button', {
            className: 'dssync-pill', type: 'button',
            disabled: busy || key === null || choice === '',
            onClick: function () {
              if (key === null || choice === '') return
              setConfirming(true)
            },
          }, '绑定…'),
        ]
      }

      return h('div', { className: 'dssync-maprow' + (hasSuggestion ? ' suggested' : '') },
        h('div', { className: 'dssync-mapkey', title: key || '远端没有 workspaceKey' },
          h('b', null, props.label || (key === null ? '未知工作区' : key.slice(0, 12) + '…')),
          h('span', null, (key === null ? '' : key.slice(0, 12) + '… · ')
            + (props.sessions > 0 ? props.sessions + ' 个会话' : '远端工作区')
            + (hasSuggestion ? ' · 同路径建议' : ''))),
        ...controls)
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

      function toggleSession(sessionId) {
        setFields(function (previous) {
          var list = previous.excludedSessionIds.slice()
          var index = list.indexOf(sessionId)
          if (index >= 0) list.splice(index, 1)
          else list.push(sessionId)
          return Object.assign({}, previous, { excludedSessionIds: list })
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
          { op: 'set', path: ['excludedSessionIds'], value: fields.excludedSessionIds.slice() },
          { op: 'set', path: ['autoBindSamePath'], value: fields.autoBindSamePath === true },
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
        var serverUrl = String(fields.serverUrl || '').trim()
        if (serverUrl === '') {
          setMessage({ bad: true, text: '先填写服务端地址' })
          return
        }
        setBusy('test')
        setMessage(null)
        try {
          // 只测当前输入的服务端地址：不落盘、不带 token，也不必等配置热更新。
          var result = await model.testConnection(serverUrl)
          if (result && result.ok) {
            setMessage({ bad: false, text: '服务端可达' })
            model.toast('服务端可达')
          } else {
            setMessage({ bad: true, text: (result && result.message) || '连接失败' })
          }
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
        var summarySessions = state.workspaces && Array.isArray(state.workspaces.sessions) ? state.workspaces.sessions : []
        var excludedNow = fields.excludedSessionIds || []
        var selected = summarySessions.filter(function (session) { return excludedNow.indexOf(session.sessionId) < 0 }).length
        return h('span', null, '自部署同步 · ' + (setup && setup.configured ? '已配置' : '未配置') + ' · ' + selected + ' 个根会话')
      }

      var workspaces = state.workspaces
      var candidates = workspaces ? workspaces.workspaces : []
      var sessions = workspaces && Array.isArray(workspaces.sessions) ? workspaces.sessions : []
      var excludedIds = fields.excludedSessionIds || []
      var includedCount = sessions.filter(function (session) { return excludedIds.indexOf(session.sessionId) < 0 }).length
      var sessionGroups = candidates.filter(function (item) {
        return sessions.some(function (session) { return session.workspacePath === item.path })
      })
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
            h('span', null, '按根会话选择；子代理跟随')),
          h('div', { className: 'dssync-btnrow' },
            h('button', {
              className: 'dssync-pill', type: 'button', disabled: disabled || sessions.length === 0,
              onClick: function () {
                set('excludedSessionIds', includedCount === sessions.length ? sessions.map(function (session) { return session.sessionId }) : [])
              },
            }, includedCount === sessions.length && sessions.length > 0 ? '清空会话' : '全选会话'),
            h('span', { className: 'dssync-note' }, '同步 ' + includedCount + ' / ' + sessions.length + ' 个根会话'),
            h('span', { className: 'spacer' }),
            workspaces === null ? h('span', { className: 'dssync-note' }, '读取会话…') : null),
          sessions.length === 0 && workspaces !== null
            ? h('div', { className: 'dssync-note warn' }, '还没有可同步的根会话。')
            : h('div', { className: 'dssync-sessionlist' }, sessionGroups.map(function (workspace) {
              var workspaceSessions = sessions.filter(function (session) { return session.workspacePath === workspace.path })
              var workspaceSelected = workspaceSessions.filter(function (session) { return excludedIds.indexOf(session.sessionId) < 0 }).length
              return h('div', { className: 'dssync-sessiongroup', key: workspace.path },
                h('div', { className: 'dssync-sessiongroup-head' },
                  h('b', null, workspace.title || workspace.path),
                  h('span', null, workspace.path),
                  h('span', null, workspaceSelected + ' / ' + workspaceSessions.length)),
                workspaceSessions.map(function (session) {
                  var excluded = excludedIds.indexOf(session.sessionId) >= 0
                  return h('label', { className: 'dssync-session' + (excluded ? ' off' : ''), key: session.sessionId },
                    h('input', { type: 'checkbox', checked: !excluded, onChange: function () { toggleSession(session.sessionId) } }),
                    h('span', { className: 'dssync-session-check' }, '✓'),
                    h('span', { className: 'dssync-session-main' },
                      h('b', null, session.sessionId),
                      h('span', null, new Date(session.createdAt).toLocaleString())),
                    h('span', { className: 'dssync-session-meta' },
                      h('span', null, session.subagentSessions + ' 个子代理'),
                      h('span', { className: 'dssync-session-status' + (excluded ? ' off' : '') }, excluded ? '已排除' : '同步')))
                }))
            })),
          h('div', { className: 'dssync-note' }, '选择只在本设备生效；取消勾选不会删除远端历史。')),

        h('section', { className: 'dssync-sec' },
          h('div', { className: 'dssync-sechead' },
            h('h3', null, '远端工作区映射'),
            h('span', null, '一次性绑定，不能改绑')),
          h('div', { className: 'dssync-note' },
            '远端会话只带 opaque workspaceKey；选择本地工作区后才会拉取。未映射的会话不会写入本机。'),
          workspaces === null
            ? h('div', { className: 'dssync-note' }, '读取映射…')
            : (workspaces.bindings || []).length > 0
              ? h('div', { className: 'dssync-bindlist' }, (workspaces.bindings || []).map(function (binding) {
                return h('div', { className: 'dssync-bindrow', key: binding.workspaceKey },
                  h('b', null, binding.label || binding.localPath),
                  h('span', { className: 'dssync-note' }, binding.localPath),
                  h('code', null, binding.workspaceKey.slice(0, 12) + '…'))
              }))
              : h('div', { className: 'dssync-note' }, '还没有本机映射。'),
          workspaces !== null && (workspaces.unmapped || []).length > 0
            ? h('div', { className: 'dssync-maplist' }, (workspaces.unmapped || []).map(function (item) {
              var suggested = item.workspaceKey === null ? undefined : candidates.find(function (candidate) { return candidate.workspaceKey === item.workspaceKey })
              return h(WorkspaceMappingRow, {
                key: String(item.workspaceKey) + ':' + item.sessions,
                model: model,
                workspaceKey: item.workspaceKey,
                label: item.label,
                sessions: item.sessions,
                suggestedPath: suggested ? suggested.path : undefined,
                options: candidates,
                boundPaths: (workspaces.bindings || []).map(function (binding) { return binding.localPath }),
              })
            }))
            : h('div', { className: 'dssync-note' }, '当前没有未映射的远端工作区。'),
          h('div', { className: 'dssync-row' },
            h('div', { className: 'dssync-rowtext' },
              h('b', null, '同路径自动绑定'),
              h('span', null, '默认关闭；开启后同名工作区匹配即建立一次性绑定')),
            h(Switch, {
              checked: fields.autoBindSamePath === true,
              disabled: disabled,
              label: '同路径自动绑定',
              onChange: function (value) { set('autoBindSamePath', value) },
            }))),

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

      function toggleSession(sessionId) {
        setFields(function (previous) {
          var list = previous.excludedSessionIds.slice()
          var index = list.indexOf(sessionId)
          if (index >= 0) list.splice(index, 1)
          else list.push(sessionId)
          return Object.assign({}, previous, { excludedSessionIds: list })
        })
      }

      async function saveFields() {
        var ops = [
          { op: 'set', path: ['serverUrl'], value: String(fields.serverUrl || '').trim() },
          { op: 'set', path: ['deviceName'], value: String(fields.deviceName || '').trim() },
          { op: 'set', path: ['excludedSessionIds'], value: fields.excludedSessionIds.slice() },
          { op: 'set', path: ['autoBindSamePath'], value: fields.autoBindSamePath === true },
          { op: 'set', path: ['autoSync'], value: fields.autoSync === true },
          { op: 'set', path: ['intervalMs'], value: Number(fields.intervalMs) || 60000 },
          { op: 'set', path: ['includeSubagents'], value: fields.includeSubagents === true },
        ]
        var accepted = await props.writeSettings(ops)
        if (!accepted.ok) throw new Error(accepted.message)
      }

      async function test() {
        var serverUrl = String(fields.serverUrl || '').trim()
        if (serverUrl === '') {
          setMessage({ bad: true, text: '先填写服务端地址' })
          return
        }
        setBusy('test')
        setMessage(null)
        try {
          // 首启第 1 步还不该有 token：直接用当前输入测可达性，不落盘也不看配置。
          var result = await model.testConnection(serverUrl)
          if (result && result.ok) {
            setMessage({ bad: false, text: '服务端可达' })
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
          setBusy('save')
          try {
            await saveFields()
            await model.refreshSetup()
            await model.refreshWorkspaces()
            setStep(3)
          } catch (error) {
            setMessage({ bad: true, text: errorText(error) })
          } finally {
            setBusy('')
          }
          return
        }
        if (step === 3) {
          setStep(4)
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
      var sessions = workspaces && Array.isArray(workspaces.sessions) ? workspaces.sessions : []
      var excludedIds = fields.excludedSessionIds || []
      var includedCount = sessions.filter(function (session) { return excludedIds.indexOf(session.sessionId) < 0 }).length
      var steps = ['连接', '凭据', '会话', '映射', '完成']
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
        body = [
          h('div', { className: 'dssync-btnrow' },
            h('button', {
              className: 'dssync-pill', type: 'button',
              onClick: function () {
                set('excludedSessionIds', includedCount === sessions.length ? sessions.map(function (session) { return session.sessionId }) : [])
              },
            }, includedCount === sessions.length && sessions.length > 0 ? '清空会话' : '全选会话'),
            h('span', { className: 'dssync-note' }, '同步 ' + includedCount + ' / ' + sessions.length + ' 个根会话')),
          sessions.length === 0
            ? h('div', { className: 'dssync-note warn' }, '还没有可同步的根会话；可以稍后在设置里处理。')
            : h('div', { className: 'dssync-sessionlist' }, candidates.map(function (workspace) {
              var workspaceSessions = sessions.filter(function (session) { return session.workspacePath === workspace.path })
              if (workspaceSessions.length === 0) return null
              var workspaceSelected = workspaceSessions.filter(function (session) { return excludedIds.indexOf(session.sessionId) < 0 }).length
              return h('div', { className: 'dssync-sessiongroup', key: workspace.path },
                h('div', { className: 'dssync-sessiongroup-head' },
                  h('b', null, workspace.title || workspace.path),
                  h('span', null, workspace.path),
                  h('span', null, workspaceSelected + ' / ' + workspaceSessions.length)),
                workspaceSessions.map(function (session) {
                  var excluded = excludedIds.indexOf(session.sessionId) >= 0
                  return h('label', { className: 'dssync-session' + (excluded ? ' off' : ''), key: session.sessionId },
                    h('input', { type: 'checkbox', checked: !excluded, onChange: function () { toggleSession(session.sessionId) } }),
                    h('span', { className: 'dssync-session-main' },
                      h('b', null, session.sessionId),
                      h('span', null, new Date(session.createdAt).toLocaleString())),
                    h('span', { className: 'dssync-session-meta' },
                      h('span', null, session.subagentSessions + ' 个子代理'),
                      h('span', { className: 'dssync-session-status' + (excluded ? ' off' : '') }, excluded ? '已排除' : '同步')))
                }))
            })),
          h('div', { className: 'dssync-note' }, '选择只在本设备生效；子代理跟随根会话。'),
          message ? h('div', { className: 'dssync-note' + (message.bad ? ' bad' : '') }, message.text) : null,
        ]
      } else if (step === 3) {
        var unmapped = workspaces && Array.isArray(workspaces.unmapped) ? workspaces.unmapped : []
        body = [
          h('div', { className: 'dssync-note' }, '远端工作区按 workspaceKey 一次性绑定；未映射的会话不会写入本机。'),
          unmapped.length === 0
            ? h('div', { className: 'dssync-note' }, '当前没有待映射的远端工作区，可以继续。')
            : h('div', { className: 'dssync-maplist' }, unmapped.map(function (item) {
              var suggested = item.workspaceKey === null ? undefined : candidates.find(function (candidate) { return candidate.workspaceKey === item.workspaceKey })
              return h(WorkspaceMappingRow, {
                key: String(item.workspaceKey) + ':' + item.sessions,
                model: model,
                workspaceKey: item.workspaceKey,
                label: item.label,
                sessions: item.sessions,
                suggestedPath: suggested ? suggested.path : undefined,
                options: candidates,
                boundPaths: (workspaces.bindings || []).map(function (binding) { return binding.localPath }),
              })
            })),
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
              busy === 'finish' ? '同步中…' : step === 4 ? '开始同步' : '下一步')),
        ),
        h(Toast, { model: model }))
    }

    /* ---------- 远端覆盖本地向导 ---------- */

    function ReplaceDialog(props) {
      var model = props.model
      var state = useModel(model)
      var plan = state.replacePlan
      var copiedState = useState(false)
      var copied = copiedState[0]
      var setCopied = copiedState[1]
      if (plan === null || plan === undefined) return null

      function close() {
        model.dismissReplace()
      }

      function copyCommand() {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(plan.command).then(function () {
            setCopied(true)
            setTimeout(function () { setCopied(false) }, 1800)
          }, function () { model.toast('复制失败，请手动选择命令', true) })
          return
        }
        model.toast('当前环境不能直接复制，请手动选择命令', true)
      }

      return h('div', { className: 'dssync dssync-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': '接受远端丢弃本地' },
        h('div', { className: 'dssync-wizard' },
          h('div', { className: 'dssync-wizard-head' },
            h('div', { className: 'dssync-wizard-icon' }, shieldIcon()),
            h('div', null,
              h('h2', null, '接受远端，丢弃本地'),
              h('p', null, '本地分支不会参与合并；只保留一份停机备份。')),
            h('button', { className: 'dssync-close', type: 'button', 'aria-label': '关闭', onClick: close }, '×')),
          h('div', { className: 'dssync-wizard-body' },
            h('div', { className: 'dssync-replace-warning' },
              '这是破坏性操作：脚本会删除本地会话 artifact。',
              h('br'),
              '只有确认远端是最终版本时才继续。脚本会先备份并逐文件校验，备份失败会立即停止。',
              h('br'),
              '执行前确认远端仍有该会话，并确认它所属工作区在同步白名单内；否则启动后不会被拉回。'),
            h('ol', { className: 'dssync-replace-steps' }, plan.steps.map(function (step, index) {
              return h('li', { key: 'replace-step-' + index }, step)
            })),
            h('div', { className: 'dssync-replace-code' }, plan.command),
            h('div', { className: 'dssync-replace-meta' }, '备份目录：' + plan.backupRoot),
            h('div', { className: 'dssync-replace-meta' },
              '脚本只生成命令；不会自动关闭或重启 DSH。执行前请先完全退出 DSH。')),
          h('div', { className: 'dssync-wizard-foot' },
            h('button', { className: 'dssync-pill', type: 'button', onClick: copyCommand }, copied ? '已复制' : '复制命令'),
            h('span', { className: 'spacer' }),
            h('button', { className: 'dssync-pill primary', type: 'button', onClick: close }, '知道了')),
        ),
        h(Toast, { model: model }))
    }

    /* ---------- 顶部同步气泡 ---------- */

    function Bubble(props) {
      var model = props.model
      var state = useModel(model)
      var setup = state.setup
      var status = state.status

      function shortSessionId(sessionId) {
        var value = String(sessionId || '')
        if (value.indexOf('session-') === 0) value = value.slice('session-'.length)
        return value.length > 8 ? value.slice(0, 8) : value
      }

      function sessionLabel(sessionId) {
        var title = props.titleOf ? String(props.titleOf(sessionId) || '') : ''
        var shortId = shortSessionId(sessionId)
        if (title === '') return '未命名会话 · ' + shortId
        return title + ' · ' + shortId
      }
      var visibleState = useState(false)
      var visible = visibleState[0]
      var setVisible = visibleState[1]
      var openState = useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var pinnedState = useState(false)
      var pinned = pinnedState[0]
      var setPinned = pinnedState[1]
      var syncingState = useState(false)
      var syncing = syncingState[0]
      var setSyncing = syncingState[1]
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
          model.onVisibilityChange()
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

      var sessions = status && Array.isArray(status.sessions) ? status.sessions.slice() : []
      var total = sessions.length
      var done = sessions.filter(function (session) { return session.phase === 'done' }).length
      var skipped = sessions.filter(function (session) { return session.phase === 'skipped' }).length
      var deferred = sessions.filter(function (session) { return session.phase === 'deferred' }).length
      var blockedCount = sessions.filter(function (session) { return session.phase === 'blocked' }).length
      var failed = sessions.some(function (session) { return session.phase === 'failed' })
      var running = status && status.running
      var title = failed ? '同步失败'
        : blockedCount > 0 ? '需要处理'
          : running ? '正在同步'
            : deferred > 0 ? '部分待处理' : '同步完成'
      var subtitle = failed ? '有会话未完成，已暂停'
        : running ? (total === 0 ? '连接服务端…' : done + '/' + total + ' 个会话 · 端到端加密')
          : blockedCount > 0 ? blockedCount + ' 个会话历史分叉，已阻止继续写入'
            : deferred > 0 ? deferred + ' 个会话等待拉取/关闭/cwd 处理'
              : total === 0 ? '还没有同步记录'
                : (done + skipped) + '/' + total + ' 个会话 · ' + (status.lastSuccess ? formatAgo(status.lastSuccess) : '尚未成功')
      var dot = statusDot(status)
      var segments = sessions.map(function (session) {
        var bad = session.phase === 'failed' || session.phase === 'blocked'
        var active = session.phase === 'running'
        var attention = session.phase === 'deferred'
        var terminal = session.phase === 'done' || session.phase === 'skipped'
        var ratio = session.totalEvents > 0 ? session.doneEvents / session.totalEvents : (terminal ? 1 : 0)
        var pct = bad ? 100 : terminal ? 100 : attention ? 55 : active ? Math.max(10, Math.min(95, Math.round(ratio * 100))) : 0
        return h('span', {
          className: 'dssync-seg' + (bad ? ' bad' : active || attention ? ' run' : pct >= 100 ? ' done' : ''),
          key: session.sessionId,
          title: sessionLabel(session.sessionId),
        }, h('i', { style: { width: pct + '%' } }))
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

      function triggerSync() {
        if (syncing) return
        setSyncing(true)
        setOpen(true)
        setVisible(true)
        model.syncNow().then(function (result) {
          if (result && result.ok === true) model.toast('同步已触发')
          else if (result && result.code === 'already-running') model.toast('同步正在进行')
          else model.toast((result && (result.message || result.code)) || '同步未执行', true)
        }).catch(function (error) {
          model.toast(errorText(error), true)
        }).finally(function () {
          setSyncing(false)
        })
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
      var badClass = failed || blockedCount > 0 ? ' bad' : ''
      function cwdActions(id) {
        return [
          h('button', {
            className: 'dssync-mini', type: 'button', key: id + ':fix',
            onClick: function (event) {
              event.stopPropagation()
              model.correctCwd(id).then(function (result) {
                if (!result || result.ok !== true) {
                  model.toast((result && result.message) || '修正失败', true)
                  return
                }
                model.toast(result.status === 'already-portable' ? '已在工作区内' : '已修正并同步 cwd')
              }).catch(function (error) { model.toast(errorText(error), true) })
            },
          }, '修正 cwd'),
          h('button', {
            className: 'dssync-mini', type: 'button', key: id + ':skip',
            onClick: function (event) {
              event.stopPropagation()
              model.correctCwd(id, 'skip').then(function (result) {
                if (!result || result.ok !== true) {
                  model.toast((result && result.message) || '导入失败', true)
                  return
                }
                model.toast('已按原 cwd 导入')
              }).catch(function (error) { model.toast(errorText(error), true) })
            },
          }, '仍然导入'),
        ]
      }

      function blockedActions(id, entry) {
        function settle(action) {
          model.resolveBlocked(id, action, entry && entry.createdAt, entry && entry.formatVersion).then(function (result) {
            if (!result || result.ok !== true) {
              model.toast((result && result.error && result.error.message) || '处理失败', true)
              return
            }
            model.toast(action === 'ignore' ? '已忽略该分叉会话' : '已允许继续写入；不会自动合并')
          }).catch(function (error) { model.toast(errorText(error), true) })
        }
        return [
          h('button', {
            className: 'dssync-mini', type: 'button', key: id + ':ignore',
            onClick: function (event) { event.stopPropagation(); settle('ignore') },
          }, '忽略'),
          h('button', {
            className: 'dssync-mini', type: 'button', key: id + ':force',
            onClick: function (event) { event.stopPropagation(); settle('force') },
          }, '强行写入'),
          h('button', {
            className: 'dssync-mini dssync-mini-danger', type: 'button', key: id + ':replace',
            title: '备份本地后删除，并让远端重建同一会话',
            onClick: function (event) {
              event.stopPropagation()
              model.prepareReplace(id).then(function (result) {
                if (!result || result.ok !== true) {
                  model.toast((result && result.error && result.error.message) || '生成覆盖脚本失败', true)
                }
              }).catch(function (error) { model.toast(errorText(error), true) })
            },
          }, '接受远端'),
        ]
      }

      function decisionActions(id, entry) {
        return [
          h('button', {
            className: 'dssync-mini', type: 'button', key: id + ':restore',
            onClick: function (event) {
              event.stopPropagation()
              model.resolveBlocked(id, 'restore', entry.createdAt, entry.formatVersion).then(function (result) {
                if (!result || result.ok !== true) {
                  model.toast((result && result.error && result.error.message) || '恢复失败', true)
                  return
                }
                model.toast('已恢复分叉拦截')
              }).catch(function (error) { model.toast(errorText(error), true) })
            },
          }, '恢复拦截'),
          h('button', {
            className: 'dssync-mini dssync-mini-danger', type: 'button', key: id + ':replace',
            title: '备份本地后删除，并让远端重建同一会话',
            onClick: function (event) {
              event.stopPropagation()
              model.prepareReplace(id).then(function (result) {
                if (!result || result.ok !== true) {
                  model.toast((result && result.error && result.error.message) || '生成覆盖脚本失败', true)
                }
              }).catch(function (error) { model.toast(errorText(error), true) })
            },
          }, '接受远端'),
        ]
      }

      var rows = sessions.map(function (session) {
        var blockedEntry = session.blocked || null
        var decisionEntry = session.decision || null
        var leaseEntry = session.lease || null
        var leaseTag = leaseEntry === null ? ''
          : leaseEntry.state === 'foreign' ? '他机编辑'
            : leaseEntry.state === 'lost' ? '租约丢失' : ''
        var isBlocked = blockedEntry !== null
        var isResolved = decisionEntry !== null
        var decisionTag = isResolved ? (decisionEntry.action === 'ignore' ? '已忽略' : '已强行写入') : ''
        var tag = isBlocked ? '分叉'
          : isResolved ? decisionTag
            : session.phase === 'failed' ? '失败'
              : session.phase === 'blocked' ? '分叉'
                : session.phase === 'skipped' ? '已跳过'
                  : session.phase === 'done' ? '已完成'
                    : session.phase === 'running' ? '同步中'
                      : session.phase === 'deferred'
                        ? (session.live ? '已加载'
                          : session.remoteAhead ? '远端领先'
                            : session.unmapped ? '待映射'
                              : session.cwdPending ? 'cwd 外' : '等待')
                        : '等待'
        var counts = []
        if (session.pending && session.pending.upload > 0) counts.push('↑ ' + session.pending.upload)
        else if (session.push && session.push.totalEvents > 0) counts.push('↑ ' + session.push.doneEvents + '/' + session.push.totalEvents)
        if (session.pending && session.pending.download > 0) counts.push('↓ ' + session.pending.download)
        else if (session.pull && session.pull.totalEvents > 0) counts.push('↓ ' + session.pull.doneEvents + '/' + session.pull.totalEvents)
        var attention = tag === '远端领先' || tag === '已加载' || tag === '待映射' || tag === 'cwd 外' || leaseTag !== ''
        var stateClass = isBlocked || session.phase === 'failed' || leaseEntry !== null && leaseEntry.state === 'lost' ? 'bad'
          : session.phase === 'done' || session.phase === 'skipped' ? 'ok'
            : session.phase === 'running' || attention || isResolved ? 'run' : ''
        return h('div', { className: 'dssync-rowline', key: session.sessionId },
          h('span', { className: 'dssync-st ' + stateClass }),
          h('span', { className: 'name' }, sessionLabel(session.sessionId)),
          counts.length > 0 ? h('span', { className: 'dssync-events' }, counts.join(' · ')) : null,
          h('span', { className: 'tag' }, tag),
          leaseTag === '' ? null : h('span', {
            className: 'dssync-warn',
            title: leaseEntry && leaseEntry.error ? leaseEntry.error : (leaseEntry.ownerDeviceId ? '租约由 ' + leaseEntry.ownerDeviceId + ' 持有' : '设备独占租约'),
          }, leaseTag),
          isBlocked ? h('span', { className: 'dssync-warn', title: '本地与远端历史已分叉，已阻止继续写入' }, '已阻止') : null,
          isBlocked ? blockedActions(session.sessionId, blockedEntry) : null,
          isResolved ? h('span', { className: 'dssync-warn', title: decisionEntry.message }, decisionTag) : null,
          isResolved ? decisionActions(session.sessionId, decisionEntry) : null,
          !isBlocked && !isResolved && session.cwdPending ? h('span', {
            className: 'dssync-warn', title: '最后 cwd 在工作区外，跨设备可能无法正确恢复',
          }, 'cwd 外') : null,
          !isBlocked && !isResolved && session.cwdPending ? cwdActions(session.sessionId) : null)
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
      h('span', { className: 'dssync-count' }, (done + skipped) + '/' + total),
      h('button', {
        className: 'dssync-chev', type: 'button', 'aria-label': open ? '收起同步会话列表' : '展开同步会话列表',
        'aria-expanded': open, onClick: onListToggle,
      }, chevronIcon()))

      var panel = h('div', { className: 'dssync-collapse' },
        h('div', { className: 'dssync-collapse-in' },
          h('div', { className: 'dssync-panel' }, rows.length > 0
            ? rows
            : h('div', { className: 'dssync-note' }, '暂无会话记录')),
          status && status.lastError ? h('div', { className: 'dssync-error' }, status.lastError.message + (status.retryCount > 0 ? ' · 已重试 ' + status.retryCount + ' 次' : '')) : null,
          h('div', { className: 'dssync-foot' },
            h('span', null, running ? '正在同步…' : failed ? '已暂停' : blockedCount > 0 ? '有分叉待处理' : deferred > 0 ? '有会话待处理' : '全部完成'),
            h('span', { className: 'spacer' }),
            h('button', { className: 'dssync-mini', type: 'button', disabled: syncing || running, 'aria-busy': syncing, onClick: triggerSync }, syncing || running ? '同步中…' : '立即同步'),
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
      if (!sync.pending && !sync.tail && !sync.lag && sync.leaseState !== 'foreign' && sync.leaseState !== 'lost') return null
      var label = sync.pending ? '正在应用云端写入'
        : sync.tail ? '有未闭合的同步尾巴'
          : sync.leaseState === 'foreign' ? '另一台设备正在编辑'
            : sync.leaseState === 'lost' ? '会话租约已丢失'
              : '安全边界落后于远端'
      return h('span', {
        className: 'dssync-rowmark' + (sync.tail || sync.lag || sync.leaseState === 'lost' ? ' tail' : ''),
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
      /** 会话标题来自客户端 session list；取不到时气泡退回短 ID。 */
      function sessionTitleOf(sessionId) {
        try {
          if (!ctx.sessions || !ctx.sessions.list || typeof ctx.sessions.list.getSnapshot !== 'function') return ''
          var summary = ctx.sessions.list.getSnapshot().byId[String(sessionId)]
          if (summary === undefined || summary === null) return ''
          return String(summary.title || '')
        } catch (error) {
          return ''
        }
      }
      var style = document.createElement('style')
      style.dataset.plugin = 'dsh-session-cloudsync'
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(function () { return function () { style.remove() } }, 'dsh-session-cloudsync: styles')
      ctx.effect(function () { return function () { model.dispose() } }, 'dsh-session-cloudsync: model')
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
        return sessionBlockReason(model.getSnapshot().status, sessionId, true)
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
      }, 'dsh-session-cloudsync: row interception')

      ctx.slots.inject('conversation.input.dock', function () {
        return ctx.slots.register({
          name: 'conversation.input.dock', id: 'session-cloudsync-guard', order: 90,
          inject: function () { return { model: model, setBlock: setBlock } },
        }, SyncComposerGuard)
      })

      ctx.slots.inject('sidebar.session.row.leading', function () {
        return ctx.slots.register({
          name: 'sidebar.session.row.leading', id: 'session-cloudsync-mark', order: 50,
          inject: function () { return { model: model } },
        }, SyncRowMark)
      })

      ctx.slots.inject('sidebar.session.row.hover', function () {
        return ctx.slots.register({
          name: 'sidebar.session.row.hover', id: 'session-cloudsync-hover', order: 50,
          inject: function () { return { model: model } },
        }, SyncRowHover)
      })

      ctx.slots.inject('plugins.bundle.config', function () {
        return ctx.slots.register({
          name: 'plugins.bundle.config', key: 'dsh-session-cloudsync',
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
          name: 'shell.overlay', id: 'dsh-session-cloudsync-onboarding', order: 20,
          inject: function () { return { model: model, setCredential: setCredential, writeSettings: writeSettings } },
        }, Onboarding)
        yield ctx.slots.register({
          name: 'shell.overlay', id: 'dsh-session-cloudsync-bubble', order: 30,
          inject: function () { return { model: model, openSettings: openSettings, titleOf: sessionTitleOf } },
        }, Bubble)
        yield ctx.slots.register({
          name: 'shell.overlay', id: 'dsh-session-cloudsync-replace', order: 40,
          inject: function () { return { model: model } },
        }, ReplaceDialog)
      })
    }

    return { inject: ['slots', 'sessions'], apply: apply }
  },
})
