/**
 * L3 agent 笔记的纯模型：校验、thread 折叠、摘要提取和注入渲染。
 *
 * 这里不碰文件、不碰网络；宿主层负责 device 本机存储、Vault append 和权限。
 * 所有写入都按 append-only 处理：修正 = 同 threadId 追加，删除 = 一条 deleted 记录。
 *
 * @module dsh-session-cloudsync/notes
 */
import { createHash } from 'node:crypto'

/** 笔记作用域：属于哪个上下文。 */
export type NoteScope = 'session' | 'workspace' | 'global'

/** 笔记存储：本机还是跨设备 Vault。 */
export type NoteStorage = 'device' | 'vault'

/** 作者类型；agent 不能修改用户笔记。 */
export type NoteAuthorKind = 'agent' | 'user'

/** 单条正文上限（UTF-8 字节）。 */
export const NOTE_TEXT_MAX_BYTES = 8 * 1024
/** 标题上限（字符）。 */
export const NOTE_TITLE_MAX_CHARS = 80
/** 摘要上限（字符）。 */
export const NOTE_SUMMARY_MAX_CHARS = 200
/** 单条注入预算上限（UTF-8 字节）。 */
export const NOTES_CONTEXT_MAX_BYTES = 2 * 1024
/** 每个 scope 的条数上限。 */
export const NOTE_LIMITS = {
  session: 50,
  workspace: 200,
  global: 100,
  device: 100,
} as const
/** 标签数量/单个标签长度。 */
const MAX_TAGS = 16
const MAX_TAG_CHARS = 32
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u

/** 一条不可变的笔记记录。 */
export interface NoteRecord {
  readonly id: string
  readonly at: number
  readonly scope: NoteScope
  readonly scopeKey: string
  readonly storage: NoteStorage
  readonly deviceId: string
  readonly authorKind: NoteAuthorKind
  readonly author?: {
    readonly sessionId?: string
    readonly agentPreset?: string
  }
  readonly title: string
  /** 自动注入用的短摘要；空时由正文提取。 */
  readonly summary: string
  readonly text: string
  readonly tags: readonly string[]
  readonly pinned: boolean
  readonly threadId: string
  readonly replyTo?: string
  /** true 表示这条记录是删除该 thread 的墓碑。 */
  readonly deleted?: boolean
}

/** 带来源顺序的笔记条目；order 用于跨设备折叠。 */
export interface NoteEntry {
  readonly note: NoteRecord
  /** Vault 用 record.revision；device 用本地 at。 */
  readonly order: number
}

/** 折叠后的 thread。 */
export interface NoteThread {
  readonly threadId: string
  readonly scope: NoteScope
  readonly scopeKey: string
  readonly storage: NoteStorage
  readonly latest: NoteRecord
  readonly notes: readonly NoteEntry[]
}

/** 注入渲染结果。 */
export interface NotesContext {
  readonly text: string
  readonly hash: string
  readonly count: number
  readonly omitted: number
  readonly ids: readonly string[]
}

/**
 * 校验并规范化一条笔记。
 * @param value - 未知输入（Vault 解密后的 payload 或本地文件）。
 * @returns 规范化记录；非法时 undefined。
 */
export function sanitizeNoteRecord(value: unknown): NoteRecord | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw['id'] !== 'string' || !ID_PATTERN.test(raw['id'])) return undefined
  if (typeof raw['threadId'] !== 'string' || !ID_PATTERN.test(raw['threadId'])) return undefined
  if (typeof raw['scopeKey'] !== 'string' || raw['scopeKey'].length > 256) return undefined
  if (typeof raw['deviceId'] !== 'string' || raw['deviceId'].trim() === '') return undefined
  if (typeof raw['at'] !== 'number' || !Number.isSafeInteger(raw['at']) || raw['at'] <= 0) return undefined
  const scope = normalizeScope(raw['scope'])
  const storage = normalizeStorage(raw['storage'])
  const authorKind = normalizeAuthorKind(raw['authorKind'])
  if (scope === undefined || storage === undefined || authorKind === undefined) return undefined
  if (scope === 'global' ? raw['scopeKey'] !== '' : raw['scopeKey'] === '') return undefined
  const deleted = raw['deleted'] === true
  const text = typeof raw['text'] === 'string' ? raw['text'] : ''
  if (!deleted && (text.trim() === '' || Buffer.byteLength(text, 'utf8') > NOTE_TEXT_MAX_BYTES)) return undefined
  if (deleted && Buffer.byteLength(text, 'utf8') > NOTE_TEXT_MAX_BYTES) return undefined
  const title = clipOneLine(typeof raw['title'] === 'string' ? raw['title'] : '', NOTE_TITLE_MAX_CHARS)
  const summary = clipOneLine(typeof raw['summary'] === 'string' ? raw['summary'] : '', NOTE_SUMMARY_MAX_CHARS)
  const tags = normalizeTags(raw['tags'])
  const author = normalizeAuthor(raw['author'])
  return {
    id: raw['id'],
    at: raw['at'],
    scope,
    scopeKey: raw['scopeKey'],
    storage,
    deviceId: raw['deviceId'].trim(),
    authorKind,
    ...author === undefined ? {} : { author },
    title,
    summary,
    text,
    tags,
    pinned: raw['pinned'] === true,
    threadId: raw['threadId'],
    ...typeof raw['replyTo'] === 'string' && ID_PATTERN.test(raw['replyTo']) ? { replyTo: raw['replyTo'] } : {},
    ...deleted ? { deleted: true } : {},
  }
}

