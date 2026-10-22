/**
 * 自部署同步服务的 HTTP 面。
 *
 * 认证是 bearer token，分两种角色：首次启动生成的 setup token 管理设备，
 * 设备 token 代表一台设备。本脚手架只提供健康检查与设备管理；
 * 会话/帧端点随同步引擎一起落地。
 *
 * @module @dsh-session-cloudsync/server/http
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { PROTOCOL_VERSION, errorBody, type DeviceRef } from '../../shared/src/protocol.ts'
import { SyncError, statusOf } from '../../shared/src/wire.ts'
import { deriveMasterKey, newSalt } from '../../shared/src/crypto.ts'
import { hasBlob, putBlob, readBlob } from './blobs.ts'
import {
  DEFAULT_DATASET,
  adminPassword,
  blobRecord,
  isAdminInitialized,
  markAdminInitialized,
  readMaxBytes,
  readMeta,
  recordBlob,
  readRevision,
  setAdminPassword,
  usedBlobBytes,
  writeMaxBytes,
  type ServerDb,
} from './db.ts'
import {
  MAX_APPEND_BODY_BYTES,
  adminSessions,
  appendFrames,
  deleteSession,
  getManifest,
  listChanges,
  listBatches,
  sessionCounts,
} from './sessions.ts'
import { acquireLease, releaseLease, sessionResource, vaultResource } from './leases.ts'
import { appendVaultRecord, readVaultCursor, readVaultStream, validVaultWriter } from './vault.ts'
import type { SealedFrameRef } from '../../shared/src/sealed-frame.ts'

/** `/v1/health` 报告的版本。 */
export const SERVER_VERSION = '0.0.0'

/** 默认存储上限：10 GiB。 */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 * 1024

/** 默认单个 blob 上限：32 MiB。 */
export const DEFAULT_MAX_BLOB_BYTES = 32 * 1024 * 1024

/**
 * 读一个内置资源；缺失时返回 undefined（打包漏文件时仍能启动）。
 * @param url - 资源路径。
 * @returns 字节内容或 undefined。
 */
function readAsset(url: URL): Buffer | undefined {
  try {
    return readFileSync(url)
  } catch {
    return undefined
  }
}

/** 页面用的深色 logo 与 favicon。 */
const LOGO_SVG = readAsset(new URL('../../../assets/logo-dark.svg', import.meta.url))
const FAVICON_SVG = readAsset(new URL('../../../assets/favicon.svg', import.meta.url))

/**
 * 读一个文本资源；缺失时给出明确错误。
 * @param url - 资源路径。
 * @param label - 报错用的名字。
 * @returns 文本内容。
 */
function readText(url: URL, label: string): string {
  try {
    return readFileSync(url, 'utf8')
  } catch {
    throw new Error(`缺少页面文件：${label}`)
  }
}

/** 管理台与初始化向导的单页（`packages/server/web/*.html`）。 */
const ADMIN_PAGE = readText(new URL('../web/admin.html', import.meta.url), 'admin.html')
const SETUP_PAGE = readText(new URL('../web/setup.html', import.meta.url), 'setup.html')

/** {@link createHttpServer} 的选项。 */
export interface ServerOptions {
  readonly db: ServerDb
  readonly dataDir: string
  readonly version?: string
  readonly maxBytes?: number
  readonly maxBlobBytes?: number
  /** 未初始化时打印到控制台的初始化密钥（由 serve 生成）。 */
  readonly onboardingCode?: string
}

interface DeviceRow {
  readonly device_id: string
  readonly label: string
  readonly created_at: number
  readonly last_seen_at: number | null
  readonly revoked_at: number | null
}

/** 路由处理函数。 */
type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/**
 * 存储前对 bearer token 做哈希。
 * @param token - 明文 token。
 * @returns 小写十六进制 SHA-256。
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * 生成一个新的随机 token。
 * @returns URL 安全的密钥。
 */
export function mintToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * 写一个 JSON 响应。
 * @param res - 要完成的响应。
 * @param status - HTTP 状态码。
 * @param body - 可 JSON 序列化的响应体。
 */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * 读取一个小体积的 JSON 对象请求体。
 * @param req - 要读的请求。
 * @returns 解析后的对象。
 * @throws 请求体不是 JSON 对象或超过大小上限时抛出。
 */
async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > limit) throw new SyncError('bad-request', `请求体超过上限 ${limit} 字节`)
    chunks.push(buffer)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyncError('bad-request', '请求体必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

/**
 * 读取原始字节请求体。
 * @param req - 要读的请求。
 * @param limit - 允许的最大字节数。
 * @returns 请求体字节。
 * @throws 超过上限时抛出 `bad-request`。
 */
async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > limit) throw new SyncError('bad-request', `请求体超过上限 ${limit} 字节`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * 解析 bearer token 及其角色。
 * @param db - 已打开的数据库。
 * @param req - 收到的请求。
 * @returns 角色；token 缺失或未知时返回 undefined。
 */
function authenticate(db: ServerDb, req: IncomingMessage): { role: 'admin' } | { role: 'device'; device: DeviceRef } | undefined {
  const header = String(req.headers.authorization ?? '')
  if (!header.startsWith('Bearer ')) return undefined
  const token = header.slice('Bearer '.length).trim()
  if (token === '') return undefined
  const setupToken = readMeta(db, 'setup_token')
  if (setupToken !== undefined && token === setupToken) return { role: 'admin' }
  const row = db.handle
    .prepare('SELECT device_id, label, created_at, last_seen_at, revoked_at FROM devices WHERE dataset = ? AND token_hash = ?')
    .get(DEFAULT_DATASET, hashToken(token)) as DeviceRow | undefined
  if (row === undefined || row.revoked_at !== null) return undefined
  return {
    role: 'device',
    device: {
      deviceId: row.device_id,
      label: row.label,
      createdAt: row.created_at,
      ...row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at },
    },
  }
}

