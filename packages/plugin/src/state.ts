/**
 * 插件持久化状态：拉取 revision 与未完成的 pending。
 *
 * 文件很小，写入用临时文件 + rename 原子替换；解析失败视为空状态，避免
 * 一个损坏的 state.json 阻塞整个插件。
 *
 * @module dsh-session-sync/state
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BlockedDecision, BlockedSessionState, PendingApply } from './engine.ts'

/** 状态文件格式版本。 */
export const STATE_VERSION = 1

/** 拉取状态。 */
export interface PullJournal {
  readonly version: 1
  readonly revision: number
  readonly pending?: PendingApply
  readonly cwdPending?: readonly string[]
  readonly blocked?: readonly BlockedSessionState[]
  readonly blockedDecisions?: readonly BlockedDecision[]
}

/**
 * 读取状态文件；不存在或损坏时返回 revision=0 的空状态。
 * @param file - 状态文件路径。
 * @returns 拉取状态。
 */
export function readPullJournal(file: string): PullJournal {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { version: STATE_VERSION, revision: 0 }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { version: STATE_VERSION, revision: 0 }
  const record = parsed as Record<string, unknown>
  const revision = record['revision']
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) return { version: STATE_VERSION, revision: 0 }
  const cwdPending = Array.isArray(record['cwdPending'])
    ? record['cwdPending'].filter((id): id is string => typeof id === 'string' && id !== '')
    : undefined
  const blocked = blockedFrom(record['blocked'])
  const blockedDecisions = decisionsFrom(record['blockedDecisions'])
  const extra = {
    ...cwdPending === undefined || cwdPending.length === 0 ? {} : { cwdPending },
    ...blocked === undefined ? {} : { blocked },
    ...blockedDecisions === undefined ? {} : { blockedDecisions },
  }
  const pending = record['pending']
  if (pending === undefined) {
    return { version: STATE_VERSION, revision: revision as number, ...extra }
  }
  if (pending === null || typeof pending !== 'object' || Array.isArray(pending)) {
    return { version: STATE_VERSION, revision: revision as number, ...extra }
  }
  const entry = pending as Record<string, unknown>
  const sessionId = entry['sessionId']
  const targetSeq = entry['targetSeq']
  const at = entry['at']
  if (typeof sessionId !== 'string' || sessionId === ''
    || !Number.isSafeInteger(targetSeq) || (targetSeq as number) < -1
    || !Number.isSafeInteger(at)) {
    return { version: STATE_VERSION, revision: revision as number, ...extra }
  }
  return {
    version: STATE_VERSION,
    revision: revision as number,
    pending: { sessionId, targetSeq: targetSeq as number, at: at as number },
    ...extra,
  }
}

/** 只接受当前已定义的阻塞类型，损坏记录静默丢弃。 */
function blockedFrom(value: unknown): readonly BlockedSessionState[] | undefined {
  if (!Array.isArray(value)) return undefined
  const blocked: BlockedSessionState[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const entry = item as Record<string, unknown>
    const sessionId = entry['sessionId']
    const kind = entry['kind']
    const message = entry['message']
    const at = entry['at']
    const createdAt = entry['createdAt']
    const formatVersion = entry['formatVersion']
    if (typeof sessionId !== 'string' || sessionId === ''
      || kind !== 'diverged'
      || typeof message !== 'string' || message === ''
      || !Number.isSafeInteger(at)
      || !Number.isSafeInteger(createdAt)
      || !Number.isSafeInteger(formatVersion)) continue
    blocked.push({
      sessionId, kind, message, at: at as number,
      createdAt: createdAt as number,
      formatVersion: formatVersion as number,
    })
  }
  return blocked.length === 0 ? undefined : blocked
}

/** 解析用户的分叉决定；损坏记录不阻止启动。 */
function decisionsFrom(value: unknown): readonly BlockedDecision[] | undefined {
  if (!Array.isArray(value)) return undefined
  const decisions: BlockedDecision[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const entry = item as Record<string, unknown>
    const sessionId = entry['sessionId']
    const action = entry['action']
    const at = entry['at']
    const createdAt = entry['createdAt']
    const formatVersion = entry['formatVersion']
    const message = entry['message']
    if (typeof sessionId !== 'string' || sessionId === ''
      || (action !== 'ignore' && action !== 'force')
      || !Number.isSafeInteger(at)
      || !Number.isSafeInteger(createdAt)
      || !Number.isSafeInteger(formatVersion)
      || typeof message !== 'string' || message === '') continue
    decisions.push({
      sessionId, action, at: at as number,
      createdAt: createdAt as number,
      formatVersion: formatVersion as number,
      message,
    })
  }
  return decisions.length === 0 ? undefined : decisions
}

/**
 * 原子写入状态文件。
 * @param file - 状态文件路径。
 * @param journal - 要写入的状态。
 */
export function writePullJournal(file: string, journal: PullJournal): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(journal)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}