/**
 * 校验一组笔记；非法项跳过，按 id 去重并保留最多 order 的最新副本。
 */
export function sanitizeNoteEntries(value: unknown): NoteEntry[] {
  if (!Array.isArray(value)) return []
  const byId = new Map<string, NoteEntry>()
  for (const item of value) {
    const record = sanitizeNoteRecord(item)
    if (record === undefined) continue
    const entry: NoteEntry = { note: record, order: record.at }
    const previous = byId.get(record.id)
    if (previous === undefined || entry.order >= previous.order) byId.set(record.id, entry)
  }
  return [...byId.values()]
}

/**
 * 按 threadId 折叠；latest 为 order 最大的记录；最新记录是 tombstone 时整个 thread 隐藏。
 * @param entries - 笔记条目。
 * @returns 活跃 thread，按最新记录倒序。
 */
export function foldNoteThreads(entries: readonly NoteEntry[]): NoteThread[] {
  const byId = new Map<string, NoteEntry>()
  for (const entry of entries) {
    const previous = byId.get(entry.note.id)
    if (previous === undefined || entry.order >= previous.order) byId.set(entry.note.id, entry)
  }
  const groups = new Map<string, NoteEntry[]>()
  for (const entry of byId.values()) {
    const group = groups.get(entry.note.threadId)
    if (group === undefined) groups.set(entry.note.threadId, [entry])
    else group.push(entry)
  }
  const threads: NoteThread[] = []
  for (const [threadId, group] of groups) {
    group.sort((left, right) => left.order - right.order || left.note.id.localeCompare(right.note.id))
    const latest = group.at(-1)
    if (latest === undefined || latest.note.deleted === true) continue
    threads.push({
      threadId,
      scope: latest.note.scope,
      scopeKey: latest.note.scopeKey,
      storage: latest.note.storage,
      latest: latest.note,
      notes: group,
    })
  }
  threads.sort((left, right) => right.notes.at(-1)!.order - left.notes.at(-1)!.order)
  return threads
}

/**
 * 会话当前的可见 thread：session + workspace + global，保留两种 storage。
 * @param entries - 全部条目。
 * @param sessionId - 当前会话。
 * @param workspaceKey - 当前工作区；未知时 workspace scope 不返回。
 * @returns 可见 thread。
 */
export function visibleNoteThreads(
  entries: readonly NoteEntry[],
  sessionId: string,
  workspaceKey: string | undefined,
): NoteThread[] {
  return foldNoteThreads(entries).filter((thread) => {
    if (thread.scope === 'session') return thread.scopeKey === sessionId
    if (thread.scope === 'workspace') return workspaceKey !== undefined && thread.scopeKey === workspaceKey
    return true
  })
}

/**
 * 渲染自动注入的摘要；预算按 UTF-8 字节计算。
 * @param threads - 已过滤的 thread。
 * @param maxBytes - 总预算。
 * @returns 文本、hash、条数和被省略数量。
 */
export function renderNotesContext(threads: readonly NoteThread[], maxBytes = NOTES_CONTEXT_MAX_BYTES): NotesContext {
  const ranked = [...threads].sort((left, right) => {
    const pinned = Number(right.latest.pinned) - Number(left.latest.pinned)
    if (pinned !== 0) return pinned
    const scope = scopeRank(left.latest.scope) - scopeRank(right.latest.scope)
    if (scope !== 0) return scope
    const storage = storageRank(left.latest.storage) - storageRank(right.latest.storage)
    if (storage !== 0) return storage
    return right.notes.at(-1)!.order - left.notes.at(-1)!.order
  })
  const header = '<notes-context version="2">'
  const footer = '</notes-context>'
  const lines: string[] = []
  const ids: string[] = []
  let bytes = Buffer.byteLength(`${header}\n${footer}`, 'utf8')
  let omitted = 0
  for (let index = 0; index < ranked.length; index += 1) {
    const thread = ranked[index]!
    const note = thread.latest
    const title = note.title === '' ? titleFromText(note.text) : note.title
    const summary = summaryOf(note)
    const line = `[scope=${note.scope} storage=${note.storage}] id=${note.id} ${title}${summary === '' ? '' : `：${summary}`}`
    const lineBytes = Buffer.byteLength(`${line}\n`, 'utf8')
    const remainingLines = ranked.length - index - 1
    const reserve = remainingLines > 0 ? 64 : 0
    if (bytes + lineBytes + reserve > maxBytes) {
      omitted = ranked.length - index
      break
    }
    lines.push(escapeContextText(line))
    ids.push(note.id)
    bytes += lineBytes
  }
  if (omitted > 0) {
    const notice = `另有 ${omitted} 条笔记未展开，可用 note_search 查看。`
    if (bytes + Buffer.byteLength(`${notice}\n`, 'utf8') <= maxBytes) {
      lines.push(notice)
      bytes += Buffer.byteLength(`${notice}\n`, 'utf8')
    }
  }
  const text = lines.length === 0 ? '' : `${header}\n${lines.join('\n')}\n${footer}`
  return {
    text,
    hash: hashNotesText(text),
    count: ids.length,
    omitted,
    ids,
  }
}

