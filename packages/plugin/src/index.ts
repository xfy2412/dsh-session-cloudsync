/**
 * dsh-session-sync 宿主插件入口。
 *
 * 当前是脚手架：只声明名称、依赖的服务与配置，并在加载时记录一行日志。
 * 同步引擎（帧链上传/下载、租约、墓碑）与投影折叠随 M1 之后的里程碑落地。
 *
 * @module dsh-session-sync
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** 插件在加载器里的名字。 */
export const name = 'dsh-session-sync'

/** 本插件读取的服务；缺任何一个都由加载器在装载期报错，而不是运行期。 */
export const inject = ['sessions', 'sessionPersistence', 'sessionProjections']

/** 插件配置。 */
export interface Config {
  /** 总开关。默认 true。 */
  enabled?: boolean
  /** 自部署服务端地址；空表示未配置，插件只加载不动。 */
  serverUrl?: string
  /** 本设备短标签；空表示首次同步时生成。 */
  deviceName?: string
}

/** 配置 schema。 */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  serverUrl: z.string().default(''),
  deviceName: z.string().default(''),
})

/**
 * 注册插件。
 * @param ctx - 插件上下文；所有注册都随该 fiber 销毁。
 * @param config - 服务端地址、设备标签与总开关。
 */
export function apply(ctx: Context, config: Config): void {
  const server = config.serverUrl === undefined || config.serverUrl === '' ? '未配置' : config.serverUrl
  ctx.logger.info(`dsh-session-sync: 已加载（serverUrl=${server}, enabled=${config.enabled === false ? 'false' : 'true'}）`)
}
