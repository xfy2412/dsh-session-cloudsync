#!/usr/bin/env node
/**
 * DSH 双实例开发控制台。
 *
 * 页面：上方左右两个 iframe（A/B 两套独立 DSH），下方左右两个日志控制台。
 * 服务端：
 *   - 用独立 DSH_HOME 启动两套临时实例；
 *   - 捕获两个实例的 stdout/stderr；
 *   - 提供 /api/log/:side 接收插件 debug sink 的结构化日志；
 *   - 通过 SSE 把日志推给页面。
 *
 * 只绑定 127.0.0.1；所有实例目录都在 <repo>/.tmp/dev-console/ 内。
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const tempRoot = join(repoRoot, '.tmp', 'dev-console')
const pluginDir = join(repoRoot, 'packages', 'plugin')
const pluginBuild = join(pluginDir, 'scripts', 'build.mjs')
const serverEntry = join(repoRoot, 'packages', 'server', 'src', 'index.ts')
const devDsh = join(repoRoot, 'scripts', 'dev-dsh.mjs')
const pageFile = join(here, 'index.html')
const consolePort = Number(process.env.DEV_CONSOLE_PORT ?? '3092')
const sidePorts = {
  a: Number(process.env.DEV_CONSOLE_A_PORT ?? '3090'),
  b: Number(process.env.DEV_CONSOLE_B_PORT ?? '3091'),
}
const bindHost = '127.0.0.1'
const MAX_LOGS = 3000
const MAX_LOG_CHARS = 32_000
const credentials = process.env.DEV_CONSOLE_CREDENTIALS === undefined
  ? undefined
  : resolve(process.env.DEV_CONSOLE_CREDENTIALS)

const syncDataDir = join(tempRoot, 'sync-data')
const syncCredentialsFile = join(tempRoot, 'sync-credentials.json')
const benchTracePath = process.env.DEV_CONSOLE_TRACE?.trim()
  ? resolve(process.env.DEV_CONSOLE_TRACE)
  : join(repoRoot, 'tests', 'fixtures', 'shapes', 'b0e-69587.trace.json')
const syncPort = Number(process.env.DEV_CONSOLE_SYNC_PORT ?? '8787')
const syncUrl = (process.env.DEV_CONSOLE_SYNC_SERVER?.trim() || `http://${bindHost}:${syncPort}`)
  .replace(/\/+$/u, '')
const syncMode = process.env.DEV_CONSOLE_SYNC === 'off'
  ? 'off'
  : process.env.DEV_CONSOLE_SYNC_SERVER?.trim() ? 'external' : 'local'
const envSyncTokens = {
  a: process.env.DEV_CONSOLE_SYNC_TOKEN_A?.trim() ?? '',
  b: process.env.DEV_CONSOLE_SYNC_TOKEN_B?.trim() ?? '',
}
const envSyncPassphrase = process.env.DEV_CONSOLE_SYNC_PASSPHRASE?.trim() ?? ''

/** 同步服务端状态；token/passphrase 只留在闭包与 0600 临时文件里，不进 /api/state。 */
const sync = {
  mode: syncMode,
  url: syncUrl,
  status: syncMode === 'off' ? 'off' : 'idle',
  ready: false,
  error: null,
  child: null,
  credentials: undefined,
  prepare: null,
  patch: undefined,
  buffers: { stdout: '', stderr: '' },
  stopping: false,
}

/** ANSI 颜色序列；控制台里不需要。 */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g

/** @type {Map<string, ReturnType<typeof makeSide>>} */
const sides = new Map()

let buildPromise

/**
 * 造一侧的运行状态。
 * @param {'a'|'b'} id - 侧标识。
 * @param {string} label - 显示名。
 * @param {number} port - DSH 端口。
 */
function makeSide(id, label, port) {
  return {
    id,
    label,
    port,
    home: join(tempRoot, id, 'home'),
    documents: join(tempRoot, id, 'documents'),
    child: null,
    url: null,
    status: 'idle',
    setup: 'unknown',
    lastError: null,
    logs: [],
    nextLogId: 1,
    clients: new Set(),
    buffers: { stdout: '', stderr: '' },
    preparing: null,
    stopping: false,
    tokenTimer: null,
  }
}

sides.set('a', makeSide('a', 'A', sidePorts.a))
sides.set('b', makeSide('b', 'B', sidePorts.b))

