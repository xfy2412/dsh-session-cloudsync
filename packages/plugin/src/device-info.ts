/**
 * 本机设备身份与环境事实：`/v2/me` 身份缓存、OS/DSH/工作区采集、工具链探测。
 *
 * 环境工具和设备切换提示共用这里的身份。工具链探测走宿主 `ctx.shell`，由执行器
 * 负责平台 shell（Windows 下是 PowerShell，`.cmd` shim 可被解析）、超时与沙箱；
 * 插件只发送固定白名单里的命令，不拼接任何模型输入。
 *
 * @module dsh-session-cloudsync/device-info
 */
import { arch, platform, release } from 'node:os'

/** 服务端为本机分配的设备身份；`name` 已按配置优先、服务端 label 兜底。 */
export interface DeviceIdentity {
  readonly deviceId: string
  readonly name: string
}

/** 宿主的 `shell` 服务里本模块用到的最小结构。 */
export interface ShellResultLike {
  readonly stdout?: string
  readonly stderr?: string
  readonly exitCode?: number | null
  readonly timedOut?: boolean
}

export interface ShellExecutionLike {
  result(): Promise<ShellResultLike>
}

export interface ShellServiceLike {
  resolve(request: {
    readonly command: string
    readonly timeoutMs?: number
    readonly signal?: AbortSignal
  }): unknown
  execute(spec: unknown): Promise<ShellExecutionLike>
}

/** 一次工具链探测的结果。 */
export interface ToolchainFact {
  readonly name: string
  /** `--version` 的第一行；探测失败时省略。 */
  readonly version?: string
  /** 执行文件路径；解析不到时省略。 */
  readonly path?: string
  readonly source: 'auto'
}

/** 环境工具返回的规范值。 */
export interface EnvironmentFacts {
  readonly device?: DeviceIdentity
  readonly os: {
    readonly platform: string
    readonly arch: string
    readonly release: string
  }
  readonly dsh: {
    readonly version: string
    readonly profile: string
    readonly sessionFormatVersion: number
  }
  readonly node: string
  readonly workspaces: readonly { readonly path: string; readonly label: string }[]
  readonly toolchain: readonly ToolchainFact[]
  readonly toolchainError?: string
}

/** 默认探测的命令；插件配置可覆盖。 */
export const DEFAULT_TOOLCHAIN_COMMANDS = ['node', 'npm', 'pnpm', 'git', 'python', 'uv'] as const

/** 当前插件验证与写入的 DSH 会话格式代际。 */
export const DSH_SESSION_FORMAT_VERSION = 4

const IDENTITY_TTL_MS = 10 * 60 * 1000
const TOOLCHAIN_TTL_MS = 10 * 60 * 1000
const PROBE_TIMEOUT_MS = 1_500
const PROBE_CONCURRENCY = 2
const SAFE_COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/u

/** 设备身份来源；每次读取时取最新配置。 */
export interface DeviceIdentitySource {
  readonly serverUrl: string
  readonly token: string
  readonly deviceName: string
  readonly requestTimeoutMs?: number
  readonly fetch?: typeof fetch
}

interface WarnLogger {
  warn(message: string): void
}

/**
 * 缓存 `/v2/me` 的设备身份（`deviceId` + 显示名）。
 *
 * 身份随 token/服务端地址失效；TTL 内复用，避免每个 turn 都发请求。
 */
export class DeviceIdentityCache {
  private cached: {
    readonly base: string
    readonly token: string
    readonly at: number
    readonly deviceId: string
    readonly label: string
  } | undefined
  private readonly source: () => DeviceIdentitySource
  private readonly logger: WarnLogger | undefined
  private readonly now: () => number
  /** 上次失败尝试的时间；离线时不每轮都打日志/发请求。 */
  private failedAt: number | undefined

  /**
   * @param source - 读取当前服务端/token/设备名的回调。
   * @param logger - 可选告警输出。
   * @param now - 可替换时钟（测试）。
   */
  constructor(
    source: () => DeviceIdentitySource,
    logger?: WarnLogger,
    now: () => number = Date.now,
  ) {
    this.source = source
    this.logger = logger
    this.now = now
  }

  /**
   * 同步读最近一次成功身份；过期或与当前配置不匹配时返回 undefined。
   * @returns 设备身份或 undefined。
   */
  snapshot(): DeviceIdentity | undefined {
    if (this.cached === undefined) return undefined
    const source = this.source()
    if (this.cached.base !== source.serverUrl || this.cached.token !== source.token) return undefined
    if (this.now() - this.cached.at > IDENTITY_TTL_MS) return undefined
    const configured = source.deviceName.trim()
    return {
      deviceId: this.cached.deviceId,
      name: configured !== '' ? configured : this.cached.label,
    }
  }