/**
 * 要求设备 token，并校验 `X-Device-Id`（若携带）。
 * @param db - 已打开的数据库。
 * @param req - 收到的请求。
 * @returns 设备信息。
 * @throws 缺 token、非设备 token 或 header 与 token 不一致时抛出 `unauthorized`。
 */
function requireDevice(db: ServerDb, req: IncomingMessage): DeviceRef {
  const auth = authenticate(db, req)
  if (auth === undefined) throw new SyncError('unauthorized', '未知 token')
  if (auth.role !== 'device') throw new SyncError('unauthorized', '需要设备 token')
  const declared = req.headers['x-device-id']
  if (declared !== undefined && String(declared) !== auth.device.deviceId) {
    throw new SyncError('unauthorized', 'X-Device-Id 与 token 不匹配')
  }
  return auth.device
}

/**
 * 读取当前 DSH 进程的 clientInstanceId。
 * @param req - 收到的请求。
 * @returns 16–64 位小写十六进制 id。
 * @throws 缺头或形状非法时抛出 `bad-request`。
 */
function clientIdFrom(req: IncomingMessage): string {
  const raw = req.headers['x-client-id']
  const value = Array.isArray(raw) ? raw[0] ?? '' : String(raw ?? '')
  if (!/^[0-9a-f]{16,64}$/u.test(value)) {
    throw new SyncError('bad-request', '需要 16–64 位十六进制 X-Client-Id')
  }
  return value
}

/**
 * 从路径里取会话 id。
 * @param pathname - 请求路径。
 * @param pattern - 含一个捕获组的正则。
 * @returns 已验证的会话 id。
 * @throws 取不到或形状非法时抛出 `bad-request`。
 */
function sessionIdFrom(pathname: string, pattern: RegExp): string {
  const match = pattern.exec(pathname)
  if (match === null) throw new SyncError('bad-request', '会话 id 缺失')
  const id = decodeURIComponent(match[1]!)
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(id)) throw new SyncError('bad-request', `会话 id 非法：${id}`)
  return id
}

/**
 * 解析 append 请求体。
 * @param body - JSON 请求体。
 * @returns 校验后的入参（会话 id 与设备由调用方补）。
 * @throws 字段缺失或类型不对时抛出 `bad-request`。
 */
function parseAppend(body: Record<string, unknown>): {
  baseIndex: number
  baseChainHash: string | null
  createdAt: number
  formatVersion: number
  frames: SealedFrameRef[]
  tailOpen?: boolean
  safeThroughSeq?: number
  workspaceKey?: string
} {
  if (!Number.isSafeInteger(body.baseIndex)) throw new SyncError('bad-request', 'baseIndex 必须是整数')
  const baseChainHash = body.baseChainHash
  if (baseChainHash !== null && (typeof baseChainHash !== 'string' || !/^[0-9a-f]{64}$/u.test(baseChainHash))) {
    throw new SyncError('bad-request', 'baseChainHash 必须是 64 位十六进制或 null')
  }
  if (!Number.isSafeInteger(body.createdAt) || Number(body.createdAt) < 0) throw new SyncError('bad-request', 'createdAt 必须是非负整数')
  if (!Number.isSafeInteger(body.formatVersion) || Number(body.formatVersion) < 1) throw new SyncError('bad-request', 'formatVersion 必须是正整数')
  // 规范字段是 `batches`；不再接受旧 `frames`。
  const refs = body.batches
  if (!Array.isArray(refs)) throw new SyncError('bad-request', 'batches 必须是数组')
  if (body.tailOpen !== undefined && typeof body.tailOpen !== 'boolean') throw new SyncError('bad-request', 'tailOpen 必须是布尔值')
  if (body.safeThroughSeq !== undefined && (!Number.isSafeInteger(body.safeThroughSeq) || Number(body.safeThroughSeq) < -1)) {
    throw new SyncError('bad-request', 'safeThroughSeq 必须是不小于 -1 的整数')
  }
  if (body.workspaceKey !== undefined && (typeof body.workspaceKey !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/u.test(body.workspaceKey))) {
    throw new SyncError('bad-request', 'workspaceKey 非法')
  }
  return {
    baseIndex: Number(body.baseIndex),
    baseChainHash: baseChainHash as string | null,
    createdAt: Number(body.createdAt),
    formatVersion: Number(body.formatVersion),
    frames: refs as SealedFrameRef[],
    ...body.tailOpen === undefined ? {} : { tailOpen: body.tailOpen },
    ...body.safeThroughSeq === undefined ? {} : { safeThroughSeq: Number(body.safeThroughSeq) },
    ...body.workspaceKey === undefined ? {} : { workspaceKey: body.workspaceKey },
  }
}

