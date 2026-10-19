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
import { DEFAULT_DATASET, readMeta, type ServerDb } from './db.ts'

/** `/v1/health` 报告的版本。 */
export const SERVER_VERSION = '0.0.0'

/** {@link createHttpServer} 的选项。 */
export interface ServerOptions {
  readonly db: ServerDb
  readonly dataDir: string
  readonly version?: string
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
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > 64 * 1024) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
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
      const message = error instanceof Error ? error.message : String(error)
      json(res, 400, errorBody('bad-request', message))
    })
  })
}
