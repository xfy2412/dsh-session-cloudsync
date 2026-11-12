#!/usr/bin/env node
/**
 * 起一个本地开发服务端（`packages/server/src/index.ts` 源码直跑）。
 *
 * 默认数据目录固定在 `<仓库>/.tmp/dev-data`，端口 8787、host 127.0.0.1。
 * `--clean` 会在启动前删除上次的数据目录（只允许 `.tmp/` 内的路径）。
 * 也可以把服务端 CLI 命令透传过来，例如：
 *
 *   node scripts/dev-server.mjs reset-password
 *   node scripts/dev-server.mjs reset-password --stdin
 *   node scripts/dev-server.mjs admin status
 *   node scripts/dev-server.mjs token list
 *
 * 用法：
 *   node scripts/dev-server.mjs [serve 选项]
 *   node scripts/dev-server.mjs <服务端命令> [命令选项]
 */
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmpRoot = join(repoRoot, '.tmp')

/**
 * 解析开发脚本参数：serve 选项与透传命令分开。
 * @param {readonly string[]} argv - 参数列表。
 * @returns {{ port: number, host: string, dataDir: string, clean: boolean, command: string[], passthrough: string[] }}
 */
function parseArgs(argv) {
  let port = 8787
  let host = '127.0.0.1'
  let dataDir = join(tmpRoot, 'dev-data')
  let clean = false
  const command = []
  const passthrough = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--clean') {
      clean = true
    } else if (argument === '--port') {
      port = Number(argv[index + 1])
      index += 1
    } else if (argument === '--host') {
      host = String(argv[index + 1] ?? '')
      index += 1
    } else if (argument === '--data-dir') {
      dataDir = String(argv[index + 1] ?? '')
      index += 1
    } else if (argument === '--stdin') {
      passthrough.push(argument)
    } else if (argument.startsWith('--')) {
      throw new Error(`未知参数：${argument}`)
    } else {
      command.push(argument)
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`端口非法：${String(port)}`)
  if (host === '') throw new Error('host 不能为空')
  return { port, host, dataDir: resolve(dataDir), clean, command, passthrough }
}

/**
 * 断言路径在仓库的 `.tmp/` 内（`--clean` 会删它）。
 * @param {string} path - 待检查路径。
 */
function assertInsideTmp(path) {
  const resolved = resolve(path)
  const baseResolved = resolve(tmpRoot)
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + sep)) {
    throw new Error(`拒绝在 .tmp/ 之外使用开发数据目录：${resolved}`)
  }
}

/**
 * 启动一个子进程并转发退出码。
 * @param {string[]} args - 传给 node 的参数。
 */
function run(args) {
  console.log(`执行：node ${args.join(' ')}`)
  const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: repoRoot, env: process.env })
  child.on('exit', (code) => process.exit(code ?? 0))
  child.on('error', (error) => {
    console.error(`启动失败：${error.message}`)
    process.exit(1)
  })
  process.once('SIGINT', () => child.kill('SIGINT'))
}

const { port, host, dataDir, clean, command, passthrough } = parseArgs(process.argv.slice(2))
assertInsideTmp(dataDir)

const entry = join(repoRoot, 'packages', 'server', 'src', 'index.ts')

if (command.length > 0) {
  if (clean) throw new Error('--clean 只能用于启动 serve，不能和 CLI 命令一起用')
  if (port !== 8787 || host !== '127.0.0.1') throw new Error('--port/--host 只能用于启动 serve')
  // 常用命令的简写：reset-password → admin reset-password。
  const mapped = command[0] === 'reset-password'
    ? ['admin', 'reset-password', ...command.slice(1)]
    : command
  run([entry, ...mapped, '--data-dir', dataDir, ...passthrough])
} else {
  if (passthrough.length > 0) throw new Error(`--stdin 只能用于 CLI 命令`)
  if (clean) {
    rmSync(dataDir, { recursive: true, force: true })
    console.log(`已清理上次数据目录：${dataDir}`)
  }
  run([entry, 'serve', '--data-dir', dataDir, '--port', String(port), '--host', host])
}