/**
 * 读取一个整数查询参数并夹到范围内。
 * @param value - 原始字符串。
 * @param fallback - 缺省值。
 * @param min - 最小值。
 * @param max - 最大值。
 * @returns 夹取后的整数。
 * @throws 不是整数时抛出 `bad-request`。
 */
function intParam(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new SyncError('bad-request', `查询参数必须是整数：${value}`)
  return Math.min(max, Math.max(min, parsed))
}

const LEASE_PATH = /^\/v1\/sessions\/([^/]+)\/lease$/u
const APPEND_PATH = /^\/v1\/sessions\/([^/]+)\/append$/u
const DELETE_PATH = /^\/v1\/sessions\/([^/]+)\/delete$/u
const MANIFEST_PATH = /^\/v1\/sessions\/([^/]+)\/manifest$/u
const BATCHES_PATH = /^\/v1\/sessions\/([^/]+)\/batches$/u
const CURSOR_PATH = /^\/v1\/cursor$/u
const VAULT_APPEND_PATH = /^\/v1\/vault\/append$/u
const VAULT_LEASE_PATH = /^\/v1\/vault\/lease$/u
const VAULT_CURSOR_PATH = /^\/v1\/vault\/cursor$/u
const VAULT_STREAM_PATH = /^\/v1\/vault\/stream\/([^/]+)$/u
const ADMIN_DEVICE_PATH = /^\/admin\/devices\/([0-9a-f]+)$/u

/**
 * 把 manifest 的内部 `frames` 输出成唯一的 `batches`。
 * @param value - 会话摘要、manifest 或批次列表。
 * @returns 只含规范字段的视图。
 */
function withBatchFields(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const result: Record<string, unknown> = { ...record }
  const refs = Array.isArray(record['batches']) ? record['batches'] : record['frames']
  if (Array.isArray(refs)) {
    result['batches'] = refs
    if (typeof record['batchCount'] !== 'number') result['batchCount'] = refs.length
    delete result['frames']
  }
  if (record['manifest'] !== null && typeof record['manifest'] === 'object') {
    result['manifest'] = withBatchFields(record['manifest'])
  }
  return result
}

/** 管理台会话 cookie 名。 */
const ADMIN_COOKIE = 'dsh_sync_admin'

/** 初始化向导的短期会话 cookie 名。 */
const SETUP_COOKIE = 'dsh_sync_setup'

/** 管理台会话有效期。 */
const ADMIN_TTL_MS = 12 * 60 * 60 * 1000

/** 初始化向导会话有效期。 */
const SETUP_TTL_MS = 15 * 60 * 1000

/** 初始化密钥有效期。 */
const ONBOARDING_TTL_MS = 10 * 60 * 1000

/** 初始化密钥字符表：去掉容易混淆的 0/O/1/I。 */
const ONBOARDING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** 配额下限与上限。 */
const MIN_MAX_BYTES = 16 * 1024 * 1024
const MAX_MAX_BYTES = 1024 * 1024 * 1024 * 1024

/**
 * 生成一个 8 位初始化密钥（展示时分成两段）。
 * @returns 形如 `ABCD-EFGH` 的字符串。
 */
export function mintOnboardingCode(): string {
  const bytes = randomBytes(8)
  let raw = ''
  for (const byte of bytes) raw += ONBOARDING_ALPHABET[byte % ONBOARDING_ALPHABET.length]
  return `${raw.slice(0, 4)}-${raw.slice(4)}`
}

/**
 * 归一化初始化密钥（去掉分隔符、转大写）。
 * @param raw - 用户输入或生成的密钥。
 * @returns 归一化后的字符串。
 */
function normalizeOnboardingCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/gu, '')
}

/**
 * 校验管理密码规则：≥6 位，字母/数字/特殊字符至少两类。
 * @param password - 用户输入的密码。
 * @returns 不合法时的说明，合法时为 undefined。
 */
export function validateAdminPassword(password: unknown): string | undefined {
  if (typeof password !== 'string') return '密码不能为空'
  if (password.length < 6) return '密码至少 6 位'
  if (password.length > 128) return '密码不能超过 128 位'
  const classes = [/[A-Za-z]/u, /[0-9]/u, /[^A-Za-z0-9]/u].filter((pattern) => pattern.test(password)).length
  if (classes < 2) return '密码需要包含字母、数字、特殊字符中的至少两类'
  return undefined
}

/**
 * 读取一个 cookie。
 * @param req - 收到的请求。
 * @param name - cookie 名。
 * @returns 值或 undefined。
 */
function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim()
  }
  return undefined
}

/**
 * 写管理台会话 cookie。
 * @param res - 响应。
 * @param token - 会话 token。
 * @param maxAgeSeconds - 有效期秒数；0 表示清除。
 */
function writeAdminCookie(res: ServerResponse, token: string, maxAgeSeconds: number): void {
  res.appendHeader('set-cookie', `${ADMIN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`)
}

/**
 * 写初始化向导会话 cookie。
 * @param res - 响应。
 * @param token - 会话 token。
 * @param maxAgeSeconds - 有效期秒数；0 表示清除。
 */
function writeSetupCookie(res: ServerResponse, token: string, maxAgeSeconds: number): void {
  res.appendHeader('set-cookie', `${SETUP_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/setup; Max-Age=${maxAgeSeconds}`)
}

/**
 * 创建一个设备 token。
 * @param db - 已打开的数据库。
 * @param label - 设备可读标签。
 * @returns 设备信息与只显示一次的 token。
 */
