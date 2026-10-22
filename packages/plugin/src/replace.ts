/**
 * 生成“远端覆盖本地”的一次性脚本。
 *
 * 脚本在 DSH 停止后运行：检查原 DSH PID、备份并校验本地会话、删除
 * session artifact、清理插件 blocked/ignore 状态和工作区记账，然后提示
 * 用户启动 DSH 做全量拉取。脚本不依赖 DSH 正在运行。
 *
 * @module dsh-session-cloudsync/replace
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 生成脚本所需的身份信息。 */
export interface ReplaceScriptInput {
  readonly sessionId: string
  readonly createdAt: number
  readonly formatVersion: number
  readonly dshHome: string
  readonly statePath: string
  readonly dshPid: number
}

/** 前端展示的远端覆盖本地计划。 */
export interface ReplacePlan {
  readonly sessionId: string
  readonly scriptPath: string
  readonly command: string
  readonly backupRoot: string
  readonly steps: readonly string[]
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * 生成脚本文件并返回前端需要的路径与说明。
 * @param input - 会话生命周期和 DSH 路径。
 * @returns 脚本路径、命令和 UI 步骤。
 */
export async function prepareReplaceScript(input: ReplaceScriptInput): Promise<ReplacePlan> {
  if (!SESSION_ID_PATTERN.test(input.sessionId)) throw new Error('非法 sessionId')
  if (!Number.isSafeInteger(input.createdAt) || !Number.isSafeInteger(input.formatVersion)) {
    throw new Error('会话生命周期字段非法')
  }

  const root = join(input.dshHome, 'session-cloudsync')
  const scriptDir = join(root, 'replace-scripts')
  const backupRoot = join(root, 'replace-backups')
  await mkdir(scriptDir, { recursive: true })
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const scriptPath = join(scriptDir, `${input.sessionId}-${stamp}.mjs`)
  const template = await readFile(new URL('../assets/replace-session.mjs', import.meta.url), 'utf8')
  if (!template.includes('__CONFIG__')) throw new Error('覆盖脚本模板缺少配置占位符')

  const config = {
    sessionId: input.sessionId,
    createdAt: input.createdAt,
    formatVersion: input.formatVersion,
    dshHome: input.dshHome,
    statePath: input.statePath,
    workspaceFile: join(input.dshHome, 'storages', 'workspace.json'),
    projectionCacheFile: join(input.dshHome, 'storages', 'session_projcache', 'sessions', `${input.sessionId}.json`),
    backupRoot,
    dshPid: input.dshPid,
  }
  const script = template.replace('__CONFIG__', JSON.stringify(config, null, 2))
  await writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o700 })
  await chmod(scriptPath, 0o700).catch(() => {})
  const command = `node "${scriptPath}"`

  return {
    sessionId: input.sessionId,
    scriptPath,
    command,
    backupRoot,
    steps: [
      '完全退出 DSH；脚本会检查生成它的 DSH 进程是否仍在运行。',
      `运行：${command}`,
      `脚本会把本地会话完整备份到 ${backupRoot}，并逐文件校验。`,
      '备份通过后，脚本删除本地 session artifact、投影缓存和该会话的工作区记账。',
      '脚本清除 blocked / ignored / cwd 待处理状态，并重置同步游标。',
      '启动 DSH，在同步气泡点击「立即同步」；插件会按同一生命周期全量拉取远端。',
    ],
  }
}
