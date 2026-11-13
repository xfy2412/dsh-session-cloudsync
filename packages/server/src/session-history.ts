/**
 * 会话变更历史：只记录服务端可见的元数据，不接触会话内容。
 *
 * 事件由 append、设备删除与管理台生命周期操作写入；历史在会话删除/重置后保留。
 *
 * @module @dsh-session-cloudsync/server/session-history
 */
import { DEFAULT_DATASET, type ServerDb } from './db.ts'

/** 历史事件类型。 */
export type SessionEventKind = 'create' | 'append' | 'device-delete' | 'archive' | 'remove' | 'reset' | 'restore'

/** 写入一条会话事件。 */
export interface SessionEventInput {
  readonly sessionId: string
  readonly at: number
  readonly kind: SessionEventKind
  readonly deviceId?: string | null
  readonly actorKind: 'device' | 'admin' | 'system'
  readonly actorId: string
  readonly events?: number
  readonly bytes?: number
  readonly seqFrom?: number | null
  readonly seqTo?: number | null
  readonly batchCount?: number
  readonly lastSeq?: number | null
  readonly storedBytes?: number | null
  readonly detail?: unknown
}

/** 读出的会话事件。 */
export interface SessionEvent {
  readonly id: number
  readonly sessionId: string
  readonly at: number
  readonly kind: SessionEventKind
  readonly deviceId: string | null
  readonly deviceLabel: string | null
  readonly deviceColor: string | null
  readonly actorKind: 'device' | 'admin' | 'system'
  readonly actorId: string
  readonly actorLabel: string
  readonly events: number
  readonly bytes: number
  readonly seqFrom: number | null
  readonly seqTo: number | null
  readonly batchCount: number
  readonly lastSeq: number | null
  readonly storedBytes: number | null
  readonly detail: unknown
}

/** 历史摘要。 */
export interface SessionHistorySummary {
  readonly events: number
  readonly bytes: number
  readonly batches: number
  readonly appends: number
  readonly devices: number
  readonly firstAt: number | null
  readonly lastAt: number | null
  readonly maxBatchEvents: number
}

/**
 * 写一条会话历史事件。
 * @param db - 已打开的数据库。
 * @param input - 事件内容。
 */