  /** 丢弃缓存；token/服务端地址/设备名变化后调用。 */
  invalidate(): void {
    this.cached = undefined
    this.failedAt = undefined
  }

  /**
   * 重新读取 `/v2/me`；失败时保留未过期的旧值并只告警。
   * @returns 设备身份或 undefined。
   */
  async refresh(): Promise<DeviceIdentity | undefined> {
    const cached = this.snapshot()
    if (cached !== undefined) return cached
    const now = this.now()
    if (this.failedAt !== undefined && now - this.failedAt < 60_000) return undefined
    const source = this.source()
    const base = source.serverUrl.trim().replace(/\/+$/u, '')
    if (base === '' || source.token.trim() === '') {
      this.cached = undefined
      return undefined
    }
    const fetchImpl = source.fetch ?? fetch
    try {
      const response = await fetchImpl(`${base}/v2/me`, {
        method: 'GET',
        headers: { authorization: `Bearer ${source.token}` },
        signal: AbortSignal.timeout(source.requestTimeoutMs ?? 10_000),
      })
      if (!response.ok) throw new Error(`/v2/me 返回 ${response.status}`)
      const body = await response.json() as { value?: { role?: unknown; device?: unknown } }
      const device = body.value?.device
      if (body.value?.role !== 'device' || device === null || typeof device !== 'object') {
        throw new Error('/v2/me 不是设备身份')
      }
      const record = device as Record<string, unknown>
      if (typeof record['deviceId'] !== 'string' || typeof record['label'] !== 'string') {
        throw new Error('/v2/me 缺少 deviceId/label')
      }
      this.cached = {
        base,
        token: source.token,
        at: this.now(),
        deviceId: record['deviceId'],
        label: record['label'],
      }
      return this.snapshot()
    } catch (error: unknown) {
      this.failedAt = now
      this.logger?.warn(`dsh-session-cloudsync: 读取本机设备身份失败：${error instanceof Error ? error.message : String(error)}`)
      return this.snapshot()
    }
  }
}

/** 环境采集依赖。 */
export interface LocalEnvironmentOptions {
  /** 最近一次设备身份；没有时输出里省略 device。 */
  readonly identity: () => DeviceIdentity | undefined
  /** 宿主的 shell 服务；没有时工具链标记为未采集。 */
  readonly shell: () => ShellServiceLike | undefined
  /** 本机已注册工作区。 */
  readonly workspaces: () => readonly { readonly path: string; readonly label: string }[]
  /** 工具链命令白名单；默认 {@link DEFAULT_TOOLCHAIN_COMMANDS}。 */
  readonly commands?: () => readonly string[]
  /** DSH 版本；缺省读环境变量。 */
  readonly dshVersion?: () => string
  /** DSH profile；缺省读环境变量。 */
  readonly dshProfile?: () => string
  readonly logger?: WarnLogger
  readonly now?: () => number
}

/**
 * 采集本机环境事实：纯本地读取，工具链探测结果缓存一段时间。
 */
export class LocalEnvironment {
  private toolchain?: {
    readonly at: number
    readonly value: readonly ToolchainFact[]
    readonly error?: string
  }
  private readonly options: LocalEnvironmentOptions

  /**
   * @param options - 采集依赖。
   */
  constructor(options: LocalEnvironmentOptions) {
    this.options = options
  }

  /**
   * 读取一次环境事实。
   * @param input - 可选中止信号与强制刷新工具链。
   * @returns 规范值。
   */
  async facts(input: { readonly signal?: AbortSignal; readonly refresh?: boolean } = {}): Promise<EnvironmentFacts> {
    const toolchain = await this.toolchainFacts(input)
    const identity = this.options.identity()
    return {
      ...identity === undefined ? {} : { device: { deviceId: identity.deviceId, name: identity.name } },
      os: { platform: platform(), arch: arch(), release: release() },
      dsh: {
        version: this.options.dshVersion?.() ?? process.env.DSH_VERSION ?? 'unknown',
        profile: this.options.dshProfile?.() ?? process.env.DSH_PROFILE ?? '',
        sessionFormatVersion: DSH_SESSION_FORMAT_VERSION,
      },
      node: process.version,
      workspaces: this.options.workspaces().map((workspace) => ({ path: workspace.path, label: workspace.label })),
      toolchain: toolchain.value,
      ...toolchain.error === undefined ? {} : { toolchainError: toolchain.error },
    }
  }