export function createDevice(db: ServerDb, label: string): { device: DeviceRef; token: string } {
  const deviceId = randomBytes(8).toString('hex')
  const token = mintToken()
  const now = Date.now()
  db.handle
    .prepare('INSERT INTO devices (dataset, device_id, label, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(DEFAULT_DATASET, deviceId, label, hashToken(token), now)
  return { device: { deviceId, label, createdAt: now }, token }
}

/**
 * 列出未吊销的设备。
 * @param db - 已打开的数据库。
 * @returns 不含密钥的设备记录。
 */
export function listDevices(db: ServerDb): DeviceRef[] {
  const rows = db.handle
    .prepare('SELECT device_id, label, created_at, last_seen_at FROM devices WHERE dataset = ? AND revoked_at IS NULL ORDER BY created_at')
    .all(DEFAULT_DATASET) as unknown as DeviceRow[]
  return rows.map((row) => ({
    deviceId: row.device_id,
    label: row.label,
    createdAt: row.created_at,
    ...row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at },
  }))
}

/**
 * 吊销一个设备 token。
 * @param db - 已打开的数据库。
 * @param deviceId - 要吊销的设备。
 * @returns 是否真的吊销了存活设备。
 */
export function revokeDevice(db: ServerDb, deviceId: string): boolean {
  const result = db.handle
    .prepare('UPDATE devices SET revoked_at = ? WHERE dataset = ? AND device_id = ? AND revoked_at IS NULL')
    .run(Date.now(), DEFAULT_DATASET, deviceId)
  return Number(result.changes) > 0
}

/**
 * 构造 HTTP 服务。
 * @param options - 数据库、数据目录与版本。
 * @returns 尚未 listen 的服务。
 */
