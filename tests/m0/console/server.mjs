#!/usr/bin/env node
// 隔离宿主控制台：状态 / 清理遗留 / 触发 ingest / 跑测试 / 起停实例。
//
// 只监听 127.0.0.1:3091，零依赖；清理范围严格限制在 <仓库>/.tmp/dev-dsh 内，
// 且只动 m0-* 工作区、m0-* 会话目录与 m0-* 工作区目录，不碰默认工作区。
import { spawn, execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const tempRoot = join(repoRoot, '.tmp', 'dev-dsh')
const tempHome = join(tempRoot, 'home')
const sessionsDir = join(tempHome, 'sessions')
const workspaceFile = join(tempHome, 'storages', 'workspace.json')
const profileFile = join(tempHome, 'profiles', 'web', 'package.json')
const CONSOLE_PORT = Number(process.env.M0_CONSOLE_PORT ?? '3091')
const HOST_PORT = 3090

let hostChild = null
let hostUrl = null
let hostOutput = []
let lastTest = { ok: null, code: null, output: '', ms: 0, at: null }

/** 写 JSON。 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 读 JSON 文件，失败返回 undefined。 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** 判断路径是否在临时目录内。 */
function insideTemp(path) {
  const resolved = resolve(path)
  return resolved === resolve(tempRoot) || resolved.startsWith(resolve(tempRoot) + sep)
}

/** 列一下 m0 相关的工作区与会话。 */
function inventory() {
  const state = readJson(workspaceFile)
  const workspaces = []
  if (state?.tables?.workspaces !== undefined) {
    for (const [id, value] of Object.entries(state.tables.workspaces)) {
      workspaces.push({ id, title: value.title, path: value.path, sessions: value.sessionIds?.length ?? 0 })
    }
  }
  let sessionDirs = []
  try {
    sessionDirs = readdirSync(sessionsDir).filter((name) => statSync(join(sessionsDir, name)).isDirectory())
  } catch {
    sessionDirs = []
  }
  const profile = readJson(profileFile)
  return {
    workspaces,
    sessionDirs,
    bundles: profile?.dsh?.profile?.bundles ?? [],
    e2eInstalled: existsSync(join(tempHome, 'profiles', 'web', 'node_modules', 'dsh-session-sync-m0-e2e')),
  }
}

/** 拉取一次控制台状态。 */
async function status() {
  let hostState = null
  try {
    const response = await fetch(`http://127.0.0.1:${HOST_PORT}/m0/state`, { signal: AbortSignal.timeout(800) })
    if (response.ok) hostState = await response.json()
  } catch {
    hostState = null
  }
  return {
    host: {
      up: hostState !== null,
      child: hostChild !== null && hostChild.exitCode === null,
      url: hostUrl,
      state: hostState,
    },
    inventory: inventory(),
    test: lastTest,
    logs: hostOutput.slice(-40),
  }
}

/** 清理 m0 遗留：工作区登记、会话目录、工作区目录。 */
function clean() {
  const removed = { workspaces: 0, sessionDirs: [], workspaceDirs: [], skipped: [] }
  const state = readJson(workspaceFile)
  if (state?.tables?.workspaces !== undefined) {
    const drop = new Set()
    for (const [id, value] of Object.entries(state.tables.workspaces)) {
      const isM0 = String(value.path ?? '').includes(`${sep}home${sep}m0-`) || /^M0/.test(String(value.title ?? ''))
      if (isM0) drop.add(id)
    }
    state.global.workspaceIds = (state.global.workspaceIds ?? []).filter((id) => !drop.has(id))
    for (const id of drop) delete state.tables.workspaces[id]
    writeFileSync(workspaceFile, `${JSON.stringify(state, null, 2)}\n`)
    removed.workspaces = drop.size
  }
  try {
    for (const name of readdirSync(sessionsDir)) {
      if (!/home-m0-/.test(name)) continue
      const path = join(sessionsDir, name)
      if (!insideTemp(path)) {
        removed.skipped.push(path)
        continue
      }
      rmSync(path, { recursive: true, force: true })
      removed.sessionDirs.push(name)
    }
  } catch {
    // 没有会话目录就跳过。
  }
  try {
    for (const name of readdirSync(tempHome)) {
      if (!/^m0-/.test(name)) continue
      const path = join(tempHome, name)
      if (!insideTemp(path)) {
        removed.skipped.push(path)
        continue
      }
      rmSync(path, { recursive: true, force: true })
      removed.workspaceDirs.push(name)
    }
  } catch {
    // 没有临时 home 就跳过。
  }
  return removed
}

/** 触发一次 ingest（要求宿主在跑）。 */
async function ingest(query) {
  const params = new URLSearchParams({ warm: '1', ...query })
  const response = await fetch(`http://127.0.0.1:${HOST_PORT}/m0/ingest?${params.toString()}`, { signal: AbortSignal.timeout(30000) })
  return { status: response.status, body: await response.json() }
}

/** 起隔离宿主。 */
function startHost() {
  if (hostChild !== null && hostChild.exitCode === null) return { started: false, reason: '已在运行' }
  hostOutput = []
  hostChild = spawn(process.execPath, ['scripts/dev-dsh.mjs', '--port', String(HOST_PORT)], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const onData = (chunk) => {
    const text = chunk.toString()
    hostOutput.push(text)
    if (hostOutput.length > 200) hostOutput.shift()
    const match = /token=([\w-]+)/.exec(text)
    if (match !== null) hostUrl = `http://127.0.0.1:${HOST_PORT}/?token=${match[1]}`
  }
  hostChild.stdout.on('data', onData)
  hostChild.stderr.on('data', onData)
  hostChild.on('exit', () => {
    hostChild = null
    hostUrl = null
  })
  return { started: true }
}

/** 停隔离宿主。 */
function stopHost() {
  if (hostChild === null) return { stopped: false, reason: '未在运行（可能由外部启动）' }
  const pid = hostChild.pid
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {})
  else hostChild.kill('SIGTERM')
  hostChild = null
  hostUrl = null
  return { stopped: true }
}

/** 跑 pnpm run check，记录结果。 */
function runTests() {
  const started = Date.now()
  return new Promise((resolvePromise) => {
    const child = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['run', 'check'], {
      cwd: repoRoot,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const collect = (chunk) => {
      output += chunk.toString()
      if (output.length > 200_000) output = output.slice(-200_000)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('exit', (code) => {
      lastTest = { ok: code === 0, code, output, ms: Date.now() - started, at: new Date().toISOString() }
      resolvePromise(lastTest)
    })
    child.on('error', (error) => {
      lastTest = { ok: false, code: null, output: String(error), ms: Date.now() - started, at: new Date().toISOString() }
      resolvePromise(lastTest)
    })
  })
}

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>M0 控制台</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 24px; background: #14161a; color: #e6e8eb; font: 14px/1.6 "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 18px; margin: 0 0 16px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; max-width: 1100px; }
  .card { background: #1c1f24; border: 1px solid #2a2f36; border-radius: 10px; padding: 16px; }
  .card h2 { font-size: 14px; margin: 0 0 10px; color: #9aa4b2; font-weight: 600; }
  button { background: #2d6cdf; color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; margin: 0 8px 8px 0; cursor: pointer; font: inherit; }
  button.secondary { background: #333a44; }
  button.danger { background: #b4453c; }
  button:disabled { opacity: .5; cursor: default; }
  pre { background: #0f1115; border-radius: 8px; padding: 12px; max-height: 260px; overflow: auto; font-size: 12px; white-space: pre-wrap; }
  .ok { color: #58c98a; } .bad { color: #e06c75; } .muted { color: #7d8694; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; }
  code { color: #8ab4f8; }
</style>
</head>
<body>
<h1>M0 控制台 <span class="muted" id="hostBadge"></span></h1>
<div class="grid">
  <div class="card">
    <h2>隔离宿主</h2>
    <div class="row">
      <button id="start">启动宿主</button>
      <button id="stop" class="secondary">停止宿主</button>
      <button id="ingest">触发 ingest</button>
      <button id="openHost" class="secondary">打开宿主页面</button>
    </div>
    <label class="muted" style="display:inline-flex;align-items:center;gap:6px;margin:4px 0 8px">
      <input type="checkbox" id="autoOpen" checked> 启动后自动打开宿主页面
    </label>
    <div id="hostInfo" class="muted"></div>
    <pre id="hostLog"></pre>
  </div>
  <div class="card">
    <h2>状态</h2>
    <div id="state"></div>
    <pre id="testLog"></pre>
  </div>
  <div class="card">
    <h2>清理遗留</h2>
    <p class="muted">只清理 m0-* 工作区、会话目录与工作区目录，默认工作区不动。</p>
    <button id="clean" class="danger">清理 m0 遗留</button>
    <button id="refresh" class="secondary">刷新状态</button>
    <pre id="cleanLog"></pre>
  </div>
  <div class="card">
    <h2>测试</h2>
    <button id="test">运行 pnpm check</button>
    <span id="testBadge"></span>
    <pre id="testOut"></pre>
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id)
const autoOpen = $('autoOpen')
autoOpen.checked = localStorage.getItem('m0.autoOpen') !== '0'
autoOpen.onchange = () => localStorage.setItem('m0.autoOpen', autoOpen.checked ? '1' : '0')
let lastUrl = null
async function call(path, options) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options })
  return response.json()
}
async function waitForUrl(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await call('/api/status')
    if (state.host.url) return state.host.url
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return null
}
async function refresh() {
  const state = await call('/api/status')
  lastUrl = state.host.url ?? lastUrl
  $('hostBadge').textContent = state.host.up ? '宿主运行中' : '宿主未运行'
  $('hostInfo').textContent = state.host.url ?? '（未启动）'
  $('hostLog').textContent = (state.logs ?? []).join('')
  const inv = state.inventory
  $('state').innerHTML = [
    '工作区：' + inv.workspaces.map((w) => w.title + '（' + w.sessions + ' 会话）').join('、'),
    '会话目录：' + inv.sessionDirs.length,
    '实验 bundle：' + (inv.e2eInstalled ? '已安装' : '未安装'),
    'bundles：' + inv.bundles.join('、'),
    '宿主 state：' + JSON.stringify(state.host.state ?? null),
  ].map((line) => '<div>' + line + '</div>').join('')
  if (state.test.at) {
    $('testBadge').textContent = state.test.ok ? '通过（' + state.test.ms + 'ms）' : '失败（exit ' + state.test.code + '）'
    $('testBadge').className = state.test.ok ? 'ok' : 'bad'
    $('testOut').textContent = state.test.output
  }
}
$('start').onclick = async () => {
  $('hostLog').textContent = '启动中…'
  await call('/api/host/start', { method: 'POST' })
  const url = await waitForUrl(30000)
  if (url) {
    $('hostLog').textContent = '宿主已就绪：' + url
    if (autoOpen.checked) {
      // 启动完成后再开；若浏览器把异步 window.open 拦了，退化成可点链接。
      const opened = window.open(url, '_blank')
      if (opened === null) {
        $('hostLog').innerHTML = '宿主已就绪：<a href="' + url + '" target="_blank" rel="noreferrer">点这里打开宿主页面</a>（浏览器拦截了新窗口）'
      }
    }
  } else {
    $('hostLog').textContent = '启动超时，点“刷新状态”查看'
  }
  refresh()
}
$('openHost').onclick = async () => { const url = (await call('/api/status')).host.url ?? lastUrl; if (url) window.open(url, '_blank'); else alert('宿主未运行') }
$('stop').onclick = async () => { await call('/api/host/stop', { method: 'POST' }); setTimeout(refresh, 1000) }
$('ingest').onclick = async () => { $('hostLog').textContent = JSON.stringify(await call('/api/ingest', { method: 'POST' }), null, 2) }
$('clean').onclick = async () => { $('cleanLog').textContent = JSON.stringify(await call('/api/clean', { method: 'POST' }), null, 2); refresh() }
$('refresh').onclick = refresh
$('test').onclick = async () => { $('testOut').textContent = '运行中…'; $('testBadge').textContent = ''; const result = await call('/api/test', { method: 'POST' }); $('testOut').textContent = result.output; $('testBadge').textContent = result.ok ? '通过（' + result.ms + 'ms）' : '失败（exit ' + result.code + '）'; $('testBadge').className = result.ok ? 'ok' : 'bad' }
refresh()
setInterval(refresh, 2000)
</script>
</body>
</html>`

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${CONSOLE_PORT}`)
  try {
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE)
      return
    }
    if (url.pathname === '/api/status' && req.method === 'GET') {
      sendJson(res, 200, await status())
      return
    }
    if (url.pathname === '/api/clean' && req.method === 'POST') {
      sendJson(res, 200, clean())
      return
    }
    if (url.pathname === '/api/ingest' && req.method === 'POST') {
      const body = await new Promise((resolveBody) => {
        let text = ''
        req.on('data', (chunk) => { text += chunk })
        req.on('end', () => resolveBody(text))
      })
      const query = body.length > 0 ? JSON.parse(body) : {}
      sendJson(res, 200, await ingest(query))
      return
    }
    if (url.pathname === '/api/host/start' && req.method === 'POST') {
      sendJson(res, 200, startHost())
      return
    }
    if (url.pathname === '/api/host/stop' && req.method === 'POST') {
      sendJson(res, 200, stopHost())
      return
    }
    if (url.pathname === '/api/test' && req.method === 'POST') {
      sendJson(res, 200, await runTests())
      return
    }
    sendJson(res, 404, { error: 'not found' })
  } catch (error) {
    sendJson(res, 500, { error: error?.message ?? String(error) })
  }
})

server.listen(CONSOLE_PORT, '127.0.0.1', () => {
  console.log(`M0 控制台：http://127.0.0.1:${CONSOLE_PORT}/`)
  console.log(`仓库：${repoRoot}`)
  console.log(`临时 home：${tempHome}`)
})
