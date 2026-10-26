#!/usr/bin/env node
/**
 * 自部署同步服务的命令行入口。
 *
 * `serve` 启动 HTTP API；`token add|list|revoke` 管理设备 token。
 * setup token 在首次启动时打印一次，也可以从 `<data>/setup-token` 读取。
 *
 * @module @dsh-session-cloudsync/server
 */
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ONBOARDING_CODE_FILE,
  ONBOARDING_TTL_MS,
  createDevice,
  createHttpServer,
  listDevices,
  mintOnboardingCode,
  revokeDevice,
  DEFAULT_MAX_BYTES,
} from './http.ts'
import { clearAdminPassword, ensureSetupToken, isAdminInitialized, openDatabase, readMaxBytes } from './db.ts'

interface Parsed {
  command: string
  positionals: string[]
  flags: Map<string, string>
}

/** 把当前初始化密钥写到本地 0600 文件，供同机开发/管理工具读取。 */
function writeOnboardingCode(dataDir: string, code: string): void {
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, ONBOARDING_CODE_FILE)
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ code, expiresAt: Date.now() + ONBOARDING_TTL_MS })}\n`, {
    mode: 0o600,
  })
  try {
    chmodSync(temporary, 0o600)
  } catch {
    // Windows 可能不支持改 mode。
  }
  renameSync(temporary, file)
}

/** 初始化完成或重置时删除本地密钥副本。 */
function clearOnboardingCode(dataDir: string): void {
  rmSync(join(dataDir, ONBOARDING_CODE_FILE), { force: true })
}

function usage(): never {
  console.error(`dsh-session-cloudsync-server <命令> [选项]

命令：
  serve                      启动 HTTP API 与管理台
  token add <标签>            签发一个设备 token（只打印一次）
  token list                 列出存活设备
  token revoke <deviceId>    吊销某个设备 token
  admin status               查看初始化状态与配额
  admin reset                忘记管理密码时重置（重启 serve 后重新初始化）

选项：
  --data-dir <目录>           数据目录（默认 .tmp/dev-data）
  --host <地址>               绑定地址（默认 127.0.0.1）
  --port <端口>               监听端口（默认 8787）
  --max-bytes <n>             存储上限（默认 10 GiB）
`)
  process.exit(2)
}

/**
 * 把 argv 解析成命令、位置参数与 `--flag value` 对。
 * @param argv - 脚本名之后的参数。
 * @returns 解析结果。
 */
function parse(argv: readonly string[]): Parsed {
  const positionals: string[] = []
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument.startsWith('--')) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) usage()
      flags.set(argument.slice(2), value)
      index += 1
    } else {
      positionals.push(argument)
    }
  }
  const command = positionals.shift()
  if (command === undefined) usage()
  return { command, positionals, flags }
}

/**
 * 执行一条命令。
 * @param parsed - 解析后的命令行。
 */
async function main(parsed: Parsed): Promise<void> {
  const dataDir = parsed.flags.get('data-dir') ?? '.tmp/dev-data'
  const db = openDatabase(dataDir)
  try {
    if (parsed.command === 'token') {
      const action = parsed.positionals[0]
      if (action === 'add') {
        const label = parsed.positionals[1] ?? 'device'
        const created = createDevice(db, label)
        console.log(JSON.stringify(created, null, 2))
        return
      }
      if (action === 'list') {
        console.log(JSON.stringify(listDevices(db), null, 2))
        return
      }
      if (action === 'revoke') {
        const deviceId = parsed.positionals[1]
        if (deviceId === undefined) usage()
        console.log(revokeDevice(db, deviceId) ? '已吊销' : '没有这个设备')
        return
      }
      usage()
    }

    if (parsed.command === 'admin') {
      const action = parsed.positionals[0]
      if (action === 'status') {
        console.log(JSON.stringify({
          initialized: isAdminInitialized(db),
          maxBytes: readMaxBytes(db, DEFAULT_MAX_BYTES),
        }, null, 2))
        return
      }
      if (action === 'reset') {
        clearAdminPassword(db)
        clearOnboardingCode(dataDir)
        console.log('已清除管理密码。重启 server 后会在控制台打印新的初始化密钥。')
        return
      }
      usage()
    }

    if (parsed.command === 'serve') {
      const host = parsed.flags.get('host') ?? '127.0.0.1'
      const port = Number(parsed.flags.get('port') ?? '8787')
      const maxBytes = Number(parsed.flags.get('max-bytes') ?? DEFAULT_MAX_BYTES)
      if (!Number.isInteger(port) || port < 0 || port > 65535) usage()
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) usage()
      const setup = ensureSetupToken(db)
      writeFileSync(join(dataDir, 'setup-token'), `${setup.token}\n`, { mode: 0o600 })
      try {
        chmodSync(join(dataDir, 'setup-token'), 0o600)
      } catch {
        // Windows 可能不支持改 mode；文件本身已经写出。
      }
      const initialized = isAdminInitialized(db)
      const onboardingCode = initialized ? undefined : mintOnboardingCode()
      if (onboardingCode === undefined) clearOnboardingCode(dataDir)
      else writeOnboardingCode(dataDir, onboardingCode)
      const server = createHttpServer({ db, dataDir, maxBytes, ...onboardingCode === undefined ? {} : { onboardingCode } })
      server.listen(port, host, () => {
        const address = server.address()
        const actualPort = typeof address === 'object' && address !== null ? address.port : port
        console.log(`dsh-session-cloudsync-server 已监听 http://${host}:${actualPort}`)
        console.log(`setup token 文件：${join(dataDir, 'setup-token')}（设备 CLI 用）`)
        if (!initialized) {
          console.log('')
          console.log(`首次启动，请打开 http://${host}:${actualPort}/admin 完成初始化`)
          console.log(`初始化密钥：${onboardingCode}`)
          console.log('（10 分钟内有效；未完成初始化时每次启动都会重新生成）')
        } else {
          console.log(`管理台：http://${host}:${actualPort}/admin（用管理密码登录）`)
        }
      })
      const stop = (): void => {
        server.close(() => {
          db.close()
          process.exit(0)
        })
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
      return
    }

    usage()
  } finally {
    if (parsed.command !== 'serve') db.close()
  }
}

void main(parse(process.argv.slice(2))).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
