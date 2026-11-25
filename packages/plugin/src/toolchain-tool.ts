/**
 * Agent 管理工具链的宿主工具：查看探测结果，或登记下载好的自定义工具。
 *
 * 只改本机配置里的 `toolchainAuthored` / `toolchainCommands`，不执行路径、
 * 不安装工具；实际下载/安装仍由 agent 用 shell 完成。
 *
 * @module dsh-session-cloudsync/toolchain-tool
 */
import type { EnvironmentFacts } from './device-info.ts'
import type { ToolsServiceLike, ToolDefinitionLike } from './env-tool.ts'

/** 工具链管理操作。 */
export type ToolchainAction = 'list' | 'add' | 'remove' | 'set-commands'

/** 宿主侧的工具链配置服务接口。 */
export interface ToolchainToolService {
  /** 读取当前环境事实。 */
  facts(refresh?: boolean): Promise<EnvironmentFacts>
  /** 新增或覆盖一个自定义工具。 */
  add(input: { readonly name: string; readonly path: string; readonly version?: string }): Promise<EnvironmentFacts>
  /** 按名称移除一个自定义工具。 */
  remove(name: string): Promise<EnvironmentFacts>
  /** 替换自动探测命令列表。 */
  setCommands(commands: readonly string[]): Promise<EnvironmentFacts>
}

/** 注册结果。 */
export interface RegisteredToolchainTool {
  readonly name: string
  dispose(): void
}

interface WarnLogger {
  warn(message: string): void
}

const NAME_CANDIDATES = ['toolchain_manage', 'dscs_toolchain'] as const

const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['list', 'add', 'remove', 'set-commands'] },
    name: { type: 'string' },
    path: { type: 'string' },
    version: { type: 'string' },
    commands: { type: 'array', items: { type: 'string' } },
  },
  required: ['action'],
  additionalProperties: false,
} as const

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
} as const

/**
 * 注册工具链管理工具。
 * @param tools - 宿主 `tools` 服务。
 * @param service - 工具链配置服务。
 * @param logger - 撞名告警。
 * @returns 实际注册名与 disposer；没有可用名时 undefined。
 */
export function registerToolchainTool(
  tools: ToolsServiceLike | undefined,
  service: ToolchainToolService,
  logger: WarnLogger,
): RegisteredToolchainTool | undefined {
  if (tools === undefined || typeof tools.register !== 'function') return undefined
  const definition: ToolDefinitionLike = {
    name: NAME_CANDIDATES[0],
    description: 'Manage this machine\'s toolchain registry. Use list to inspect detected tools; '
      + 'after downloading or installing a tool, use add with its absolute path to register it locally. '
      + 'Paths are recorded only and are never executed. add updates an entry with the same name.',
    parameters: PARAMETERS_SCHEMA,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const action = (args as { readonly action?: unknown }).action
      if (action === 'list') {
        return { action, facts: await service.facts() }
      }
      if (action === 'add') {
        const name = (args as { readonly name?: unknown }).name
        const path = (args as { readonly path?: unknown }).path
        const version = (args as { readonly version?: unknown }).version
        if (typeof name !== 'string' || name.trim() === '') throw new Error('add 需要非空 name')
        if (typeof path !== 'string' || path.trim() === '') throw new Error('add 需要非空 path')
        if (version !== undefined && typeof version !== 'string') throw new Error('version 必须是字符串')
        const facts = await service.add({
          name: name.trim(),
          path: path.trim(),
          ...version === undefined || version.trim() === '' ? {} : { version: version.trim() },
        })
        return { action, facts }
      }
      if (action === 'remove') {
        const name = (args as { readonly name?: unknown }).name
        if (typeof name !== 'string' || name.trim() === '') throw new Error('remove 需要非空 name')
        return { action, facts: await service.remove(name.trim()) }
      }
      if (action === 'set-commands') {
        const commands = (args as { readonly commands?: unknown }).commands
        if (!Array.isArray(commands) || commands.some((item) => typeof item !== 'string')) {
          throw new Error('set-commands 需要字符串数组 commands')
        }
        return { action, facts: await service.setCommands(commands) }
      }
      throw new Error('action 必须是 list/add/remove/set-commands')
    },
  }
  for (const candidate of NAME_CANDIDATES) {
    if (typeof tools.get === 'function') {
      try {
        if (tools.get(candidate) !== undefined) continue
      } catch {
        // `get` 的 scope 语义可能不同；以 register 的撞名错误为准。
      }
    }
    try {
      const dispose = tools.register({ ...definition, name: candidate })
      return { name: candidate, dispose }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/already registered/u.test(message)) throw error
    }
  }
  logger.warn('dsh-session-cloudsync: 工具链工具候选名全部被占用，未注册工具链管理工具')
  return undefined
}
