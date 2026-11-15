/**
 * 把形状轨迹生成的大会话导入一个隔离 DSH_HOME。
 *
 * 只写临时实例目录：`<home>/sessions/...` 与 `workspace.json`。不碰真实 home。
 *
 * @module dsh-session-cloudsync/tests/import-bench-session
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { generateSession } from './make-bench-session.ts'
import type { BenchImageRef } from './make-bench-session.ts'
import type { SessionShapeTrace } from './session-trace.ts'

/** 导入输入。 */
export interface ImportBenchOptions {
  /** 形状轨迹。 */
  readonly trace: SessionShapeTrace
  /** 隔离 DSH_HOME。 */
  readonly home: string
  /** 会话 cwd（应落在该实例默认工作区内）。 */
  readonly cwd: string
  /** 会话 id；默认 `session-bench-shape`。 */
  readonly id?: string
  /** 注入到会话里的图片；只支持 PNG。 */
  readonly attachments?: readonly BenchAttachment[]
}

/** 一张待注入的图片。 */
export interface BenchAttachment {
  readonly name: string
  readonly data: Uint8Array
}

/** 导入结果（不含正文）。 */
export interface ImportBenchResult {
  readonly sessionId: string
  readonly workspaceId: string
  readonly path: string
  readonly bytes: number
  /** 注入并写入附件的图片数量。 */
  readonly attachments: number
}

/**
 * 读 PNG 的宽高，顺便校验文件头。
 * @param data - PNG 字节。
 * @returns 像素宽高。
 * @throws 不是合法 PNG 时抛出。
 */
function pngDimensions(data: Uint8Array): { readonly width: number; readonly height: number } {
  const bytes = Buffer.from(data)
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) throw new Error('附件不是合法 PNG')
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') throw new Error('PNG 缺少 IHDR')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/** 与 DSH JSONL 后端一致的会话目录分段编码。 */
function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/u.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** 与 DSH JSONL 后端一致的 projectKey。 */
function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/u.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/u, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** 读 JSON，失败返回 undefined。 */
function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** 确保 workspace 记录包含该会话，返回 workspaceId。 */
function attachToWorkspace(home: string, cwd: string, sessionId: string): string {
  const file = join(home, 'storages', 'workspace.json')
  const now = new Date().toISOString()
  const parsed = readJson(file)
  const state = parsed !== undefined && parsed['tables'] !== undefined
    ? parsed
    : {
        unit: { name: 'workspace', version: 2 },
        global: {
          initialized: true,
          workspaceIds: [] as string[],
          archivedSessionIds: [] as string[],
          pinnedSessionIds: [] as string[],
          defaultWorkspaceId: '',
        },
        tables: { workspaces: {} as Record<string, Record<string, unknown>> },
      }
  const global = state['global'] as Record<string, unknown>
  const tables = state['tables'] as Record<string, unknown>
  const workspaces = tables['workspaces'] as Record<string, Record<string, unknown>>
  const ids = Array.isArray(global['workspaceIds']) ? global['workspaceIds'] as string[] : []
  let workspaceId = typeof global['defaultWorkspaceId'] === 'string' ? global['defaultWorkspaceId'] : ''
  if (workspaceId === '' || workspaces[workspaceId] === undefined) {
    workspaceId = Object.keys(workspaces).find((id) => workspaces[id]?.['path'] === cwd) ?? ''
  }
  if (workspaceId === '') {
    workspaceId = randomUUID()
    workspaces[workspaceId] = {
      path: cwd,
      title: basename(cwd),
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    }
    ids.push(workspaceId)
  }
  const workspace = workspaces[workspaceId]!
  const sessionIds = Array.isArray(workspace['sessionIds']) ? workspace['sessionIds'] as string[] : []
  if (!sessionIds.includes(sessionId)) sessionIds.push(sessionId)
  workspace['sessionIds'] = sessionIds
  workspace['updatedAt'] = now
  global['workspaceIds'] = ids
  if (typeof global['defaultWorkspaceId'] !== 'string' || global['defaultWorkspaceId'] === '') {
    global['defaultWorkspaceId'] = workspaceId
  }
  if (Array.isArray(global['archivedSessionIds'])) {
    global['archivedSessionIds'] = (global['archivedSessionIds'] as string[]).filter((id) => id !== sessionId)
  }
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`)
  return workspaceId
}

/**
 * 生成并导入一个大会话。
 * @param options - home、cwd、轨迹与 id。
 * @returns 会话路径与大小。
 */
export function importBenchSession(options: ImportBenchOptions): ImportBenchResult {
  if (!existsSync(options.home)) throw new Error(`DSH_HOME 不存在：${options.home}`)
  const sessionId = options.id ?? 'session-bench-shape'
  mkdirSync(options.cwd, { recursive: true })
  const objectRoot = join(options.home, 'attachments', 'v1', 'objects')
  const images: BenchImageRef[] = (options.attachments ?? []).map((attachment) => {
    const data = Buffer.from(attachment.data)
    const digest = createHash('sha256').update(data).digest('hex')
    const dimensions = pngDimensions(data)
    mkdirSync(join(objectRoot, digest.slice(0, 2)), { recursive: true })
    writeFileSync(join(objectRoot, digest.slice(0, 2), digest), data)
    return {
      attachmentId: `sha256:${digest}`,
      mediaType: 'image/png',
      bytes: data.length,
      width: dimensions.width,
      height: dimensions.height,
      name: attachment.name,
    }
  })
  const generated = generateSession(options.trace, { cwd: options.cwd, id: sessionId, images })
  const directory = join(options.home, 'sessions', projectKey(options.cwd), encodeSegment(sessionId))
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'session.v4.jsonl.zstd')
  const bytes = Buffer.concat(generated.frames)
  writeFileSync(path, bytes)
  const workspaceId = attachToWorkspace(options.home, options.cwd, sessionId)
  return { sessionId, workspaceId, path, bytes: bytes.length, attachments: images.length }
}
