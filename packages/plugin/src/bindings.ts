/**
 * 本机 workspaceKey → localPath 绑定。
 *
 * 绑定是一次性的：同一 key 不能改绑，同一 localPath 不能成为两个 key 的推送
 * 身份。DSH 不支持工作区/会话迁移，这里也不做搬迁。
 *
 * @module dsh-session-cloudsync/bindings
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

/** 一条本机绑定。 */
export interface WorkspaceBinding {
  readonly key: string
  readonly localPath: string
  readonly label: string
  readonly createdAt: number
}

/** bindings.json 文件结构。 */
export interface WorkspaceBindings {
  readonly version: 1
  readonly bindings: Record<string, WorkspaceBinding>
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u

/** 空绑定表。 */
export function emptyBindings(): WorkspaceBindings {
  return { version: 1, bindings: {} }
}

/**
 * 读取绑定表；文件缺失/损坏时返回空表。
 * @param stateDir - Vault 状态目录。
 * @returns 绑定表。
 */
export async function readBindings(stateDir: string): Promise<WorkspaceBindings> {
  try {
    const parsed = JSON.parse(await readFile(join(stateDir, 'bindings.json'), 'utf8')) as Record<string, unknown>
    if (parsed['version'] !== 1 || parsed['bindings'] === null || typeof parsed['bindings'] !== 'object') return emptyBindings()
    const bindings: Record<string, WorkspaceBinding> = {}
    for (const [key, value] of Object.entries(parsed['bindings'] as Record<string, unknown>)) {
      if (!KEY_PATTERN.test(key) || value === null || typeof value !== 'object') continue
      const record = value as Record<string, unknown>
      if (typeof record.localPath !== 'string' || !isAbsolute(record.localPath)
        || typeof record.label !== 'string' || !Number.isSafeInteger(record.createdAt)) continue
      bindings[key] = {
        key,
        localPath: record.localPath,
        label: record.label,
        createdAt: record.createdAt as number,
      }
    }
    return { version: 1, bindings }
  } catch {
    return emptyBindings()
  }
}

/**
 * 建立一条不可变绑定。
 * @param stateDir - Vault 状态目录。
 * @param key - 远端 workspaceKey。
 * @param localPath - 本机 canonical workspace path。
 * @param label - 本机显示名。
 * @param now - 创建时间。
 * @returns 更新后的绑定表。
 * @throws key/path 已绑定到别处，或 key/path 已被占用时抛出。
 */
export async function bindWorkspace(
  stateDir: string,
  key: string,
  localPath: string,
  label: string,
  now = Date.now(),
): Promise<WorkspaceBindings> {
  if (!KEY_PATTERN.test(key)) throw new Error('workspaceKey 非法')
  if (!isAbsolute(localPath)) throw new Error('localPath 必须是绝对路径')
  const current = await readBindings(stateDir)
  if (current.bindings[key] !== undefined) throw new Error('该远端工作区已经绑定，不能改绑')
  for (const binding of Object.values(current.bindings)) {
    if (binding.localPath === localPath) throw new Error('该本地工作区已经有推送身份，不能重复绑定')
  }
  const next: WorkspaceBindings = {
    version: 1,
    bindings: {
      ...current.bindings,
      [key]: { key, localPath, label, createdAt: now },
    },
  }
  await mkdir(stateDir, { recursive: true })
  const target = join(stateDir, 'bindings.json')
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(temp, target)
  return next
}

/**
 * 查一个远端 key 的本地落点。
 * @param bindings - 绑定表。
 * @param key - workspaceKey。
 * @returns 本地路径或 undefined。
 */
export function pathForKey(bindings: WorkspaceBindings, key: string): string | undefined {
  return bindings.bindings[key]?.localPath
}

/**
 * 查一个本地路径的推送身份。
 * @param bindings - 绑定表。
 * @param localPath - canonical workspace path。
 * @returns 绑定的 key 或 undefined。
 */
export function keyForPath(bindings: WorkspaceBindings, localPath: string): string | undefined {
  for (const binding of Object.values(bindings.bindings)) {
    if (binding.localPath === localPath) return binding.key
  }
  return undefined
}
