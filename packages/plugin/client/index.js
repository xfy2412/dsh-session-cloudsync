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
    var useLayoutEffect = React.useLayoutEffect || React.useEffect
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
    var AGREEMENT_ACCEPTED_KEY = 'dsh-session-cloudsync.agreement.accepted'
    var ONBOARD_FORCE_KEY = 'dsh-session-cloudsync.onboarding.force'
    var AGREEMENT_DOC_BASE = 'https://github.com/xfy2412/dsh-session-cloudsync/blob/main/docs/guides/'
    var OPEN_GUARD_MARK = '__dshSessionCloudsyncOpenGuard'

    var CSS = [
      '.dssync{--dssync-accent:#5686fe;--dssync-accent-soft:rgba(86,134,254,.14);--dssync-line:var(--dsw-alias-border-l2,rgba(127,127,127,.24));--dssync-line-strong:var(--dsw-alias-border-l4,rgba(127,127,127,.42));--dssync-text:var(--dsw-alias-label-primary,inherit);--dssync-muted:var(--dsw-alias-label-secondary,rgba(220,220,230,.7));--dssync-faint:var(--dsw-alias-label-tertiary,rgba(220,220,230,.46));color:var(--dssync-text);font-size:14px;line-height:1.55}',
      '.dssync *{box-sizing:border-box}',
      '.dssync-page{display:flex;flex-direction:column;gap:22px;padding:4px 0 28px}',
      '.dssync-savebar{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:10px;padding:10px 0;background:var(--dsw-alias-bg-primary,#151a20);border-bottom:1px solid var(--dssync-line)}',
      '.dssync-savebar .spacer{flex:1 1 auto}',
      '.dssync-savebar .dirty{color:var(--dsw-alias-state-warn-primary,#f0b64a);font-size:12px}',
      '.dssync-savebar .clean{color:var(--dssync-faint);font-size:12px}',
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
      '.dssync-note.dssync-idle{font-style:italic;opacity:.82;letter-spacing:.01em}',
      '.dssync-perf-pre{margin:0;padding:9px 10px;max-height:180px;overflow:auto;border:1px solid var(--dssync-line);border-radius:8px;background:rgba(127,127,127,.07);color:var(--dssync-muted);font:10.5px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}',
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
      '.dssync-mappanel{display:flex;flex-direction:column;gap:10px}',
      '.dssync-mapstats{display:flex;flex-wrap:wrap;gap:7px}',
      '.dssync-mapstat{padding:3px 8px;border:1px solid var(--dssync-line);border-radius:999px;background:rgba(255,255,255,.025);color:var(--dssync-faint);font-size:10.5px}',
      '.dssync-mapstat b{color:var(--dssync-text);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}',
      '.dssync-maptablewrap{overflow-x:auto;border:1px solid var(--dssync-line);border-radius:11px}',
      '.dssync-maptable{width:100%;border-collapse:collapse;table-layout:fixed}',
      '.dssync-maptable th{padding:8px 11px;border-bottom:1px solid var(--dssync-line);background:rgba(255,255,255,.025);color:var(--dssync-faint);font-size:10px;font-weight:500;text-align:left;white-space:nowrap}',
      '.dssync-maptable td{padding:10px 11px;border-bottom:1px solid rgba(255,255,255,.055);vertical-align:top;font-size:11px}',
      '.dssync-maptable tr:last-child td{border-bottom:0}',
      '.dssync-maptable col.local{width:41%}',
      '.dssync-maptable col.rel{width:92px}',
      '.dssync-maptable .relcell{text-align:center}',
      '.dssync-maplocal b,.dssync-mapremote b{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dssync-text);font-size:12px;font-weight:550}',
      '.dssync-mappath,.dssync-mapkeytext{margin-top:2px;color:var(--dssync-faint);font:10px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}',
      '.dssync-mapremote-meta{margin-top:3px;color:var(--dssync-faint);font-size:10px}',
      '.dssync-mapnote{margin-top:4px;color:var(--dssync-faint);font-size:10px;line-height:1.45}',      '.dssync-mapboard{display:flex;flex-direction:column;gap:10px}',
      '.dssync-maprow{display:grid;grid-template-columns:minmax(200px,1fr) 92px minmax(200px,1fr);gap:12px;align-items:stretch}',
      '.dssync-mapslot{display:flex;flex-direction:column;justify-content:center;min-height:78px;border:1px dashed transparent;border-radius:11px}',
      '.dssync-mapslot.empty{border-color:var(--dssync-line);align-items:center;color:var(--dssync-faint);font-size:11.5px}',
      '.dssync-mapslot.drop{border-color:var(--dssync-accent);background:var(--dssync-accent-soft)}',
      '.dssync-mapcard{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:1px solid var(--dssync-line-strong);border-radius:11px;background:rgba(255,255,255,.02)}',
      '.dssync-mapcard[draggable="true"]{cursor:grab}',
      '.dssync-mapcard[draggable="true"]:active{cursor:grabbing}',
      '.dssync-mapcard.locked{border-color:rgba(34,197,94,.35)}',
      '.dssync-mapcard .title{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.dssync-mapcard .title b{font-size:12.5px}',
      '.dssync-mapcard .dssync-mappath{font-size:11px}',      '.dssync-mapcenter{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px}',
      '.dssync-maplock{width:32px;height:32px;border-radius:9px;border:1px solid var(--dssync-line-strong);background:transparent;display:grid;place-items:center;cursor:pointer;color:var(--dssync-faint)}',
      '.dssync-maplock:hover{background:rgba(127,127,127,.12);color:var(--dssync-text)}',
      '.dssync-maplock.locked{border-color:rgba(34,197,94,.45);background:rgba(34,197,94,.1);color:#9ce8bc}',
      '.dssync-maplock[disabled]{cursor:default;opacity:.55}',
      '.dssync-maplock svg{width:15px;height:15px;display:block}',
      '.dssync-maparrow{display:inline-flex;align-items:center;justify-content:center;height:22px;min-width:32px;padding:0 6px;border:1px solid var(--dssync-line);border-radius:6px;background:transparent;color:var(--dssync-muted);font:12px/1 ui-monospace,monospace;cursor:pointer}',
      '.dssync-maparrow:hover{color:var(--dssync-text);border-color:var(--dssync-line-strong)}',
      '.dssync-maparrow.accent{color:#b9ccff;border-color:rgba(86,134,254,.35)}',
      '.dssync-maparrow.on{color:#f0c87a;border-color:rgba(240,184,74,.45);background:rgba(240,184,74,.1)}',
      '.dssync-mapremote{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:1px solid var(--dssync-line);border-radius:11px;background:rgba(255,255,255,.02)}',
      '.dssync-mapremote .title{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.dssync-mapremote .title b{font-size:12.5px}',
      '.dssync-mapremote .state{margin-left:auto;font-size:10.5px;color:var(--dssync-faint)}',
      '.dssync-mapremote .state.bound{color:#9ce8bc}',
      '.dssync-mapremote .state.ready{color:#b9ccff}',
      '.dssync-mapremote.empty{border-style:dashed}',
      '.dssync-maprow-drop{outline:none}',


      '.dssync-rel{display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:999px;font-size:10px;white-space:nowrap;border:1px solid var(--dssync-line)}',
      '.dssync-rel.bound{color:#9ce8bc;background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.22)}',
      '.dssync-rel.native{color:#b9ccff;background:var(--dssync-accent-soft);border-color:rgba(86,134,254,.24)}',
      '.dssync-rel.local{color:var(--dssync-muted);background:rgba(255,255,255,.04)}',
      '.dssync-rel.pending{color:#f4cd82;background:rgba(240,182,74,.12);border-color:rgba(240,182,74,.24)}',
      '.dssync-mappick{display:flex;flex-direction:column;gap:6px}',
      '.dssync-mappick-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.dssync-mappick select{flex:1 1 170px;min-width:0;height:29px;border:1px solid var(--dssync-line-strong);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#1d1d1f);color:inherit;font:inherit;font-size:11px}',
      '.dssync-mapempty{padding:16px;border:1px dashed var(--dssync-line);border-radius:10px;color:var(--dssync-faint);font-size:11.5px;line-height:1.55;text-align:center}',
      '.dssync-mapempty b{display:block;margin-bottom:3px;color:var(--dssync-muted);font-size:12.5px;font-weight:550}',
      '.dssync-mapempty .dssync-pill{margin-top:9px}',
      '@media(max-width:640px){.dssync-mappath,.dssync-mapkeytext{overflow-wrap:anywhere}.dssync-maptable col.rel{width:76px}.dssync-maptable th,.dssync-maptable td{padding:8px}}',
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
      '@keyframes dssync-pulse{0%,100%{opacity:1}50%{opacity:.3}}',
      '@keyframes dssync-overlay-in{from{opacity:0}to{opacity:1}}',
      '@keyframes dssync-wizard-in{from{opacity:0;transform:translateY(-14px) scale(.97)}to{opacity:1;transform:none}}',
      '@keyframes dssync-step-next{from{opacity:0;transform:translateX(10px)}to{opacity:1;transform:none}}',
      '@keyframes dssync-step-back{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:none}}',
      '.dssync-wizard-head{display:flex;align-items:flex-start;gap:14px;margin-bottom:20px;position:relative}',
      '.dssync-wizard-icon{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;background:var(--dssync-accent-soft);color:#b9ccff;flex:0 0 auto}',
      '.dssync-wizard h2{margin:0;font-size:22px;line-height:1.25;font-weight:600}',
      '.dssync-wizard p{margin:5px 0 0;color:var(--dssync-muted);font-size:13px}',
      '.dssync-agreement{max-height:42vh;overflow:auto;padding:12px 14px;border:1px solid var(--dssync-line);border-radius:10px;background:rgba(0,0,0,.14);font-size:12.5px;line-height:1.65}',
      '.dssync-agreement h3,.dssync-agreement h4{margin:10px 0 6px;color:var(--dssync-text);font-size:13px;line-height:1.35}',
      '.dssync-agreement h3:first-child,.dssync-agreement h4:first-child{margin-top:0}',
      '.dssync-agreement p{margin:0 0 8px;color:var(--dssync-muted);font-size:12.5px;line-height:1.65}',
      '.dssync-agreement p:last-child{margin-bottom:0}',
      '.dssync-agreement ul{margin:0 0 8px;padding-left:18px;color:var(--dssync-muted)}',
      '.dssync-agreement li{margin:3px 0}',
      '.dssync-agreement blockquote{margin:8px 0;padding:5px 10px;border-left:2px solid var(--dssync-line-strong);color:var(--dssync-faint)}',
      '.dssync-agreement code{padding:1px 4px;border-radius:4px;background:rgba(127,127,127,.16);font-size:11.5px}',
      '.dssync-agreement pre{overflow:auto;padding:8px;border-radius:6px;background:rgba(0,0,0,.2);font-size:11.5px}',
      '.dssync-agreement a{color:#b9ccff;text-decoration:underline}',
      '.dssync-agree{display:flex;align-items:flex-start;gap:8px;color:var(--dssync-muted);font-size:12.5px;line-height:1.5;cursor:pointer}',
      '.dssync-agree input{margin:2px 0 0;flex:0 0 auto}',      '.dssync-choice{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
      '.dssync-choice-card{display:flex;flex-direction:column;gap:6px;padding:16px;border:1px solid var(--dssync-line-strong);border-radius:12px;background:transparent;color:var(--dssync-text);text-align:left;cursor:pointer}',
      '.dssync-choice-card:hover{background:rgba(127,127,127,.08)}',
      '.dssync-choice-card b{font-size:13.5px}',
      '.dssync-choice-card span{color:var(--dssync-muted);font-size:12px;line-height:1.5}',
      '.dssync-summary{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--dssync-line);border-radius:10px;background:rgba(0,0,0,.14)}',
      '.dssync-summary>div{display:flex;gap:12px;align-items:baseline}',
      '.dssync-summary span{color:var(--dssync-faint);font-size:11px;min-width:64px}',
      '.dssync-summary b{font-size:12.5px;color:var(--dssync-text);word-break:break-all}',
      '@media(max-width:560px){.dssync-choice{grid-template-columns:1fr}}',


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
      '.dssync-dot{position:absolute;right:1px;bottom:1px;width:6px;height:6px;border-radius:50%;background:var(--dssync-faint);border:1.5px solid #232324;overflow:visible}',
      '.dssync-dot.syncing{background:#f0b64a}.dssync-dot.bad{background:#ef4444}.dssync-dot.ok{background:#22c55e}.dssync-dot.warn{background:#f59e0b}',
      '.dssync-dot.syncing::before,.dssync-st.run::before{content:"";position:absolute;inset:-3px;border-radius:50%;border:1.5px solid transparent;border-top-color:#f0b64a;border-right-color:rgba(240,182,74,.35);animation:dssync-orbit 1.15s linear infinite;pointer-events:none}',
      '.dssync-dot.syncing::after,.dssync-st.run::after{content:"";position:absolute;inset:-3px;border-radius:50%;animation:dssync-halo 1.6s ease-in-out infinite;pointer-events:none}',
      '.dssync-dot.waiting{background:#f59e0b}.dssync-dot.waiting::after,.dssync-st.waiting::after{content:"";position:absolute;inset:-3px;border-radius:50%;border:1.5px solid rgba(245,158,11,.65);animation:dssync-ripple 2.4s ease-out infinite;pointer-events:none}',
      '@keyframes dssync-orbit{to{transform:rotate(360deg)}}',
      '@keyframes dssync-halo{0%,100%{box-shadow:0 0 0 0 rgba(240,182,74,.25)}50%{box-shadow:0 0 0 4px rgba(240,182,74,0)}}',
      '@keyframes dssync-ripple{0%{opacity:.65;transform:scale(.75)}70%,100%{opacity:0;transform:scale(1.45)}}',
      '@media(prefers-reduced-motion:reduce){.dssync-dot::before,.dssync-dot::after,.dssync-st::before,.dssync-st::after{animation:none!important}}',
      '.dssync-label{min-width:0;flex:1 1 auto;max-width:100%;overflow:hidden;transition:max-width .34s,opacity .18s}',
      '.dssync-label b{display:block;font-size:12px;font-weight:500;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dssync-label span{display:block;color:var(--dssync-faint);font-size:10.5px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dssync-count{margin-left:auto;color:#c6d7ff;font-size:11px;font-variant-numeric:tabular-nums;flex:0 0 auto;max-width:80px;overflow:hidden;transition:max-width .34s,opacity .18s}',
      '.dssync-chev{width:20px;height:20px;max-width:20px;display:grid;place-items:center;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dssync-faint);cursor:pointer;overflow:hidden;transition:transform .18s,background .15s,max-width .34s,opacity .18s}',
      '.dssync-chev:hover{background:rgba(255,255,255,.06);color:var(--dssync-text)}',
      '.dssync-bubble.open .dssync-chev{transform:rotate(180deg)}',
      '.dssync-bubble.collapsed .dssync-label{max-width:0;opacity:0}',
      '.dssync-bubble.collapsed .dssync-count,.dssync-bubble.collapsed .dssync-chev{max-width:0;opacity:0}',
      '.dssync-segbar{display:flex;align-items:center;gap:6px;margin:0 8px 9px;background:transparent;overflow:visible;transition:opacity .18s}',
      '.dssync-bubble.collapsed .dssync-segbar{opacity:0}',
      '.dssync-seg-end{width:13px;height:13px;flex:0 0 auto;display:grid;place-items:center;color:var(--dssync-faint);opacity:.8}',
      '.dssync-seg-end.remote{color:#8db7ff}',
      '.dssync-seg-track{display:flex;flex:1 1 auto;min-width:0;height:8px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden}',
      '.dssync-seg{position:relative;flex:1 1 0;min-width:0;overflow:hidden;background:rgba(255,255,255,.06)}',
      '.dssync-seg .push,.dssync-seg .pull{position:absolute;width:0;height:4px;transition:width .2s linear,background-color .18s}',
      '.dssync-seg .push{left:0;bottom:0;background:#f0b64a}',
      '.dssync-seg .pull{right:0;top:0;background:#5b9cff;opacity:.92}',
      '.dssync-seg .task{position:absolute;top:2px;bottom:2px;height:4px;background:#5b9cff;opacity:.92;transition:width .2s linear}',
      '.dssync-seg .task.push{left:0;background:#f0b64a}',
      '.dssync-seg .task.pull{right:0;background:#5b9cff}',
      '.dssync-seg.run .push{background:linear-gradient(90deg,#f0b64a,#ffd27a,#f0b64a);background-size:200% 100%;animation:dssync-flow 1.2s linear infinite}',
      '.dssync-seg.push-done .push{background:#22c55e;animation:none}',
      '.dssync-seg.done .push,.dssync-seg.done .pull{background:#22c55e}',
      '.dssync-seg.bad .push,.dssync-seg.bad .pull{background:#ef4444}',
      '.dssync-seg.wait .push,.dssync-seg.wait .pull{width:0!important}',
      '@keyframes dssync-flow{to{background-position:-200% 0}}',
      '.dssync-collapse{display:grid;grid-template-rows:0fr;transition:grid-template-rows .3s cubic-bezier(.2,.8,.2,1)}',
      '.dssync-bubble.open .dssync-collapse{grid-template-rows:1fr}',
      '.dssync-collapse-in{min-height:0;overflow:hidden;opacity:0;transform:translateY(-4px);transition:opacity .18s,transform .26s}',
      '.dssync-bubble.open .dssync-collapse-in{opacity:1;transform:none}',
      '.dssync-panel{padding:2px 10px 4px;max-height:250px;overflow-y:auto;overflow-x:hidden}',
      '.dssync-task-anim{max-height:44px;overflow:hidden}',
      '.dssync-task-anim.enter{animation:dssync-task-in .22s cubic-bezier(.2,.8,.2,1) both}',
      '.dssync-task-anim.exit{animation:dssync-task-out .2s cubic-bezier(.4,0,.6,1) both;pointer-events:none}',
      '@keyframes dssync-task-in{from{max-height:0;opacity:0;transform:translateX(28px)}to{max-height:44px;opacity:1;transform:none}}',
      '@keyframes dssync-task-out{from{max-height:44px;opacity:1;transform:none}to{max-height:0;opacity:0;transform:translateX(-28px)}}',
      '.dssync-rowline{display:flex;align-items:center;gap:8px;padding:5px 4px;border-radius:6px;font-size:11.5px}',
      '.dssync-rowline.focus{background:rgba(240,182,74,.08);box-shadow:inset 2px 0 0 rgba(240,182,74,.65)}',
      '.dssync-rowline .name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dssync-muted)}',
      '.dssync-rowline .name.child{padding-left:12px;color:var(--dssync-faint)}',
      '.dssync-rowline .tag{margin-left:auto;color:var(--dssync-faint);font-size:10px;white-space:nowrap}',
      '.dssync-st{position:relative;width:6px;height:6px;border-radius:50%;flex:0 0 auto;background:var(--dssync-faint);overflow:visible}',
      '.dssync-st.ok{background:#22c55e}.dssync-st.bad{background:#ef4444}.dssync-st.run{background:#f0b64a}.dssync-st.waiting{background:#f59e0b}',
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

    function computerIcon() {
      return h('svg', {
        width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      },
      h('rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 }),
      h('path', { d: 'M8 20h8M12 16v4' }))
    }

    function serverIcon() {
      return h('svg', {
        width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      },
      h('rect', { x: 3, y: 4, width: 18, height: 6, rx: 1.5 }),
      h('rect', { x: 3, y: 14, width: 18, height: 6, rx: 1.5 }),
      h('path', { d: 'M7 7h.01M7 17h.01' }))
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

    /** 单调时钟；测试环境的假 DOM 没有 performance 时退回 Date.now。 */
    function monotonicNow() {
      return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now()
    }

    /** 复制文本；Clipboard API 被权限/焦点拒绝时退回隐藏 textarea。 */
    function writeClipboard(text) {
      return new Promise(function (resolve, reject) {
        function legacy() {
          try {
            var area = document.createElement('textarea')
            area.value = text
            area.setAttribute('readonly', '')
            area.style.position = 'fixed'
            area.style.top = '-1000px'
            area.style.opacity = '0'
            document.body.appendChild(area)
            area.select()
            var copied = typeof document.execCommand === 'function' && document.execCommand('copy')
            document.body.removeChild(area)
            if (copied) resolve()
            else reject(new Error('浏览器拒绝了复制'))
          } catch (error) {
            reject(error)
          }
        }
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).then(resolve, legacy)
        } else {
          legacy()
        }
      })
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
        loading: true, setup: null, status: null, workspaces: null, config: null,
        error: null, toast: null, replacePlan: null,
      }
      var listeners = new Set()
      var pollTimer = null
      var streamAbort = null
      var streamFailedUntil = 0
      var streamLastAt = 0
      var watchdogTimer = null
      var lastVersion = -1
      var hidden = false
      var toastTimer = null
      var streamConnectStartedAt = 0
      var streamEverConnected = false
      var lastStreamFrameAt = 0
      var longTaskObserver = null
      var clientPerf = {
        sse: { connects: 0, reconnects: 0, connectMs: 0, frames: 0, maxGapMs: 0 },
        run: { runId: null, frames: 0, maxGapMs: 0 },
        longTasks: { count: 0, maxMs: 0 },
      }
      if (typeof PerformanceObserver === 'function') {
        try {
          longTaskObserver = new PerformanceObserver(function (list) {
            list.getEntries().forEach(function (entry) {
              clientPerf.longTasks.count += 1
              clientPerf.longTasks.maxMs = Math.max(clientPerf.longTasks.maxMs, Math.round(entry.duration))
            })
          })
          longTaskObserver.observe({ entryTypes: ['longtask'] })
        } catch {
          longTaskObserver = null
        }
      }
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

      function clearWatchdog() {
        if (watchdogTimer !== null) {
          clearInterval(watchdogTimer)
          watchdogTimer = null
        }
      }

      function handleStreamStatus(status) {
        if (disposed) return
        var now = monotonicNow()
        var runChanged = status && status.run && status.run.id !== clientPerf.run.runId
        if (runChanged) {
          clientPerf.run = { runId: status.run.id, frames: 0, maxGapMs: 0 }
          // 跨 run 的空闲/隐藏时间不算进本轮首帧间隔。
          lastStreamFrameAt = 0
        }
        clientPerf.sse.frames += 1
        clientPerf.run.frames += 1
        if (!runChanged && lastStreamFrameAt > 0 && !hidden) {
          var gap = Math.round(now - lastStreamFrameAt)
          clientPerf.sse.maxGapMs = Math.max(clientPerf.sse.maxGapMs, gap)
          clientPerf.run.maxGapMs = Math.max(clientPerf.run.maxGapMs, gap)
        }
        lastStreamFrameAt = now
        streamLastAt = Date.now()
        acceptStatus(status)
      }

      function closeStream() {
        clearWatchdog()
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
        streamLastAt = Date.now()
        streamConnectStartedAt = monotonicNow()
        function fail(error) {
          if (streamAbort !== controller) return
          clearWatchdog()
          streamAbort = null
          streamFailedUntil = Date.now() + 3000
          schedule()
        }
        // 不使用 until=idle：空闲时也保持一条长连接。后台自动同步可能在任何
        // 时刻启动，客户端不能等到“发现 running”才去连接 SSE，否则会错过
        // 前几秒甚至大半进度。连接建立时服务端会立即发一帧全量快照。
        fetch(API + '/events', {
          credentials: 'same-origin',
          headers: { accept: 'text/event-stream' },
          signal: controller.signal,
        }).then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status)
          if (response.body === null || typeof response.body.getReader !== 'function') {
            throw new Error('SSE 不可用')
          }
          streamFailedUntil = 0
          streamLastAt = Date.now()
          clientPerf.sse.connects += 1
          if (streamEverConnected) clientPerf.sse.reconnects += 1
          streamEverConnected = true
          clientPerf.sse.connectMs = Math.round(monotonicNow() - streamConnectStartedAt)
          clearWatchdog()
          watchdogTimer = setInterval(function () {
            if (streamAbort !== controller) return
            if (Date.now() - streamLastAt <= 40_000) return
            clearWatchdog()
            streamAbort = null
            controller.abort()
            streamFailedUntil = Date.now() + 1000
            schedule()
          }, 10_000)
          var reader = response.body.getReader()
          var decoder = new TextDecoder()
          var buffer = ''
          function pump() {
            return reader.read().then(function (result) {
              if (streamAbort !== controller) return
              if (result.done) {
                clearWatchdog()
                streamAbort = null
                streamFailedUntil = Date.now() + 1000
                schedule()
                return
              }
              buffer += decoder.decode(result.value, { stream: true })
              streamLastAt = Date.now()
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
        if (streamAbort !== null) return
        if (Date.now() < streamFailedUntil) {
          // SSE 短暂失败时用 /status 兜底，恢复后重新挂长连接。
          pollTimer = setTimeout(function () { refreshStatus() }, 1000)
          return
        }
        openStream()
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
        lastStreamFrameAt = 0
        refreshStatus()
      }

      async function refreshConfig() {
        try {
          var config = await fetchJson('/config')
          if (config && config.status) acceptStatus(config.status)
          patch({
            config: config,
            setup: config ? config.setup : snapshot.setup,
            workspaces: config ? config.workspaces : snapshot.workspaces,
            loading: false,
          })
          return config
        } catch (error) {
          // 旧版 host 还没有 /config：退回旧端点，避免升级期间整页失效。
          try {
            var values = await Promise.all([fetchJson('/setup'), fetchJson('/status')])
            var fallback = { setup: values[0], status: values[1], workspaces: null }
            acceptStatus(values[1])
            try { fallback.workspaces = await fetchJson('/workspaces') } catch (_) { /* 允许暂不可用 */ }
            patch({
              config: null,
              setup: fallback.setup,
              workspaces: fallback.workspaces,
              loading: false,
            })
            return fallback
          } catch (fallbackError) {
            patch({ loading: false, error: errorText(fallbackError) })
            return null
          }
        } finally {
          // refreshAll 以前会顺带调用 refreshStatus；改成 /config 后必须显式
          // 重新排期，否则初始状态不会再打开 SSE / 轮询。
          schedule()
        }
      }

      async function refreshSetup() {
        var config = await refreshConfig()
        return config ? config.setup : null
      }

      async function refreshWorkspaces() {
        var config = await refreshConfig()
        return config ? config.workspaces : null
      }

      function refreshAll() {
        if (inflight !== null) return inflight
        // /config 可能包含远端清单，不能让它挡住第一帧状态；先拿便宜的
        // /status 打开 SSE/轮询，再等聚合快照。
        if (snapshot.status === null) void refreshStatus()
        inflight = refreshConfig().then(function (config) {
          inflight = null
          return config
        }, function (error) {
          inflight = null
          patch({ error: errorText(error) })
          return null
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

      async function agreement() {
        return fetchJson('/agreement')
      }

      /** 用给定地址与 token 探测服务端（不落盘）。 */
      async function probe(serverUrl, token) {
        return fetchJson('/probe', {
          method: 'POST',
          body: JSON.stringify({ serverUrl: serverUrl, token: token }),
        })
      }

      /** 用给定口令验证能否解开云端数据。 */
      async function verifyPassphrase(serverUrl, token, passphrase) {
        return fetchJson('/verify-passphrase', {
          method: 'POST',
          body: JSON.stringify({ serverUrl: serverUrl, token: token, passphrase: passphrase }),
        })
      }

      /** 判断目标路径能直接绑定、需要建目录还是只能另选。 */
      async function resolveWorkspacePath(path) {
        return fetchJson('/workspaces/resolve', {
          method: 'POST',
          body: JSON.stringify({ path: path }),
        })
      }

      /** 必要时建目录并注册为 DSH 工作区。 */
      async function createWorkspace(path, title) {
        var result = await fetchJson('/workspaces/create', {
          method: 'POST',
          body: JSON.stringify({ path: path, title: title }),
        })
        await refreshWorkspaces()
        return result
      }

      /** 打开宿主目录选择器。 */
      async function pickDirectory() {
        return fetchJson('/directory/pick', { method: 'POST', body: '{}' })
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
        var plan = await fetchJson('/replace', {
          method: 'POST',
          body: JSON.stringify({ sessionId: sessionId }),
        })
        patch({ replacePlan: plan })
        return { ok: true, value: plan }
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

      function perfSnapshot() {
        return JSON.parse(JSON.stringify(clientPerf))
      }

      function dispose() {
        disposed = true
        if (pollTimer !== null) clearTimeout(pollTimer)
        clearWatchdog()
        if (streamAbort !== null) {
          var controller = streamAbort
          streamAbort = null
          controller.abort()
        }
        if (toastTimer !== null) clearTimeout(toastTimer)
        if (longTaskObserver !== null) {
          try { longTaskObserver.disconnect() } catch (ignored) { /* 已断开 */ }
          longTaskObserver = null
        }
        listeners.clear()
      }

      return {
        getSnapshot: getSnapshot,
        subscribe: subscribe,
        refreshAll: refreshAll,
        refreshConfig: refreshConfig,
        refreshStatus: refreshStatus,
        onVisibilityChange: onVisibilityChange,
        refreshSetup: refreshSetup,
        refreshWorkspaces: refreshWorkspaces,
        syncNow: syncNow,
        testConnection: testConnection,
        probe: probe,
        verifyPassphrase: verifyPassphrase,
        resolveWorkspacePath: resolveWorkspacePath,
        createWorkspace: createWorkspace,
        pickDirectory: pickDirectory,
        agreement: agreement,
        correctCwd: correctCwd,
        resolveBlocked: resolveBlocked,
        prepareReplace: prepareReplace,
        dismissReplace: dismissReplace,
        bindWorkspace: bindWorkspace,
        toast: toast,
        perfSnapshot: perfSnapshot,
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

    var STAGE_LABELS = {
      reading: '读取中',
      planning: '计算中',
      sealing: '加密中',
      verifying: '校验中',
      uploading: '上传中',
      committing: '提交中',
      downloading: '下载中',
      verifying: '校验中',
      applying: '写入中',
      flushing: '落盘中',
      projecting: '预热标题',
      attaching: '挂载中',
      'waiting-write': '等待官方写入',
      'waiting-live': '等待会话关闭',
      'waiting-cwd': '等待 cwd 处理',
      'waiting-retry': '等待重试',
      done: '已完成',
      failed: '失败',
    }

    function isWaitingStage(stage) {
      return stage === 'waiting-write' || stage === 'waiting-live'
        || stage === 'waiting-cwd' || stage === 'waiting-retry'
    }

    function isActiveStage(stage) {
      return stage !== undefined && stage !== null && !isWaitingStage(stage)
        && stage !== 'done' && stage !== 'failed'
    }

    function sessionStage(session) {
      if (session && session.stage) return session.stage
      if (session && session.pull && session.pull.stage) return session.pull.stage
      if (session && session.push && session.push.stage) return session.push.stage
      return undefined
    }

    function stageLabel(stage) {
      return STAGE_LABELS[stage] || ''
    }

    function sessionOngoing(session) {
      if (!session) return false
      if (session.phase === 'running') return true
      var stage = sessionStage(session)
      return isActiveStage(stage) || isWaitingStage(stage)
    }

    function statusDot(status) {
      if (status === null) return 'warn'
      var sessions = Array.isArray(status.sessions) ? status.sessions : []
      var tasks = statusTasks(status) || []
      if (tasks.some(function (task) { return task.state === 'running' || task.state === 'checking' })) return 'syncing'
      if (tasks.some(function (task) { return task.state === 'failed' || task.state === 'blocked' })) return 'bad'
      if (tasks.some(function (task) { return task.state === 'deferred' })) return 'warn'
      if (sessions.some(function (session) { return isActiveStage(sessionStage(session)) })) return 'syncing'
      if (sessions.some(function (session) { return isWaitingStage(sessionStage(session)) })) return 'waiting'
      if (status.running) return 'syncing'
      if (status.lastError !== null) return 'bad'
      var lease = status.deviceLease
      if (lease && (lease.state === 'foreign' || lease.state === 'lost')) return 'warn'
      if (sessions.some(function (session) { return session.phase === 'failed' || session.phase === 'blocked' })) return 'bad'
      if (sessions.some(function (session) {
        return session.phase === 'deferred' || session.cwdPending === true
      })) return 'warn'
      if (sessions.some(function (session) { return session.decision })) return 'warn'
      if (status.configured) return 'ok'
      return 'warn'
    }

    /** 全局单写者租约是否阻止本机上传。 */
    function deviceLeaseBlockReason(status) {
      var lease = status && status.deviceLease
      if (!lease || lease.state === 'held' || lease.state === 'unconfigured') return null
      return lease.state === 'foreign'
        ? '另一台设备持有全局同步锁；本机当前只拉取'
        : '全局同步租约丢失；本机暂停上传并重试'
    }

    /** 取短会话 id，和同步气泡保持一致。 */
    function shortDisplaySessionId(sessionId) {
      var value = String(sessionId || '')
      if (value.indexOf('session-') === 0) value = value.slice('session-'.length)
      return value.length > 12 ? value.slice(0, 12) + '…' : value
    }

    /** 与同步气泡相同：从 DSH 客户端会话列表取标题，取不到时显示未命名。 */
    function displaySessionTitle(titleOf, sessionId) {
      try {
        var title = titleOf ? String(titleOf(sessionId) || '') : ''
        return title.trim() === '' ? '未命名会话' : title
      } catch (error) {
        return '未命名会话'
      }
    }

    /** 拒绝把 https;//host 这类地址写进配置，避免同步阶段才出现 fetch 解析错误。 */
    function assertServerUrl(value) {
      var url = String(value || '').trim()
      if (url === '') return
      var parsed
      try {
        parsed = new URL(url)
      } catch (error) {
        throw new Error('服务端地址不合法，应形如 https://host:port')
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('服务端地址必须以 http:// 或 https:// 开头')
      }
    }

    /** 首启与设置页共用的连接探测；只测当前输入，不落盘、不带 token。 */
    async function probeServer(model, serverUrl) {
      assertServerUrl(serverUrl)
      return await model.testConnection(String(serverUrl || '').trim())
    }

    /** 取一个会话的聚合视图。 */
    function findSession(status, sessionId) {
      if (status === null || !Array.isArray(status.sessions)) return null
      return status.sessions.find(function (session) { return session && session.sessionId === sessionId }) || null
    }

    /** SessionTarget 可以是字符串 id，也可以是 subagent 的 parent/child 地址。 */
    function sessionTargetId(target) {
      if (typeof target === 'string') return target === '' ? null : target
      if (target !== null && typeof target === 'object') {
        if (typeof target.sessionId === 'string' && target.sessionId !== '') return target.sessionId
        if (typeof target.childSessionId === 'string' && target.childSessionId !== '') return target.childSessionId
      }
      return null
    }

    /** 一个会话当前的同步保护状态：正在应用 / 开放尾 / 待 cwd 决策 / 已分叉。 */
    function statusTasks(status) {
      if (!status || !status.run) return null
      if (Array.isArray(status.run.tasks)) return status.run.tasks
      // 任务完成后 controller 会移除空任务表，但 run.mode 仍标记本轮是新任务模式。
      if (status.run.mode === 'auto' || status.run.mode === 'manual') return []
      return null
    }

    function taskOf(status, sessionId) {
      var tasks = statusTasks(status)
      if (tasks === null) return null
      for (var index = 0; index < tasks.length; index += 1) {
        if (tasks[index].sessionId === sessionId) return tasks[index]
      }
      return null
    }

    function sessionState(status, sessionId) {
      if (status === null) return {
        pending: false, tail: false, lag: false, cwd: false, blocked: false,
        blockedReason: '', unmapped: false, live: false, compression: undefined, task: null,
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
        compression: session ? session.compression : undefined,
        task: taskOf(status, sessionId),
      }
    }

    /**
     * 会话为什么不能继续操作；row=true 时用于列表行（live 会话允许打开/切换，
     * 只由 composer 拦输入），否则用于输入框。
     */
    function sessionBlockReason(status, sessionId, row) {
      var state = sessionState(status, sessionId)
      if (row === true && state.live) return null
      // 全局租约只表示“本机暂不上传”，不是会话级写锁；打开/继续本地
      // 会话必须照常允许，等拿到租约后再补推即可。
      if (state.blocked) return '这个会话的本地与远端历史已分叉，已阻止继续写入；请先人工处理'
      if (state.task && state.task.state === 'blocked') {
        return state.task.error || '这个会话的本地与远端历史已分叉，已阻止继续写入；请先人工处理'
      }
      if (state.unmapped) return '这个远端会话的工作区尚未映射到本机，请先在设置里建立一次性映射'
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
        syncSessionIds: Array.isArray(source.syncSessionIds)
          ? source.syncSessionIds.slice()
          : (Array.isArray(fallback.syncSessionIds) ? fallback.syncSessionIds.slice() : []),
        autoBindSamePath: source.autoBindSamePath !== undefined ? source.autoBindSamePath === true : fallback.autoBindSamePath === true,
        autoSync: source.autoSync !== undefined ? source.autoSync === true : fallback.autoSync === true,
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

    function shortMapKey(key) {
      return key === null || key === undefined ? '' : String(key).slice(0, 12) + '…'
    }

    /** 合并 /workspaces 的远端列表与绑定/未映射兜底，按 key 去重。 */
    function remoteWorkspaceList(workspaces) {
      var source = workspaces && Array.isArray(workspaces.remoteWorkspaces) ? workspaces.remoteWorkspaces : []
      var seen = new Map()
      function add(workspaceKey, label, sessions, path) {
        if (workspaceKey === null || workspaceKey === undefined) return
        var current = seen.get(workspaceKey)
        var resolvedLabel = label === undefined || label === '' ? (current && current.label) : label
        var resolvedPath = typeof path === 'string' && path !== '' ? path : (current && current.path)
        seen.set(workspaceKey, {
          workspaceKey: workspaceKey,
          sessions: Math.max(current ? current.sessions : 0, sessions || 0),
          ...resolvedLabel === undefined ? {} : { label: resolvedLabel },
          ...resolvedPath === undefined ? {} : { path: resolvedPath },
        })
      }
      source.forEach(function (entry) { add(entry.workspaceKey, entry.label, entry.sessions || 0, entry.path) })
      var bindings = workspaces && Array.isArray(workspaces.bindings) ? workspaces.bindings : []
      bindings.forEach(function (binding) { add(binding.workspaceKey, binding.label, 0) })
      var unmapped = workspaces && Array.isArray(workspaces.unmapped) ? workspaces.unmapped : []
      unmapped.forEach(function (entry) { add(entry.workspaceKey, entry.label, entry.sessions || 0, entry.path) })
      return Array.from(seen.values()).sort(function (left, right) {
        return String(left.label || left.workspaceKey).localeCompare(String(right.label || right.workspaceKey))
      })
    }

    /** 计算本机/远端配对、统计和待绑定行。 */
    function mappingState(workspaces) {
      var locals = workspaces && Array.isArray(workspaces.workspaces) ? workspaces.workspaces : []
      var bindings = workspaces && Array.isArray(workspaces.bindings) ? workspaces.bindings : []
      var remote = remoteWorkspaceList(workspaces)
      var paired = new Set()
      bindings.forEach(function (binding) { paired.add(binding.workspaceKey) })
      var rows = locals.map(function (local) {
        var binding = bindings.find(function (entry) { return entry.localPath === local.path }) || null
        if (binding !== null) {
          var boundRemote = remote.find(function (entry) { return entry.workspaceKey === binding.workspaceKey }) || {
            workspaceKey: binding.workspaceKey, label: binding.label, sessions: 0,
          }
          paired.add(binding.workspaceKey)
          return { kind: 'bound', local: local, remote: boundRemote, binding: binding }
        }
        var native = local.workspaceKey === undefined
          ? null
          : remote.find(function (entry) { return entry.workspaceKey === local.workspaceKey }) || null
        if (native !== null) {
          paired.add(native.workspaceKey)
          return { kind: 'native', local: local, remote: native, binding: null }
        }
        return { kind: 'local', local: local, remote: null, binding: null }
      })
      var pending = remote.filter(function (entry) {
        return entry.workspaceKey !== null && !paired.has(entry.workspaceKey)
      })
      var counts = {
        locals: locals.length,
        total: remote.length,
        bound: rows.filter(function (row) { return row.kind === 'bound' }).length,
        native: rows.filter(function (row) { return row.kind === 'native' }).length,
        localOnly: rows.filter(function (row) { return row.kind === 'local' }).length,
        pending: pending.length,
      }
      return {
        locals: locals,
        remote: remote,
        rows: rows,
        pending: pending,
        candidates: rows.filter(function (row) { return row.binding === null }).map(function (row) { return row.local }),
        counts: counts,
      }
    }


    function WorkspaceMappingPanel(props) {
      var model = props.model
      var workspaces = props.workspaces
      var compact = props.compact === true
      var choiceState = useState({})
      var choices = choiceState[0]
      var setChoices = choiceState[1]
      var busyState = useState({})
      var busy = busyState[0]
      var setBusy = busyState[1]
      var confirmState = useState(null)
      var confirming = confirmState[0]
      var setConfirming = confirmState[1]
      var dragState = useState(null)
      var dragPath = dragState[0]
      var setDragPath = dragState[1]
      var dropState = useState(null)
      var dropKey = dropState[0]
      var setDropKey = dropState[1]
      var unboundState = useState({})
      var unbound = unboundState[0]
      var setUnboundMap = unboundState[1]
      var mapping = mappingState(workspaces)





      if (workspaces === null) {
        return h('div', { className: 'dssync-mapempty' },
          h('b', null, '读取工作区映射…'),
          '连接服务端并读取本机/远端工作区后，这里会显示配对关系。',
          typeof props.onRetry === 'function' ? h('button', {
            className: 'dssync-pill', type: 'button', onClick: props.onRetry,
          }, '重新读取') : null)
      }

      function normMapPath(path) {
        return String(path || '').replace(/\//g, '\\').replace(/\\+$/u, '').toLowerCase()
      }

      var normPath = normMapPath
      var boundRows = mapping.rows.filter(function (row) { return row.kind !== 'local' })
      var localOnlyRows = mapping.rows
        .filter(function (row) { return row.kind === 'local' })
        .map(function (row) { return row.local })
      var pairs = {}
      var usedPaths = {}
      boundRows.forEach(function (row) {
        pairs[row.remote.workspaceKey] = row.local
        usedPaths[row.local.path] = true
      })
      mapping.pending.forEach(function (remote) {
        if (choices[remote.workspaceKey] === '') return
        var chosen = null
        if (choices[remote.workspaceKey] !== undefined) {
          chosen = localOnlyRows.find(function (local) { return local.path === choices[remote.workspaceKey] }) || null
        }
        if (chosen !== null && usedPaths[chosen.path] !== true) {
          pairs[remote.workspaceKey] = chosen
          usedPaths[chosen.path] = true
        }
      })
      mapping.pending.forEach(function (remote) {
        if (pairs[remote.workspaceKey] !== undefined || choices[remote.workspaceKey] === '' || !remote.path) return
        var match = localOnlyRows.find(function (local) {
          return usedPaths[local.path] !== true && normMapPath(local.path) === normMapPath(remote.path)
        }) || null
        if (match !== null) {
          pairs[remote.workspaceKey] = match
          usedPaths[match.path] = true
        }
      })
      var pairedRemoteByPath = {}
      Object.keys(pairs).forEach(function (key) { pairedRemoteByPath[pairs[key].path] = key })

      function assignPair(remoteKey, path) {
        if (remoteKey === null || remoteKey === undefined || path === '') return
        setChoices(function (previous) {
          var next = Object.assign({}, previous)
          Object.keys(next).forEach(function (other) {
            if (next[other] === path && other !== remoteKey) delete next[other]
          })
          next[remoteKey] = path
          return next
        })
      }

      async function createFromRemote(remote) {
        var path = String(remote.path || '').trim()
        if (path === '') {
          model.toast('该远端工作区没有可用的来源路径，请拖入或新建本机卡片', true)
          return
        }
        setBusy(function (previous) {
          var next = Object.assign({}, previous)
          next[remote.workspaceKey] = true
          return next
        })
        try {
          var state = await model.resolveWorkspacePath(path)
          if (state.mode === 'pick') {
            model.toast(state.sameOs ? '这个位置不可用（无权限或父目录不存在）' : '路径格式与当前系统不一致', true)
            return
          }
          setConfirming({
            key: remote.workspaceKey,
            path: path,
            mode: state.mode,
            create: true,
            label: remote.label || shortMapKey(remote.workspaceKey),
          })
        } catch (error) {
          model.toast(errorText(error), true)
        } finally {
          setBusy(function (previous) {
            var next = Object.assign({}, previous)
            delete next[remote.workspaceKey]
            return next
          })
        }
      }

      async function applyBinding(confirm) {
        var key = confirm.key
        setBusy(function (previous) {
          var next = Object.assign({}, previous)
          next[key] = true
          return next
        })
        try {
          if (confirm.create === true) await model.createWorkspace(confirm.path, confirm.label)
          var result = await model.bindWorkspace(key, confirm.path)
          if (!result || result.ok !== true) {
            model.toast((result && result.error && result.error.message) || '绑定失败', true)
            return
          }
          setConfirming(null)
          setChoices(function (previous) {
            var next = Object.assign({}, previous)
            delete next[key]
            return next
          })
          model.toast('已建立工作区映射；不能改绑')
        } catch (error) {
          model.toast(errorText(error), true)
        } finally {
          setBusy(function (previous) {
            var next = Object.assign({}, previous)
            delete next[key]
            return next
          })
        }
      }

      function lockIcon(locked) {
        return locked
          ? h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
            h('rect', { x: 3, y: 7, width: 10, height: 7, rx: 2, stroke: 'currentColor', strokeWidth: 1.5 }),
            h('path', { d: 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2', stroke: 'currentColor', strokeWidth: 1.5 }))
          : h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
            h('rect', { x: 3, y: 7, width: 10, height: 7, rx: 2, stroke: 'currentColor', strokeWidth: 1.5 }),
            h('path', { d: 'M5.5 7V5a2.5 2.5 0 0 1 4.6-1.3', stroke: 'currentColor', strokeWidth: 1.5 }))
      }


      function localCard(local, locked, draggable, kind, paired) {
        return h('div', {
          className: 'dssync-mapcard' + (locked ? ' locked' : ''),
          draggable: draggable === true && !locked,
          onDragStart: function (event) {
            if (locked || !draggable) { event.preventDefault(); return }
            setDragPath(local.path)
            event.dataTransfer.effectAllowed = 'move'
            try { event.dataTransfer.setData('text/plain', local.path) } catch (ignored) { /* 旧浏览器 */ }
          },
          onDragEnd: function () { setDragPath(null); setDropKey(null) },
        },
        h('div', { className: 'title' },
          h('b', null, local.title || local.path),
          locked ? h('span', { className: 'dssync-session-status' }, '已绑定') : null,
          !locked && kind === 'native' ? h('span', { className: 'dssync-rel native' }, '本机身份') : null,
          !locked && paired === true ? h('span', { className: 'dssync-session-status' }, '已配对') : null),
        h('div', { className: 'dssync-mappath', title: local.path }, local.path))
      }


      function unassignByPath(path) {
        setChoices(function (previous) {
          var next = Object.assign({}, previous)
          Object.keys(next).forEach(function (key) {
            if (next[key] === path) next[key] = ''
          })
          return next
        })
      }


      function slotForRow(row) {
        if (row.remote !== null && row.kind === 'pending' && row.local === null) {
          var dropActive = dropKey === row.remote.workspaceKey
          return h('div', {
            className: 'dssync-mapslot empty' + (dropActive ? ' drop' : ''),
            onDragOver: function (event) {
              if (dragPath === null) return
              event.preventDefault()
              if (dropKey !== row.remote.workspaceKey) setDropKey(row.remote.workspaceKey)
            },
            onDragLeave: function () { if (dropActive) setDropKey(null) },
            onDrop: function (event) {
              if (dragPath === null) return
              event.preventDefault()
              assignPair(row.remote.workspaceKey, dragPath)
              setDragPath(null)
              setDropKey(null)
            },
          }, '拖一个本机工作区卡片到这里')
        }
        if (row.remote !== null) {
          return h('div', { className: 'dssync-mapslot' },
            localCard(row.local, row.kind === 'bound', row.kind === 'pending', row.kind, row.kind === 'pending'))
        }
        // 本地行：卡片拖走后保留原行，作为“拖回取消配对”的落点。
        var pairedKey = pairedRemoteByPath[row.local.path]
        if (pairedKey === undefined) {
          return h('div', { className: 'dssync-mapslot' },
            localCard(row.local, false, true, 'local', false))
        }
        var pairedRemote = mapping.remote.find(function (entry) { return entry.workspaceKey === pairedKey }) || null
        return h('div', {
          className: 'dssync-mapslot empty',
          onDragOver: function (event) {
            if (dragPath === null) return
            event.preventDefault()
          },
          onDrop: function (event) {
            if (dragPath === null) return
            event.preventDefault()
            if (dragPath === row.local.path) unassignByPath(row.local.path)
            setDragPath(null)
            setDropKey(null)
          },
        }, '「' + (row.local.title || row.local.path) + '」已配对到「' + (pairedRemote === null ? shortMapKey(pairedKey) : (pairedRemote.label || shortMapKey(pairedKey))) + '」· 拖回取消')
      }

      function centerForRow(row) {
        if (row.remote === null) {
          var localUnbound = unbound[row.local.path] === true
          return h('div', { className: 'dssync-mapcenter' },
            h('button', {
              className: 'dssync-maparrow' + (localUnbound ? ' on' : ''),
              type: 'button', title: localUnbound ? '不绑定：推送时新建远端工作区' : '标记为不绑定（推送时新建远端）',
              onClick: function () { toggleUnbound(row.local.path) },
            }, '→'))
        }
        var key = row.remote.workspaceKey
        if (row.kind === 'bound') {
          return h('div', { className: 'dssync-mapcenter' },
            h('button', { className: 'dssync-maplock locked', type: 'button', disabled: true, title: '已绑定，不可改绑', 'aria-label': '已绑定' }, lockIcon(true)))
        }
        if (row.kind === 'native') {
          return h('div', { className: 'dssync-mapcenter' },
            h('button', { className: 'dssync-maplock', type: 'button', disabled: true, title: 'key 与本机路径一致，无需绑定', 'aria-label': '本机身份' }, lockIcon(true)))
        }
        return h('div', { className: 'dssync-mapcenter' },
          h('button', {
            className: 'dssync-maplock' + (row.local !== null ? '' : ' locked'),
            type: 'button',
            disabled: row.local === null || busy[key] === true,
            title: row.local === null ? '先把本地卡片拖到这里，或点击 ← 新建' : '点击绑定这条映射',
            'aria-label': row.local === null ? '待映射' : '绑定',
            onClick: function () {
              if (row.local === null) return
              setConfirming({ key: key, path: row.local.path, mode: 'bind', create: false, label: row.remote.label || shortMapKey(key) })
            },
          }, lockIcon(row.local !== null)),
          row.local === null && row.remote.path
            ? h('button', {
              className: 'dssync-maparrow accent', type: 'button',
              disabled: busy[key] === true,
              title: '用远端路径新建本机工作区（不存在则创建目录）',
              onClick: function () { createFromRemote(row.remote) },
            }, '←')
            : null)
      }

      function remoteForRow(row) {
        if (row.remote === null) {
          var pairedKey = pairedRemoteByPath[row.local.path]
          var pairedRemote = pairedKey === undefined
            ? null
            : (mapping.remote.find(function (entry) { return entry.workspaceKey === pairedKey }) || null)
          return h('div', { className: 'dssync-mapremote empty' },
            h('div', { className: 'title' }, h('b', null, pairedRemote === null ? '暂无远端工作区' : '已配对到「' + (pairedRemote.label || shortMapKey(pairedKey)) + '」')),
            h('div', { className: 'dssync-mapnote' },
              pairedRemote !== null
                ? '未锁定；点中间的锁图标才会建立一次性绑定。'
                : unbound[row.local.path] === true
                  ? '不绑定：该工作区推送时会在远端新建'
                  : '首次推送根会话后自动创建远端 workspaceKey'))
        }
        var paired = row.local !== null
        var stateText = row.locked ? '已绑定' : paired ? '已配对，未锁定' : '待映射'
        return h('div', { className: 'dssync-mapremote' + (row.locked ? ' bound' : '') },
          h('div', { className: 'title' },
            h('b', null, row.remote.label || shortMapKey(row.remote.workspaceKey)),
            h('span', { className: 'dssync-note' }, (row.remote.sessions || 0) + ' 个会话'),
            h('span', { className: 'dssync-note', style: { marginLeft: 'auto', color: row.locked ? '#9ce8bc' : paired ? '#b9ccff' : undefined } }, stateText)),
          h('div', { className: 'dssync-mapnote', title: row.remote.path },
            row.remote.path === undefined ? '无来源路径' : '来源：' + row.remote.path))
      }

      var allRows = []
      boundRows.forEach(function (row) { allRows.push({ kind: row.kind, local: row.local, remote: row.remote, locked: row.kind === 'bound' }) })
      mapping.pending.forEach(function (remote) {
        allRows.push({ kind: 'pending', local: pairs[remote.workspaceKey] || null, remote: remote, locked: false })
      })
      // 行数始终 = 远端工作区 + 未绑定本地工作区；配对中的本地卡片仍保留自己的行。
      localOnlyRows.forEach(function (local) {
        allRows.push({ kind: 'local', local: local, remote: null, locked: false })
      })
      var stats = h('div', { className: 'dssync-mapstats' },
        h('span', { className: 'dssync-mapstat' }, h('b', null, mapping.locals.length), ' 本机工作区'),
        h('span', { className: 'dssync-mapstat' }, h('b', null, mapping.remote.length), ' 远端工作区'),
        h('span', { className: 'dssync-mapstat' }, h('b', null, mapping.counts.bound), ' 已绑定'),
        h('span', { className: 'dssync-mapstat' }, h('b', null, mapping.counts.native), ' 本机身份'),
        h('span', { className: 'dssync-mapstat' }, h('b', null, allRows.filter(function (row) { return row.kind === 'local' }).length), ' 仅本机'),
        h('span', { className: 'dssync-mapstat' }, h('b', null, allRows.filter(function (row) { return row.kind === 'pending' && row.local === null }).length), ' 待映射'))

      if (allRows.length === 0) {
        return h('div', { className: 'dssync-mappanel' },
          h('div', { className: 'dssync-mapempty' },
            h('b', null, '还没有工作区'),
            '本机没有已注册的工作区，远端也没有 workspaceKey。'))
      }


      var confirmBanner = confirming === null ? null : h('div', { className: 'dssync-mapconfirm', role: 'group', 'aria-label': '确认工作区映射' },
        h('span', { className: 'dssync-note warn' },
          confirming.create === true
            ? (confirming.mode === 'create'
              ? '目录不存在；确认后会先创建 ' + confirming.path + '，再注册并永久绑定到「' + confirming.label + '」。'
              : '确认把「' + confirming.label + '」注册到 ' + confirming.path + ' 并永久绑定？')
            : '把「' + confirming.label + '」永久绑定到 ' + confirming.path + '？绑定后不可改绑。'),
        h('button', { className: 'dssync-pill', type: 'button', disabled: busy[confirming.key] === true, onClick: function () { setConfirming(null) } }, '取消'),
        h('button', { className: 'dssync-pill primary', type: 'button', disabled: busy[confirming.key] === true, onClick: function () { applyBinding(confirming) } },
          busy[confirming.key] === true ? '处理中…' : '确认绑定'))

      return h('div', { className: 'dssync-mappanel' },
        stats,
        confirmBanner,
        h('div', { className: 'dssync-mapboard' }, allRows.map(function (row, index) {
          return h('div', { className: 'dssync-maprow', key: 'row-' + index },
            slotForRow(row),
            centerForRow(row),
            remoteForRow(row))
        })),
        h('p', { className: 'dssync-mapnote' },
          compact
            ? '这一步可以跳过；把本地卡片拖到远端行左侧的空位即可配对，或点 ← 用远端路径新建。'
            : '把本地卡片拖到远端行左侧的空位即可配对；拖回原来的行取消配对；点锁图标才建立一次性绑定；→ 表示不绑定、推送时新建远端。'))

      function toggleUnbound(path) {
        setUnboundMap(function (previous) {
          var next = Object.assign({}, previous)
          if (next[path] === true) delete next[path]
          else next[path] = true
          return next
        })
      }
    }
    function PerfPanel(props) {
      var model = props.model
      var appState = useModel(model)
      var statePair = useState({ loading: true, error: null, host: null })
      var view = statePair[0]
      var setView = statePair[1]
      var copiedPair = useState(false)
      var copied = copiedPair[0]
      var setCopied = copiedPair[1]

      function load() {
        fetchJson('/perf').then(function (host) {
          setView({ loading: false, error: null, host: host })
        }).catch(function (error) {
          setView({ loading: false, error: errorText(error), host: null })
        })
      }

      useEffect(function () { load() }, [
        appState.status && appState.status.run && appState.status.run.id,
        appState.status && appState.status.run && appState.status.run.state,
      ])

      var client = model.perfSnapshot()
      var latest = view.host && view.host.latest
      var ops = latest && latest.operations ? latest.operations : {}
      var blocks = latest && latest.eventLoopByStage ? latest.eventLoopByStage : {}
      var phases = latest && latest.phases ? latest.phases : {}
      var summary = latest
        ? [
            '墙钟 ' + latest.wallMs + 'ms',
            '读取 ' + Math.round(ops.read || 0) + 'ms',
            '封帧 ' + Math.round(ops.seal || 0) + 'ms',
            '上传 ' + Math.round(ops.upload || 0) + 'ms',
            '校验 ' + Math.round(ops.verify || 0) + 'ms',
            '提交 ' + Math.round(ops.append || 0) + 'ms',
            '事件循环 max ' + latest.eventLoop.maxMs + 'ms / p99 ' + latest.eventLoop.p99Ms + 'ms',
            'RSS ' + latest.rss.peakMb + 'MB',
          ].join(' · ')
        : '还没有完成的 run'
      var blockSummary = latest
        ? '阻塞归因：读取 ' + (blocks.read || 0) + 'ms · 封帧 ' + (blocks.seal || 0)
          + 'ms · 校验 ' + (blocks.verify || 0) + 'ms · 上传 ' + (blocks.upload || 0) + 'ms · 提交 ' + (blocks.append || 0) + 'ms'
        : ''
      var phaseSummary = latest
        ? '外层阶段：推送 ' + Math.round(phases.push || 0) + 'ms · 拉取 ' + Math.round(phases.pull || 0)
          + 'ms · 列表 ' + Math.round(phases.list || 0) + 'ms · seed ' + Math.round(phases.seed || 0) + 'ms'
        : ''

      function copy() {
        var text = JSON.stringify({ host: view.host, client: client }, null, 2)
        writeClipboard(text).then(function () {
          setCopied(true)
          setTimeout(function () { setCopied(false) }, 1800)
        }).catch(function () {
          model.toast('复制失败；请手动选择 JSON', true)
        })
      }

      return h('section', { className: 'dssync-sec dssync-perf' },
        h('div', { className: 'dssync-sechead' },
          h('h3', null, '性能诊断'),
          h('span', null, '仅保存在本机，不上传')),
        h('div', { className: 'dssync-row' },
          h('div', { className: 'dssync-rowtext' },
            h('b', null, latest ? '最近一次同步' : '等待同步'),
            h('span', null, summary),
            latest ? h('span', null, blockSummary) : null,
            latest && phaseSummary !== '' ? h('span', null, phaseSummary) : null),
          h('button', { className: 'dssync-mini', type: 'button', onClick: load }, '刷新')),
        h('div', { className: 'dssync-row' },
          h('div', { className: 'dssync-rowtext' },
            h('b', null, '浏览器侧'),
            h('span', null, 'SSE 连接 ' + client.sse.connects + ' 次 · 重连 ' + client.sse.reconnects
              + ' 次 · 帧 ' + client.sse.frames + ' · 本轮最大间隔 ' + client.run.maxGapMs + 'ms'
              + ' · 长任务 ' + client.longTasks.count + ' 次 / max ' + client.longTasks.maxMs + 'ms')),
          h('button', { className: 'dssync-mini', type: 'button', onClick: copy }, copied ? '已复制' : '复制 JSON')),
        view.error ? h('div', { className: 'dssync-note bad' }, view.error) : null,
        h('pre', { className: 'dssync-perf-pre' }, JSON.stringify({ host: view.host, client: client }, null, 2)))
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
      var dirtyState = useState(false)
      var dirty = dirtyState[0]
      var setDirty = dirtyState[1]
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
          setDirty(false)
        }
      }, [revision])

      function set(key, value) {
        setDirty(true)
        setFields(function (previous) {
          var next = Object.assign({}, previous)
          next[key] = value
          return next
        })
      }

      function toggleSession(sessionId) {
        setDirty(true)
        setFields(function (previous) {
          var list = previous.syncSessionIds.slice()
          var index = list.indexOf(sessionId)
          if (index >= 0) list.splice(index, 1)
          else list.push(sessionId)
          return Object.assign({}, previous, { syncSessionIds: list })
        })
      }

      async function persistFields() {
        if (!form || !formState || formState.status !== 'ready' || !formState.writable) {
          setMessage({ bad: true, text: '设置当前不可写，请稍后再试' })
          return false
        }
        try {
          assertServerUrl(fields.serverUrl)
        } catch (error) {
          setMessage({ bad: true, text: errorText(error) })
          return false
        }
        var ops = [
          ...serverLocked ? [] : [{ op: 'set', path: ['serverUrl'], value: String(fields.serverUrl || '').trim() }],

          { op: 'set', path: ['syncSessionIds'], value: fields.syncSessionIds.slice() },
          { op: 'set', path: ['autoBindSamePath'], value: fields.autoBindSamePath === true },
          { op: 'set', path: ['autoSync'], value: fields.autoSync === true },
          { op: 'set', path: ['intervalMs'], value: Math.max(5000, Number(fields.intervalMs) || 60000) },
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
          setDirty(false)
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
          var result = await probeServer(model, serverUrl)
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
        var selectedIds = fields.syncSessionIds || []
        var selected = summarySessions.filter(function (session) { return selectedIds.indexOf(session.sessionId) >= 0 }).length
        return h('span', null, '自部署同步 · ' + (setup && setup.configured ? '已配置' : '未配置') + ' · ' + selected + ' 个根会话')
      }

      var workspaces = state.workspaces
      var candidates = workspaces ? workspaces.workspaces : []
      var sessions = workspaces && Array.isArray(workspaces.sessions) ? workspaces.sessions : []
      var selectedIds = fields.syncSessionIds || []
      var includedCount = sessions.filter(function (session) { return selectedIds.indexOf(session.sessionId) >= 0 }).length
      var sessionGroups = candidates.filter(function (item) {
        return sessions.some(function (session) { return session.workspacePath === item.path })
      })
      var setupInfo = state.setup
      var tokenConfigured = setupInfo ? setupInfo.hasToken : false
      var passConfigured = setupInfo ? setupInfo.hasPassphrase : false
      var disabled = busy !== '' || formState.status !== 'ready' || !formState.writable
      var serverLocked = setupInfo !== null && setupInfo.serverUrlSource === 'env'
      var deviceLocked = setupInfo !== null && setupInfo.deviceNameSource === 'env'
      var tokenLocked = setupInfo !== null && setupInfo.tokenSource === 'env'
      var passLocked = setupInfo !== null && setupInfo.passphraseSource === 'env'
      var savebar = h('div', { className: 'dssync-savebar' },
        h('span', { className: dirty ? 'dirty' : 'clean' },
          busy === 'save' ? '正在保存…' : dirty ? '有未保存修改' : '非敏感配置已保存'),
        h('span', { className: 'spacer' }),
        h('button', {
          className: 'dssync-pill', type: 'button',
          onClick: function () { forceOnboarding(); location.reload() },
        }, '重新运行引导'),
        h('button', {
          className: 'dssync-pill primary', type: 'button',
          disabled: disabled || busy === 'save' || !dirty,
          onClick: save,
        }, busy === 'save' ? '保存中…' : '保存配置'))

      return h('div', { className: 'dssync dssync-page' },
        savebar,
        h('section', { className: 'dssync-sec' },
          h('div', { className: 'dssync-sechead' },
            h('h3', null, '连接'),
            h('span', null, '自部署服务端')),
          h('div', { className: 'dssync-grid' },
            h(Field, { id: 'dssync-server', label: '服务端地址', hint: serverLocked ? '由环境变量设置，设置页不可修改。' : '填写后测试服务端与 token。' },
              h('input', {
                id: 'dssync-server', value: fields.serverUrl, spellCheck: false,
                disabled: serverLocked,
                placeholder: 'http://127.0.0.1:8787',
                onChange: function (event) { set('serverUrl', event.target.value) },
              })),
            h(Field, { id: 'dssync-device', label: '设备名称', hint: '在服务端设置；这里只读展示，改名去管理台。' },
              h('div', { className: 'dssync-note' },
                (setupInfo && setupInfo.deviceName) || '未命名',
                ' · ',
                h('a', {
                  href: String(fields.serverUrl || '').trim().replace(/\/+$/u, '') + '/admin',
                  target: '_blank', rel: 'noreferrer',
                  style: { color: '#b9ccff', textDecoration: 'underline' },
                }, '去管理台改名')))),
          h('div', { className: 'dssync-btnrow' },
            h('button', { className: 'dssync-pill', type: 'button', disabled: disabled || busy === 'test', onClick: test }, busy === 'test' ? '测试中…' : '测试连接'),
            h('span', { className: 'spacer' }),
            setupInfo && setupInfo.configured ? h('span', { className: 'dssync-note' }, '已连接') : h('span', { className: 'dssync-note warn' }, setupInfo && setupInfo.reason ? setupInfo.reason : '尚未配置'))),

        h('section', { className: 'dssync-sec' },
          h('div', { className: 'dssync-sechead' },
            h('h3', null, '凭据'),
            h('span', null, '保存到 DSH 凭据库，不写进普通配置')),
          h('div', { className: 'dssync-grid' },
            h(Field, { id: 'dssync-token', label: '设备 token', hint: tokenLocked ? '由环境变量设置，设置页不可修改。' : tokenConfigured ? '已配置；留空保持不变。' : '由服务端管理台或 CLI 签发。' },
              h('input', {
                id: 'dssync-token', type: 'password', value: token, autoComplete: 'off',
                disabled: tokenLocked,
                placeholder: tokenConfigured ? '已配置；留空保持不变' : '粘贴 token',
                onChange: function (event) { setDirty(true); setToken(event.target.value) },
              })),
            h(Field, { id: 'dssync-pass', label: '同步口令', hint: passLocked ? '由环境变量设置，设置页不可修改。' : passConfigured ? '已配置；留空保持不变。所有设备必须使用同一口令。' : '用于派生端到端加密密钥；所有设备必须一致。' },
              h('input', {
                id: 'dssync-pass', type: 'password', value: passphrase, autoComplete: 'new-password',
                disabled: passLocked,
                placeholder: passConfigured ? '已配置；留空保持不变' : '设置同步口令',
                onChange: function (event) { setDirty(true); setPassphrase(event.target.value) },
              }))),
          h('div', { className: 'dssync-note' }, '同步口令必须与其它设备一致；加解密参数还取决于服务端地址，建议各设备填写同一个规范地址（如 http://127.0.0.1:8787），不要混用 localhost/127.0.0.1 或省略 //。口令或地址不同都会导致加解密参数不符、无法解密。'),
          h('div', { className: 'dssync-note' }, '口令丢失后，云端内容无法解密。凭据引用：' + CREDENTIAL_REFS.token + ' / ' + CREDENTIAL_REFS.passphrase)),

        h('section', { className: 'dssync-sec' },
          h('div', { className: 'dssync-sechead' },
            h('h3', null, '上传范围'),
            h('span', null, '仅本地根会话；拉取由工作区绑定决定')),
          h('div', { className: 'dssync-btnrow' },
            h('button', {
              className: 'dssync-pill', type: 'button', disabled: disabled || sessions.length === 0,
              onClick: function () {
                set('syncSessionIds', includedCount === sessions.length ? [] : sessions.map(function (session) { return session.sessionId }))
              },
            }, includedCount === sessions.length && sessions.length > 0 ? '清空会话' : '全选会话'),
            h('span', { className: 'dssync-note' }, '同步 ' + includedCount + ' / ' + sessions.length + ' 个根会话'),
            h('span', { className: 'spacer' }),
            workspaces === null ? h('span', { className: 'dssync-note' }, '读取会话…') : null),
          sessions.length === 0 && workspaces !== null
            ? h('div', { className: 'dssync-note warn' }, '还没有可同步的根会话。')
            : h('div', { className: 'dssync-sessionlist' }, sessionGroups.map(function (workspace) {
              var workspaceSessions = sessions.filter(function (session) { return session.workspacePath === workspace.path })
              var workspaceSelected = workspaceSessions.filter(function (session) { return selectedIds.indexOf(session.sessionId) >= 0 }).length
              return h('div', { className: 'dssync-sessiongroup', key: workspace.path },
                h('div', { className: 'dssync-sessiongroup-head' },
                  h('b', null, workspace.title || workspace.path),
                  h('span', null, workspace.path),
                  h('span', null, workspaceSelected + ' / ' + workspaceSessions.length)),
                workspaceSessions.map(function (session) {
                  var checked = selectedIds.indexOf(session.sessionId) >= 0
                  return h('label', { className: 'dssync-session' + (checked ? '' : ' off'), key: session.sessionId },
                    h('input', { type: 'checkbox', checked: checked, onChange: function () { toggleSession(session.sessionId) } }),
                    h('span', { className: 'dssync-session-check' }, '✓'),
                    h('span', { className: 'dssync-session-main' },
                      h('b', { title: session.sessionId }, displaySessionTitle(props.titleOf, session.sessionId)),
                      h('span', null, shortDisplaySessionId(session.sessionId) + ' · ' + new Date(session.createdAt).toLocaleString())),
                    h('span', { className: 'dssync-session-meta' },
                      h('span', null, session.subagentSessions + ' 个子代理'),
                      h('span', { className: 'dssync-session-status' + (checked ? '' : ' off') }, checked ? '同步' : '未选中')))
                }))
            })),
          h('div', { className: 'dssync-note' }, '默认不选中任何会话；勾选只决定本机上传，不决定拉取。绑定工作区后会自动拉取该工作区的远端会话，取消勾选不会删除远端历史。')),

        h('section', { className: 'dssync-sec' },
          h('div', { className: 'dssync-sechead' },
            h('h3', null, '工作区映射'),
            h('span', null, '一次性绑定，不能改绑'),
            h('button', {
              className: 'dssync-pill', type: 'button', style: { marginLeft: 'auto' },
              disabled: workspaces === null,
              onClick: function () { model.refreshWorkspaces() },
            }, '刷新')),
          h('div', { className: 'dssync-note' },
            '左侧本机工作区，右侧远端 workspaceKey；只有绑定或本机身份一致的会话才会落到本机。'),
          h(WorkspaceMappingPanel, {
            model: model,
            workspaces: workspaces,
            onRetry: function () { model.refreshWorkspaces() },
          }),
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
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            h('input', {
              type: 'number', min: 5, max: 86400, step: 5,
              value: String(Math.round((Number(fields.intervalMs) || 60000) / 1000)),
              disabled: disabled || !fields.autoSync,
              onChange: function (event) { set('intervalMs', Math.max(0, Number(event.target.value) || 0) * 1000) },
              style: { width: 96, height: 30, border: '1px solid var(--dssync-line-strong)', borderRadius: 8, background: 'transparent', color: 'inherit', padding: '0 8px' },
            }),
            h('span', { className: 'dssync-note' }, '秒'),
            [10, 30, 60, 300].map(function (seconds) {
              return h('button', {
                key: seconds, type: 'button', className: 'dssync-mini',
                disabled: disabled || !fields.autoSync,
                onClick: function () { set('intervalMs', seconds * 1000) },
              }, seconds < 60 ? seconds + 's' : (seconds / 60) + 'm')
            }))),
          h('div', { className: 'dssync-row' },
            h('div', { className: 'dssync-rowtext' },
              h('b', null, '同步子代理会话'),
              h('span', null, '随根会话一起同步全部后代；关闭后只同步根会话')),
            h(Switch, { checked: fields.includeSubagents, disabled: disabled, label: '同步子代理会话', onChange: function (value) { set('includeSubagents', value) } }))),

        h(PerfPanel, { model: model }),

        h('div', { className: 'dssync-btnrow' },
          h('button', { className: 'dssync-pill', type: 'button', disabled: disabled || busy === 'sync', onClick: syncNow }, busy === 'sync' ? '同步中…' : '立即同步'),
          h('span', { className: 'spacer' }),
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

    function forceOnboarding() {
      try { localStorage.setItem(ONBOARD_FORCE_KEY, '1') } catch (ignored) { /* 隐私模式 */ }
    }

    function onboardingForced() {
      try { return localStorage.getItem(ONBOARD_FORCE_KEY) === '1' } catch (ignored) { return false }
    }

    function clearOnboardingForce() {
      try { localStorage.removeItem(ONBOARD_FORCE_KEY) } catch (ignored) { /* 隐私模式 */ }
    }

    function readAcceptedAgreement() {
      try { return String(localStorage.getItem(AGREEMENT_ACCEPTED_KEY) || '') } catch (ignored) { return '' }
    }

    function saveAcceptedAgreement(hash) {
      try { if (hash) localStorage.setItem(AGREEMENT_ACCEPTED_KEY, String(hash)) } catch (ignored) { /* 隐私模式 */ }
    }

    /** 协议里的轻量内联格式：粗体、代码、链接。 */
    function agreementInline(text) {
      var parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g)
      return parts.map(function (part, index) {
        if (part === '') return null
        if (part.slice(0, 2) === '**' && part.slice(-2) === '**') {
          return h('strong', { key: index }, part.slice(2, -2))
        }
        if (part.charAt(0) === '`' && part.charAt(part.length - 1) === '`') {
          return h('code', { key: index }, part.slice(1, -1))
        }
        var link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
        if (link) {
          var href = link[2]
          if (!/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(href)) {
            try { href = new URL(href, AGREEMENT_DOC_BASE).toString() } catch (ignored) { /* 保留原文 */ }
          }
          return h('a', { key: index, href: href, target: '_blank', rel: 'noreferrer' }, link[1])
        }
        return part
      }).filter(function (part) { return part !== null })
    }

    /** 只覆盖使用协议用到的 Markdown 子集，避免引入渲染依赖。 */
    function AgreementContent(props) {
      var lines = String(props.markdown || '').split('\n')
      var blocks = []
      var paragraph = []
      var list = []
      var code = []
      var inCode = false

      function flushParagraph() {
        if (paragraph.length === 0) return
        blocks.push(h('p', { key: 'agreement-p-' + blocks.length }, agreementInline(paragraph.join(' '))))
        paragraph = []
      }
      function flushList() {
        if (list.length === 0) return
        blocks.push(h('ul', { key: 'agreement-ul-' + blocks.length }, list.map(function (item, index) {
          return h('li', { key: index }, agreementInline(item))
        })))
        list = []
      }
      function flushCode() {
        if (code.length === 0) return
        blocks.push(h('pre', { key: 'agreement-pre-' + blocks.length }, code.join('\n')))
        code = []
      }

      lines.forEach(function (raw) {
        var line = String(raw)
        if (line.trim().indexOf('```') === 0) {
          if (inCode) { flushCode(); inCode = false } else { flushParagraph(); flushList(); inCode = true }
          return
        }
        if (inCode) { code.push(line); return }
        var trimmed = line.trim()
        if (trimmed === '') { flushParagraph(); flushList(); return }
        var heading = /^(#{1,4})\s+(.*)$/.exec(trimmed)
        if (heading) {
          flushParagraph(); flushList()
          var level = heading[1].length
          blocks.push(h(level <= 2 ? 'h3' : 'h4', { key: 'agreement-h-' + blocks.length }, agreementInline(heading[2])))
          return
        }
        if (/^>\s?/.test(trimmed)) {
          flushParagraph(); flushList()
          blocks.push(h('blockquote', { key: 'agreement-q-' + blocks.length }, agreementInline(trimmed.replace(/^>\s?/, ''))))
          return
        }
        var item = /^[-*]\s+(.*)$/.exec(trimmed)
        if (item) { flushParagraph(); list.push(item[1]); return }
        if (list.length > 0 && /^\s+/.test(line)) {
          list[list.length - 1] += ' ' + trimmed
          return
        }
        flushList()
        paragraph.push(trimmed)
      })
      flushParagraph(); flushList(); flushCode()
      return h('div', { className: 'dssync-agreement' }, blocks)
    }

    function AgreementPanel(props) {
      if (!props.agreement) {
        return h('div', { className: 'dssync-note warn' }, props.error || '正在读取使用须知…')
      }
      var version = props.agreement.version || String(props.agreement.hash || '').slice(0, 12)
      return h('div', { className: 'dssync-agreement-wrap' },
        h('div', { className: 'dssync-note' }, '生效日期 ' + version + ' · 内容版本 ' + String(props.agreement.hash || '').slice(0, 12)),
        h(AgreementContent, { markdown: props.agreement.markdown }))
    }

    function AgreementUpdateDialog(props) {
      return h('div', { className: 'dssync dssync-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': '使用须知已更新' },
        h('div', { className: 'dssync-wizard' },
          h('div', { className: 'dssync-wizard-head' },
            h('div', { className: 'dssync-wizard-icon' }, shieldIcon()),
            h('div', null, h('h2', null, '使用须知已更新'), h('p', null, '开始同步前，请重新阅读并确认当前版本。')),
            h('button', { className: 'dssync-close', type: 'button', 'aria-label': '稍后', onClick: props.onLater }, '×')),
          h('div', { className: 'dssync-wizard-body' }, h(AgreementPanel, { agreement: props.agreement })),
          h('div', { className: 'dssync-wizard-foot' },
            h('button', { className: 'dssync-pill', type: 'button', onClick: props.onLater }, '稍后'),
            h('span', { className: 'spacer' }),
            h('button', { className: 'dssync-pill primary', type: 'button', onClick: props.onAccept }, '我已阅读并同意'))))
    }


    /* ---------- 首启向导（重做：场景 → 连接 → 确认 → 口令 → 场景专属 → 须知） ---------- */


    /** 人类可读的字节数。 */
    function fmtBytes(bytes) {
      var value = Number(bytes) || 0
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB'
      return (value / 1024 / 1024 / 1024).toFixed(2) + ' GB'
    }


    var ONBOARD_PROGRESS_KEY = 'dsh-session-cloudsync.onboarding.progress'

    function readOnboardProgress() {
      try {
        var raw = sessionStorage.getItem(ONBOARD_PROGRESS_KEY)
        return raw ? JSON.parse(raw) : null
      } catch (ignored) { return null }
    }

    function saveOnboardProgress(value) {
      try { sessionStorage.setItem(ONBOARD_PROGRESS_KEY, JSON.stringify(value)) } catch (ignored) { /* 隐私模式 */ }
    }

    function clearOnboardProgress() {
      try { sessionStorage.removeItem(ONBOARD_PROGRESS_KEY) } catch (ignored) { /* 隐私模式 */ }
    }

    function Onboarding(props) {
      var model = props.model
      var state = useModel(model)
      var setup = state.setup
      var restored = useRef(readOnboardProgress())
      var start = restored.current || {}
      var startStep = Number.isSafeInteger(start.step) && start.step >= 0 && start.step <= 1 ? start.step : 0
      var stepState = useState(startStep)
      var step = stepState[0]
      var setStep = stepState[1]
      var personaState = useState(start.persona === 'upload' || start.persona === 'adopt' ? start.persona : null)
      var persona = personaState[0]
      var setPersona = personaState[1]
      var serverUrlState = useState(typeof start.serverUrl === 'string' ? start.serverUrl : '')
      var serverUrl = serverUrlState[0]
      var setServerUrl = serverUrlState[1]
      var tokenState = useState('')
      var token = tokenState[0]
      var setToken = tokenState[1]
      var passState = useState('')
      var passphrase = passState[0]
      var setPassphrase = passState[1]
      var passConfirmState = useState('')
      var passConfirm = passConfirmState[0]
      var setPassConfirm = passConfirmState[1]
      var probeState = useState(null)
      var probe = probeState[0]
      var setProbe = probeState[1]
      var selectedState = useState(function () {
        return Array.isArray(setup && setup.syncSessionIds) ? setup.syncSessionIds.slice() : []
      })
      var selectedIds = selectedState[0]
      var setSelectedIds = selectedState[1]
      var hiddenState = useState(dismissed)
      var hidden = hiddenState[0]
      var setHidden = hiddenState[1]
      var forcedState = useState(onboardingForced)
      var forced = forcedState[0]
      var activeState = useState(false)
      var active = activeState[0]
      var setActive = activeState[1]
      var busyState = useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]
      var messageState = useState(null)
      var message = messageState[0]
      var setMessage = messageState[1]
      var agreementState = useState(null)
      var agreement = agreementState[0]
      var setAgreement = agreementState[1]
      var agreementErrorState = useState(null)
      var agreementError = agreementErrorState[0]
      var setAgreementError = agreementErrorState[1]
      var acceptedState = useState(readAcceptedAgreement)
      var accepted = acceptedState[0]
      var setAccepted = acceptedState[1]
      var agreedState = useState(false)
      var agreed = agreedState[0]
      var setAgreed = agreedState[1]
      var updateDismissedState = useState(false)
      var updateDismissed = updateDismissedState[0]
      var setUpdateDismissed = updateDismissedState[1]
      var mappingRefreshed = useRef(false)

      useEffect(function () { model.refreshAll() }, [model])
      useEffect(function () {
        var live = true
        model.agreement().then(function (value) {
          if (live) setAgreement(value)
        }, function (error) {
          if (live) setAgreementError(errorText(error))
        })
        return function () { live = false }
      }, [model])
      useEffect(function () {
        if (setup === null) return
        // 一旦以“未配置”姿态打开，后续步骤保存让 setup 变成已配置时也不能
        // 把向导抽掉；只有首次加载就是已配置才不显示。
        setActive(function (previous) { return previous || forced || !setup.configured })
      }, [setup && setup.configured])
      useEffect(function () {
        if (setup && setup.configured) setDismissed()
      }, [setup && setup.configured])
      useEffect(function () {
        if (!active) return
        saveOnboardProgress({ step: Math.min(step, 1), persona: persona, serverUrl: serverUrl })
      }, [active, step, persona, serverUrl])

      if (setup === null) return null
      if (!active) {
        if (updateDismissed || agreement === null || accepted === agreement.hash) return null
        return h(AgreementUpdateDialog, {
          agreement: agreement,
          onAccept: acceptAgreement,
          onLater: function () { setUpdateDismissed(true) },
        })
      }
      if (hidden) return null

      function choosePersona(value) {
        setPersona(value)
        setStep(1)
        setMessage(null)
      }

      function toggleSession(sessionId) {
        setSelectedIds(function (previous) {
          var list = previous.slice()
          var index = list.indexOf(sessionId)
          if (index >= 0) list.splice(index, 1)
          else list.push(sessionId)
          return list
        })
      }

      function acceptAgreement() {
        if (!agreement || !agreement.hash) return
        saveAcceptedAgreement(agreement.hash)
        setAccepted(agreement.hash)
        setAgreed(true)
      }

      function close() {
        setDismissed()
        setHidden(true)
        clearOnboardProgress()
        clearOnboardingForce()
      }

      async function connect() {
        var url = String(serverUrl || '').trim()
        if (url === '') {
          setMessage({ bad: true, text: '先填写服务端地址' })
          return
        }
        try { assertServerUrl(url) } catch (error) { setMessage({ bad: true, text: errorText(error) }); return }
        if (String(token).trim() === '') {
          setMessage({ bad: true, text: '先填写设备 token' })
          return
        }
        setBusy('probe')
        setMessage(null)
        try {
          var result = await model.probe(url, String(token).trim())
          if (!result || result.ok !== true) {
            setMessage({ bad: true, text: (result && result.message) || '连接失败' })
            return
          }
          if (!result.probe || !result.probe.me || result.probe.me.role !== 'device') {
            setMessage({ bad: true, text: '这是管理 token，不是设备 token；请在管理台签发一个设备 token。' })
            return
          }
          setProbe(result.probe)
          setStep(2)
        } catch (error) {
          setMessage({ bad: true, text: errorText(error) })
        } finally {
          setBusy('')
        }
      }

      async function confirmDevice() {
        if (probe === null) return
        setBusy('save')
        setMessage(null)
        try {
          var label = probe.me && probe.me.device ? String(probe.me.device.label || '') : ''
          var ops = [
            { op: 'set', path: ['serverUrl'], value: String(serverUrl).trim() },
            ...label === '' ? [] : [{ op: 'set', path: ['deviceName'], value: label }],
          ]
          var acceptedOps = await props.writeSettings(ops)
          if (!acceptedOps.ok) throw new Error(acceptedOps.message)
          var saved = await props.setCredential(CREDENTIAL_REFS.token, String(token).trim())
          if (!saved.ok) throw new Error(saved.message)
          await model.refreshSetup()
          setStep(3)
        } catch (error) {
          setMessage({ bad: true, text: errorText(error) })
        } finally {
          setBusy('')
        }
      }

      async function confirmPassphrase() {
        if (String(passphrase).trim() === '') {
          setMessage({ bad: true, text: '同步口令不能为空' })
          return
        }
        if (persona === 'upload' && passphrase !== passConfirm) {
          setMessage({ bad: true, text: '两次输入的口令不一致' })
          return
        }
        setBusy('pass')
        setMessage(null)
        try {
          if (persona === 'adopt') {
            var check = await model.verifyPassphrase(String(serverUrl).trim(), String(token).trim(), passphrase)
            if (!check || check.ok !== true) {
              setMessage({ bad: true, text: (check && check.message) || '口令验证失败' })
              return
            }
            if (check.verified !== true) {
              setMessage({ bad: true, text: check.message || '云端还没有可验证的数据，请确认口令后继续' })
              return
            }
          }
          var saved = await props.setCredential(CREDENTIAL_REFS.passphrase, passphrase)
          if (!saved.ok) throw new Error(saved.message)
          await model.refreshSetup()
          setPassphrase('')
          setPassConfirm('')
          setStep(4)
        } catch (error) {
          setMessage({ bad: true, text: errorText(error) })
        } finally {
          setBusy('')
        }
      }

      async function saveSelection() {
        var result = await props.writeSettings([
          { op: 'set', path: ['syncSessionIds'], value: selectedIds.slice() },
        ])
        if (!result.ok) throw new Error(result.message)
      }

      async function next() {
        setMessage(null)
        if (step === 1) {
          await connect()
          return
        }
        if (step === 2) {
          await confirmDevice()
          return
        }
        if (step === 3) {
          await confirmPassphrase()
          return
        }
        if (step === 4) {
          if (persona !== 'upload') {
            setStep(5)
            return
          }
          setBusy('save')
          try {
            await saveSelection()
            setStep(5)
          } catch (error) {
            setMessage({ bad: true, text: errorText(error) })
          } finally {
            setBusy('')
          }
          return
        }
        if (step === 5) {
          if (!agreement || !agreement.hash) {
            setMessage({ bad: true, text: agreementError || '使用须知尚未加载，请稍后重试' })
            return
          }
          if (!agreed) {
            setMessage({ bad: true, text: '请先阅读并勾选同意使用协议' })
            return
          }
          acceptAgreement()
          setStep(6)
          return
        }
        setBusy('finish')
        try {
          var result = await model.syncNow()
          if (!result || result.ok !== true) {
            setMessage({ bad: true, text: (result && (result.message || result.code)) || '同步未执行' })
            return
          }
          clearOnboardProgress()
          clearOnboardingForce()
          close()
          model.toast('同步已启动')
        } catch (error) {
          setMessage({ bad: true, text: errorText(error) })
        } finally {
          setBusy('')
        }
      }

      function back() {
        setMessage(null)
        setStep(step - 1)
      }

      var workspaces = state.workspaces
      var candidates = workspaces ? workspaces.workspaces : []
      var sessions = workspaces && Array.isArray(workspaces.sessions) ? workspaces.sessions : []
      var includedCount = sessions.filter(function (session) { return selectedIds.indexOf(session.sessionId) >= 0 }).length
      var labels = persona === 'adopt'
        ? ['场景', '连接', '确认', '口令', '映射', '须知', '完成']
        : ['场景', '连接', '确认', '口令', '会话', '须知', '完成']
      var body
      if (step === 0) {
        body = [
          h('div', { className: 'dssync-note' }, '先选一个场景；下一步会连服务器核对，选错也能在确认页改。'),
          h('div', { className: 'dssync-choice' },
            h('button', { className: 'dssync-choice-card', type: 'button', onClick: function () { choosePersona('upload') } },
              h('b', null, '第一次使用'),
              h('span', null, '把本机会话上传到云端；')),
            h('button', { className: 'dssync-choice-card', type: 'button', onClick: function () { choosePersona('adopt') } },
              h('b', null, '接入已有云端'),
              h('span', null, '把云端已有的会话接到这台电脑；'))),
          message ? h('div', { className: 'dssync-note' + (message.bad ? ' bad' : '') }, message.text) : null,
        ]
      } else if (step === 1) {
        body = [
          h(Field, { id: 'ob-server', label: '服务端地址', hint: '自部署服务端地址形如 http://127.0.0.1:8787。' },
            h('input', { id: 'ob-server', value: serverUrl, placeholder: 'http://127.0.0.1:8787', onChange: function (e) { setServerUrl(e.target.value) } })),
          h(Field, { id: 'ob-token', label: '设备 token', hint: '由服务端管理台或 CLI 签发；只显示一次。' },
            h('input', { id: 'ob-token', type: 'password', value: token, placeholder: '粘贴 token', autoComplete: 'off', onChange: function (e) { setToken(e.target.value) } })),
          message ? h('div', { className: 'dssync-note' + (message.bad ? ' bad' : '') }, message.text) : null,
        ]
      } else if (step === 2) {
        // 0.1.2 及更早的服务端没有 counts：统计未知，不能按“空”处理。
        var counts = probe && probe.counts ? probe.counts : null
        var remoteEmpty = counts !== null && counts.sessions === 0 && counts.workspaces === 0
        var conflict = counts === null ? null : persona === 'upload' && !remoteEmpty
          ? '云端已经有 ' + counts.workspaces + ' 个工作区 / ' + counts.sessions + ' 个会话，这更像“接入已有云端”。'
          : persona === 'adopt' && remoteEmpty
            ? '云端还没有任何会话，这更像“第一次使用”。'
            : null
        var serverInfo = probe && probe.server ? probe.server : null
        var device = probe && probe.me && probe.me.device ? probe.me.device : null
        body = [
          h('div', { className: 'dssync-note' }, '确认一下服务器与设备信息；确认后会保存地址和 token。'),
          h('div', { className: 'dssync-summary' },
            h('div', null, h('span', null, '服务器'), h('b', null, String(serverUrl).trim())),
            h('div', null, h('span', null, '版本'), h('b', null, (serverInfo ? serverInfo.version : (probe.health.version || '未知')) + ' · 协议 v' + (serverInfo ? serverInfo.protocolVersion : (probe.health.protocols[0] || '?')))),
            h('div', null, h('span', null, '设备'), h('b', null, device ? device.label : '未知')),
            h('div', null, h('span', null, '设备 ID'), h('b', null, device ? String(device.deviceId).slice(0, 12) : '—')),
            h('div', null, h('span', null, '远端'), h('b', null, counts === null ? '统计不可用（服务端版本较旧）' : counts.workspaces + ' 个工作区 · ' + counts.sessions + ' 个会话')),
            serverInfo ? h('div', null, h('span', null, '配额'), h('b', null, fmtBytes(serverInfo.usedBytes) + ' / ' + fmtBytes(serverInfo.quotaBytes))) : null),
          conflict ? h('div', { className: 'dssync-note warn' }, conflict) : null,
          conflict && persona === 'upload'
            ? h('button', { className: 'dssync-pill', type: 'button', onClick: function () { setPersona('adopt') } }, '改走“接入已有云端”')
            : conflict && persona === 'adopt'
              ? h('button', { className: 'dssync-pill', type: 'button', onClick: function () { setPersona('upload') } }, '改走“第一次使用”')
              : null,
          message ? h('div', { className: 'dssync-note' + (message.bad ? ' bad' : '') }, message.text) : null,
        ]
      } else if (step === 3) {
        body = [
          h(Field, { id: 'ob-pass', label: '同步口令', hint: persona === 'adopt' ? '必须与云端其他设备一致；下一步会验证。' : '用于派生端到端加密密钥；所有设备必须一致，丢失后云端内容无法解密。' },
            h('input', { id: 'ob-pass', type: 'password', value: passphrase, placeholder: persona === 'adopt' ? '输入云端使用的口令' : '设置同步口令', autoComplete: 'new-password', onChange: function (e) { setPassphrase(e.target.value) } })),
          persona === 'upload'
            ? h(Field, { id: 'ob-pass2', label: '再输一次' },
              h('input', { id: 'ob-pass2', type: 'password', value: passConfirm, placeholder: '确认口令', autoComplete: 'new-password', onChange: function (e) { setPassConfirm(e.target.value) } }))
            : null,
          message ? h('div', { className: 'dssync-note' + (message.bad ? ' bad' : '') }, message.text) : null,
        ]
      } else if (step === 4) {
        if (persona === 'adopt') {
          body = [
            h('div', { className: 'dssync-note' }, '远端工作区按 workspaceKey 一次性绑定；未映射的会话不会写入本机。'),
            h(WorkspaceMappingPanel, { model: model, workspaces: workspaces, compact: true, onRetry: function () { model.refreshWorkspaces() } }),
            message ? h('div', { className: 'dssync-note' + (message.bad ? ' bad' : '') }, message.text) : null,
          ]
        } else {
          body = [
            h('div', { className: 'dssync-btnrow' },
              h('button', {
                className: 'dssync-pill', type: 'button',
                onClick: function () { setSelectedIds(includedCount === sessions.length ? [] : sessions.map(function (session) { return session.sessionId })) },
              }, includedCount === sessions.length && sessions.length > 0 ? '清空会话' : '全选会话'),
              h('span', { className: 'dssync-note' }, '同步 ' + includedCount + ' / ' + sessions.length + ' 个根会话')),
            sessions.length === 0
              ? h('div', { className: 'dssync-note warn' }, '还没有可同步的根会话；可以稍后在设置里处理。')
              : h('div', { className: 'dssync-sessionlist' }, candidates.map(function (workspace) {
                var workspaceSessions = sessions.filter(function (session) { return session.workspacePath === workspace.path })
                if (workspaceSessions.length === 0) return null
                var workspaceSelected = workspaceSessions.filter(function (session) { return selectedIds.indexOf(session.sessionId) >= 0 }).length
                return h('div', { className: 'dssync-sessiongroup', key: workspace.path },
                  h('div', { className: 'dssync-sessiongroup-head' },
                    h('b', null, workspace.title || workspace.path),
                    h('span', null, workspace.path),
                    h('span', null, workspaceSelected + ' / ' + workspaceSessions.length)),
                  workspaceSessions.map(function (session) {
                    var checked = selectedIds.indexOf(session.sessionId) >= 0
                    return h('label', { className: 'dssync-session' + (checked ? '' : ' off'), key: session.sessionId },
                      h('input', { type: 'checkbox', checked: checked, onChange: function () { toggleSession(session.sessionId) } }),
                      h('span', { className: 'dssync-session-main' },
                        h('b', { title: session.sessionId }, displaySessionTitle(props.titleOf, session.sessionId)),
                        h('span', null, shortDisplaySessionId(session.sessionId) + ' · ' + new Date(session.createdAt).toLocaleString())),
                      h('span', { className: 'dssync-session-meta' },
                        h('span', null, session.subagentSessions + ' 个子代理'),
                        h('span', { className: 'dssync-session-status' + (checked ? '' : ' off') }, checked ? '同步' : '未选中')))
                  }))
              })),
            h('div', { className: 'dssync-note' }, '默认不选中任何会话；勾选只决定本机上传；绑定工作区后会自动拉取该工作区的远端会话。'),
            message ? h('div', { className: 'dssync-note' + (message.bad ? ' bad' : '') }, message.text) : null,
          ]
        }
      } else if (step === 5) {
        body = [
          h('div', { className: 'dssync-note' }, '开始同步前请阅读以下使用协议；它说明插件会修改什么、服务端能看到什么，以及跨设备恢复的风险。'),
          h(AgreementPanel, { agreement: agreement, error: agreementError }),
          h('label', { className: 'dssync-agree' },
            h('input', { type: 'checkbox', checked: agreed, disabled: !agreement, onChange: function (event) { setAgreed(event.target.checked) } }),
            h('span', null, '我已阅读并同意使用协议，理解同步不是备份、跨设备恢复和分叉风险。')),
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
            h('button', { className: 'dssync-close', type: 'button', 'aria-label': '稍后配置', onClick: close }, '×')),
          h('ol', { className: 'dssync-steps' }, labels.map(function (label, index) {
            return h('li', { className: 'dssync-step' + (index === step ? ' on' : '') + (index < step ? ' done' : ''), key: label },
              h('i', null, index < step ? '✓' : String(index + 1)), label)
          })),
          h('div', { className: 'dssync-wizard-body', key: 'step-' + step }, body),
          h('div', { className: 'dssync-wizard-foot' },
            step > 0 && step < 6 ? h('button', { className: 'dssync-pill', type: 'button', disabled: busy !== '', onClick: back }, '上一步') : null,
            h('button', { className: 'dssync-pill', type: 'button', onClick: close }, '稍后'),
            h('span', { className: 'spacer' }),
            h('button', {
              className: 'dssync-pill primary', type: 'button', disabled: busy !== '' || step === 0,
              onClick: next,
            }, busy === 'finish' ? '同步中…' : step === 0 ? '先选场景' : step === 5 ? '开始同步' : '下一步')),
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
        writeClipboard(plan.command).then(function () {
          setCopied(true)
          setTimeout(function () { setCopied(false) }, 1800)
        }).catch(function () {
          model.toast('复制失败，请手动选择命令', true)
        })
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

    var TASK_ANIM_MS = 220
    var TASK_ANIM_MAX = 8

    /**
     * 任务行进出动画：高度展开/折叠 + 右侧滑入/左侧滑出。
     * 只动画当前视口附近的少量行，避免一次校验 80 行时刷屏。
     * @param props - tasks、scan 与单行渲染函数。
     * @returns 任务行列表。
     */
    function AnimatedTaskRows(props) {
      var tasks = Array.isArray(props.tasks) ? props.tasks : []
      var scan = props.scan
      var renderRow = props.renderRow
      var enteringState = useState([])
      var entering = enteringState[0]
      var setEntering = enteringState[1]
      var exitingState = useState([])
      var exiting = exitingState[0]
      var setExiting = exitingState[1]
      // 初始已存在的任务不做入场动画，只动画后续新增的行。
      var prevRef = useRef(tasks)
      var latestRef = useRef(new Map())
      var enterTimers = useRef(new Map())
      var exitTimers = useRef(new Map())
      var aliveRef = useRef(true)
      var idsKey = tasks.map(function (task) { return String(task.sessionId) }).join('|')
      var reduceMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      tasks.forEach(function (task) {
        latestRef.current.set(String(task.sessionId), task)
      })

      useEffect(function () {
        aliveRef.current = true
        return function () {
          aliveRef.current = false
          enterTimers.current.forEach(function (timer) { clearTimeout(timer) })
          exitTimers.current.forEach(function (timer) { clearTimeout(timer) })
          enterTimers.current.clear()
          exitTimers.current.clear()
        }
      }, [])

      useLayoutEffect(function () {
        var prev = prevRef.current
        var prevIds = new Set(prev.map(function (task) { return String(task.sessionId) }))
        var currentIds = new Set(tasks.map(function (task) { return String(task.sessionId) }))
        var added = tasks.filter(function (task) { return !prevIds.has(String(task.sessionId)) })
        var removed = prev.filter(function (task) { return !currentIds.has(String(task.sessionId)) })
        prevRef.current = tasks

        if (reduceMotion) {
          enterTimers.current.forEach(function (timer) { clearTimeout(timer) })
          exitTimers.current.forEach(function (timer) { clearTimeout(timer) })
          enterTimers.current.clear()
          exitTimers.current.clear()
          setEntering(function (current) { return current.length === 0 ? current : [] })
          setExiting(function (current) { return current.length === 0 ? current : [] })
          return
        }

        // 同一会话重新出现时，取消上一轮的退场，不重复挂旧行。
        currentIds.forEach(function (id) {
          var timer = exitTimers.current.get(id)
          if (timer !== undefined) {
            clearTimeout(timer)
            exitTimers.current.delete(id)
          }
        })
        removed.forEach(function (task) {
          var id = String(task.sessionId)
          var timer = enterTimers.current.get(id)
          if (timer !== undefined) {
            clearTimeout(timer)
            enterTimers.current.delete(id)
          }
        })
        setEntering(function (current) {
          var next = current.filter(function (id) { return currentIds.has(id) })
          added.slice(0, TASK_ANIM_MAX).forEach(function (task) {
            var id = String(task.sessionId)
            if (next.indexOf(id) < 0) next.push(id)
          })
          return next
        })
        setExiting(function (current) {
          var next = current.filter(function (item) { return !currentIds.has(item.sessionId) })
          removed.slice(0, TASK_ANIM_MAX).forEach(function (task) {
            var id = String(task.sessionId)
            if (!next.some(function (item) { return item.sessionId === id })) {
              next.push({ sessionId: id, task: latestRef.current.get(id) || task })
            }
          })
          return next
        })

        added.slice(0, TASK_ANIM_MAX).forEach(function (task) {
          var id = String(task.sessionId)
          if (enterTimers.current.has(id)) return
          enterTimers.current.set(id, setTimeout(function () {
            enterTimers.current.delete(id)
            if (!aliveRef.current) return
            setEntering(function (current) {
              return current.filter(function (item) { return item !== id })
            })
          }, TASK_ANIM_MS + 20))
        })
        removed.slice(0, TASK_ANIM_MAX).forEach(function (task) {
          var id = String(task.sessionId)
          if (exitTimers.current.has(id)) return
          exitTimers.current.set(id, setTimeout(function () {
            exitTimers.current.delete(id)
            if (!aliveRef.current) return
            setExiting(function (current) {
              return current.filter(function (item) { return item.sessionId !== id })
            })
          }, TASK_ANIM_MS + 20))
        })
      }, [idsKey, reduceMotion])

      var enteringIds = new Set(entering)
      var currentIds = new Set(tasks.map(function (task) { return String(task.sessionId) }))
      var items = tasks.map(function (task) {
        var id = String(task.sessionId)
        return { sessionId: id, task: task, phase: enteringIds.has(id) ? ' enter' : '' }
      })
      exiting.forEach(function (item) {
        if (currentIds.has(item.sessionId)) return
        items.push({ sessionId: item.sessionId, task: item.task, phase: ' exit', exit: true })
      })
      // 空态交给调用方渲染：组件保持挂载，退场动画才不会被整块替换打断。
      if (items.length === 0) return props.empty === undefined ? null : props.empty
      return h(React.Fragment, null, items.map(function (item) {
        return h('div', {
          className: 'dssync-task-anim' + item.phase,
          key: (item.exit ? 'exit:' : '') + item.sessionId,
          'data-session-id': item.sessionId,
          'aria-hidden': item.exit ? 'true' : undefined,
        }, renderRow(item.task, scan))
      }))
    }

    // —— 任务列表为空时的句子 ——
    var SYNC_IDLE_LINES = [
      '所有会话都在同一页上。',
      '没有待办，云端很安静。',
      '两边末序号一样长，像对过表。',
      '链哈希对齐，一个字节都不差。',
      '这一刻没有要搬运的东西。',
      '心跳正常，租约在手，无事发生。',
      '加密后的原文，只有你我看得见。',
      '会话在生长，同步在等它停下来。',
      '先歇一会儿，有变化我会记账。',
      '远端在点头，本地也在点头。',
      '别点啦，再点也不会突然多出新事件来的。',
      '真的没有更多要同步的啦。',
      '云在飘。没有别的事。',
    ]

    /**
     * 挑一句空闲文案：日期彩蛋优先，再按"每次变空"递增轮换。
     * @param now - 当前时间。
     * @param tick - 变空次数（每空一次 +1）。
     * @param lastSuccess - 上次成功同步时间；null 表示从未成功。
     * @returns 文案。
     */
    function syncIdleLine(now, tick, lastSuccess) {
      var month = now.getMonth() + 1
      var day = now.getDate()
      if (month === 4 && day === 1) return '今天同步会倒着走。愚人节快乐。'
      if (month === 2 && day === 14) return '本地和远端今天终于对齐了。'
      if (month === 10 && day === 24) return '1024 个事件，一个不多。程序员节快乐。'
      if (now.getDay() === 5 && day === 13) return '链哈希今天格外可靠。'
      if (now.getHours() === 0 && now.getMinutes() < 5) return '零点刚过，昨天的尾巴收好了。'
      if (lastSuccess === null || lastSuccess === undefined) return '第一次同步之前，先聊两句？'
      if (now.getTime() - lastSuccess > 24 * 3600 * 1000) return '一整天没动过，我替你看着。'
      var index = Math.abs(Math.floor(tick)) % SYNC_IDLE_LINES.length
      return SYNC_IDLE_LINES[index]
    }

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
      var pinnedRef = useRef(false)
      var hoveringRef = useRef(false)
      var focusWithinRef = useRef(false)
      var activeRef = useRef(false)
      // 自动收回时长（ms）；0 / 负数 = 不自动收回。
      var autoCollapseRef = useRef(0)
      var laneRunRef = useRef(null)
      var laneHighRef = useRef({})
      var idleTickState = useState(0)
      var idleTick = idleTickState[0]
      var setIdleTick = idleTickState[1]
      var wasEmptyRef = useRef(false)
      // 只在"变空"这一刻换一句；一直空着不刷。必须放在任何早退之前。
      useEffect(function () {
        var tasks = statusTasks(status)
        var empty = tasks !== null
          ? tasks.length === 0
          : !(status && Array.isArray(status.sessions) && status.sessions.length > 0)
        if (empty && !wasEmptyRef.current) setIdleTick(function (value) { return value + 1 })
        wasEmptyRef.current = empty
      }, [status])

      useEffect(function () { pinnedRef.current = pinned }, [pinned])
      activeRef.current = !!(status && (status.running || status.pending !== null))
      var laneRunId = status && status.run ? status.run.id : 0
      if (laneRunRef.current !== laneRunId) {
        laneRunRef.current = laneRunId
        laneHighRef.current = {}
      }

      useEffect(function () { model.refreshAll() }, [model])
      useEffect(function () {
        if (status && setup === null) return
        if (setup && !setup.configured && !dismissed()) return
        // 单会话定向操作由底栏展示，不自动弹气泡。
        var single = !!(status && status.run && status.run.scope === 'session')
        if (status && (status.running || status.pending !== null || status.lastError !== null) && !visible) {
          expand(false, single ? 3000 : 0)
        }
      }, [status && status.running, status && status.pending, status && status.lastError, setup && setup.configured, status && status.run && status.run.scope])

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
        if (hideTimer.current !== null) {
          clearTimeout(hideTimer.current)
          hideTimer.current = null
        }
        if (!was || activeRef.current || !visible || pinned) return
        // 完成结果保留到下一轮任务进来；不要 3 秒后把结果一起隐藏。
        // 单会话定向操作不保留结果面板，跑完照常收起。
        var single = !!(status && status.run && status.run.scope === 'session')
        if (!single && status && status.run && Array.isArray(status.run.tasks) && status.run.tasks.length > 0) return
        if (status && status.lastError !== null && status.lastError !== undefined) return
        scheduleAutoCollapse()
      }, [status && status.running, status && status.pending, status && status.lastError, visible, pinned])

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

      var panelRef = useRef(null)
      var focusRef = useRef(null)
      var followState = useState(true)
      var follow = followState[0]
      var setFollow = followState[1]
      var taskList = statusTasks(status)
      var useTasks = taskList !== null
      var focusSessions = useTasks ? [] : (status && Array.isArray(status.sessions) ? status.sessions : [])
      var currentFocus = focusSessions.find(function (session) {
        return session.sessionId === focusRef.current && sessionOngoing(session)
      })
      var focusSession = currentFocus || focusSessions.find(sessionOngoing)
      var focusSessionId = focusSession ? focusSession.sessionId : null

      useEffect(function () {
        focusRef.current = focusSessionId
        if (!visible || !open || !follow || focusSessionId === null || panelRef.current === null) return
        var panel = panelRef.current
        var rows = panel.querySelectorAll('[data-session-id]')
        var target = null
        for (var index = 0; index < rows.length; index += 1) {
          if (rows[index].getAttribute('data-session-id') === focusSessionId) {
            target = rows[index]
            break
          }
        }
        if (target === null) return
        var panelRect = panel.getBoundingClientRect()
        var rowRect = target.getBoundingClientRect()
        if (rowRect.top >= panelRect.top && rowRect.bottom <= panelRect.bottom) return
        if (typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        }
      }, [focusSessionId, follow, open, visible, status && status.statusVersion])

      function pauseFollowOnUserScroll() {
        if (!follow || focusSessionId === null) return
        setFollow(false)
      }

      function resumeFollow() {
        setFollow(true)
      }

      if (setup === null || !setup.configured) return h(Toast, { model: model })

      var sessions = useTasks ? [] : (status && Array.isArray(status.sessions) ? status.sessions.slice() : [])
      var scan = useTasks && status.run ? status.run.scan : null
      var total = useTasks
        ? (scan && typeof scan.total === 'number' ? scan.total : taskList.length)
        : sessions.length
      var taskDone = useTasks
        ? taskList.filter(function (task) { return task.state === 'done' }).length
        : 0
      var pendingTasks = useTasks
        ? taskList.filter(function (task) { return task.state !== 'done' }).length
        : 0
      var done = useTasks
        ? Math.max(0, total - taskList.length) + taskDone
        : sessions.filter(function (session) { return session.phase === 'done' }).length
      var planned = useTasks ? 0 : sessions.filter(function (session) { return session.phase === 'planned' }).length
      var deferred = useTasks
        ? taskList.filter(function (task) { return task.state === 'deferred' }).length
        : sessions.filter(function (session) { return session.phase === 'deferred' }).length
      var blockedCount = useTasks
        ? taskList.filter(function (task) { return task.state === 'blocked' }).length
        : sessions.filter(function (session) { return session.phase === 'blocked' }).length
      var failed = useTasks
        ? taskList.some(function (task) { return task.state === 'failed' })
        : sessions.some(function (session) { return session.phase === 'failed' })
      var running = status && status.running
      var activeStage = sessions.map(sessionStage).find(isActiveStage)
      var waitingStage = sessions.map(sessionStage).find(isWaitingStage)
      var activeCount = sessions.filter(sessionOngoing).length
      var headerStageLabel = stageLabel(activeStage) || stageLabel(waitingStage)
      var lease = status && status.deviceLease
      var leaseBlocked = lease && (lease.state === 'foreign' || lease.state === 'lost')
      var title = failed ? '同步失败'
        : blockedCount > 0 ? '需要处理'
          : leaseBlocked ? '只读同步'
            : running ? '正在同步'
              : waitingStage ? '等待处理'
                : deferred > 0 ? '部分待处理' : '同步完成'
      var subtitle = failed ? '有会话未完成，已暂停'
        : blockedCount > 0 ? blockedCount + ' 个会话历史分叉，已阻止继续写入'
          : leaseBlocked ? (lease.state === 'foreign'
            ? '另一台设备持有全局同步锁；本机只拉取'
            : '全局同步租约丢失；本机只拉取并重试')
            : running ? (headerStageLabel !== ''
              ? headerStageLabel + ' · ' + activeCount + ' 个会话'
              : total === 0 ? '连接服务端…' : done + '/' + total + ' 个会话 · 端到端加密')
              : waitingStage ? (headerStageLabel + ' · ' + activeCount + ' 个会话')
                : deferred > 0 ? deferred + ' 个会话等待拉取/关闭/cwd 处理'
                  : planned > 0 ? planned + ' 个会话待开始'
                    : total === 0 ? '还没有同步记录'
                      : done + '/' + total + ' 个会话 · ' + (status.lastSuccess ? formatAgo(status.lastSuccess) : '尚未成功')
      if (useTasks) {
        var phase = status.run ? status.run.phase : undefined
        var scanChecked = scan && typeof scan.checked === 'number' ? scan.checked : done
        title = failed ? '同步失败'
          : blockedCount > 0 ? '需要处理'
            : running ? (phase === 'scanning' ? '正在校验' : '正在同步')
              : deferred > 0 ? '部分待处理'
                : pendingTasks > 0 ? '等待同步' : '同步完成'
        subtitle = failed ? '有任务未完成，已暂停'
          : blockedCount > 0 ? blockedCount + ' 个会话历史分叉，已阻止继续写入'
            : running
              ? (phase === 'scanning'
                ? '校验 ' + scanChecked + '/' + total
                  + (scan && scan.currentSessionId ? ' · ' + sessionLabel(scan.currentSessionId) : '')
                : taskList.length + ' 个任务 · 端到端加密')
              : deferred > 0 ? deferred + ' 个任务等待处理'
                : pendingTasks > 0 ? '等待开始'
                  : taskList.length > 0 ? '上次任务完成 · ' + taskDone + ' 个'
                    : status.lastSuccess ? '上次成功 ' + formatAgo(status.lastSuccess) : '没有待同步任务'
      }
      var dot = statusDot(status)
      function lanePercent(session, direction) {
        if (session.phase === 'done' || session.phase === 'skipped') return 100
        if (direction === undefined || direction === null) return 0
        var terminal = direction.status === 'pushed' || direction.status === 'pulled'
          || direction.status === 'up-to-date' || direction.status === 'skipped'
        var pct = terminal || direction.phase === 'done'
          ? 100
          : direction.totalEvents > 0
            ? Math.max(0, Math.min(100, Math.round(direction.doneEvents / direction.totalEvents * 100)))
            : 0
        var key = session.sessionId + ':' + direction.direction
        var previous = laneHighRef.current[key] || 0
        pct = Math.max(previous, pct)
        laneHighRef.current[key] = pct
        return pct
      }
      var segments = useTasks
        ? taskList.map(function (task) {
          var bad = task.state === 'failed' || task.state === 'blocked'
          var active = task.state === 'running' || task.state === 'checking'
          var terminal = task.state === 'done'
          var pct = terminal ? 100
            : task.state === 'checking' ? 0
              : task.totalEvents > 0 ? Math.max(0, Math.min(100, Math.round(task.doneEvents / task.totalEvents * 100)))
                : task.progress > 0 ? Math.round(task.progress * 100) : 0
          var className = 'dssync-seg' + (bad ? ' bad' : terminal ? ' done' : active ? ' run' : '')
          return h('span', {
            className: className,
            key: task.sessionId,
            title: sessionLabel(task.sessionId) + ' · ' + (task.direction === 'push' ? '上传 ' + pct + '%' : '下载 ' + pct + '%'),
          },
            h('i', {
              className: 'task ' + task.direction,
              style: task.direction === 'push'
                ? { left: '0', width: pct + '%' }
                : { right: '0', width: pct + '%' },
            }))
        })
        : sessions.map(function (session) {
          var bad = session.phase === 'failed' || session.phase === 'blocked'
          var active = session.phase === 'running'
          var terminal = session.phase === 'done' || session.phase === 'skipped'
          var push = lanePercent(session, session.push)
          var pull = lanePercent(session, session.pull)
          var pushDone = push >= 100
          var className = 'dssync-seg'
            + (bad ? ' bad' : terminal ? ' done' : active ? ' run' : '')
            + (pushDone && !terminal ? ' push-done' : '')
          return h('span', {
            className: className,
            key: session.sessionId,
            title: sessionLabel(session.sessionId) + ' · 上传 ' + push + '% · 拉取 ' + pull + '%',
          },
          h('i', { className: 'push', style: { width: push + '%' } }),
          h('i', { className: 'pull', style: { width: pull + '%' } }))
        })
      if (segments.length === 0) {
        segments = [h('span', { className: 'dssync-seg' + (running ? ' run' : ''), key: 'empty' },
          h('i', { className: 'push', style: { width: running ? '35%' : '0%' } }),
          h('i', { className: 'pull', style: { width: '0%' } }))]
      }

      function clearBlur() {
        if (blurTimer.current !== null) { clearTimeout(blurTimer.current); blurTimer.current = null }
      }

      function clearHide() {
        if (hideTimer.current !== null) { clearTimeout(hideTimer.current); hideTimer.current = null }
      }

      function scheduleBlur() {
        if (!visible || !pinned) return
        // 同步期间不自动收起；阶段/列表可能正被查看。
        if (activeRef.current) return
        // 任务结果保留到下一轮，不要在失焦时收走。
        if (status && status.run && Array.isArray(status.run.tasks) && status.run.tasks.length > 0) return
        clearBlur()
        blurTimer.current = setTimeout(function () {
          blurTimer.current = null
          if (!visible || activeRef.current || pinnedRef.current || hoveringRef.current || focusWithinRef.current) return
          if (document.hasFocus() && document.activeElement && document.querySelector('.dssync-bubble') &&
            document.querySelector('.dssync-bubble').contains(document.activeElement)) return
          pinnedRef.current = false
          setPinned(false)
          setVisible(false)
          setOpen(false)
        }, 5000)
      }

      /**
       * 按当前时长安排一次自动收回；仍在跑或被占用时稍后重试。
       */
      function scheduleAutoCollapse() {
        clearHide()
        var delay = autoCollapseRef.current
        if (!(delay > 0) || !visible) return
        hideTimer.current = setTimeout(function () {
          hideTimer.current = null
          if (!visible) return
          if (pinnedRef.current) return
          if (activeRef.current || hoveringRef.current || focusWithinRef.current) {
            scheduleAutoCollapse()
            return
          }
          setVisible(false)
          setOpen(false)
        }, delay)
      }

      /**
       * 展开气泡。
       * @param pin - 是否钉住（用户主动操作）。
       * @param autoCollapseMs - 自动收回时长；0 / 负数表示不自动收回。
       */
      function expand(pin, autoCollapseMs) {
        touched.current = true
        autoCollapseRef.current = typeof autoCollapseMs === 'number' ? autoCollapseMs : 0
        if (pin !== false) {
          pinnedRef.current = true
          setPinned(true)
        }
        clearHide()
        clearBlur()
        setVisible(true)
        scheduleAutoCollapse()
      }

      function collapse() {
        pinnedRef.current = false
        setPinned(false)
        setVisible(false)
        setOpen(false)
        clearBlur()
        clearHide()
      }

      function onIcon() {
        if (visible) collapse()
        else { expand(true); model.refreshStatus() }
      }

      function onHead() {
        if (!visible) { expand(true); model.refreshStatus(); return }
        setOpen(function (value) { return !value })
      }

      function triggerSync() {
        if (syncing) return
        setSyncing(true)
        pinnedRef.current = true
        setPinned(true)
        clearHide()
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
        if (!visible) { expand(true); model.refreshStatus() }
        else setOpen(function (value) { return !value })
      }

      function onPointerDown(event) {
        if (event.target.closest && event.target.closest('.dssync-cloud')) return
        clearHide()
        clearBlur()
        pinnedRef.current = true
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
        var isBlocked = blockedEntry !== null
        var isResolved = decisionEntry !== null
        var decisionTag = isResolved ? (decisionEntry.action === 'ignore' ? '已忽略' : '已强行写入') : ''
        var stage = sessionStage(session)
        var waitingStage = isWaitingStage(stage)
        var stageText = stage === 'done' || stage === 'failed' ? '' : stageLabel(stage)
        var tag = isBlocked ? '分叉'
          : isResolved ? decisionTag
            : session.phase === 'failed' ? '失败'
              : session.phase === 'blocked' ? '分叉'
                : waitingStage ? (stageText || '等待')
                  : session.push && session.push.status === 'local-ahead' ? '本地领先'
                    : session.push && session.push.status === 'remote-ahead' ? '远端领先'
                      : session.pull && session.pull.status === 'remote-ahead' ? '远端领先'
                        : session.phase === 'planned'
                          ? (session.pull && session.pull.status === 'planned' ? '待拉取'
                            : session.push && session.push.status === 'planned' ? '待上传' : '待开始')
                          : stageText !== '' && session.phase !== 'done' && session.phase !== 'skipped' ? stageText
                            : session.phase === 'skipped' ? '未选上传'
                              : session.phase === 'done' ? '已同步'
                                : session.phase === 'running' ? '同步中'
                                  : session.phase === 'deferred'
                                    ? (session.live ? '已加载'
                                      : session.remoteAhead ? '远端领先'
                                        : session.unmapped ? '待映射'
                                          : session.cwdPending ? 'cwd 外' : '等待')
                                    : '等待'
        var counts = []
        var liveRunning = session.phase === 'running'
        if (session.push && session.push.totalEvents > 0 && (liveRunning || session.push.doneEvents > 0)) {
          counts.push('↑ ' + session.push.doneEvents + '/' + session.push.totalEvents)
        } else if (session.pending && session.pending.upload > 0) {
          counts.push('↑ ' + session.pending.upload)
        }
        if (session.pull && session.pull.totalEvents > 0 && (liveRunning || session.pull.doneEvents > 0)) {
          var pullText = '↓ ' + session.pull.doneEvents + '/' + session.pull.totalEvents
          if (!liveRunning && session.pending && session.pending.download > 0) {
            pullText += '（待 ' + session.pending.download + '）'
          }
          counts.push(pullText)
        } else if (session.pending && session.pending.download > 0) {
          counts.push('↓ ' + session.pending.download)
        }
        if (session.compression === 'zstd') counts.push('zstd')
        else if (session.compression === 'mixed') counts.push('zstd 混合')
        var attention = tag === '远端领先' || tag === '已加载' || tag === '待映射' || tag === 'cwd 外'
        var queued = tag === '本地领先' || tag === '远端领先' || tag === '待拉取' || tag === '待上传'
        var stateClass = isBlocked || session.phase === 'failed' ? 'bad'
          : session.phase === 'done' || session.phase === 'skipped' ? 'ok'
            : waitingStage || queued ? 'waiting'
              : session.phase === 'running' || attention || isResolved ? 'run' : ''
        return h('div', {
          className: 'dssync-rowline' + (focusSessionId === session.sessionId ? ' focus' : ''),
          key: session.sessionId,
          'data-session-id': session.sessionId,
        },
          h('span', { className: 'dssync-st ' + stateClass }),
          h('span', { className: 'name' }, sessionLabel(session.sessionId)),
          counts.length > 0 ? h('span', { className: 'dssync-events' }, counts.join(' · ')) : null,
          h('span', { className: 'tag' }, tag),
          isBlocked ? h('span', { className: 'dssync-warn', title: '本地与远端历史已分叉，已阻止继续写入' }, '已阻止') : null,
          isBlocked ? blockedActions(session.sessionId, blockedEntry) : null,
          isResolved ? h('span', { className: 'dssync-warn', title: decisionEntry.message }, decisionTag) : null,
          isResolved ? decisionActions(session.sessionId, decisionEntry) : null,
          !isBlocked && !isResolved && session.cwdPending ? h('span', {
            className: 'dssync-warn', title: '最后 cwd 在工作区外，跨设备可能无法正确恢复',
          }, 'cwd 外') : null,
          !isBlocked && !isResolved && session.cwdPending ? cwdActions(session.sessionId) : null)
      })

      function renderTaskRow(task, taskScan) {
        var totalEvents = task.totalEvents || 0
        var doneEvents = task.doneEvents || 0
        var stageText = stageLabel(task.stage)
        var tag = task.state === 'checking' ? '校验中'
          : task.state === 'done' ? '完成'
            : task.state === 'blocked' ? '分叉'
              : task.state === 'failed' ? '失败'
                : task.state === 'deferred' ? '等待'
                  : task.state === 'running'
                    ? (stageText || (task.direction === 'push' ? '上传中' : '下载中'))
                    : task.direction === 'push' ? '待上传' : '待拉取'
        var counts = totalEvents > 0 && task.state !== 'checking'
          ? [(task.direction === 'push' ? '↑ ' : '↓ ') + doneEvents + '/' + totalEvents]
          : []
        var stateClass = task.state === 'failed' || task.state === 'blocked' ? 'bad'
          : task.state === 'done' ? 'ok'
            : task.state === 'running' || task.state === 'checking' ? 'run'
              : task.state === 'deferred' ? 'waiting' : ''
        return h('div', {
          className: 'dssync-rowline' + (taskScan && taskScan.currentSessionId === task.sessionId ? ' focus' : ''),
          'data-session-id': task.sessionId,
        },
          h('span', { className: 'dssync-st ' + stateClass }),
          h('span', { className: 'name' }, sessionLabel(task.sessionId)),
          counts.length > 0 ? h('span', { className: 'dssync-events' }, counts.join(' · ')) : null,
          h('span', { className: 'tag' }, tag),
          task.error ? h('span', { className: 'dssync-warn', title: task.error }, '!') : null)
      }

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
          h('div', {
            className: 'dssync-panel',
            ref: panelRef,
            onWheel: pauseFollowOnUserScroll,
            onTouchMove: pauseFollowOnUserScroll,
          }, useTasks
            ? h(AnimatedTaskRows, {
              tasks: taskList, scan: scan, renderRow: renderTaskRow,
              empty: taskList.length === 0
                ? h('div', { className: 'dssync-note dssync-idle' }, syncIdleLine(new Date(), idleTick, status ? status.lastSuccess : null))
                : undefined,
            })
            : rows.length > 0
              ? rows
              : h('div', { className: 'dssync-note dssync-idle' }, syncIdleLine(new Date(), idleTick, status ? status.lastSuccess : null))),
          leaseBlocked ? h('div', { className: 'dssync-error' }, lease.state === 'foreign'
            ? '另一台设备持有全局同步锁；本机只拉取，不上传'
            : '全局同步租约丢失；本机暂停上传并重试') : null,
          status && status.lastError ? h('div', { className: 'dssync-error' }, status.lastError.message + (status.retryCount > 0 ? ' · 已重试 ' + status.retryCount + ' 次' : '')) : null,
          h('div', { className: 'dssync-foot' },
            h('span', null, running ? '正在同步…' : failed ? '已暂停' : blockedCount > 0 ? '有分叉待处理' : deferred > 0 ? '有会话待处理' : planned > 0 ? '等待开始' : '全部完成'),
            h('span', { className: 'spacer' }),
            !follow && focusSessionId !== null
              ? h('button', { className: 'dssync-mini', type: 'button', onClick: resumeFollow }, '回到当前同步')
              : null,
            h('button', { className: 'dssync-mini', type: 'button', disabled: syncing || running, 'aria-busy': syncing, onClick: triggerSync }, syncing || running ? '同步中…' : '立即同步'),
            h('button', { className: 'dssync-mini', type: 'button', onClick: props.openSettings }, '设置'))))

      var bubble = h('div', { className: 'dssync-bubble' + openClass + collapsedClass + badClass, 'aria-live': 'polite' },
        head,
        h('div', { className: 'dssync-segbar', 'aria-hidden': 'true' },
          h('span', { className: 'dssync-seg-end', title: '本机' }, computerIcon()),
          h('span', { className: 'dssync-seg-track' }, segments),
          h('span', { className: 'dssync-seg-end remote', title: '服务端' }, serverIcon())),
        panel)

      var wrap = h('div', {
        className: 'dssync-bubble-wrap' + collapsedClass,
        onPointerEnter: function () {
          hoveringRef.current = true
          clearBlur()
          clearHide()
        },
        onPointerLeave: function () {
          hoveringRef.current = false
          scheduleBlur()
        },
        onFocus: function () {
          focusWithinRef.current = true
          clearBlur()
          clearHide()
        },
        onBlur: function (event) {
          focusWithinRef.current = !!(event.currentTarget.contains && event.currentTarget.contains(event.relatedTarget))
          if (!focusWithinRef.current) scheduleBlur()
        },
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

    // —— 会话同步状态条（shell.bottom）——
    // 底栏是 root 作用域拿不到会话，所以由 dock（会话作用域）发布当前会话 id。
    var activeSessionId = ''
    var activeSessionListeners = []

    /** 发布当前会话 id，通知所有订阅者。 */
    function publishActiveSession(next) {
      var value = typeof next === 'string' ? next : ''
      if (value === activeSessionId) return
      activeSessionId = value
      activeSessionListeners.forEach(function (listener) { listener(value) })
    }

    /** 订阅当前会话 id。 */
    function useActiveSession() {
      var pair = React.useState(activeSessionId)
      React.useEffect(function () {
        function listener(value) { pair[1](value) }
        activeSessionListeners.push(listener)
        listener(activeSessionId)
        return function () {
          var at = activeSessionListeners.indexOf(listener)
          if (at >= 0) activeSessionListeners.splice(at, 1)
        }
      }, [])
      return pair[0]
    }

    /** 不可见组件：把当前会话 id 发布给底栏。 */
    function SessionSyncTracker(props) {
      var session = props.session
      var sessionId = session && session.sessionId ? String(session.sessionId) : ''
      React.useEffect(function () {
        publishActiveSession(sessionId)
        return function () { publishActiveSession('') }
      }, [sessionId])
      return null
    }

    var SYNC_BAR_STYLE = {
      bar: {
        height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px',
        padding: '0 12px', borderTop: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.28))',
        background: 'var(--dsw-alias-bg-layer-1, #17171c)',
        color: 'var(--dsw-alias-label-secondary, #c3c7cf)',
        font: '12px/1 ui-sans-serif, system-ui, sans-serif', whiteSpace: 'nowrap', overflow: 'hidden',
      },
      dot: { width: '7px', height: '7px', borderRadius: '4px', flex: '0 0 auto' },
      label: { fontWeight: 600, color: 'var(--dsw-alias-label-primary, #e6e8ec)' },
      id: { opacity: 0.45, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      nums: {
        display: 'flex', flexDirection: 'column', gap: '1px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '10.5px', lineHeight: 1.15, opacity: 0.8,
      },
      chip: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px', padding: '0 6px', borderRadius: '4px' },
      button: { height: '22px', padding: '0 9px', borderRadius: '6px', cursor: 'pointer', font: '11px/1 ui-sans-serif, system-ui', border: '1px solid transparent' },
      primary: { background: 'var(--dsw-alias-interactive-bg-accent, #3d6ff0)', color: '#fff' },
      disabled: { background: 'rgba(127,127,127,.14)', color: 'inherit', opacity: 0.45, cursor: 'default' },
    }

    /**
     * 双细条：绿色是共同前缀，尾段是差值（本地领先橙、远端领先蓝）。
     * @param localLast - 本地末序号。
     * @param remoteLast - 远端末序号。
     * @returns 元素。
     */
    function syncMeterRows(localLast, remoteLast) {
      var diff = localLast - remoteLast
      var deltaPx = diff === 0
        ? 0
        : Math.max(6, Math.round((Math.abs(diff) / Math.max(localLast, remoteLast, 1)) * 100))
      var green = { height: '3px', borderRadius: '2px', background: '#3fb950', flex: '1 1 auto' }
      function tip(color) {
        return h('span', { style: { height: '3px', borderRadius: '2px', background: color, flex: '0 0 ' + deltaPx + 'px' } })
      }
      function row(key, color) {
        return h('span', { key: key, style: { display: 'flex', gap: '2px', width: '100px' } },
          h('span', { style: green }),
          diff > 0 && key === 'local' ? tip('#d29922') : null,
          diff < 0 && key === 'remote' ? tip('#58a6ff') : null)
      }
      return h('span', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, row('local'), row('remote'))
    }

    /**
     * 会话级同步状态条：跟随当前会话，右对齐贴在 shell.bottom。
     * @param props - 槽位属性（含 model）。
     */
    function SessionSyncBar(props) {
      var state = useModel(props.model)
      var sessionId = useActiveSession()
      var viewPair = React.useState(null)
      var view = viewPair[0]
      var setView = viewPair[1]
      var busyPair = React.useState(false)
      var busy = busyPair[0]
      var setBusy = busyPair[1]
      var tickPair = React.useState(0)
      var tick = tickPair[0]
      var setTick = tickPair[1]
      var dialogPair = React.useState(null)
      var dialog = dialogPair[0]
      var setDialog = dialogPair[1]
      var collapsedPair = React.useState(function () {
        try { return localStorage.getItem('dssync.bar.collapsed') === '1' } catch (error) { return false }
      })
      var collapsed = collapsedPair[0]
      var setCollapsed = collapsedPair[1]
      var pushingRef = React.useRef(false)
      var detailPair = React.useState(false)
      var showDetail = detailPair[0]
      var setShowDetail = detailPair[1]

      /** 收起/展开底栏，记住选择。 */
      function toggleCollapsed() {
        try { localStorage.setItem('dssync.bar.collapsed', collapsed ? '0' : '1') } catch (error) { /* 忽略 */ }
        setCollapsed(!collapsed)
      }

      React.useEffect(function () {
        if (sessionId === '') {
          setView(null)
          return undefined
        }
        var cancelled = false
        function load() {
          fetchJson('/session-status?id=' + encodeURIComponent(sessionId)).then(function (value) {
            if (!cancelled) setView(value || null)
          }, function () {
            if (!cancelled) setView(null)
          })
        }
        load()
        // 单会话状态很便宜（宿主侧 2 秒缓存），轮询比多开一条 SSE 简单。
        var timer = setInterval(load, 2000)
        return function () {
          cancelled = true
          clearInterval(timer)
        }
      }, [sessionId, tick])

      /** 重新拉一次状态（动作完成后）。 */
      function reload() { setTick(tick + 1) }

      /**
       * 切换「上传本会话」；未绑定工作区时后端返回 needs-binding 交给弹窗。
       * @param choice - 绑定的 workspaceKey，或 'create' 按本地路径新建。
       */
      function scope(choice) {
        if (busy) return
        var enabled = !(view && view.upload === true)
        setBusy(true)
        var body = { sessionId: sessionId, enabled: enabled }
        if (choice !== undefined) body.choice = choice
        fetchJson('/session-scope', { method: 'POST', body: JSON.stringify(body) }).then(function (result) {
          setBusy(false)
          if (result && result.status === 'needs-binding') {
            setDialog(result)
            return
          }
          setDialog(result && result.status === 'error' ? result : null)
          reload()
        }, function (error) {
          setBusy(false)
          setDialog({ status: 'error', message: error && error.message ? String(error.message) : '写入失败' })
        })
      }

      /**
       * 「上传本会话」开关；未纳入同步时也要能打开，所以两个分支共用。
       * @param upload - 当前是否在白名单里。
       */
      function scopeSwitch(upload) {
        return h('span', {
          className: 'dssync-bar-scope',
          style: {
            display: 'flex', alignItems: 'center', gap: '7px', paddingLeft: '10px',
            borderLeft: '1px solid rgba(127,127,127,.22)', cursor: 'pointer',
          },
          onClick: function () { scope(undefined) },
          title: '上传本会话（等价于设置页的会话列表）',
        },
        h('span', { style: { fontSize: '11px', opacity: 0.7 } }, '上传本会话'),
        h('span', {
          style: {
            position: 'relative', width: '30px', height: '16px', borderRadius: '9px',
            background: upload ? '#3d6ff0' : 'rgba(127,127,127,.35)',
            transition: 'background .15s', flex: '0 0 auto',
          },
        }, h('span', {
          style: {
            position: 'absolute', top: '2px', left: upload ? '16px' : '2px',
            width: '12px', height: '12px', borderRadius: '6px', background: '#fff',
            transition: 'left .15s', boxShadow: '0 1px 2px rgba(0,0,0,.4)',
          },
        })))
      }

      // 官方 SSE（/status）是实时的：本轮任务的 doneEvents 直接覆盖轮询结果。
      // 起点在任务首次出现时记一次，避免把上一次轮询的滞后值当成真实起点。
      var runView = state.status && state.status.run ? state.status.run : null
      var runId = runView ? runView.id : 0
      var liveTask = sessionId === '' ? null : taskOf(state.status, sessionId)
      var baselineRef = React.useRef(null)
      React.useEffect(function () {
        if (sessionId === '') {
          baselineRef.current = null
          return
        }
        if (view === null || liveTask === null) return
        // 新页面挂载时模型里可能已经带着上一轮的完成任务：它没有可用起点，别记。
        if (liveTask.state === 'done') return
        var current = baselineRef.current
        if (current === null || current.runId !== runId || current.sessionId !== sessionId) {
          baselineRef.current = {
            runId: runId,
            sessionId: sessionId,
            local: typeof view.localLastSeq === 'number' ? view.localLastSeq : -1,
            remote: typeof view.remoteLastSeq === 'number' ? view.remoteLastSeq : -1,
          }
        }
      }, [runId, sessionId, liveTask === null, view === null])

      if (sessionId === '') return null
      var task = liveTask
      var running = task !== null && task.state !== 'done' && task.state !== 'failed'
        && task.state !== 'deferred' && task.state !== 'blocked'
      var leaseState = state.status && state.status.deviceLease ? state.status.deviceLease.state : null
      // 没有租约时推送会被宿主拒绝；这里提前置灰，别让用户白点。
      var leaseHeld = leaseState === null || leaseState === 'held'
      if (collapsed) {
        var collapsedAligned = view !== null && typeof view.localLastSeq === 'number'
          && typeof view.remoteLastSeq === 'number' && view.localLastSeq === view.remoteLastSeq
        return h('div', { className: 'dssync-bar', style: Object.assign({}, SYNC_BAR_STYLE.bar, { height: '18px', fontSize: '11px', gap: '6px' }) },
          h('span', { style: { cursor: 'pointer', opacity: 0.7 }, onClick: toggleCollapsed, title: '展开同步状态条' }, '▸'),
          h('span', {
            style: Object.assign({}, SYNC_BAR_STYLE.dot, {
              background: view === null
                ? '#8a8f98'
                : collapsedAligned
                  ? '#3fb950'
                  : (typeof view.localLastSeq === 'number' && typeof view.remoteLastSeq === 'number' && view.localLastSeq < view.remoteLastSeq)
                    ? '#58a6ff'
                    : '#d29922',
            }, running ? { animation: 'dssync-pulse 1.1s ease-in-out infinite' } : {}),
          }),
          h('span', { style: { opacity: 0.8 } }, view === null ? '未纳入上传' : running ? '同步中…' : collapsedAligned ? '已同步' : '未同步'),
          h('span', { style: SYNC_BAR_STYLE.id }, shortDisplaySessionId(sessionId)))
      }
      if (view === null) {
        return h('div', { className: 'dssync-bar', style: SYNC_BAR_STYLE.bar, title: '会话 ' + sessionId },
          h('span', { style: Object.assign({}, SYNC_BAR_STYLE.dot, { background: '#8a8f98' }) }),
          h('span', { style: SYNC_BAR_STYLE.label }, running ? '同步中…' : '未纳入上传'),
          h('span', { style: SYNC_BAR_STYLE.id }, shortDisplaySessionId(sessionId)),
          scopeSwitch(false))
      }
      var localLast = typeof view.localLastSeq === 'number' ? view.localLastSeq : -1
      var remoteLast = typeof view.remoteLastSeq === 'number' ? view.remoteLastSeq : -1
      // 官方 SSE 覆盖轮询：任务存在时，"起点 + 已完成"就是实时值（完成则用总数），
      // 跑完的瞬间就能对齐，不必等下一次 2 秒轮询。
      var liveDone = task !== null && typeof task.doneEvents === 'number' ? task.doneEvents : 0
      var baseline = baselineRef.current !== null
        && baselineRef.current.runId === runId
        && baselineRef.current.sessionId === sessionId
        ? baselineRef.current
        : null
      if (task !== null && baseline !== null) {
        // 轮询是否还停在起点：只有停在起点时，完成态才用 total 补一次；
        // 否则以轮询值为准，避免把同一批事件算两遍。
        var stale = view.localLastSeq === baseline.local && view.remoteLastSeq === baseline.remote
        if (task.state === 'done') {
          if (stale && typeof task.totalEvents === 'number') {
            if (task.direction === 'push') remoteLast = Math.max(remoteLast, baseline.remote + task.totalEvents)
            else localLast = Math.max(localLast, baseline.local + task.totalEvents)
          }
        } else if (task.direction === 'push') {
          remoteLast = Math.max(remoteLast, baseline.remote + liveDone)
        } else {
          localLast = Math.max(localLast, baseline.local + liveDone)
        }
      }
      var diff = localLast - remoteLast
      var blocked = typeof view.blocked === 'string' && view.blocked !== ''
      // 颜色只表达对齐状态：绿=一致 黄=本地领先 蓝=远端领先 红=分叉；
      // 运行中不抢颜色，用呼吸动画表达。
      var dot = blocked ? '#f85149' : diff === 0 ? '#3fb950' : diff > 0 ? '#d29922' : '#58a6ff'
      // 差值由 chip 表达，这里只留过程态（运行/分叉/已对齐）。
      var label = blocked
        ? '历史分叉'
        : running
          ? (task && task.direction === 'pull' ? '正在下载' : '正在上传')
            + ' ' + liveDone + '/' + (task && typeof task.totalEvents === 'number' ? task.totalEvents : '?')
          : diff === 0 ? '已同步' : ''
      var canPush = !blocked && !running && diff > 0
      /** 真正发起单会话推送。 */
      function pushNow() {
        // busy 是异步 state，同一帧里的第二次点击读到的还是 false。
        if (pushingRef.current) return
        pushingRef.current = true
        setBusy(true)
        fetchJson('/sync', {
          method: 'POST',
          body: JSON.stringify({ sessionId: sessionId, direction: 'push' }),
        }).then(function () {
          pushingRef.current = false
          setBusy(false)
          reload()
        }, function () {
          pushingRef.current = false
          setBusy(false)
        })
      }
      function push(event) {
        if (event) {
          event.preventDefault()
          event.stopPropagation()
        }
        if (busy || blocked || pushingRef.current) return
        if (!leaseHeld) {
          setDialog({ status: 'error', message: '全局同步租约被其他设备占用，稍后再试。' })
          return
        }
        // 会话正在生成（尾未闭合）时，推送只能到安全边界：先确认。
        if (view.tailOpen === true) {
          setDialog({ status: 'confirm', message: '会话正在运行，推送只会推到安全边界（约 ' + diff + ' 条）。继续？' })
          return
        }
        if (!canPush) return
        pushNow()
      }
      var pushDisabled = busy || blocked || !leaseHeld || (!canPush && !running)
      var pushStyle = blocked || !leaseHeld
        ? { background: 'rgba(248,81,73,.22)', color: '#ff9a92' }
        : running
          ? { background: 'rgba(248,81,73,.9)', color: '#fff' }
          : canPush ? SYNC_BAR_STYLE.primary : SYNC_BAR_STYLE.disabled
      var pushLabel = busy ? '推送中…' : running ? '同步中…' : '↑ 推送'
      var pushTitle = blocked ? (view.blocked || '历史分叉') : !leaseHeld ? '等待全局同步租约' : view.tailOpen === true ? '会话运行中，只推到安全边界' : running ? '本会话正在同步' : ''
      /** 详情：head 哈希、差异、租约等可核对字段。 */
      function detailRow(key, value) {
        return h('div', { key: key, style: { display: 'flex', justifyContent: 'space-between', gap: '10px' } },
          h('span', { style: { opacity: 0.6 } }, key),
          h('span', { style: { fontFamily: 'ui-monospace, monospace' } }, String(value)))
      }
      function detailCard() {
        return h('div', {
          style: {
            position: 'fixed', right: '14px', bottom: '40px', width: '300px', zIndex: 2147483000,
            padding: '10px 12px', borderRadius: '10px', background: 'var(--dsw-alias-bg-layer-1, #1b1b20)',
            border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.3))',
            boxShadow: '0 12px 32px rgba(0,0,0,.5)', fontSize: '11.5px', lineHeight: 1.6,
            color: 'var(--dsw-alias-label-primary, #e6e8ec)', whiteSpace: 'normal',
          },
        },
        h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '会话同步'),
        detailRow('会话', shortDisplaySessionId(sessionId)),
        detailRow('本地', localLast),
        detailRow('远端', remoteLast + ' · ' + (view.headChainHash ? String(view.headChainHash).slice(0, 8) : '-')),
        detailRow('差异', diff === 0 ? '一致' : diff > 0 ? '本地领先 ' + diff : '远端领先 ' + (-diff)),
        detailRow('格式', 'v' + (view.formatVersion === null ? '?' : view.formatVersion)),
        detailRow('租约', leaseState === null ? '未知' : leaseState === 'held' ? '已持有' : '被其他设备占用'),
        view.blocked ? detailRow('阻塞', view.blocked) : null)
      }
      return h('div', { className: 'dssync-bar', style: SYNC_BAR_STYLE.bar, title: blocked ? view.blocked : '会话 ' + sessionId },
        h('span', { style: Object.assign({}, SYNC_BAR_STYLE.dot, { background: dot }, running ? { animation: 'dssync-pulse 1.1s ease-in-out infinite' } : {}) }),
        h('span', { style: SYNC_BAR_STYLE.label }, label),
        h('span', { style: SYNC_BAR_STYLE.id }, shortDisplaySessionId(sessionId)),
        syncMeterRows(localLast, remoteLast),
        h('span', { style: SYNC_BAR_STYLE.nums },
          h('span', null, '本地 ' + localLast),
          h('span', null, '远端 ' + remoteLast)),
        h('span', {
          style: Object.assign({}, SYNC_BAR_STYLE.chip, {
            background: diff === 0 ? 'rgba(63,185,80,.16)' : diff > 0 ? 'rgba(210,153,34,.18)' : 'rgba(88,166,255,.18)',
            color: diff === 0 ? '#3fb950' : diff > 0 ? '#e0b143' : '#79b8ff',
          }),
        }, diff === 0 ? '一致' : diff > 0 ? '+' + diff : String(diff)),
        h('button', {
          type: 'button',
          disabled: pushDisabled,
          onClick: push,
          title: pushTitle,
          style: Object.assign({}, SYNC_BAR_STYLE.button, pushStyle),
        }, pushLabel),
        scopeSwitch(view.upload === true),
        h('button', {
          type: 'button',
          onClick: function () { setShowDetail(!showDetail) },
          style: Object.assign({}, SYNC_BAR_STYLE.button, { border: '1px solid rgba(127,127,127,.3)', background: 'transparent', color: 'inherit' }),
        }, '详情 ' + (showDetail ? '▾' : '▸')),
        h('span', { style: { cursor: 'pointer', opacity: 0.55, fontSize: '11px' }, onClick: toggleCollapsed, title: '收起底栏' }, '收起'),
        showDetail ? detailCard() : null,
        dialog === null ? null : h('div', {
          style: {
            position: 'fixed', right: '14px', bottom: '40px', width: '320px', zIndex: 2147483000,
            padding: '11px 12px', borderRadius: '10px', background: 'var(--dsw-alias-bg-layer-1, #1b1b20)',
            border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.3))',
            boxShadow: '0 12px 32px rgba(0,0,0,.5)', whiteSpace: 'normal', lineHeight: 1.5,
            fontSize: '12px', color: 'var(--dsw-alias-label-primary, #e6e8ec)',
          },
        }, dialog.status === 'needs-binding'
          ? h('div', null,
            h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '「' + dialog.path + '」还没绑定远程工作区'),
            h('div', { style: { opacity: 0.7, marginBottom: '8px' } },
              dialog.willCreateNew
                ? '远端还没有可用工作区：确认后会按本地路径新建一个。'
                : '选一个要绑定到的远程工作区：'),
            (dialog.candidates || []).map(function (candidate) {
              return h('button', {
                key: candidate.key,
                type: 'button',
                onClick: function () { scope(candidate.key) },
                style: {
                  display: 'block', width: '100%', marginBottom: '4px', height: '24px', borderRadius: '6px',
                  border: '1px solid rgba(127,127,127,.3)', background: 'transparent', color: 'inherit',
                  cursor: 'pointer', font: '11px/1 ui-sans-serif, system-ui',
                },
              }, candidate.label + ' · ' + candidate.sessions + ' 个会话')
            }),
            h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px' } },
              h('button', {
                type: 'button',
                onClick: function () { scope('create') },
                style: Object.assign({}, SYNC_BAR_STYLE.button, SYNC_BAR_STYLE.primary),
              }, '按本地路径新建'),
              h('button', {
                type: 'button',
                onClick: function () { setDialog(null) },
                style: Object.assign({}, SYNC_BAR_STYLE.button, { border: '1px solid rgba(127,127,127,.3)' }),
              }, '取消')))
          : dialog.status === 'confirm'
            ? h('div', null,
              h('div', { style: { marginBottom: '8px' } }, dialog.message),
              h('div', { style: { display: 'flex', gap: '6px' } },
                h('button', {
                  type: 'button',
                  onClick: function () { setDialog(null); pushNow() },
                  style: Object.assign({}, SYNC_BAR_STYLE.button, { background: 'rgba(248,81,73,.9)', color: '#fff' }),
                }, '继续推送'),
                h('button', {
                  type: 'button',
                  onClick: function () { setDialog(null) },
                  style: Object.assign({}, SYNC_BAR_STYLE.button, { border: '1px solid rgba(127,127,127,.3)' }),
                }, '取消')))
          : h('div', null,
            h('div', { style: { marginBottom: '8px' } }, dialog.message || '操作失败'),
            h('button', {
              type: 'button',
              onClick: function () { setDialog(null) },
              style: Object.assign({}, SYNC_BAR_STYLE.button, { border: '1px solid rgba(127,127,127,.3)' }),
            }, '关闭'))))
    }

    function SyncRowMark(props) {
      var state = useModel(props.model)
      var sessionId = props.sessionId ? String(props.sessionId) : ''
      if (sessionId === '') return null
      var sync = sessionState(state.status, sessionId)
      var task = sync.task
      if (task !== null && task !== undefined && task.state === 'done') return null
      if (task !== null && task !== undefined) {
        var taskLabel = task.state === 'checking' ? '正在校验'
          : task.state === 'failed' ? '同步失败'
            : task.state === 'blocked' ? '历史分叉，已阻止'
              : task.state === 'deferred' ? '同步等待中'
                : task.state === 'done' ? '已完成'
                  : stageLabel(task.stage) || (task.direction === 'push' ? '正在上传' : '正在下载')
        return h('span', {
          className: 'dssync-rowmark' + (task.state === 'blocked' ? ' tail' : ''),
          title: taskLabel, 'aria-label': taskLabel, role: 'img',
        }, task.state === 'blocked' ? '!' : task.direction === 'push' ? '↑' : '↓')
      }
      if (!sync.pending && !sync.tail && !sync.lag) return null
      var label = sync.pending ? '正在应用云端写入'
        : sync.tail ? '有未闭合的同步尾巴'
          : '安全边界落后于远端'
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
      var sync = sessionState(state.status, sessionId)
      var compressed = sync.compression === 'zstd' || sync.compression === 'mixed'
      var taskError = sync.task && sync.task.error ? sync.task.error : null
      var leaseNote = deviceLeaseBlockReason(state.status)
      if (reason === null && !compressed && taskError === null && leaseNote === null) return null
      return h('div', { className: 'dssync-hovernote' },
        reason === null ? null : h('div', null, '会话同步：', reason),
        taskError === null ? null : h('div', null, '同步任务：', taskError),
        leaseNote === null ? null : h('div', null, leaseNote),
        compressed ? h('div', null, '封帧压缩：' + (sync.compression === 'mixed' ? 'zstd 混合' : 'zstd')) : null)
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

      // 同步完成后让 DSH 客户端重新拉一次 session/list：拉取 attach 的会话、
      // 投影缓存里的标题和工作区分组才会进入已有窗口，而不需要用户手动刷新。
      var lastFinishedRunId = -1
      var lastSessionRefreshKey = ''
      function refreshSessionList() {
        try {
          if (!ctx.sessions || typeof ctx.sessions.refresh !== 'function') return
          var result = ctx.sessions.refresh()
          if (result && typeof result.catch === 'function') result.catch(function () {})
        } catch (error) {
          // 列表刷新失败不能影响同步状态界面。
        }
      }
      model.subscribe(function () {
        var status = model.getSnapshot().status
        if (!status || !status.run || status.run.state !== 'finished') return
        var sessions = Array.isArray(status.sessions) ? status.sessions : []
        var key = sessions.map(function (session) {
          var pull = session.pull || {}
          var push = session.push || {}
          return [session.sessionId, session.phase, pull.status || '', pull.applied || '', push.status || ''].join(':')
        }).join('|')
        if (status.run.id !== lastFinishedRunId || key !== lastSessionRefreshKey) {
          lastFinishedRunId = status.run.id
          lastSessionRefreshKey = key
          refreshSessionList()
        }
      })

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

      /**
       * 包一层 uiWorkspace.openSession，覆盖搜索结果/schedule/feedback 等没有
       * data-row-key 的入口。只做同步拦/放，不 await；探测/安装失败一律放行。
       */
      function installOpenGuard(workspace) {
        if (workspace === null || typeof workspace !== 'object'
          || typeof workspace.openSession !== 'function') return undefined
        var previous = workspace[OPEN_GUARD_MARK]
        if (previous && typeof previous.restore === 'function' && previous.wrapper === workspace.openSession) {
          try { previous.restore() } catch (error) { /* 旧 guard 清理失败不应阻塞新 guard */ }
        }
        var original = workspace.openSession
        var own = Object.prototype.hasOwnProperty.call(workspace, 'openSession')
        function uninstall() {
          try {
            if (workspace.openSession === wrapper) {
              if (own) workspace.openSession = original
              else delete workspace.openSession
            }
          } catch (error) { /* 恢复失败只影响 HMR，保持 fail-open */ }
          try {
            if (workspace[OPEN_GUARD_MARK] === guard) delete workspace[OPEN_GUARD_MARK]
          } catch (error) { /* 标记清理失败不影响运行 */ }
        }
        function wrapper(target) {
          var sessionId = sessionTargetId(target)
          if (sessionId !== null) {
            var reason = sessionBlockReason(model.getSnapshot().status, sessionId, true)
            if (reason !== null) {
              model.toast(reason, true)
              return undefined
            }
          }
          return original.apply(this, arguments)
        }
        var guard = { wrapper: wrapper, restore: uninstall }
        try {
          workspace.openSession = wrapper
          if (workspace.openSession !== wrapper) throw new Error('openSession 不可写')
          workspace[OPEN_GUARD_MARK] = guard
        } catch (error) {
          uninstall()
          console.warn('dsh-session-cloudsync: uiWorkspace.openSession guard 不可用，回退 DOM 拦截', error)
          return undefined
        }
        return function () {
          if (workspace[OPEN_GUARD_MARK] === guard) uninstall()
        }
      }

      function installOpenGuardFrom(scope) {
        var workspace = null
        try {
          workspace = typeof scope.get === 'function' ? scope.get('uiWorkspace') : scope.uiWorkspace
        } catch (error) {
          workspace = null
        }
        if (workspace === null || workspace === undefined) return
        var restore = installOpenGuard(workspace)
        if (restore === undefined) return
        if (typeof scope.effect === 'function') {
          scope.effect(function () { return restore }, 'dsh-session-cloudsync: openSession guard')
        }
      }

      if (typeof ctx.inject === 'function') {
        try { ctx.inject(['uiWorkspace'], installOpenGuardFrom) } catch (error) {
          console.warn('dsh-session-cloudsync: 无法探测 uiWorkspace，回退 DOM 拦截', error)
        }
      } else {
        installOpenGuardFrom(ctx)
      }

      ctx.slots.inject('conversation.input.dock', function* () {
        yield ctx.slots.register({
          name: 'conversation.input.dock', id: 'session-cloudsync-guard', order: 90,
          inject: function () { return { model: model, setBlock: setBlock } },
        }, SyncComposerGuard)
        // 会话作用域的发布器：底栏靠它知道当前会话。
        yield ctx.slots.register({
          name: 'conversation.input.dock', id: 'session-cloudsync-active-session', order: 95,
          inject: function () { return {} },
        }, SessionSyncTracker)
      })

      // 会话同步状态条：老版本 DSH 没有 shell.bottom 槽位时静默降级。
      try {
        ctx.slots.inject('shell.bottom', function* () {
          yield ctx.slots.register({
            name: 'shell.bottom', id: 'session-cloudsync-bar', order: 40,
            inject: function () { return { model: model } },
          }, SessionSyncBar)
        })
      } catch (error) {
        // 没有该槽位：不显示状态条，其余功能不受影响。
      }

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
              titleOf: sessionTitleOf,
            }
          },
        }, SyncSettingsPage)
      })

      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register({
          name: 'shell.overlay', id: 'dsh-session-cloudsync-onboarding', order: 20,
          inject: function () { return { model: model, setCredential: setCredential, writeSettings: writeSettings, titleOf: sessionTitleOf } },
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
