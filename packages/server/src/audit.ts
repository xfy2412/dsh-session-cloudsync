/**
 * 管理端审计日志：记录登录、设备、配额、初始化与会话删除等动作。
 *
 * 只记录元数据；调用方负责确保 `detail` 里不含 token、口令或会话内容。
 *
 * @module @dsh-session-cloudsync/server/audit
 */
import type { IncomingMessage } from 'node:http'
import { DEFAULT_DATASET, type ServerDb } from './db.ts'

/** 动作发起方。 */
export type AuditActorKind = 'admin' | 'device' | 'system'

/** 写入一条审计事件。 */
export interface AuditInput {
  readonly actorKind: AuditActorKind
  readonly actorId: string
  readonly action: string
  readonly target?: string
  readonly detail?: unknown
}

/** 读出的审计事件。 */
export interface AuditEvent {
  readonly id: number
  readonly at: number
  readonly actorKind: AuditActorKind
  readonly actorId: string
  readonly actorLabel: string
  readonly action: string
  readonly target: string | null
  readonly detail: unknown
  readonly ip: string | null
  readonly userAgent: string | null
}

/** 审计列表查询参数。 */
export interface AuditQuery {
  readonly limit?: number
  readonly before?: number
  readonly action?: string
}

/**
 * 取出请求的 IP 与 User-Agent；仅用于审计展示。
 * @param req - 收到的请求。
 * @returns IP 与 UA。
 */
function requestMeta(req: IncomingMessage | undefined): { ip: string | null; userAgent: string | null } {
  if (req === undefined) return { ip: null, userAgent: null }
  const forwarded = req.headers['x-forwarded-for']
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded
  const ip = first !== undefined && first.trim() !== ''
    ? first.split(',')[0]!.trim()
    : req.socket.remoteAddress ?? null
  const agent = req.headers['user-agent']
  const userAgent = typeof agent === 'string' && agent !== '' ? agent.slice(0, 300) : null
  return { ip, userAgent }
}

/**
 * 写一条审计事件。失败时静默忽略，不能影响主操作。
 * @param db - 已打开的数据库。
 * @param input - 事件内容。
 * @param req - 用于记录 IP/UA 的请求。
 */
export function recordAudit(db: ServerDb, input: AuditInput, req?: IncomingMessage): void {
  try {
    const meta = requestMeta(req)
    db.handle
      .prepare(`INSERT INTO audit_events (dataset, at, actor_kind, actor_id, action, target, detail, ip, user_agent)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        DEFAULT_DATASET,
        Date.now(),
        input.actorKind,
        input.actorId,
        input.action,
        input.target ?? null,
        input.detail === undefined ? null : JSON.stringify(input.detail),
        meta.ip,
        meta.userAgent,
      )
  } catch {
    // 审计失败不阻断业务；真正的错误已经由主流程返回。
  }
}

/**
 * 读审计事件，按 id 倒序分页。
 * @param db - 已打开的数据库。
 * @param query - 条数、游标与动作过滤。
 * @returns 事件与下一页游标。
 */
export function listAudit(db: ServerDb, query: AuditQuery = {}): {
  events: AuditEvent[]
  nextBefore: number | null
} {
  const limit = Math.min(200, Math.max(1, Math.trunc(query.limit ?? 50)))
  const where: string[] = ['e.dataset = ?']
  const params: Array<string | number> = [DEFAULT_DATASET]
  if (query.before !== undefined && Number.isSafeInteger(query.before)) {
    where.push('e.id < ?')
    params.push(query.before)
  }
  if (query.action !== undefined && query.action !== '') {
    where.push('e.action = ?')
    params.push(query.action)
  }
  params.push(limit)
  const rows = db.handle
    .prepare(`SELECT e.id, e.at, e.actor_kind, e.actor_id, e.action, e.target, e.detail, e.ip, e.user_agent,
                     d.label AS actor_label
              FROM audit_events e
              LEFT JOIN devices d ON d.dataset = e.dataset AND d.device_id = e.actor_id
              WHERE ${where.join(' AND ')}
              ORDER BY e.id DESC LIMIT ?`)
    .all(...params) as unknown as Array<{
      id: number
      at: number
      actor_kind: AuditActorKind
      actor_id: string
      actor_label: string | null
      action: string
      target: string | null
      detail: string | null
      ip: string | null
      user_agent: string | null
    }>
  const events = rows.map((row) => ({
    id: row.id,
    at: row.at,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    actorLabel: row.actor_kind === 'admin'
      ? '管理台'
      : row.actor_kind === 'system'
        ? '系统'
        : row.actor_label ?? row.actor_id,
    action: row.action,
    target: row.target,
    detail: row.detail === null ? null : parseDetail(row.detail),
    ip: row.ip,
    userAgent: row.user_agent,
  }))
  return {
    events,
    nextBefore: rows.length === limit ? rows[rows.length - 1]!.id : null,
  }
}

/**
 * 尽量把 detail 还原成对象；非法 JSON 保留原文。
 * @param raw - 存储的 JSON 文本。
 * @returns 解析后的值。
 */
function parseDetail(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}