/** 注入文本的稳定 hash；模板版本变化时调用方改版本前缀。 */
export function hashNotesText(text: string): string {
  return createHash('sha256').update(`notes-injection/v2\n${text}`, 'utf8').digest('hex')
}

/** 取一条笔记的注入摘要：显式 summary 优先，否则从正文提取。 */
export function summaryOf(note: Pick<NoteRecord, 'summary' | 'text'>): string {
  const explicit = clipOneLine(note.summary, NOTE_SUMMARY_MAX_CHARS)
  if (explicit !== '') return explicit
  return extractSummary(note.text)
}

/**
 * 从 Markdown 正文提取确定性摘要：去代码块/标记，取首个非标题段落，按句子边界截断。
 * @param text - 笔记正文。
 * @returns ≤ 200 字符的摘要；无可用文本时返回空串。
 */
export function extractSummary(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/~~~[\s\S]*?~~~/gu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gmu, '')
    .replace(/^\s{0,3}>\s?/gmu, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gmu, '')
    .replace(/<\/?[A-Za-z][^>]*>/gu, ' ')
    .replace(/[*_~]{1,3}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (plain === '') return ''
  const clipped = clipOneLine(plain, NOTE_SUMMARY_MAX_CHARS)
  if (clipped.length < plain.length) {
    const boundary = Math.max(
      clipped.lastIndexOf('。'),
      clipped.lastIndexOf('. '),
      clipped.lastIndexOf('；'),
      clipped.lastIndexOf('; '),
      clipped.lastIndexOf('！'),
      clipped.lastIndexOf('？'),
    )
    if (boundary >= 80) return `${clipped.slice(0, boundary + 1).trim()}…`
    return `${clipped}…`
  }
  return clipped
}

/** 按 UTF-8 字节截断到指定字节数，避免把多字节字符截断。 */
export function clipUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let value = text
  while (value !== '' && Buffer.byteLength(value, 'utf8') > maxBytes) value = value.slice(0, -1)
  return value
}

/** 单行化并截断。 */
export function clipOneLine(text: string, maxChars: number): string {
  const oneLine = text.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim()
  return oneLine.length > maxChars ? `${oneLine.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…` : oneLine
}

function titleFromText(text: string): string {
  const first = text.split(/\r?\n/u).map((line) => line.trim()).find((line) => line !== '') ?? ''
  return clipOneLine(first.replace(/^\s{0,3}#{1,6}\s+/u, ''), NOTE_TITLE_MAX_CHARS)
}

function normalizeScope(value: unknown): NoteScope | undefined {
  return value === 'session' || value === 'workspace' || value === 'global' ? value : undefined
}

function normalizeStorage(value: unknown): NoteStorage | undefined {
  return value === 'device' || value === 'vault' ? value : undefined
}

function normalizeAuthorKind(value: unknown): NoteAuthorKind | undefined {
  return value === 'agent' || value === 'user' ? value : undefined
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const tags: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const tag = clipOneLine(item, MAX_TAG_CHARS)
    if (tag === '' || tags.includes(tag)) continue
    tags.push(tag)
    if (tags.length >= MAX_TAGS) break
  }
  return tags
}

function normalizeAuthor(value: unknown): NoteRecord['author'] | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const sessionId = typeof raw['sessionId'] === 'string' && raw['sessionId'].trim() !== '' ? raw['sessionId'].trim() : undefined
  const agentPreset = typeof raw['agentPreset'] === 'string' && raw['agentPreset'].trim() !== ''
    ? raw['agentPreset'].trim()
    : undefined
  if (sessionId === undefined && agentPreset === undefined) return undefined
  return {
    ...sessionId === undefined ? {} : { sessionId },
    ...agentPreset === undefined ? {} : { agentPreset },
  }
}

function scopeRank(scope: NoteScope): number {
  return scope === 'session' ? 0 : scope === 'workspace' ? 1 : 2
}

function storageRank(storage: NoteStorage): number {
  return storage === 'device' ? 0 : 1
}

function escapeContextText(text: string): string {
  return text.replaceAll('</notes-context>', '&lt;/notes-context&gt;')
}