/** 写 JSON 响应。 */
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** 读一个小 JSON 请求体。 */
async function readBody(req, limit = 256 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error(`请求体超过 ${limit} 字节`)
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** 读 JSON 文件，失败返回 undefined。 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** 判断 DSH profile 是否已安装并启用本插件。 */
function pluginInstalled(side) {
  const profile = readJson(join(side.home, 'profiles', 'web', 'package.json'))
  const dependency = profile?.dependencies?.['dsh-session-cloudsync'] !== undefined
  const bundles = Array.isArray(profile?.dsh?.profile?.bundles) ? profile.dsh.profile.bundles : []
  return dependency && bundles.includes('dsh-session-cloudsync')
}

/** 是否已构建。 */
function pluginBuilt() {
  return existsSync(join(pluginDir, 'lib', 'index.js'))
}

/** 去掉 ANSI，统一换行。 */
function clean(text) {
  return String(text).replace(ANSI, '').replace(/\r/g, '')
}

/** 从 host 输出推测级别。 */
function levelOf(text) {
  if (/\b(error|fatal|exception|unhandled|failed|失败)\b/iu.test(text)) return 'error'
  if (/\b(warn|warning|警告)\b/iu.test(text)) return 'warn'
  return 'info'
}

/** SSE 发一帧。 */
function sse(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  } catch {
    // 断开的连接由 close 清理。
  }
}

/**
 * 追加一条日志并广播。
 * @param {ReturnType<typeof makeSide>} side - 侧。
 * @param {'info'|'warn'|'error'} level - 级别。
 * @param {string} message - 文本。
 * @param {string} source - 来源标签。
 */
function appendLog(side, level, message, source = 'host') {
  const text = clean(message).trimEnd()
  if (text === '') return
  const entry = {
    id: side.nextLogId++,
    time: Date.now(),
    level,
    source,
    message: text.length > MAX_LOG_CHARS ? `${text.slice(0, MAX_LOG_CHARS)}…` : text,
  }
  side.logs.push(entry)
  if (side.logs.length > MAX_LOGS) side.logs.splice(0, side.logs.length - MAX_LOGS)
  for (const client of side.clients) sse(client, 'log', entry)
}

/**
 * 跑一个命令并捕获输出；用于 token 签发等不能回显到控制台的敏感命令。
 * @param {string} command - 可执行文件。
 * @param {string[]} args - 参数。
 * @param {NodeJS.ProcessEnv} env - 环境。
 * @param {number} timeoutMs - 超时。
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function capture(command, args, env = { ...process.env }, timeoutMs = 30_000) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    }
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', () => finish(-1))
    child.on('close', (code) => finish(code ?? -1))
    timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(-1)
    }, timeoutMs)
    timer.unref?.()
  })
}

/** 查服务端健康状态；不可达返回 undefined。 */
async function checkHealth(url) {
  try {
    const response = await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) return undefined
    const body = await response.json()
    return body?.ok === true ? body : undefined
  } catch {
    return undefined
  }
}

