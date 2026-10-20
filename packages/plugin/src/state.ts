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
import type { PendingApply } from './engine.ts'

/** 状态文件格式版本。 */
export const STATE_VERSION = 1

/** 拉取状态。 */
export interface PullJournal {
  readonly version: 1
  readonly revision: number
  readonly pending?: PendingApply
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
  const pending = record['pending']
  if (pending === undefined) return { version: STATE_VERSION, revision: revision as number }
  if (pending === null || typeof pending !== 'object' || Array.isArray(pending)) return { version: STATE_VERSION, revision: revision as number }
  const entry = pending as Record<string, unknown>
  const sessionId = entry['sessionId']
  const targetSeq = entry['targetSeq']
  const at = entry['at']
  if (typeof sessionId !== 'string' || sessionId === ''
    || !Number.isSafeInteger(targetSeq) || (targetSeq as number) < -1
    || !Number.isSafeInteger(at)) {
    return { version: STATE_VERSION, revision: revision as number }
  }
  return {
    version: STATE_VERSION,
    revision: revision as number,
    pending: { sessionId, targetSeq: targetSeq as number, at: at as number },
  }
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
