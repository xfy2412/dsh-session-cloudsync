/**
 * 跨设备插件版本快照：本机 bundle 列表、Vault 上行数据与 UI 共用的规范形态。
 *
 * 只描述“这个 profile 装了哪些 bundle、什么版本、是否启用”，不保存图标或路径；
 * 图标由客户端本地读取，未安装的插件后续再按 registry 元数据补。
 *
 * @module dsh-session-cloudsync/plugin-versions
 */

/** 一条插件版本快照。 */
export interface PluginVersionSnapshot {
  readonly name: string
  readonly version: string
  /** 原始 profile spec（registry 范围、git、file:、link:）；安装自带的 bundle 省略。 */
  readonly source?: string
  readonly enabled: boolean
}

/** UI 用的快照：带本机或 registry 读到的图标 data URL，不写 Vault。 */
export interface PluginVersionView extends PluginVersionSnapshot {
  /** `data:image/...;base64,...`；取不到时省略。 */
  readonly icon?: string
}

/** 跨设备插件版本面板的完整快照。 */
export interface PluginVersionsSnapshot {
  /** 本机是否提供 pluginManager（没有时面板只能展示，不能应用）。 */
  readonly supported: boolean
  readonly generatedAt: number
  readonly local: {
    readonly deviceId: string
    readonly name: string
    readonly plugins: readonly PluginVersionView[]
  }
  readonly peers: readonly {
    readonly deviceId: string
    readonly name: string
    readonly plugins: readonly PluginVersionView[]
  }[]
  /** plugin name → registry 上 `latest` 的版本；查不到时省略。 */
  readonly registry: Readonly<Record<string, string>>
  /** plugin name → registry latest 的图标 data URL；查不到时省略。 */
  readonly registryIcons: Readonly<Record<string, string>>
}

/** UI 选中的一项变更。 */
export interface PluginVersionApplyItem {
  readonly name: string
  readonly version: string
  readonly action: 'install' | 'update'
}

/** 单项变更的执行结果。 */
export interface PluginVersionApplyResult {
  readonly name: string
  readonly version: string
  readonly action: 'install' | 'update'
  readonly ok: boolean
  readonly error?: string
  readonly pendingBuilds?: readonly string[]
}

/** `pluginManager.listBundles()` 里本模块用到的最小字段。 */
export interface PluginManagerBundleLike {
  readonly name: string
  readonly version?: string
  readonly installed?: boolean
  readonly enabled?: boolean
  readonly source?: string
  readonly official?: boolean
  readonly availability?: string
  readonly meta?: { readonly icon?: string }
}

/** 宿主 `pluginManager` 服务的最小结构。 */
export interface PluginManagerLike {
  listBundles(): Promise<readonly PluginManagerBundleLike[]>
  installBundle(spec: string, options?: {
    readonly enabled?: boolean
    readonly saveExact?: boolean
    readonly expected?: { readonly name: string; readonly version: string }
  }): Promise<unknown>
  updateBundle(name: string, version: string, options?: {
    readonly requestId?: string
  }): Promise<unknown>
  /** 当前 profile 的 registry 计划；旧宿主可能没有。 */
  registries?(): Promise<{
    readonly registry: string | null
    readonly resolved: string | null
    readonly fallbackRegistries?: readonly string[]
  }>
}

/** 最多上报/比较的插件数；避免异常 profile 把 Vault 记录撑爆。 */
export const MAX_PLUGIN_SNAPSHOTS = 64

/**
 * 把 `pluginManager.listBundles()` 的结果整理成快照。
 *
 * 只保留 profile 里真正声明过、能读到版本号的 bundle；安装自带的 official bundle
 * 各设备一致，不参与跨设备对齐。当前插件自身也排除，避免运行中替换自己。
 *
 * @param bundles - `listBundles()` 的返回值。
 * @returns 按 name 排序的快照。
 */
export function snapshotsFromBundles(
  bundles: readonly PluginManagerBundleLike[],
): PluginVersionView[] {
  const seen = new Set<string>()
  const result: PluginVersionView[] = []
  for (const bundle of bundles) {
    if (bundle === null || typeof bundle !== 'object') continue
    const name = typeof bundle.name === 'string' ? bundle.name.trim() : ''
    const version = typeof bundle.version === 'string' ? bundle.version.trim() : ''
    if (name === '' || version === '' || seen.has(name)) continue
    if (name === 'dsh-session-cloudsync') continue
    if (bundle.installed !== true) continue
    seen.add(name)
    const source = typeof bundle.source === 'string' && bundle.source.trim() !== ''
      ? bundle.source.trim()
      : undefined
    const icon = typeof bundle.meta?.icon === 'string' && bundle.meta.icon.startsWith('data:image/')
      ? bundle.meta.icon
      : undefined
    result.push({
      name,
      version,
      ...source === undefined ? {} : { source },
      enabled: bundle.enabled === true,
      ...icon === undefined ? {} : { icon },
    })
    if (result.length >= MAX_PLUGIN_SNAPSHOTS) break
  }
  return result.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * 校验并归一化 Vault/设备台账里读到的插件快照。
 *
 * 上游数据可能来自旧版本或损坏记录；非法项静默跳过。
 *
 * @param value - 原始数组。
 * @returns 合法快照。
 */
export function sanitizePluginSnapshots(value: unknown): PluginVersionSnapshot[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: PluginVersionSnapshot[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const name = typeof record['name'] === 'string' ? record['name'].trim() : ''
    const version = typeof record['version'] === 'string' ? record['version'].trim() : ''
    if (name === '' || name.length > 200 || version === '' || version.length > 200) continue
    if (seen.has(name)) continue
    seen.add(name)
    const source = typeof record['source'] === 'string' && record['source'].trim() !== ''
      ? record['source'].trim().slice(0, 1024)
      : undefined
    result.push({
      name,
      version,
      ...source === undefined ? {} : { source },
      enabled: record['enabled'] !== false,
    })
    if (result.length >= MAX_PLUGIN_SNAPSHOTS) break
  }
  return result.sort((left, right) => left.name.localeCompare(right.name))
}