/** 服务端日志脱敏：初始化密钥和 Bearer 不进入面板。 */
function redactServerLine(text) {
  return clean(text)
    .replace(/(初始化密钥[:：]\s*)\S+/gu, '$1<redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gu, '$1<redacted>')
}

/** 把服务端输出写到两侧控制台。 */
function appendServerChunk(stream, chunk) {
  const input = sync.buffers[stream] + chunk.toString('utf8')
  const lines = input.split('\n')
  sync.buffers[stream] = lines.pop() ?? ''
  for (const line of lines) {
    const text = redactServerLine(line)
    if (text.trim() === '') continue
    for (const side of sides.values()) appendLog(side, levelOf(text), text, `sync-server:${stream}`)
  }
}

/** 读同步凭据文件；不存在或版本不对返回 undefined。 */
function readSyncCredentials() {
  const value = readJson(syncCredentialsFile)
  return value?.version === 1 ? value : undefined
}

/** 原子写同步凭据（0600；Windows 上 chmod 可能被忽略）。 */
function writeSyncCredentials(value) {
  mkdirSync(dirname(syncCredentialsFile), { recursive: true })
  writeFileSync(syncCredentialsFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(syncCredentialsFile, 0o600)
  } catch {
    // Windows 可能不支持 chmod。
  }
}

/** 给一个临时实例签发设备 token；输出不写日志。 */
async function mintSyncToken(label) {
  const result = await capture(process.execPath, [
    serverEntry, 'token', 'add', label, '--data-dir', syncDataDir,
  ])
  if (result.code !== 0) throw new Error(`签发设备 token 失败（exit ${String(result.code)}）`)
  let parsed
  try {
    parsed = JSON.parse(result.stdout.trim())
  } catch {
    throw new Error('签发设备 token 的输出不是 JSON')
  }
  if (typeof parsed?.token !== 'string' || parsed.token === '') throw new Error('签发设备 token 没有返回 token')
  return {
    token: parsed.token,
    deviceId: typeof parsed?.device?.deviceId === 'string' ? parsed.device.deviceId : undefined,
  }
}

/** 本地模式：确保 A/B 各有设备 token 和共享口令。 */
async function ensureSyncCredentials() {
  mkdirSync(syncDataDir, { recursive: true })
  const dbExists = existsSync(join(syncDataDir, 'db.sqlite'))
  let current = readSyncCredentials()
  if (current === undefined || !dbExists) {
    current = { version: 1, serverUrl: syncUrl, passphrase: '', tokens: {} }
  }
  if (!current.tokens || typeof current.tokens !== 'object') current.tokens = {}
  current.serverUrl = syncUrl
  if (envSyncPassphrase !== '') current.passphrase = envSyncPassphrase
  if (typeof current.passphrase !== 'string' || current.passphrase === '') {
    current.passphrase = randomBytes(24).toString('base64url')
  }
  for (const side of sides.values()) {
    const envToken = envSyncTokens[side.id]
    if (envToken !== '') {
      current.tokens[side.id] = { token: envToken, deviceId: 'external' }
      continue
    }
    if (typeof current.tokens[side.id]?.token !== 'string' || current.tokens[side.id].token === '') {
      const minted = await mintSyncToken(`console-${side.id}`)
      current.tokens[side.id] = minted
    }
  }
  writeSyncCredentials(current)
  sync.credentials = current
  return current
}

/** 外部模式：token/passphrase 必须由环境提供，不落盘。 */
function externalSyncCredentials() {
  if (envSyncPassphrase === '') throw new Error('外部同步服务端需要 DEV_CONSOLE_SYNC_PASSPHRASE')
  for (const side of sides.values()) {
    if (envSyncTokens[side.id] === '') {
      throw new Error(`外部同步服务端需要 DEV_CONSOLE_SYNC_TOKEN_${side.id.toUpperCase()}`)
    }
  }
  return {
    version: 1,
    serverUrl: syncUrl,
    passphrase: envSyncPassphrase,
    tokens: {
      a: { token: envSyncTokens.a, deviceId: 'external' },
      b: { token: envSyncTokens.b, deviceId: 'external' },
    },
  }
}

/** 等服务端健康检查通过。 */
async function waitForSyncHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await checkHealth(syncUrl) !== undefined) return
    await new Promise((resolvePromise) => {
      const timer = setTimeout(resolvePromise, 250)
      timer.unref?.()
    })
  }
  throw new Error(`同步服务端在 10s 内没有通过 /v1/health：${syncUrl}`)
}

