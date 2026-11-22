/**
 * L3 笔记的 agent 工具：`note_write` / `note_search` / `note_read`。
 *
 * 工具只负责参数形状和会话 id；权限、scopeKey、thread 校验都在宿主 service 里，
 * 这样 HTTP UI 与 agent 工具走同一套规则。
 *
 * @module dsh-session-cloudsync/notes-tool
 */
import type { NoteThreadView } from './host-api.ts'
import type { NoteRecord, NoteScope, NoteStorage } from './notes.ts'
import type { ToolDefinitionLike, ToolExecutionLike, ToolsServiceLike } from './env-tool.ts'

/** 工具实际注册名。 */
export interface NotesToolNames {
  readonly write: string
  readonly search: string
  readonly read: string
}

/** 工具实际注册名与释放函数。 */
export interface NotesToolsHandle {
  readonly names: NotesToolNames
  dispose(): void
}

/** 工具依赖的宿主笔记服务。 */
export interface NotesToolService {
  write(input: {
    readonly sessionId: string
    readonly storage?: NoteStorage
    readonly scope?: NoteScope
    readonly title?: string
    readonly summary?: string
    readonly text: string
    readonly tags?: readonly string[]
    readonly pinned?: boolean
    readonly threadId?: string
  }): Promise<NoteRecord>
  search(input: {
    readonly sessionId: string
    readonly storage?: NoteStorage
    readonly scope?: NoteScope
    readonly query?: string
    readonly tags?: readonly string[]
    readonly limit?: number
  }): Promise<readonly NoteThreadView[]>
  read(sessionId: string, id: string): Promise<NoteThreadView>
}

interface WarnLogger {
  warn(message: string): void
}

const NAME_CANDIDATES = {
  write: ['note_write', 'dscs_note_write'],
  search: ['note_search', 'dscs_note_search'],
  read: ['note_read', 'dscs_note_read'],
} as const

const PARAMETERS = {
  write: {
    type: 'object',
    properties: {
      storage: { type: 'string', enum: ['device', 'vault'] },
      scope: { type: 'string', enum: ['session', 'workspace', 'global'] },
      title: { type: 'string' },
      summary: { type: 'string' },
      text: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      pinned: { type: 'boolean' },
      threadId: { type: 'string' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  search: {
    type: 'object',
    properties: {
      storage: { type: 'string', enum: ['device', 'vault'] },
      scope: { type: 'string', enum: ['session', 'workspace', 'global'] },
      query: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      limit: { type: 'integer' },
    },
    additionalProperties: false,
  },
  read: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
} as const

const OUTPUT = {
  type: 'object',
  additionalProperties: true,
} as const

const OUTPUT_LIST = {
  type: 'array',
  items: { type: 'object', additionalProperties: true },
} as const

/** 工具执行上下文里本模块用到的字段。 */
interface NotesToolExecution {
  readonly agent?: {
    readonly session?: {
      readonly header?: { readonly id?: unknown }
    }
  }
}

function sessionIdOf(exec: ToolExecutionLike | undefined): string {
  const id = (exec as NotesToolExecution | undefined)?.agent?.session?.header?.id
  if (typeof id !== 'string' || id === '') throw new Error('笔记工具需要当前会话')
  return id
}

/**
 * 注册笔记工具。
 * @param tools - 宿主 `tools` 服务。
 * @param service - 宿主笔记服务。
 * @param logger - 撞名告警。
 * @returns 实际注册名；全部失败时 undefined。
 */
export function registerNotesTools(
  tools: ToolsServiceLike | undefined,
  service: NotesToolService,
  logger: WarnLogger,
): NotesToolsHandle | undefined {
  if (tools === undefined || typeof tools.register !== 'function') return undefined
  const names: { write: string | undefined; search: string | undefined; read: string | undefined } = {
    write: undefined,
    search: undefined,
    read: undefined,
  }
  const disposers: Array<() => void> = []
  const register = (kind: keyof typeof NAME_CANDIDATES, definition: ToolDefinitionLike): string | undefined => {
    for (const name of NAME_CANDIDATES[kind]) {
      if (typeof tools.get === 'function' && tools.get(name) !== undefined) continue
      try {
        disposers.push(tools.register({ ...definition, name }))
        return name
      } catch (error: unknown) {
        logger.warn(`dsh-session-cloudsync: 注册笔记工具 ${name} 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return undefined
  }
  names.write = register('write', {
    name: 'note_write',
    description: '写一条长期笔记（工作区约定、环境事实、agent 经验）。长笔记请提供 summary。',
    parameters: PARAMETERS.write,
    output: { schema: OUTPUT, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => {
      const text = (args as { readonly text?: unknown }).text
      if (typeof text !== 'string' || text.trim() === '') throw new Error('需要非空 text')
      return service.write({
        sessionId: sessionIdOf(exec),
        ...argStorage(args),
        ...argScope(args),
        ...argString(args, 'title'),
        ...argString(args, 'summary'),
        text,
        ...argTags(args),
        ...argBoolean(args, 'pinned'),
        ...argString(args, 'threadId'),
      })
    },
  })
  names.search = register('search', {
    name: 'note_search',
    description: '搜索当前会话可见的长期笔记（本会话/本工作区/全局，本机与同步）。',
    parameters: PARAMETERS.search,
    output: { schema: OUTPUT_LIST, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => service.search({
      sessionId: sessionIdOf(exec),
      ...argStorage(args),
      ...argScope(args),
      ...argString(args, 'query'),
      ...argTags(args),
      ...argNumber(args, 'limit'),
    }),
  })
  names.read = register('read', {
    name: 'note_read',
    description: '读取一条笔记的全文和同 thread 的历史。',
    parameters: PARAMETERS.read,
    output: { schema: OUTPUT, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => {
      const id = typeof (args as { readonly id?: unknown }).id === 'string' ? (args as { readonly id: string }).id : ''
      if (id === '') throw new Error('需要 id')
      return service.read(sessionIdOf(exec), id)
    },
  })
  const writeName = names.write
  const searchName = names.search
  const readName = names.read
  if (writeName === undefined || searchName === undefined || readName === undefined) {
    for (const dispose of disposers) dispose()
    logger.warn('dsh-session-cloudsync: 笔记工具名被占用，部分工具未注册')
    return undefined
  }
  return {
    names: { write: writeName, search: searchName, read: readName },
    dispose: () => {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

function argStorage(args: unknown): { storage?: NoteStorage } {
  const value = (args as { readonly storage?: unknown }).storage
  return value === 'device' || value === 'vault' ? { storage: value } : {}
}

function argScope(args: unknown): { scope?: NoteScope } {
  const value = (args as { readonly scope?: unknown }).scope
  return value === 'session' || value === 'workspace' || value === 'global' ? { scope: value } : {}
}

function argString(args: unknown, key: string): Record<string, string> {
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() !== '' ? { [key]: value } : {}
}

function argBoolean(args: unknown, key: string): Record<string, boolean> {
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'boolean' ? { [key]: value } : {}
}

function argNumber(args: unknown, key: string): Record<string, number> {
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? { [key]: value } : {}
}

function argTags(args: unknown): { tags?: readonly string[] } {
  const value = (args as { readonly tags?: unknown }).tags
  return Array.isArray(value) ? { tags: value.filter((tag): tag is string => typeof tag === 'string') } : {}
}
