/**
 * 本机环境事实工具：按 `get_env` → `this_env` → `dscs_env` 取第一个可用名注册。
 *
 * 工具名是全局扁平表，DSH 撞名直接抛错、不自动改名；所以按优先级探测并回退，
 * 全部被占用时只告警、不注册。设备切换提示里的工具名必须用这里实际注册成功的名字。
 *
 * @module dsh-session-cloudsync/env-tool
 */
import type { EnvironmentFacts } from './device-info.ts'

/** 工具名候选，按优先级排列。 */
export const ENV_TOOL_NAMES = ['get_env', 'this_env', 'dscs_env'] as const

/** 宿主 `tools` 服务里本模块用到的最小结构。 */
export interface ToolsServiceLike {
  register(definition: ToolDefinitionLike): () => void
  get?(name: string): unknown
}

/** 工具执行上下文里本工具用到的字段。 */
export interface ToolExecutionLike {
  readonly signal?: AbortSignal
}

/** 工具定义的最小结构；字段按 DSH `ToolDefinition` 的运行时契约填写。 */
export interface ToolDefinitionLike {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
  readonly output: {
    readonly schema: unknown
    render(args: unknown, value: unknown): readonly { readonly type: 'text'; readonly text: string }[]
  }
  execute(args: unknown, exec?: ToolExecutionLike): Promise<unknown>
}

/** 注册结果。 */
export interface RegisteredEnvTool {
  /** 实际注册成功的工具名。 */
  readonly name: string
  dispose(): void
}

interface WarnLogger {
  warn(message: string): void
}

/** 工具输出的 JSON Schema（DSH 支持的子集）。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    device: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['deviceId', 'name'],
      additionalProperties: false,
    },
    os: {
      type: 'object',
      properties: {
        platform: { type: 'string' },
        arch: { type: 'string' },
        release: { type: 'string' },
      },
      required: ['platform', 'arch', 'release'],
      additionalProperties: false,
    },
    dsh: {
      type: 'object',
      properties: {
        version: { type: 'string' },
        profile: { type: 'string' },
        sessionFormatVersion: { type: 'integer' },
      },
      required: ['version', 'profile', 'sessionFormatVersion'],
      additionalProperties: false,
    },
    node: { type: 'string' },
    workspaces: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          label: { type: 'string' },
        },
        required: ['path', 'label'],
        additionalProperties: false,
      },
    },
    toolchain: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          version: { type: 'string' },
          path: { type: 'string' },
          source: { type: 'string', enum: ['auto'] },
        },
        required: ['name', 'source'],
        additionalProperties: false,
      },
    },
    toolchainError: { type: 'string' },
  },
  required: ['os', 'dsh', 'node', 'workspaces', 'toolchain'],
  additionalProperties: false,
} as const

/** 无参数；`refresh` 可强制重新探测工具链。 */
const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    refresh: { type: 'boolean' },
  },
  required: [],
  additionalProperties: false,
} as const

/**
 * 按优先级注册环境工具。
 * @param tools - 宿主 `tools` 服务；不存在时返回 undefined。
 * @param collect - 采集环境事实（接收中止信号与 refresh）。
 * @param logger - 可选告警输出。
 * @returns 注册结果（实际工具名 + disposer），或 undefined。
 */
export function registerEnvTool(
  tools: ToolsServiceLike | undefined,
  collect: (input: { readonly signal?: AbortSignal; readonly refresh?: boolean }) => Promise<EnvironmentFacts>,
  logger?: WarnLogger,
): RegisteredEnvTool | undefined {
  if (tools === undefined || typeof tools.register !== 'function') return undefined
  for (const candidate of ENV_TOOL_NAMES) {
    if (typeof tools.get === 'function') {
      try {
        if (tools.get(candidate) !== undefined) continue
      } catch {
        // `get` 的 scope 语义可能不同；以 register 的撞名错误为准。
      }
    }
    try {
      const dispose = tools.register(definitionOf(candidate, collect))
      return { name: candidate, dispose }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/already registered/u.test(message)) throw error
    }
  }
  logger?.warn('dsh-session-cloudsync: 环境工具候选名全部被占用，未注册环境工具（设备切换提示同时关闭）')
  return undefined
}

/**
 * 构造一次注册用的工具定义。
 * @param name - 本次候选的工具名。
 * @param collect - 事实采集。
 * @returns 工具定义。
 */
function definitionOf(
  name: string,
  collect: (input: { readonly signal?: AbortSignal; readonly refresh?: boolean }) => Promise<EnvironmentFacts>,
): ToolDefinitionLike {
  return {
    name,
    description: 'Read this machine\'s environment facts: device name and id, OS, DSH version/profile, '
      + 'Node, local workspace paths, and toolchain versions/paths. Local only; no network.',
    parameters: PARAMETERS_SCHEMA,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderFacts(value as EnvironmentFacts) }],
    },
    async execute(args, exec) {
      const refresh = args !== null && typeof args === 'object'
        && (args as { readonly refresh?: unknown }).refresh === true
      return await collect({
        ...exec?.signal === undefined ? {} : { signal: exec.signal },
        ...refresh ? { refresh: true } : {},
      })
    },
  }
}

/**
 * 模型可读的 Markdown 摘要。
 * @param facts - 环境事实。
 * @returns Markdown 文本。
 */
export function renderFacts(facts: EnvironmentFacts): string {
  const lines = ['# This machine', '']
  if (facts.device === undefined) {
    lines.push('- device: unknown (server identity unavailable)')
  } else {
    lines.push(`- device: ${facts.device.name} (${facts.device.deviceId})`)
  }
  lines.push(`- OS: ${facts.os.platform} ${facts.os.arch} ${facts.os.release}`)
  lines.push(`- DSH: ${facts.dsh.version}${facts.dsh.profile === '' ? '' : ` (profile ${facts.dsh.profile})`}`
    + `, Node ${facts.node}, session format ${facts.dsh.sessionFormatVersion}`)
  if (facts.workspaces.length === 0) {
    lines.push('- workspaces: none registered')
  } else {
    lines.push('- workspaces:')
    for (const workspace of facts.workspaces) lines.push(`  - ${workspace.path} (${workspace.label})`)
  }
  if (facts.toolchain.length === 0) {
    lines.push(`- toolchain: not collected${facts.toolchainError === undefined ? '' : ` (${facts.toolchainError})`}`)
  } else {
    lines.push('- toolchain:')
    for (const tool of facts.toolchain) {
      const path = tool.path === undefined ? '' : ` — ${tool.path}`
      lines.push(`  - ${tool.name} ${tool.version ?? 'unknown'}${path}`)
    }
    if (facts.toolchainError !== undefined) lines.push(`  - error: ${facts.toolchainError}`)
  }
  return lines.join('\n')
}
