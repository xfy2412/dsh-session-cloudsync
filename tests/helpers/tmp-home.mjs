// 测试用的隔离 DSH home。
//
// 所有临时 DSH 数据目录都在 <仓库>/.tmp/ 下，且只能通过 createTempHome() 创建；
// 本模块的价值在于下面这些硬性检查，而不是省事。
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 仓库根目录（含 package.json 与 pnpm-workspace.yaml 的那层）。 */
export const repoRoot = resolve(here, '..', '..')

/** 唯一允许存放临时 DSH home 的目录。 */
export const tmpRoot = join(repoRoot, '.tmp')

/** 无人认领的运行目录最多保留多久（毫秒）。 */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000

function real(path) {
  try {
    return realpathSync.native(path)
  } catch (error) {
    // The protected parent may not exist on a fresh runner (for example
    // ~/.dsh before DSH has ever been started). Comparing its resolved
    // lexical path is still enough to prove the temp home is outside it.
    if (error?.code === 'ENOENT') return resolve(path)
    throw error
  }
}

function inside(parent, child) {
  const base = real(parent)
  const target = real(child)
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)
}

/** 若 `.tmp/` 没被忽略就报错：夹具日志绝不能被提交。 */
export function assertTmpIgnored() {
  try {
    execFileSync('git', ['check-ignore', '-q', join('.tmp', 'probe')], { cwd: repoRoot, stdio: 'ignore' })
  } catch {
    throw new Error('tests: .tmp/ 没有被 git 忽略，请先修 .gitignore')
  }
}

/** 清理超过保留期的运行目录。 */
export function pruneStaleRuns(now = Date.now()) {
  let entries
  try {
    entries = readdirSync(tmpRoot, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(tmpRoot, entry.name)
    try {
      if (now - statSync(path).mtimeMs > STALE_AFTER_MS) rmSync(path, { recursive: true, force: true })
    } catch {
      // Windows 上文件可能被占用；下次运行再清。
    }
  }
}

/**
 * 创建一个隔离的 DSH home 与服务端数据目录。
 * @param {string} [label] - 运行目录名的短前缀。
 * @returns {{ root: string, home: string, dataDir: string, dispose: () => void }}
 */
export function createTempHome(label = 'run') {
  assertTmpIgnored()
  mkdirSync(tmpRoot, { recursive: true })
  pruneStaleRuns()

  const root = real(mkdtempSync(join(tmpRoot, `${label}-`)))
  if (!inside(tmpRoot, root)) throw new Error(`tests: 运行目录跑到 .tmp/ 之外了：${root}`)

  const home = join(root, 'home')
  const dataDir = join(root, 'data')
  mkdirSync(home)
  mkdirSync(dataDir)

  const forbiddenParents = [
    process.env.USERPROFILE ? join(process.env.USERPROFILE, '.dsh') : undefined,
    process.env.HOME ? join(process.env.HOME, '.dsh') : undefined,
    process.env.DSH_HOME,
  ].filter((value) => typeof value === 'string' && value.length > 0)

  for (const candidate of forbiddenParents) {
    if (inside(candidate, home) || real(candidate) === real(home)) {
      throw new Error(`tests: 拒绝把受保护的目录当作 DSH_HOME：${home}`)
    }
  }
  if (real(repoRoot) === real(home)) {
    throw new Error(`tests: 拒绝把仓库根当作 DSH_HOME：${home}`)
  }

  return {
    root,
    home,
    dataDir,
    dispose() {
      if (process.env.KEEP_TMP === '1') return
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    },
  }
}

/**
 * 断言临时 home 里只有测试自己创建的会话。
 * @param {string} home - 临时 DSH home。
 * @param {readonly string[]} allowedIds - 测试允许出现的会话 id。
 */
export function assertOnlySessions(home, allowedIds) {
  const sessionsDir = join(home, 'sessions')
  let projectDirs
  try {
    projectDirs = readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return
  }
  const found = []
  for (const project of projectDirs) {
    const projectPath = join(sessionsDir, project.name)
    for (const session of readdirSync(projectPath, { withFileTypes: true })) {
      if (session.isDirectory()) found.push(session.name)
    }
  }
  const allowed = new Set(allowedIds)
  const unexpected = found.filter((id) => !allowed.has(id))
  if (unexpected.length > 0) {
    throw new Error(`tests: 临时 home 里出现了预期之外的会话：${unexpected.join(', ')}`)
  }
}
