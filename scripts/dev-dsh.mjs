#!/usr/bin/env node
/**
 * 起一个隔离的 DSH 开发实例（web profile）。
 *
 * 三件事都关在 <仓库>/.tmp/dev-dsh/ 里，缺一不可：
 *   1. DSH_HOME 指向临时 home；
 *   2. 默认工作区（Documents/deepseek-harness/default-workspace）指到临时目录，
 *      通过 --patch 覆盖 workspace-controller 的 documentsDirectory；
 *   3. 清掉从当前会话继承的 DSH_* 环境变量，避免新实例以为自己在嵌套运行。
 *
 * 用法：
 *   node scripts/dev-dsh.mjs [--port 3090] [--credentials <path>]
 *
 * `--credentials` 用于把已有 home 的 `.credentials.yaml` 拷进新 home（保留登录态）。
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmpRoot = join(repoRoot, '.tmp')
const base = join(tmpRoot, 'dev-dsh')
const home = join(base, 'home')
const documents = join(base, 'documents')
const overlay = join(base, 'overlay.yml')

/**
 * 解析 `--key value` 参数。
 * @param {readonly string[]} argv - 参数列表。
 * @returns {{ port: number, credentials?: string, patches: string[] }}
 */
function parseArgs(argv) {
  let port = 3090
  let credentials
  const patches = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--port') {
      port = Number(argv[index + 1])
      index += 1
    } else if (argument === '--credentials') {
      credentials = argv[index + 1]
      index += 1
    } else if (argument === '--patch') {
      patches.push(argv[index + 1])
      index += 1
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`端口非法：${String(port)}`)
  return { port, patches, ...credentials === undefined ? {} : { credentials } }
}

/**
 * 断言路径在临时目录内。
 * @param {string} path - 待检查路径。
 */
function assertInsideTmp(path) {
  const resolved = resolve(path)
  const baseResolved = resolve(tmpRoot)
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + sep)) {
    throw new Error(`拒绝在 .tmp/ 之外创建实例目录：${resolved}`)
  }
}

const { port, credentials, patches } = parseArgs(process.argv.slice(2))

assertInsideTmp(base)
mkdirSync(home, { recursive: true })
mkdirSync(documents, { recursive: true })

if (credentials !== undefined) {
  if (!existsSync(credentials)) throw new Error(`找不到凭据文件：${credentials}`)
  copyFileSync(credentials, join(home, '.credentials.yaml'))
  console.log(`已把登录态复制进临时 home：${join(home, '.credentials.yaml')}`)
}

// 默认工作区由 documentsDirectory + 'deepseek-harness/default-workspace' 组成。
writeFileSync(
  overlay,
  [
    '# 由 scripts/dev-dsh.mjs 生成：把首次使用的工作区限制在 .tmp 内。',
    '- id: workspace-controller',
    '  config:',
    `    documentsDirectory: '${documents.replace(/\\/g, '/')}'`,
    '',
  ].join('\n'),
)

const env = { ...process.env, DSH_HOME: home }
for (const key of ['DSH_SESSION_ID', 'DSH_SHELL', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_WEB_URL']) delete env[key]

const extraPatches = patches.map((path) => {
  assertInsideTmp(path)
  if (!existsSync(path)) throw new Error(`附加 patch 不存在：${path}`)
  return resolve(path)
})

const args = [
  '--profile', 'web',
  '--patch', overlay,
  ...extraPatches.flatMap((path) => ['--patch', path]),
  '--no-open',
  '--port', String(port),
]
console.log(`DSH_HOME=${home}`)
console.log(`默认工作区：${join(documents, 'deepseek-harness', 'default-workspace')}`)
console.log(`启动：dsh ${args.join(' ')}`)

/** 给 cmd.exe 拼参数时最少的引号处理。 */
function quoteArg(value) {
  return /[\s"]/u.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

const child = process.platform === 'win32'
  ? spawn(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/c', ['dsh', ...args.map(quoteArg)].join(' ')],
      { stdio: 'inherit', env, cwd: repoRoot },
    )
  : spawn('dsh', args, { stdio: 'inherit', env, cwd: repoRoot })
child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (error) => {
  console.error(`启动失败：${error.message}`)
  process.exit(1)
})

// 让子进程的 Ctrl+C 走正常关闭。
process.once('SIGINT', () => child.kill('SIGINT'))
