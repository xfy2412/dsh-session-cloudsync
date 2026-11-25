/**
 * 注入笔记摘要的消息与去重。
 *
 * 用 `source.hash` 标记最近一次注入的渲染文本；首 turn、hash 变化、或之后发生
 * 上下文压缩时重新注入。消息走 `agent/pre-step`，只在用户 turn 落盘。
 *
 * @module dsh-session-cloudsync/note-notice
 */
import { randomUUID } from 'node:crypto'
import type { NotesContext } from './notes.ts'
import type { SessionEventLike } from './device-notice.ts'

/** 本插件注入消息的 source.kind。 */
export const NOTE_SOURCE_KIND = 'session-cloudsync'

/** 注入消息的 source.form；用 notice 走提示行，不影响会话列表。 */
export const NOTE_SOURCE_FORM = 'notice'

/** 笔记摘要消息。 */
export interface NotesContextMessage {
  readonly role: 'user'
  readonly id: string
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly source: {
    readonly kind: typeof NOTE_SOURCE_KIND
    readonly form: typeof NOTE_SOURCE_FORM
    readonly summary: string
    readonly hash: string
    readonly noteCount: number
  }
}

/**
 * 构造一条 notes 摘要消息。
 * @param context - `renderNotesContext()` 的结果。
 * @param id - 消息 id；测试可传固定值。
 */
export function noteContextMessage(context: NotesContext, id: string = randomUUID()): NotesContextMessage {
  const count = context.count
  return {
    role: 'user',
    id,
    content: [{
      type: 'text',
      text: context.text === ''
        ? '<notes-context version="2">\n当前没有可用笔记。\n</notes-context>'
        : context.text,
    }],
    source: {
      kind: NOTE_SOURCE_KIND,
      form: NOTE_SOURCE_FORM,
      summary: count === 0 ? '当前没有笔记' : `已带入 ${count} 条笔记`,
      hash: context.hash,
      noteCount: count,
    },
  }
}

/**
 * 找最近一条带 hash 的本插件注入消息。
 * @param events - `session.snapshotEvents()`。
 * @returns 索引与 hash；没有时 undefined。
 */
export function lastNotesMarker(events: readonly SessionEventLike[]): { readonly index: number; readonly hash: string } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'user/message') continue
    if (event.data === null || typeof event.data !== 'object') continue
    const source = (event.data as { readonly source?: unknown }).source
    if (source === null || typeof source !== 'object') continue
    const record = source as Record<string, unknown>
    if (record['kind'] !== NOTE_SOURCE_KIND) continue
    if (typeof record['hash'] !== 'string' || record['hash'] === '') continue
    return { index, hash: record['hash'] }
  }
  return undefined
}

/**
 * 最近一条 notes 注入之后是否发生过成功完成的上下文压缩。
 * @param events - 会话事件。
 * @param markerIndex - 注入消息索引。
 */
export function hasCompactionAfter(events: readonly SessionEventLike[], markerIndex: number): boolean {
  for (let index = markerIndex + 1; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'compaction/end') continue
    if (event.data !== null && typeof event.data === 'object') {
      const error = (event.data as { readonly error?: unknown }).error
      if (error !== undefined && error !== null && error !== '') continue
    }
    return true
  }
  return false
}

/**
 * 是否需要注入。
 * @param events - 会话事件。
 * @param hash - 当前渲染文本的 hash。
 * @param hasNotes - 当前是否有可用笔记（空摘要也允许在删除后注入一次空标记）。
 */
export function shouldInjectNotes(events: readonly SessionEventLike[], hash: string, hasNotes: boolean): boolean {
  const marker = lastNotesMarker(events)
  if (marker === undefined) return hasNotes
  if (marker.hash !== hash) return true
  return hasCompactionAfter(events, marker.index)
}

/** 把 notes 摘要插到决策消息最前面。 */
export function prependNotes<T extends { readonly messages: readonly unknown[] }>(decision: T, message: NotesContextMessage): T {
  return { ...decision, messages: [message, ...decision.messages] }
}
