/**
 * 本机笔记文件：`storage=device` 的笔记，以及待上行的 Vault outbox。
 *
 * 两个文件都只在本机，原子写、0600；outbox 成功 append 后由宿主移除。
 * Vault 记录本身仍由 `vault-sync.ts` 负责。
 *
 * @module dsh-session-cloudsync/notes-store
 */
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sanitizeNoteRecord, type NoteEntry, type NoteRecord } from './notes.ts'

interface NotesFile {
  readonly version: 1
  readonly notes: readonly NoteRecord[]
}

/** 本机笔记 + outbox。 */
export class NotesStore {
  private readonly devicePath: string
  private readonly outboxPath: string
  private tail: Promise<unknown> = Promise.resolve()

  /**
   * @param dir - 本机 `session-cloudsync/notes` 目录。
   */
  constructor(dir: string) {
    this.devicePath = join(dir, 'device.json')
    this.outboxPath = join(dir, 'outbox.json')
  }

  /** `storage=device` 的条目。 */
  async deviceEntries(): Promise<NoteEntry[]> {
    const notes = await this.read(this.devicePath)
    return notes.map((note) => ({ note, order: note.at }))
  }

  /** 追加一条本机笔记。 */
  async appendDevice(note: NoteRecord): Promise<void> {
    await this.withLock(async () => {
      const notes = await this.read(this.devicePath)
      if (notes.some((item) => item.id === note.id)) return
      await this.write(this.devicePath, [...notes, note])
    })
  }

  /** 待上行 Vault 的笔记（含 tombstone）。 */
  async pending(): Promise<NoteRecord[]> {
    return this.read(this.outboxPath)
  }

  /** 加入 outbox；同 id 不重复。 */
  async enqueue(note: NoteRecord): Promise<void> {
    await this.withLock(async () => {
      const notes = await this.read(this.outboxPath)
      if (notes.some((item) => item.id === note.id)) return
      await this.write(this.outboxPath, [...notes, note])
    })
  }

  /** 已经成功进入 Vault 链的 outbox 项。 */
  async removePending(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    await this.withLock(async () => {
      const remove = new Set(ids)
      const notes = await this.read(this.outboxPath)
      await this.write(this.outboxPath, notes.filter((item) => !remove.has(item.id)))
    })
  }

  private async read(path: string): Promise<NoteRecord[]> {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return []
    }
    const raw = Array.isArray(parsed)
      ? parsed
      : parsed !== null && typeof parsed === 'object'
        ? (parsed as { readonly notes?: unknown }).notes
        : undefined
    if (!Array.isArray(raw)) return []
    const result: NoteRecord[] = []
    const seen = new Set<string>()
    for (const item of raw) {
      const note = sanitizeNoteRecord(item)
      if (note === undefined || seen.has(note.id)) continue
      seen.add(note.id)
      result.push(note)
    }
    return result
  }

  private async write(path: string, notes: readonly NoteRecord[]): Promise<void> {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.tmp-${process.pid}-${Date.now()}`
    const body: NotesFile = { version: 1, notes }
    await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(temp, 0o600)
    } catch {
      // Windows 可能不支持 mode。
    }
    await rename(temp, path)
  }

  private withLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation)
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }
}