  /**
   * 探测工具链；TTL 内复用缓存。
   * @param input - 中止信号与强制刷新。
   * @returns 条目与可选错误说明。
   */
  private async toolchainFacts(input: { readonly signal?: AbortSignal; readonly refresh?: boolean }): Promise<{
    readonly value: readonly ToolchainFact[]
    readonly error?: string
  }> {
    const now = (this.options.now ?? Date.now)()
    const current = this.toolchain
    if (input.refresh !== true && current !== undefined && now - current.at < TOOLCHAIN_TTL_MS) {
      return current.error === undefined ? { value: current.value } : { value: current.value, error: current.error }
    }
    const shell = this.options.shell()
    if (shell === undefined) {
      const error = '宿主没有 shell 服务，工具链未采集'
      this.toolchain = { at: now, value: [], error }
      return { value: [], error }
    }
    const commands = (this.options.commands?.() ?? DEFAULT_TOOLCHAIN_COMMANDS)
      .filter((name): name is string => typeof name === 'string' && SAFE_COMMAND_NAME.test(name))
    const probed = await runLimited(
      commands.map((name) => async () => probeTool(shell, name, input.signal)),
      PROBE_CONCURRENCY,
    )
    const value = probed.filter((entry): entry is ToolchainFact => entry !== undefined)
    this.toolchain = { at: now, value }
    return { value }
  }
}

/**
 * 用宿主 shell 探测一个命令：版本行 + 可执行文件路径。
 * @param shell - 宿主 shell 服务。
 * @param name - 已通过白名单校验的命令名。
 * @param signal - 调用方的中止信号。
 * @returns 探测结果；命令不存在时 undefined。
 */
async function probeTool(shell: ShellServiceLike, name: string, signal?: AbortSignal): Promise<ToolchainFact | undefined> {
  const versionOutput = await runShell(shell, `${name} --version`, signal)
  if (versionOutput === undefined) return undefined
  const version = firstLine(versionOutput, 120)
  if (version === undefined) return undefined
  const pathOutput = await runShell(shell, executablePathCommand(name), signal)
  const executable = pathOutput === undefined ? undefined : firstLine(pathOutput, 300)
  return {
    name,
    version,
    ...executable === undefined ? {} : { path: executable },
    source: 'auto',
  }
}

/**
 * 平台对应的可执行文件解析命令；只是展示信息，失败不影响版本。
 * @param name - 白名单命令名。
 * @returns shell 命令文本。
 */
function executablePathCommand(name: string): string {
  return process.platform === 'win32'
    ? `(Get-Command ${name} -ErrorAction SilentlyContinue).Source`
    : `command -v ${name}`
}

/**
 * 跑一条固定命令并返回合并后的输出。
 * @param shell - 宿主 shell 服务。
 * @param command - 固定命令文本（不含外部输入）。
 * @param signal - 调用方的中止信号。
 * @returns stdout/stderr；超时、失败或空输出时 undefined。
 */
async function runShell(shell: ShellServiceLike, command: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const spec = shell.resolve({
      command,
      timeoutMs: PROBE_TIMEOUT_MS,
      ...signal === undefined ? {} : { signal },
    })
    const handle = await shell.execute(spec)
    const result = await handle.result()
    if (result.timedOut === true) return undefined
    // 命令不存在时 PowerShell/bash 会把错误写到 stderr；非 0 退出码不能当版本行。
    if (result.exitCode !== undefined && result.exitCode !== 0) return undefined
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
    return output === '' ? undefined : output
  } catch {
    // 单条探测失败只说明该工具不可用；整体环境采集继续。
    return undefined
  }
}

/**
 * 取第一行并截断。
 * @param text - 命令输出。
 * @param limit - 最大字符数。
 * @returns 第一行或 undefined。
 */
function firstLine(text: string, limit: number): string | undefined {
  const line = text.split(/\r?\n/u).map((part) => part.trim()).find((part) => part !== '')
  if (line === undefined) return undefined
  return line.length <= limit ? line : line.slice(0, limit)
}

/**
 * 限并发执行。
 * @param tasks - 任务列表。
 * @param limit - 最大并发。
 * @returns 与输入同序的结果。
 */
async function runLimited<T>(tasks: readonly (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= tasks.length) return
      results[index] = await tasks[index]!()
    }
  })
  await Promise.all(workers)
  return results
}
