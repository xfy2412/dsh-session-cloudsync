/**
 * 自部署同步服务的 HTTP 面。
 *
 * 认证是 bearer token，分两种角色：首次启动生成的 setup token 管理设备，
 * 设备 token 代表一台设备。本脚手架只提供健康检查与设备管理；
 * 会话/帧端点随同步引擎一起落地。
 *
 * @module @dsh-session-sync/server/http
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { API_PREFIX, PROTOCOL_VERSION, errorBody, type DeviceRef } from '../../shared/src/protocol.ts'
import { SyncError, statusOf } from '../../shared/src/wire.ts'
import { hasBlob, putBlob, readBlob } from './blobs.ts'
import { DEFAULT_DATASET, blobRecord, readMeta, recordBlob, usedBlobBytes, type ServerDb } from './db.ts'
import {
  MAX_APPEND_BODY_BYTES,
  acquireLease,
  appendFrames,
  deleteSession,
  getManifest,
  listChanges,
  listFrames,
  releaseLease,
} from './sessions.ts'
import type { SealedFrameRef } from '../../shared/src/sealed-frame.ts'

/** `/v1/health` 报告的版本。 */
export const SERVER_VERSION = '0.0.0'

/** 默认存储上限：10 GiB。 */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 * 1024

/** 默认单个 blob 上限：32 MiB。 */
export const DEFAULT_MAX_BLOB_BYTES = 32 * 1024 * 1024

/** {@link createHttpServer} 的选项。 */
export interface ServerOptions {
  readonly db: ServerDb
  readonly dataDir: string
  readonly version?: string
  readonly maxBytes?: number
  readonly maxBlobBytes?: number
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
} {
  if (!Number.isSafeInteger(body.baseIndex)) throw new SyncError('bad-request', 'baseIndex 必须是整数')
  const baseChainHash = body.baseChainHash
  if (baseChainHash !== null && (typeof baseChainHash !== 'string' || !/^[0-9a-f]{64}$/u.test(baseChainHash))) {
    throw new SyncError('bad-request', 'baseChainHash 必须是 64 位十六进制或 null')
  }
  if (!Number.isSafeInteger(body.createdAt) || Number(body.createdAt) < 0) throw new SyncError('bad-request', 'createdAt 必须是非负整数')
  if (!Number.isSafeInteger(body.formatVersion) || Number(body.formatVersion) < 1) throw new SyncError('bad-request', 'formatVersion 必须是正整数')
  if (!Array.isArray(body.frames)) throw new SyncError('bad-request', 'frames 必须是数组')
  return {
    baseIndex: Number(body.baseIndex),
    baseChainHash: baseChainHash as string | null,
    createdAt: Number(body.createdAt),
    formatVersion: Number(body.formatVersion),
    frames: body.frames as SealedFrameRef[],
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
const FRAMES_PATH = /^\/v1\/sessions\/([^/]+)\/frames$/u
const CURSOR_PATH = /^\/v1\/cursor$/u

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
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES

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
        if (kind !== 'frame' && kind !== 'attachment') {
          return json(res, 400, errorBody('bad-request', 'kind 只能是 frame 或 attachment'))
        }
        const bytes = await readRaw(req, maxBlobBytes)
        if (bytes.length === 0) return json(res, 400, errorBody('bad-request', 'blob 不能为空'))
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const existing = blobRecord(db, sha256)
        if (existing !== undefined) return json(res, 200, { ok: true, value: { sha256, bytes: existing.bytes, dedup: true } })
        const used = usedBlobBytes(db)
        if (used + bytes.length > maxBytes) {
          throw new SyncError('quota', `存储超额：已用 ${used} 字节，上限 ${maxBytes} 字节`)
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
        const id = sessionIdFrom(new URL(req.url ?? '/', 'http://localhost').pathname, LEASE_PATH)
        return json(res, 200, { ok: true, value: acquireLease(db, id, device.deviceId) })
      },
    },
    {
      method: 'DELETE',
      path: LEASE_PATH,
      handler: async (req, res) => {
        const device = requireDevice(db, req)
        const id = sessionIdFrom(new URL(req.url ?? '/', 'http://localhost').pathname, LEASE_PATH)
        return json(res, 200, { ok: true, value: { released: releaseLease(db, id, device.deviceId) } })
      },
    },
    {
      method: 'POST',
      path: APPEND_PATH,
      handler: async (req, res) => {
        const device = requireDevice(db, req)
        const id = sessionIdFrom(new URL(req.url ?? '/', 'http://localhost').pathname, APPEND_PATH)
        const body = await readJson(req, MAX_APPEND_BODY_BYTES)
        const parsed = parseAppend(body)
        const value = appendFrames(db, options.dataDir, { sessionId: id, deviceId: device.deviceId, ...parsed })
        return json(res, 200, { ok: true, value })
      },
    },
    {
      method: 'POST',
      path: DELETE_PATH,
      handler: async (req, res) => {
        const device = requireDevice(db, req)
        const id = sessionIdFrom(new URL(req.url ?? '/', 'http://localhost').pathname, DELETE_PATH)
        const body = await readJson(req)
        if (!Number.isSafeInteger(body.createdAt)) throw new SyncError('bad-request', 'createdAt 必须是整数')
        return json(res, 200, { ok: true, value: deleteSession(db, id, device.deviceId, Number(body.createdAt)) })
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
        return json(res, 200, { ok: true, value: found })
      },
    },
    {
      method: 'GET',
      path: FRAMES_PATH,
      handler: async (req, res) => {
        requireDevice(db, req)
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = sessionIdFrom(url.pathname, FRAMES_PATH)
        const found = listFrames(db, id, intParam(url.searchParams.get('from'), 0, 0, Number.MAX_SAFE_INTEGER), intParam(url.searchParams.get('limit'), 500, 1, 1000))
        if (found === undefined) return json(res, 404, errorBody('not-found', `没有会话 ${id}`))
        return json(res, 200, { ok: true, value: found })
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
    if (!path.startsWith(API_PREFIX)) {
      json(res, 404, errorBody('not-found', `没有 ${req.method ?? 'GET'} ${path} 这条路由`))
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