export function createHttpServer(options: ServerOptions): Server {
  const { db } = options
  const version = options.version ?? SERVER_VERSION
  const maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES
  const defaultMaxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const effectiveMaxBytes = (): number => readMaxBytes(db, defaultMaxBytes)
  const adminSessionsByKey = new Map<string, number>()
  const setupSessionsByKey = new Map<string, number>()
  const attemptsByKey = new Map<string, { count: number; resetAt: number }>()
  const onboarding = {
    codeHash: options.onboardingCode === undefined ? undefined : hashToken(normalizeOnboardingCode(options.onboardingCode)),
    expiresAt: Date.now() + ONBOARDING_TTL_MS,
  }

  /**
   * 要求管理台 cookie 会话有效。
   * @param req - 收到的请求。
   * @throws 未登录或已过期时抛出 `unauthorized`。
   */
  function requireAdmin(req: IncomingMessage): void {
    const token = cookieValue(req, ADMIN_COOKIE)
    if (token === undefined) throw new SyncError('unauthorized', '需要登录管理台')
    const key = hashToken(token)
    const expiresAt = adminSessionsByKey.get(key)
    if (expiresAt === undefined || expiresAt <= Date.now()) {
      adminSessionsByKey.delete(key)
      throw new SyncError('unauthorized', '管理台会话已过期')
    }
  }

  /**
   * 要求初始化向导会话有效。
   * @param req - 收到的请求。
   * @throws 未验证密钥或会话过期时抛出 `unauthorized`。
   */
  function requireSetup(req: IncomingMessage): void {
    const token = cookieValue(req, SETUP_COOKIE)
    if (token === undefined) throw new SyncError('unauthorized', '请先验证初始化密钥')
    const key = hashToken(token)
    const expiresAt = setupSessionsByKey.get(key)
    if (expiresAt === undefined || expiresAt <= Date.now()) {
      setupSessionsByKey.delete(key)
      throw new SyncError('unauthorized', '初始化会话已过期，请重新验证密钥')
    }
  }

  /**
   * 下发一个正式管理台会话。
   * @param res - 响应。
   * @returns 过期时间。
   */
  function issueAdminSession(res: ServerResponse): number {
    const token = randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + ADMIN_TTL_MS
    adminSessionsByKey.set(hashToken(token), expiresAt)
    writeAdminCookie(res, token, Math.floor(ADMIN_TTL_MS / 1000))
    return expiresAt
  }

  /**
   * 记录一次可能失败的尝试，超过阈值时拒绝。
   * @param key - 限速键（IP + 场景）。
   * @throws 超过 10 次/10 分钟时抛出 `rate-limited`。
   */
  function guardAttempts(key: string): void {
    const now = Date.now()
    const entry = attemptsByKey.get(key)
    if (entry === undefined || entry.resetAt <= now) {
      attemptsByKey.set(key, { count: 0, resetAt: now + 10 * 60 * 1000 })
      return
    }
    if (entry.count >= 10) throw new SyncError('rate-limited', '尝试过于频繁，请稍后再试')
  }

  /**
   * 记录一次失败。
   * @param key - 限速键。
   */
  function noteFailure(key: string): void {
    const entry = attemptsByKey.get(key)
    if (entry !== undefined) entry.count += 1
  }

  /**
   * 校验管理密码。
   * @param submitted - 用户输入。
   * @returns 匹配时为 true。
   */
  function passwordMatches(submitted: string): boolean {
    const stored = adminPassword(db)
    if (stored === undefined || submitted.length === 0) return false
    const derived = deriveMasterKey(submitted, Buffer.from(stored.salt, 'hex'))
    const actual = Buffer.from(stored.hash, 'hex')
    return derived.length === actual.length && timingSafeEqual(derived, actual)
  }

  const routes: Array<{ method: string; path: RegExp; handler: Handler }> = [
    {
      method: 'GET',
      path: /^\/v1\/health$/,
      handler: async (_req, res) => {
        json(res, 200, { ok: true, version, protocol: PROTOCOL_VERSION, now: Date.now() })
      },
    },
    {
      method: 'POST',
      path: /^\/v1\/devices$/,
      handler: async (req, res) => {
        const auth = authenticate(db, req)
        if (auth?.role !== 'admin') return json(res, 401, errorBody('unauthorized', '需要 setup token'))
        const body = await readJson(req)
        const label = typeof body.label === 'string' && body.label.trim() !== '' ? body.label.trim() : 'device'
        const created = createDevice(db, label)
        return json(res, 201, { ok: true, value: created })
      },
    },
    {
      method: 'GET',
      path: /^\/v1\/devices$/,
      handler: async (req, res) => {
        const auth = authenticate(db, req)
        if (auth?.role !== 'admin') return json(res, 401, errorBody('unauthorized', '需要 setup token'))
        return json(res, 200, { ok: true, value: listDevices(db) })
      },
    },
    {
      method: 'DELETE',
      path: /^\/v1\/devices\/([0-9a-f]+)$/,
      handler: async (req, res) => {
        const auth = authenticate(db, req)
        if (auth?.role !== 'admin') return json(res, 401, errorBody('unauthorized', '需要 setup token'))
        const match = /^\/v1\/devices\/([0-9a-f]+)$/.exec(new URL(req.url ?? '/', 'http://localhost').pathname)
        if (match === null) return json(res, 404, errorBody('not-found', '没有这个设备'))
        const revoked = revokeDevice(db, match[1]!)
        return revoked
          ? json(res, 200, { ok: true, value: { deviceId: match[1], revoked: true } })
          : json(res, 404, errorBody('not-found', '没有这个设备'))
      },
    },
    {
      method: 'POST',
      path: /^\/v1\/blobs$/,
      handler: async (req, res) => {
        const auth = authenticate(db, req)
        if (auth === undefined) return json(res, 401, errorBody('unauthorized', '需要设备或 setup token'))
        const url = new URL(req.url ?? '/', 'http://localhost')
        const kind = url.searchParams.get('kind') ?? 'frame'
        if (kind !== 'frame' && kind !== 'attachment' && kind !== 'vault') {
          return json(res, 400, errorBody('bad-request', 'kind 只能是 frame、attachment 或 vault'))
        }
        const bytes = await readRaw(req, maxBlobBytes)
        if (bytes.length === 0) return json(res, 400, errorBody('bad-request', 'blob 不能为空'))
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const existing = blobRecord(db, sha256)
        if (existing !== undefined) return json(res, 200, { ok: true, value: { sha256, bytes: existing.bytes, dedup: true } })
        const used = usedBlobBytes(db)
        const limit = effectiveMaxBytes()
        if (used + bytes.length > limit) {
          throw new SyncError('quota', `存储超额：已用 ${used} 字节，上限 ${limit} 字节`)
        }
        const stored = await putBlob(options.dataDir, bytes)
        recordBlob(db, stored.sha256, stored.bytes, kind)
        return json(res, 201, { ok: true, value: { sha256: stored.sha256, bytes: stored.bytes, dedup: false } })
      },
    },
    {
      method: 'HEAD',
      path: /^\/v1\/blobs\/([0-9a-f]{64})$/,
      handler: async (req, res) => {
        const auth = authenticate(db, req)
        if (auth === undefined) {
          res.statusCode = 401
          res.end()
          return
        }
        const match = /^\/v1\/blobs\/([0-9a-f]{64})$/.exec(new URL(req.url ?? '/', 'http://localhost').pathname)
        res.statusCode = match !== null && await hasBlob(options.dataDir, match[1]!) ? 200 : 404
        res.end()
      },
    },
    {
      method: 'GET',
      path: /^\/v1\/blobs\/([0-9a-f]{64})$/,
      handler: async (req, res) => {
        const auth = authenticate(db, req)
        if (auth === undefined) return json(res, 401, errorBody('unauthorized', '需要设备或 setup token'))
        const match = /^\/v1\/blobs\/([0-9a-f]{64})$/.exec(new URL(req.url ?? '/', 'http://localhost').pathname)
        if (match === null) return json(res, 404, errorBody('not-found', '没有这个 blob'))
        const sha256 = match[1]!
        if (!(await hasBlob(options.dataDir, sha256))) return json(res, 404, errorBody('not-found', '没有这个 blob'))
        const bytes = await readBlob(options.dataDir, sha256)
        res.statusCode = 200
        res.setHeader('content-type', 'application/octet-stream')
        res.setHeader('content-length', bytes.length)
        res.end(bytes)
      },
    },
    {
      method: 'POST',
      path: LEASE_PATH,
      handler: async (req, res) => {
        const device = requireDevice(db, req)
        const clientId = clientIdFrom(req)
        const id = sessionIdFrom(new URL(req.url ?? '/', 'http://localhost').pathname, LEASE_PATH)
        return json(res, 200, { ok: true, value: acquireLease(db, sessionResource(id), device.deviceId, clientId) })
      },
    },
    {
      method: 'DELETE',
      path: LEASE_PATH,
      handler: async (req, res) => {
        const device = requireDevice(db, req)
        const clientId = clientIdFrom(req)
        const id = sessionIdFrom(new URL(req.url ?? '/', 'http://localhost').pathname, LEASE_PATH)
        return json(res, 200, { ok: true, value: { released: releaseLease(db, sessionResource(id), device.deviceId, clientId) } })
      },
    },
    {
      method: 'POST',
      path: APPEND_PATH,
      handler: async (req, res) => {
        const device = requireDevice(db, req)
        const clientId = clientIdFrom(req)
        const id = sessionIdFrom(new URL(req.url ?? '/', 'http://localhost').pathname, APPEND_PATH)
        const body = await readJson(req, MAX_APPEND_BODY_BYTES)
        const parsed = parseAppend(body)
        const value = appendFrames(db, options.dataDir, { sessionId: id, deviceId: device.deviceId, clientId, ...parsed })
        return json(res, 200, { ok: true, value: withBatchFields(value) })
      },
    },
    {
      method: 'POST',
      path: DELETE_PATH,
      handler: async (req, res) => {
        const device = requireDevice(db, req)
        const clientId = clientIdFrom(req)
        const id = sessionIdFrom(new URL(req.url ?? '/', 'http://localhost').pathname, DELETE_PATH)
        const body = await readJson(req)
        if (!Number.isSafeInteger(body.createdAt)) throw new SyncError('bad-request', 'createdAt 必须是整数')
        return json(res, 200, { ok: true, value: deleteSession(db, id, device.deviceId, clientId, Number(body.createdAt)) })
      },
    },
    {
      method: 'GET',
      path: MANIFEST_PATH,
      handler: async (req, res) => {
        requireDevice(db, req)
        const id = sessionIdFrom(new URL(req.url ?? '/', 'http://localhost').pathname, MANIFEST_PATH)
        const found = getManifest(db, id)
        if (found === undefined) return json(res, 404, errorBody('not-found', `没有会话 ${id}`))
        return json(res, 200, { ok: true, value: withBatchFields(found) })
      },
    },
    {
      method: 'GET',
      path: BATCHES_PATH,
      handler: async (req, res) => {
        requireDevice(db, req)
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = sessionIdFrom(url.pathname, BATCHES_PATH)
        const found = listBatches(db, id, intParam(url.searchParams.get('from'), 0, 0, Number.MAX_SAFE_INTEGER), intParam(url.searchParams.get('limit'), 500, 1, 1000))
        if (found === undefined) return json(res, 404, errorBody('not-found', `没有会话 ${id}`))
        return json(res, 200, { ok: true, value: withBatchFields(found) })
      },
    },
    {
      method: 'GET',
      path: CURSOR_PATH,
      handler: async (req, res) => {
        requireDevice(db, req)
        const url = new URL(req.url ?? '/', 'http://localhost')
        const since = intParam(url.searchParams.get('since'), 0, 0, Number.MAX_SAFE_INTEGER)
        const limit = intParam(url.searchParams.get('limit'), 200, 1, 1000)
        return json(res, 200, { ok: true, value: listChanges(db, since, limit) })
      },
    },
    {
      method: 'POST',
      path: VAULT_LEASE_PATH,
      handler: async (req, res) => {
        const device = requireDevice(db, req)
        const clientId = clientIdFrom(req)
        const resource = vaultResource(device.deviceId)
        return json(res, 200, { ok: true, value: acquireLease(db, resource, device.deviceId, clientId) })
      },
    },
    {
      method: 'DELETE',
      path: VAULT_LEASE_PATH,
      handler: async (req, res) => {
        const device = requireDevice(db, req)
        const clientId = clientIdFrom(req)
        const resource = vaultResource(device.deviceId)
        return json(res, 200, { ok: true, value: { released: releaseLease(db, resource, device.deviceId, clientId) } })
      },
    },
    {
      method: 'POST',
      path: VAULT_APPEND_PATH,
      handler: async (req, res) => {
        const device = requireDevice(db, req)
        const clientId = clientIdFrom(req)
        const body = await readJson(req)
        const writer = typeof body.writer === 'string' ? body.writer : device.deviceId
        if (writer !== device.deviceId) throw new SyncError('bad-request', 'writer 必须等于当前 deviceId')
        const sealedRaw = body.sealed
        if (sealedRaw === null || typeof sealedRaw !== 'object' || Array.isArray(sealedRaw)) {
          throw new SyncError('bad-request', 'sealed 必须是对象')
        }
        const sealed = sealedRaw as Record<string, unknown>
        const result = appendVaultRecord(db, options.dataDir, {
          writer,
          deviceId: device.deviceId,
          clientId,
          seq: Number(body.seq),
          prevHash: body.prevHash === null ? null : String(body.prevHash),
          blobSha256: typeof body.blobSha256 === 'string' ? body.blobSha256 : '',
          bytes: Number(body.bytes),
          createdAt: Number(body.createdAt),
          sealed: {
            formatVersion: Number(sealed.formatVersion),
            keyId: typeof sealed.keyId === 'string' ? sealed.keyId : '',
          },
        })
        return json(res, 200, { ok: true, value: { ...result.record, dedup: result.dedup } })
      },
    },
    {
      method: 'GET',
      path: VAULT_CURSOR_PATH,
      handler: async (req, res) => {
        requireDevice(db, req)
        const url = new URL(req.url ?? '/', 'http://localhost')
        const since = intParam(url.searchParams.get('since'), 0, 0, Number.MAX_SAFE_INTEGER)
        const limit = intParam(url.searchParams.get('limit'), 200, 1, 500)
        return json(res, 200, { ok: true, value: readVaultCursor(db, since, limit) })
      },
    },
    {
      method: 'GET',
      path: VAULT_STREAM_PATH,
      handler: async (req, res) => {
        requireDevice(db, req)
        const url = new URL(req.url ?? '/', 'http://localhost')
        const match = VAULT_STREAM_PATH.exec(url.pathname)
        if (match === null) throw new SyncError('bad-request', '缺少 writer')
        const writer = decodeURIComponent(match[1]!)
        if (!validVaultWriter(writer)) throw new SyncError('bad-request', 'writer 非法')
        const from = intParam(url.searchParams.get('from'), 1, 1, Number.MAX_SAFE_INTEGER)
        const limit = intParam(url.searchParams.get('limit'), 200, 1, 500)
        return json(res, 200, { ok: true, value: readVaultStream(db, writer, from, limit) })
      },
    },
    {
      method: 'POST',
      path: /^\/admin\/login$/u,
      handler: async (req, res) => {
        if (!isAdminInitialized(db)) throw new SyncError('conflict', '请先完成初始化')
        const ip = req.socket.remoteAddress ?? 'unknown'
        guardAttempts(`login:${ip}`)
        const body = await readJson(req)
        const password = typeof body.password === 'string' ? body.password : ''
        if (!passwordMatches(password)) {
          noteFailure(`login:${ip}`)
          throw new SyncError('unauthorized', '密码不正确')
        }
        attemptsByKey.delete(`login:${ip}`)
        return json(res, 200, { ok: true, value: { expiresAt: issueAdminSession(res) } })
      },
    },
    {
      method: 'POST',
      path: /^\/admin\/logout$/u,
      handler: async (req, res) => {
        const token = cookieValue(req, ADMIN_COOKIE)
        if (token !== undefined) adminSessionsByKey.delete(hashToken(token))
        writeAdminCookie(res, '', 0)
        return json(res, 200, { ok: true, value: { loggedOut: true } })
      },
    },
    {
      method: 'GET',
      path: /^\/setup\/state$/u,
      handler: async (_req, res) => {
        return json(res, 200, {
          ok: true,
          value: {
            initialized: isAdminInitialized(db),
            hasPassword: adminPassword(db) !== undefined,
            hasQuota: readMeta(db, 'max_bytes') !== undefined,
            devices: listDevices(db).length,
          },
        })
      },
    },
    {
      method: 'POST',
      path: /^\/setup\/verify$/u,
      handler: async (req, res) => {
        if (isAdminInitialized(db)) throw new SyncError('conflict', '已经完成初始化')
        const ip = req.socket.remoteAddress ?? 'unknown'
        guardAttempts(`verify:${ip}`)
        if (onboarding.codeHash === undefined || Date.now() > onboarding.expiresAt) {
          throw new SyncError('unauthorized', '初始化密钥已过期，请重启服务')
        }
        const body = await readJson(req)
        const submitted = normalizeOnboardingCode(typeof body.code === 'string' ? body.code : '')
        const actual = Buffer.from(hashToken(submitted), 'hex')
        const expected = Buffer.from(onboarding.codeHash, 'hex')
        if (submitted.length === 0 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
          noteFailure(`verify:${ip}`)
          throw new SyncError('unauthorized', '初始化密钥不正确')
        }
        attemptsByKey.delete(`verify:${ip}`)
        const token = randomBytes(32).toString('base64url')
        const expiresAt = Date.now() + SETUP_TTL_MS
        setupSessionsByKey.set(hashToken(token), expiresAt)
        writeSetupCookie(res, token, Math.floor(SETUP_TTL_MS / 1000))
        return json(res, 200, { ok: true, value: { expiresAt } })
      },
    },
    {
      method: 'POST',
      path: /^\/setup\/password$/u,
      handler: async (req, res) => {
        requireSetup(req)
        if (isAdminInitialized(db)) throw new SyncError('conflict', '已经完成初始化')
        const body = await readJson(req)
        const problem = validateAdminPassword(body.password)
        if (problem !== undefined) throw new SyncError('bad-request', problem)
        const salt = newSalt()
        setAdminPassword(db, deriveMasterKey(String(body.password), salt).toString('hex'), salt.toString('hex'))
        return json(res, 200, { ok: true, value: { passwordSet: true } })
      },
    },
    {
      method: 'POST',
      path: /^\/setup\/quota$/u,
      handler: async (req, res) => {
        requireSetup(req)
        if (isAdminInitialized(db)) throw new SyncError('conflict', '已经完成初始化')
        const body = await readJson(req)
        if (!Number.isSafeInteger(body.maxBytes)) throw new SyncError('bad-request', '配额必须是整数')
        const maxBytes = Number(body.maxBytes)
        if (maxBytes < MIN_MAX_BYTES || maxBytes > MAX_MAX_BYTES) throw new SyncError('bad-request', '配额超出允许范围')
        writeMaxBytes(db, maxBytes)
        return json(res, 200, { ok: true, value: { maxBytes } })
      },
    },
    {
      method: 'POST',
      path: /^\/setup\/device$/u,
      handler: async (req, res) => {
        requireSetup(req)
        if (isAdminInitialized(db)) throw new SyncError('conflict', '已经完成初始化')
        const body = await readJson(req)
        const label = typeof body.label === 'string' && body.label.trim() !== '' ? body.label.trim() : 'device'
        return json(res, 201, { ok: true, value: createDevice(db, label) })
      },
    },
    {
      method: 'POST',
      path: /^\/setup\/complete$/u,
      handler: async (req, res) => {
        requireSetup(req)
        if (isAdminInitialized(db)) throw new SyncError('conflict', '已经完成初始化')
        if (adminPassword(db) === undefined) throw new SyncError('conflict', '请先设置密码')
        markAdminInitialized(db)
        onboarding.expiresAt = 0
        setupSessionsByKey.clear()
        writeSetupCookie(res, '', 0)
        return json(res, 200, { ok: true, value: { redirect: '/admin', expiresAt: issueAdminSession(res) } })
      },
    },
    {
      method: 'POST',
      path: /^\/admin\/quota$/u,
      handler: async (req, res) => {
        requireAdmin(req)
        const body = await readJson(req)
        if (!Number.isSafeInteger(body.maxBytes)) throw new SyncError('bad-request', '配额必须是整数')
        const maxBytes = Number(body.maxBytes)
        if (maxBytes < MIN_MAX_BYTES || maxBytes > MAX_MAX_BYTES) throw new SyncError('bad-request', '配额超出允许范围')
        writeMaxBytes(db, maxBytes)
        return json(res, 200, { ok: true, value: { maxBytes } })
      },
    },
    {
      method: 'GET',
      path: /^\/admin\/overview$/u,
      handler: async (req, res) => {
        requireAdmin(req)
        const counts = sessionCounts(db)
        return json(res, 200, {
          ok: true,
          value: {
            version,
            protocol: PROTOCOL_VERSION,
            revision: readRevision(db),
            devices: listDevices(db).length,
            sessions: counts.total,
            deletedSessions: counts.deleted,
            usedBytes: usedBlobBytes(db),
            maxBytes: effectiveMaxBytes(),
          },
        })
      },
    },
    {
      method: 'GET',
      path: /^\/admin\/devices$/u,
      handler: async (req, res) => {
        requireAdmin(req)
        return json(res, 200, { ok: true, value: listDevices(db) })
      },
    },
    {
      method: 'POST',
      path: /^\/admin\/devices$/u,
      handler: async (req, res) => {
        requireAdmin(req)
        const body = await readJson(req)
        const label = typeof body.label === 'string' && body.label.trim() !== '' ? body.label.trim() : 'device'
        return json(res, 201, { ok: true, value: createDevice(db, label) })
      },
    },
    {
      method: 'DELETE',
      path: ADMIN_DEVICE_PATH,
      handler: async (req, res) => {
        requireAdmin(req)
        const match = ADMIN_DEVICE_PATH.exec(new URL(req.url ?? '/', 'http://localhost').pathname)
        if (match === null) return json(res, 404, errorBody('not-found', '没有这个设备'))
        return revokeDevice(db, match[1]!)
          ? json(res, 200, { ok: true, value: { deviceId: match[1], revoked: true } })
          : json(res, 404, errorBody('not-found', '没有这个设备'))
      },
    },
    {
      method: 'GET',
      path: /^\/admin\/sessions$/u,
      handler: async (req, res) => {
        requireAdmin(req)
        return json(res, 200, { ok: true, value: adminSessions(db) })
      },
    },
    {
      method: 'GET',
      path: /^\/v1\/me$/,
      handler: async (req, res) => {
        const auth = authenticate(db, req)
        if (auth === undefined) return json(res, 401, errorBody('unauthorized', '未知 token'))
        if (auth.role === 'admin') return json(res, 200, { ok: true, value: { role: 'admin' } })
        return json(res, 200, { ok: true, value: { role: 'device', device: auth.device } })
      },
    },
  ]

  return createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/' && req.method === 'GET') {
      res.writeHead(302, { location: '/admin' })
      res.end()
      return
    }
    if ((path === '/admin' || path === '/admin/') && req.method === 'GET') {
      if (!isAdminInitialized(db)) {
        res.writeHead(302, { location: '/setup' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(ADMIN_PAGE)
      return
    }
    if ((path === '/setup' || path === '/setup/') && req.method === 'GET') {
      if (isAdminInitialized(db)) {
        res.writeHead(302, { location: '/admin' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(SETUP_PAGE)
      return
    }
    if (path === '/logo.svg' && LOGO_SVG !== undefined) {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' })
      res.end(LOGO_SVG)
      return
    }
    if (path === '/favicon.svg' && FAVICON_SVG !== undefined) {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' })
      res.end(FAVICON_SVG)
      return
    }
    const route = routes.find((candidate) => candidate.method === req.method && candidate.path.test(path))
    if (route === undefined) {
      json(res, 404, errorBody('not-found', `没有 ${req.method ?? 'GET'} ${path} 这条路由`))
      return
    }
    void route.handler(req, res).catch((error: unknown) => {
      const sync = error instanceof SyncError ? error : undefined
      const code = sync?.code ?? 'bad-request'
      const message = sync?.message ?? (error instanceof Error ? error.message : String(error))
      json(res, statusOf(code), errorBody(code, message))
    })
  })
}