export function recordSessionEvent(db: ServerDb, input: SessionEventInput): void {
  db.handle
    .prepare(`INSERT INTO session_events
      (dataset, session_id, at, kind, device_id, actor_kind, actor_id, events, bytes, seq_from, seq_to,
       batch_count, last_seq, stored_bytes, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      DEFAULT_DATASET,
      input.sessionId,
      input.at,
      input.kind,
      input.deviceId ?? null,
      input.actorKind,
      input.actorId,
      Math.max(0, Math.trunc(input.events ?? 0)),
      Math.max(0, Math.trunc(input.bytes ?? 0)),
      input.seqFrom ?? null,
      input.seqTo ?? null,
      Math.max(0, Math.trunc(input.batchCount ?? 0)),
      input.lastSeq ?? null,
      input.storedBytes ?? null,
      input.detail === undefined ? null : JSON.stringify(input.detail),
    )
}

/**
 * 读会话历史；按 id 倒序分页。摘要覆盖全部历史，不受分页影响。
 * @param db - 已打开的数据库。
 * @param sessionId - 会话 id。
 * @param options - 条数、游标。
 * @returns 事件、摘要与下一页游标。
 */
export function listSessionHistory(
  db: ServerDb,
  sessionId: string,
  options: { readonly limit?: number; readonly before?: number } = {},
): { events: SessionEvent[]; summary: SessionHistorySummary; nextBefore: number | null } {
  const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 100)))
  const before = options.before !== undefined && Number.isSafeInteger(options.before) ? options.before : undefined
  const rows = db.handle
    .prepare(`SELECT e.id, e.session_id, e.at, e.kind, e.device_id, e.actor_kind, e.actor_id,
                     e.events, e.bytes, e.seq_from, e.seq_to, e.batch_count, e.last_seq, e.stored_bytes, e.detail,
                     d.label AS device_label, d.color AS device_color
              FROM session_events e
              LEFT JOIN devices d ON d.dataset = e.dataset AND d.device_id = e.device_id
              WHERE e.dataset = ? AND e.session_id = ? ${before === undefined ? '' : 'AND e.id < ?'}
              ORDER BY e.id DESC LIMIT ?`)
    .all(...[DEFAULT_DATASET, sessionId, ...before === undefined ? [] : [before], limit]) as unknown as Array<{
      id: number
      session_id: string
      at: number
      kind: SessionEventKind
      device_id: string | null
      actor_kind: 'device' | 'admin' | 'system'
      actor_id: string
      events: number
      bytes: number
      seq_from: number | null
      seq_to: number | null
      batch_count: number
      last_seq: number | null
      stored_bytes: number | null
      detail: string | null
      device_label: string | null
      device_color: string | null
    }>
  const events = rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    at: row.at,
    kind: row.kind,
    deviceId: row.device_id,
    deviceLabel: row.device_label,
    deviceColor: row.device_color,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    actorLabel: row.actor_kind === 'admin' ? '管理台' : row.actor_kind === 'system' ? '系统' : row.device_label ?? row.actor_id,
    events: Number(row.events ?? 0),
    bytes: Number(row.bytes ?? 0),
    seqFrom: row.seq_from,
    seqTo: row.seq_to,
    batchCount: Number(row.batch_count ?? 0),
    lastSeq: row.last_seq,
    storedBytes: row.stored_bytes,
    detail: row.detail === null ? null : parseDetail(row.detail),
  }))
  const summaryRow = db.handle
    .prepare(`SELECT COALESCE(SUM(events), 0) AS events, COALESCE(SUM(bytes), 0) AS bytes,
                     COALESCE(SUM(batch_count), 0) AS batches,
                     COALESCE(SUM(CASE WHEN kind IN ('create', 'append') THEN 1 ELSE 0 END), 0) AS appends,
                     COUNT(DISTINCT device_id) AS devices,
                     MIN(at) AS first_at, MAX(at) AS last_at,
                     COALESCE(MAX(events), 0) AS max_batch_events
              FROM session_events WHERE dataset = ? AND session_id = ?`)
    .get(DEFAULT_DATASET, sessionId) as {
      events?: number
      bytes?: number
      batches?: number
      appends?: number
      devices?: number
      first_at?: number | null
      last_at?: number | null
      max_batch_events?: number
    } | undefined
  return {
    events,
    summary: {
      events: Number(summaryRow?.events ?? 0),
      bytes: Number(summaryRow?.bytes ?? 0),
      batches: Number(summaryRow?.batches ?? 0),
      appends: Number(summaryRow?.appends ?? 0),
      devices: Number(summaryRow?.devices ?? 0),
      firstAt: summaryRow?.first_at ?? null,
      lastAt: summaryRow?.last_at ?? null,
      maxBatchEvents: Number(summaryRow?.max_batch_events ?? 0),
    },
    nextBefore: rows.length === limit ? rows[rows.length - 1]!.id : null,
  }
}

/** 一天的聚合活动。 */
export interface ActivityDay {
  readonly day: string
  readonly events: number
  readonly bytes: number
  readonly appends: number
  readonly sessions: number
  readonly devices: number
}

/**
 * 按天聚合 append/create 事件；结果按 day 升序，只包含有活动的天。
 * @param db - 已打开的数据库。
 * @param query - 时间范围、时区偏移与过滤。
 * @returns 按天聚合。
 */
export function listActivity(
  db: ServerDb,
  query: {
    readonly from: number
    readonly to: number
    readonly tzOffset?: number
    readonly deviceId?: string
    readonly sessionId?: string
  },
): { days: ActivityDay[] } {
  const offsetMs = Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(query.tzOffset ?? 0))) * 60_000
  const where = [
    'e.dataset = ?',
    "e.kind IN ('create', 'append')",
    'e.at >= ?',
    'e.at < ?',
  ]
  const params: Array<string | number> = [DEFAULT_DATASET, Math.trunc(query.from), Math.trunc(query.to)]
  if (query.deviceId !== undefined && query.deviceId !== '') {
    where.push('e.device_id = ?')
    params.push(query.deviceId)
  }
  if (query.sessionId !== undefined && query.sessionId !== '') {
    where.push('e.session_id = ?')
    params.push(query.sessionId)
  }
  const rows = db.handle
    .prepare(`SELECT date((e.at + ?) / 1000, 'unixepoch') AS day,
                     COALESCE(SUM(e.events), 0) AS events,
                     COALESCE(SUM(e.bytes), 0) AS bytes,
                     COUNT(*) AS appends,
                     COUNT(DISTINCT e.session_id) AS sessions,
                     COUNT(DISTINCT e.device_id) AS devices
              FROM session_events e
              WHERE ${where.join(' AND ')}
              GROUP BY day ORDER BY day ASC`)
    .all(offsetMs, ...params) as unknown as Array<{
      day: string
      events: number
      bytes: number
      appends: number
      sessions: number
      devices: number
    }>
  return {
    days: rows.map((row) => ({
      day: row.day,
      events: Number(row.events ?? 0),
      bytes: Number(row.bytes ?? 0),
      appends: Number(row.appends ?? 0),
      sessions: Number(row.sessions ?? 0),
      devices: Number(row.devices ?? 0),
    })),
  }
}

/** 某一天参与同步的会话。 */
export interface ActivitySession {
  readonly sessionId: string
  readonly events: number
  readonly bytes: number
  readonly appends: number
}

/**
 * 列出某一天有 append/create 活动的会话。
 * @param db - 已打开的数据库。
 * @param query - 本地日期与浏览器时区偏移。
 * @returns 会话聚合。
 */
export function listActivitySessions(
  db: ServerDb,
  query: { readonly day: string; readonly tzOffset?: number },
): { sessions: ActivitySession[] } {
  const offsetMs = Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(query.tzOffset ?? 0))) * 60_000
  const rows = db.handle
    .prepare(`SELECT e.session_id, COALESCE(SUM(e.events), 0) AS events,
                     COALESCE(SUM(e.bytes), 0) AS bytes, COUNT(*) AS appends
              FROM session_events e
              WHERE e.dataset = ? AND e.kind IN ('create', 'append')
                AND date((e.at + ?) / 1000, 'unixepoch') = ?
              GROUP BY e.session_id ORDER BY events DESC`)
    .all(DEFAULT_DATASET, offsetMs, query.day) as unknown as Array<{
      session_id: string
      events: number
      bytes: number
      appends: number
    }>
  return {
    sessions: rows.map((row) => ({
      sessionId: row.session_id,
      events: Number(row.events ?? 0),
      bytes: Number(row.bytes ?? 0),
      appends: Number(row.appends ?? 0),
    })),
  }
}

/**
 * 解析 detail JSON；损坏时保留原文。
 * @param raw - 原始文本。
 * @returns 解析后的值。
 */
function parseDetail(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}