/** 启动本地同步服务端。 */
function startSyncServer() {
  const child = spawn(process.execPath, [
    serverEntry, 'serve',
    '--data-dir', syncDataDir,
    '--host', bindHost,
    '--port', String(syncPort),
  ], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  sync.child = child
  child.stdout.on('data', (chunk) => appendServerChunk('stdout', chunk))
  child.stderr.on('data', (chunk) => appendServerChunk('stderr', chunk))
  child.on('error', (error) => {
    sync.error = error.message
    sync.status = 'error'
    sync.ready = false
  })
  child.on('close', (code) => {
    for (const stream of ['stdout', 'stderr']) {
      if (sync.buffers[stream] !== '') appendServerChunk(stream, '\n')
    }
    const wasStopping = sync.stopping
    sync.stopping = false
    sync.child = null
    sync.ready = false
    if (wasStopping) {
      sync.status = 'idle'
      return
    }
    sync.status = 'error'
    if (sync.error === null) sync.error = `同步服务端退出（code ${String(code)}）`
    for (const side of sides.values()) {
      appendLog(side, 'error', sync.error, 'sync-server')
    }
  })
  return child
}

/** 确保同步服务端与凭据就绪；prepare 和 start 共用。 */
async function ensureSync() {
  if (sync.mode === 'off') {
    sync.status = 'off'
    sync.ready = false
    return
  }
  if (sync.ready) return
  if (sync.prepare !== null) return sync.prepare
  sync.prepare = (async () => {
    sync.status = 'starting'
    sync.error = null
    const existing = await checkHealth(syncUrl)
    if (sync.mode === 'external') {
      sync.credentials = externalSyncCredentials()
      if (existing === undefined) throw new Error(`外部同步服务端不可达：${syncUrl}`)
      sync.ready = true
      sync.status = 'external'
      return
    }
    if (existing !== undefined && sync.child === null) {
      throw new Error(
        `端口 ${syncPort} 已有其他同步服务端；请停止它，或设置 DEV_CONSOLE_SYNC_SERVER、`
        + 'DEV_CONSOLE_SYNC_TOKEN_A/B、DEV_CONSOLE_SYNC_PASSPHRASE 指向它',
      )
    }
    await ensureSyncCredentials()
    if (existing === undefined) {
      startSyncServer()
      await waitForSyncHealth()
    }
    sync.ready = true
    sync.status = 'local'
  })().catch((error) => {
    sync.ready = false
    sync.status = 'error'
    sync.error = error instanceof Error ? error.message : String(error)
    for (const side of sides.values()) appendLog(side, 'error', sync.error, 'sync-server')
    throw error
  }).finally(() => {
    sync.prepare = null
  })
  return sync.prepare
}

/** 停本地同步服务端。 */
async function stopSyncServer() {
  const child = sync.child
  if (child === null) {
    sync.ready = false
    sync.status = sync.mode === 'off' ? 'off' : 'idle'
    return
  }
  sync.stopping = true
  sync.ready = false
  if (process.platform === 'win32') {
    await new Promise((resolvePromise) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      killer.on('close', () => resolvePromise())
      killer.on('error', () => resolvePromise())
    })
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
  sync.child = null
  sync.ready = false
  sync.status = 'idle'
}


/** 判断路径在控制台临时根内。 */
function insideTempRoot(path) {
  const resolved = resolve(path)
  const root = resolve(tempRoot)
  return resolved !== root && resolved.startsWith(`${root}${sep}`)
}

/** 清空一侧日志并通知 SSE 客户端。 */
function clearSideLogs(side) {
  side.logs = []
  side.nextLogId = 1
  for (const client of side.clients) sse(client, 'clear', {})
}

/** 清理选中的 DSH 数据和/或本地同步服务端。 */
async function cleanData(request) {
  const selected = Array.isArray(request?.sides)
    ? request.sides.filter((id) => id === 'a' || id === 'b')
    : []
  const cleanServer = request?.server === true
  if (selected.length === 0 && !cleanServer) throw new Error('没有选择要清理的数据')

  const removed = { sides: [], server: false }
  for (const id of selected) {
    const side = sides.get(id)
    if (side === undefined) continue
    await stopSide(side)
    const dir = join(tempRoot, id)
    if (!insideTempRoot(dir)) throw new Error(`拒绝清理临时目录之外的路径：${dir}`)
    rmSync(dir, { recursive: true, force: true })
    side.home = join(tempRoot, id, 'home')
    side.documents = join(tempRoot, id, 'documents')
    side.url = null
    side.status = 'idle'
    side.setup = 'unknown'
    side.lastError = null
    side.buffers = { stdout: '', stderr: '' }
    side.tokenSince = 0
    clearSideLogs(side)
    removed.sides.push(id)
  }

  if (cleanServer) {
    if (sync.mode !== 'local') throw new Error('外部同步服务端不能由控制台清理')
    await stopSyncServer()
    for (const side of sides.values()) await stopSide(side)
    if (!insideTempRoot(syncDataDir)) throw new Error(`拒绝清理临时目录之外的路径：${syncDataDir}`)
    rmSync(syncDataDir, { recursive: true, force: true })
    if (!insideTempRoot(syncCredentialsFile)) throw new Error(`拒绝清理临时目录之外的路径：${syncCredentialsFile}`)
    rmSync(syncCredentialsFile, { force: true })
    sync.credentials = undefined
    sync.ready = false
    sync.error = null
    sync.status = 'idle'
    sync.buffers = { stdout: '', stderr: '' }
    removed.server = true
  }
  return removed
}

/** 重新应用预配置：确保服务端/凭据，再重启正在运行的实例。 */
async function restorePreconfigured(restart = true) {
  if (sync.mode === 'off') throw new Error('同步预配置已关闭（DEV_CONSOLE_SYNC=off）')
  await ensureSync()
  const restarted = []
  if (!restart) return { sync: state().sync, restarted }
  for (const side of sides.values()) {
    const wasRunning = side.child !== null && side.child.exitCode === null
    if (!wasRunning) continue
    await stopSide(side)
    await startSide(side)
    restarted.push(side.id)
  }
  return { sync: state().sync, restarted }
}

/** 把形状轨迹生成的大会话导入选中的临时实例。 */
async function importLargeSession(request) {
  if (!existsSync(benchTracePath)) {
    throw new Error(`找不到大会话形状轨迹：${benchTracePath}（可用 pnpm bench:trace 生成）`)
  }
  const selected = Array.isArray(request?.sides)
    ? request.sides.filter((id) => id === 'a' || id === 'b')
    : []
  if (selected.length === 0) throw new Error('没有选择要导入的实例')
  const trace = JSON.parse(readFileSync(benchTracePath, 'utf8'))
  const { importBenchSession } = await import('../../tests/tools/import-bench-session.ts')
  const imported = []
  for (const id of selected) {
    const side = sides.get(id)
    if (side === undefined) continue
    const wasRunning = side.child !== null && side.child.exitCode === null
    if (wasRunning) await stopSide(side)
    try {
      await prepareSide(side)
      const cwd = join(side.documents, 'deepseek-harness', 'default-workspace')
      const result = importBenchSession({
        trace,
        home: side.home,
        cwd,
        id: 'session-bench-shape',
      })
      appendLog(
        side,
        'info',
        `已导入大会话 ${result.sessionId}（${(result.bytes / 1_048_576).toFixed(1)} MB）到 ${cwd}`,
        'bench',
      )
      imported.push({ side: id, sessionId: result.sessionId, bytes: result.bytes, restarted: wasRunning })
      if (wasRunning) await startSide(side)
    } catch (error) {
      if (wasRunning) await startSide(side).catch(() => {})
      throw error
    }
  }
  return { imported }
}

/** 追加一个 host 子进程的数据块，按行切分。 */
function appendHostChunk(side, stream, chunk) {
  const input = side.buffers[stream] + chunk.toString('utf8')
  const lines = input.split('\n')
  side.buffers[stream] = lines.pop() ?? ''
  for (const line of lines) {
    const text = clean(line)
    if (text.trim() !== '') appendLog(side, levelOf(text), text, `host:${stream}`)
  }
}

/** 清理 DSH 嵌套环境变量，并注入本侧同步预配置。 */
function cleanDshEnv(side) {
  const env = { ...process.env, DSH_HOME: side.home }
  for (const key of ['DSH_SESSION_ID', 'DSH_SHELL', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_WEB_URL']) delete env[key]
  env.DSH_SESSION_CLOUDSYNC_DEV_LOG = `http://${bindHost}:${consolePort}/api/log/${side.id}`
  if (sync.ready && sync.credentials !== undefined) {
    const credential = sync.credentials.tokens[side.id]
    if (credential !== undefined) {
      env.DSH_SESSION_CLOUDSYNC_SERVER_URL = sync.url
      env.DSH_SESSION_CLOUDSYNC_TOKEN = credential.token
      env.DSH_SESSION_CLOUDSYNC_PASSPHRASE = sync.credentials.passphrase
      env.DSH_SESSION_CLOUDSYNC_DEVICE_NAME = `console-${side.id}`
    }
  } else {
    for (const key of [
      'DSH_SESSION_CLOUDSYNC_SERVER_URL',
      'DSH_SESSION_CLOUDSYNC_TOKEN',
      'DSH_SESSION_CLOUDSYNC_PASSPHRASE',
      'DSH_SESSION_CLOUDSYNC_DEVICE_NAME',
    ]) delete env[key]
  }
  return env
}

/** Windows cmd 最小引号处理。 */
function quoteCmd(value) {
  return /[\s"]/u.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

/**
 * 跑一个子进程并把输出写进对应控制台。
 * @param {ReturnType<typeof makeSide>} side - 侧。
 * @param {string} command - 可执行文件。
 * @param {string[]} args - 参数。
 * @param {NodeJS.ProcessEnv} env - 环境。
 * @param {number} timeoutMs - 超时。
 * @returns {Promise<number>} 退出码。
 */
function runProcess(side, command, args, env, timeoutMs = 180_000) {
  return new Promise((resolvePromise) => {
    appendLog(side, 'info', `$ ${command} ${args.join(' ')}`, 'setup')
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(code)
    }
    const collect = (stream) => (chunk) => {
      for (const line of clean(chunk.toString('utf8')).split('\n')) {
        if (line.trim() !== '') appendLog(side, levelOf(line), line, `setup:${stream}`)
      }
    }
    child.stdout.on('data', collect('stdout'))
    child.stderr.on('data', collect('stderr'))
    child.on('error', (error) => {
      appendLog(side, 'error', `启动失败：${error.message}`, 'setup')
      finish(-1)
    })
    child.on('close', (code) => finish(code ?? -1))
    const timer = setTimeout(() => {
      appendLog(side, 'error', `命令超时（${timeoutMs}ms），已终止`, 'setup')
      child.kill('SIGTERM')
      finish(-1)
    }, timeoutMs)
    timer.unref?.()
  })
}

/** 跑 dsh 子命令（Windows 经过 cmd.exe）。 */
function runDsh(side, args, env, timeoutMs) {
  if (process.platform === 'win32') {
    const line = ['dsh', ...args].map(quoteCmd).join(' ')
    return runProcess(side, process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line], env, timeoutMs)
  }
  return runProcess(side, 'dsh', args, env, timeoutMs)
}

/** 构建插件产物；多侧共享一次。默认每轮准备都重建，避免 dev 面板用到旧 lib。 */
async function ensureBuilt(side) {
  if (process.env.DEV_CONSOLE_SKIP_BUILD === '1' && pluginBuilt()) return
  if (buildPromise === undefined) {
    appendLog(side, 'info', '构建插件 lib/…', 'setup')
    buildPromise = runProcess(side, process.execPath, [pluginBuild], { ...process.env }, 180_000)
      .then((code) => {
        if (code !== 0) throw new Error(`插件构建失败（exit ${code}）`)
        if (!pluginBuilt()) throw new Error('插件构建结束但没有 lib/index.js')
      })
      .finally(() => {
        buildPromise = undefined
      })
  }
  await buildPromise
}

/** 准备一侧：建目录、构建、安装插件。 */
async function prepareSide(side, force = false) {
  if (side.preparing !== null) return side.preparing
  side.preparing = (async () => {
    side.setup = 'preparing'
    side.lastError = null
    appendLog(side, 'info', `准备实例 ${side.label}（${side.home}）`, 'setup')
    mkdirSync(side.home, { recursive: true })
    mkdirSync(side.documents, { recursive: true })
    await ensureSync()
    await ensureBuilt(side)
    if (force || !pluginInstalled(side)) {
      appendLog(side, 'info', '安装/更新 dsh-session-cloudsync 到该实例 profile…', 'setup')
      const code = await runDsh(side, ['plugin', '--profile', 'web', 'add', pluginDir], cleanDshEnv(side))
      if (code !== 0) throw new Error(`dsh plugin add 失败（exit ${code}）`)
    }
    side.setup = 'ready'
    appendLog(side, 'info', `实例 ${side.label} 准备完成`, 'setup')
  })().catch((error) => {
    side.setup = 'error'
    side.lastError = error instanceof Error ? error.message : String(error)
    appendLog(side, 'error', `准备失败：${side.lastError}`, 'setup')
    throw error
  }).finally(() => {
    side.preparing = null
  })
  return side.preparing
}

/** 启动一侧。 */
async function startSide(side) {
  if (side.child !== null && side.child.exitCode === null) return { started: false, reason: '已在运行' }
  await prepareSide(side)
  if (side.child !== null && side.child.exitCode === null) return { started: false, reason: '已在运行' }

  side.status = 'starting'
  side.lastError = null
  side.url = null
  side.stopping = false
  appendLog(side, 'info', `启动 DSH ${side.label} :${side.port}`, 'host')
  side.tokenSince = side.logs.length

  const args = ['--port', String(side.port), '--home', side.home, '--documents', side.documents]
  if (credentials !== undefined) args.push('--credentials', credentials)
  const child = spawn(process.execPath, [devDsh, ...args], {
    cwd: repoRoot,
    env: cleanDshEnv(side),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  side.child = child
  side.status = 'starting'
  child.stdout.on('data', (chunk) => appendHostChunk(side, 'stdout', chunk))
  child.stderr.on('data', (chunk) => appendHostChunk(side, 'stderr', chunk))
  child.on('error', (error) => {
    side.lastError = error.message
    side.status = 'error'
    appendLog(side, 'error', `DSH 启动失败：${error.message}`, 'host')
  })
  child.on('close', (code) => {
    if (side.tokenTimer !== null) {
      clearInterval(side.tokenTimer)
      side.tokenTimer = null
    }
    for (const stream of ['stdout', 'stderr']) {
      if (side.buffers[stream] !== '') appendHostChunk(side, stream, '\n')
    }
    const wasStopping = side.stopping
    appendLog(side, code === 0 || wasStopping ? 'info' : 'error', `DSH ${side.label} 退出（code ${String(code)}）`, 'host')
    side.child = null
    side.url = null
    side.status = code === 0 || wasStopping ? 'idle' : 'error'
    side.stopping = false
  })

  // 从 host 日志里抓 token URL；抓不到就保持 null，页面会显示等待。
  side.tokenTimer = setInterval(() => {
    if (side.url !== null || side.child === null) return
    const text = side.logs.slice(side.tokenSince).map((entry) => entry.message).join('\n')
    const matches = [...text.matchAll(/[?&]token=([A-Za-z0-9_-]+)/gu)]
    const match = matches.at(-1)
    if (match !== undefined && match[1] !== undefined) {
      side.url = `http://${bindHost}:${side.port}/?token=${match[1]}`
      side.status = 'running'
      appendLog(side, 'info', `页面就绪：${side.url}`, 'host')
      if (side.tokenTimer !== null) {
        clearInterval(side.tokenTimer)
        side.tokenTimer = null
      }
    }
  }, 250)
  side.tokenTimer.unref?.()
  return { started: true }
}

/** 停一侧（Windows 杀进程树）。 */
async function stopSide(side) {
  const child = side.child
  if (child === null) return { stopped: false, reason: '未运行' }
  side.stopping = true
  side.status = 'stopping'
  appendLog(side, 'info', `停止 DSH ${side.label}…`, 'host')
  const closed = new Promise((resolvePromise) => {
    if (child.exitCode !== null) return resolvePromise()
    child.once('close', () => resolvePromise())
  })
  if (process.platform === 'win32') {
    await new Promise((resolvePromise) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      killer.on('close', () => resolvePromise())
      killer.on('error', () => resolvePromise())
    })
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
  await Promise.race([
    closed,
    new Promise((resolvePromise) => {
      const timer = setTimeout(resolvePromise, 5_000)
      timer.unref?.()
    }),
  ])
  if (side.child === child) {
    // close 事件通常已经把 child 清空；这里兜底，避免 restart 立刻看到旧 child。
    side.child = null
    side.url = null
    side.status = 'idle'
  }
  return { stopped: true }
}

/** 单侧状态。 */
function sideState(side) {
  return {
    id: side.id,
    label: side.label,
    port: side.port,
    home: side.home,
    url: side.url,
    status: side.status,
    setup: side.setup,
    lastError: side.lastError,
    running: side.child !== null && side.child.exitCode === null,
    pluginInstalled: pluginInstalled(side),
    syncConfigured: sync.ready
      && sync.credentials !== undefined
      && sync.credentials.tokens[side.id] !== undefined
      && existsSync(side.home),
    logCount: side.logs.length,
    ingestUrl: `http://${bindHost}:${consolePort}/api/log/${side.id}`,
  }
}

/** 全局状态。 */
function state() {
  return {
    consolePort,
    pluginBuilt: pluginBuilt(),
    credentialsConfigured: credentials !== undefined && existsSync(credentials),
    sync: {
      mode: sync.mode,
      url: sync.url,
      status: sync.status,
      ready: sync.ready,
      error: sync.error,
      ...sync.mode === 'local' ? { dataDir: syncDataDir } : {},
    },
    importTrace: {
      available: existsSync(benchTracePath),
      path: benchTracePath,
    },
    sides: [...sides.values()].map(sideState),
  }
}

/** 打开一条日志 SSE。 */
function logStream(req, res, side) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write('retry: 1000\n\n')
  sse(res, 'snapshot', side.logs)
  side.clients.add(res)
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      // close 处理。
    }
  }, 15_000)
  heartbeat.unref?.()
  const cleanup = () => {
    clearInterval(heartbeat)
    side.clients.delete(res)
    try {
      res.end()
    } catch {
      // 已断开。
    }
  }
  // 只挂 res：Node 的 GET IncomingMessage 可能在请求体读完时就触发 close，
  // 会把刚建立的 SSE 当场关掉。
  res.on('close', cleanup)
}

/** 处理 /api/log/:side。 */
async function ingestLog(req, res, side) {
  let body
  try {
    body = await readBody(req)
  } catch (error) {
    json(res, 413, { ok: false, error: error instanceof Error ? error.message : String(error) })
    return
  }
  const entries = Array.isArray(body?.entries) ? body.entries : [body]
  let accepted = 0
  for (const raw of entries.slice(0, 100)) {
    if (raw === null || typeof raw !== 'object') continue
    const level = raw.level === 'warn' || raw.level === 'error' ? raw.level : 'info'
    const message = typeof raw.message === 'string' ? raw.message : ''
    if (message.trim() === '') continue
    const source = typeof raw.source === 'string' && raw.source.trim() !== ''
      ? raw.source.slice(0, 80)
      : 'plugin'
    appendLog(side, level, message, source)
    accepted += 1
  }
  json(res, 200, { ok: true, accepted })
}

/** 静默关闭所有实例。 */
function shutdown() {
  if (sync.child !== null) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(sync.child.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        process.kill(-sync.child.pid, 'SIGTERM')
      }
    } catch {
      // 已退出。
    }
  }
  for (const side of sides.values()) {
    if (side.child !== null) {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(side.child.pid), '/T', '/F'], { stdio: 'ignore' })
        } else {
          process.kill(-side.child.pid, 'SIGTERM')
        }
      } catch {
        // 已退出。
      }
    }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${bindHost}:${consolePort}`)
  const pathname = url.pathname
  try {
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const page = readFileSync(pageFile)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(page)
      return
    }
    if (req.method === 'GET' && pathname === '/api/state') {
      json(res, 200, state())
      return
    }
    if (req.method === 'GET' && pathname.startsWith('/api/logs/')) {
      const side = sides.get(pathname.slice('/api/logs/'.length))
      if (side === undefined) return json(res, 404, { ok: false, error: 'unknown side' })
      logStream(req, res, side)
      return
    }
    if (req.method === 'POST' && pathname.startsWith('/api/log/')) {
      const side = sides.get(pathname.slice('/api/log/'.length))
      if (side === undefined) return json(res, 404, { ok: false, error: 'unknown side' })
      await ingestLog(req, res, side)
      return
    }
    if (req.method === 'POST' && pathname.startsWith('/api/clear/')) {
      const side = sides.get(pathname.slice('/api/clear/'.length))
      if (side === undefined) return json(res, 404, { ok: false, error: 'unknown side' })
      clearSideLogs(side)
      json(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && pathname === '/api/clean') {
      const body = await readBody(req)
      const removed = await cleanData(body)
      json(res, 200, { ok: true, removed, state: state() })
      return
    }
    if (req.method === 'POST' && pathname === '/api/import-large') {
      const body = await readBody(req)
      const result = await importLargeSession(body)
      json(res, 200, { ok: true, ...result, state: state() })
      return
    }
    if (req.method === 'POST' && pathname === '/api/restore') {
      const body = await readBody(req)
      const result = await restorePreconfigured(body?.restart !== false)
      json(res, 200, { ok: true, ...result, state: state() })
      return
    }

    const match = /^\/api\/(start|stop|prepare|restart)\/([ab])$/u.exec(pathname)
    if (req.method === 'POST' && match !== null) {
      const side = sides.get(match[2])
      if (side === undefined) return json(res, 404, { ok: false, error: 'unknown side' })
      if (match[1] === 'prepare') {
        await prepareSide(side, url.searchParams.get('force') === '1')
        json(res, 200, { ok: true, side: sideState(side) })
        return
      }
      if (match[1] === 'start') {
        const result = await startSide(side)
        json(res, 200, { ok: true, ...result, side: sideState(side) })
        return
      }
      if (match[1] === 'stop') {
        const result = await stopSide(side)
        json(res, 200, { ok: true, ...result, side: sideState(side) })
        return
      }
      await stopSide(side)
      const result = await startSide(side)
      json(res, 200, { ok: true, ...result, side: sideState(side) })
      return
    }

    if (req.method === 'POST' && (pathname === '/api/start' || pathname === '/api/stop' || pathname === '/api/prepare')) {
      const action = pathname.slice('/api/'.length)
      for (const side of sides.values()) {
        if (action === 'stop') {
          await stopSide(side)
          continue
        }
        if (action === 'prepare') {
          await prepareSide(side, url.searchParams.get('force') === '1')
          continue
        }
        await startSide(side)
      }
      json(res, 200, { ok: true, sides: [...sides.values()].map(sideState) })
      return
    }

    json(res, 404, { ok: false, error: 'not found' })
  } catch (error) {
    const fallback = sides.get('a')
    if (fallback !== undefined) {
      appendLog(fallback, 'error', error instanceof Error ? error.message : String(error), 'console')
    }
    json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})

server.listen(consolePort, bindHost, () => {
  console.log(`DSH 双实例控制台：http://${bindHost}:${consolePort}/`)
  console.log(`A：http://${bindHost}:${sidePorts.a}/  B：http://${bindHost}:${sidePorts.b}/`)
  console.log(`同步服务端：${sync.mode === 'off' ? '关闭' : syncUrl}（${sync.mode}）`)
  console.log(`实例目录：${tempRoot}`)
  if (credentials === undefined) {
    console.log('登录态：未指定 DEV_CONSOLE_CREDENTIALS（两套实例都不会复制凭据）')
  } else {
    console.log(`登录态：${credentials}`)
  }
})

server.on('error', (error) => {
  console.error(`控制台启动失败：${error.message}`)
  process.exitCode = 1
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shutdown()
    server.close(() => process.exit(0))
  })
}
