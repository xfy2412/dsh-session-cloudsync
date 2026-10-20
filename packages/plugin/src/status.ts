/**
 * 同步状态快照：宿主内部状态到客户端可读 JSON 的稳定投影。
 *
 * 快照只含非敏感字段，可以直接由 `/api/session-sync/status` 返回；token /
 * passphrase 永远不出现在这里。
 *
 * @module dsh-session-sync/status
 */
import type { PendingApply, SyncErrorKind } from './engine.ts'

/** 一个会话在最近一次同步中的结果；推送与拉取分开记录。 */
export interface SessionSyncView {
  /** 会话 id。 */
  readonly sessionId: string
  /** 这个结果来自推送还是拉取。 */
  readonly direction: 'push' | 'pull'
  /** 推送或拉取引擎给出的原始状态。 */
  readonly status: string
  /** 推送的批次数。 */
  readonly batches?: number
  /** 拉取应用的事件数。 */
  readonly applied?: number
  /** 推送的密文字节数。 */
  readonly bytes?: number
  /** 本地尾巴是否有未闭合的 turn。 */
  readonly tailOpen?: boolean
  /** 失败分类。 */
  readonly kind?: SyncErrorKind
  /** 失败说明。 */
  readonly error?: string
}

/** 最近一次错误。 */
export interface SyncErrorView {
  /** 稳定分类。 */
  readonly kind: SyncErrorKind
  /** 可读消息。 */
  readonly message: string
  /** 发生时间（epoch ms）。 */
  readonly at: number
}

/** 客户端轮询的完整同步状态。 */
export interface SyncStatus {
  /** serverUrl / token / passphrase 是否齐全。 */
  readonly configured: boolean
  /** 未配置时的原因；已配置为 null。 */
  readonly reason: string | null
  /** 当前是否有一轮同步在执行。 */
  readonly running: boolean
  /** 最近一轮开始时间；从未执行过为 null。 */
  readonly lastAttempt: number | null
  /** 最近一轮无错误完成的时间；从未成功为 null。 */
  readonly lastSuccess: number | null
  /** 最近一次错误；成功后清空。 */
  readonly lastError: SyncErrorView | null
  /** 连续失败次数，用于退避。 */
  readonly retryCount: number
  /** 下次自动重试时间；不处于退避中为 null。 */
  readonly nextRetryAt: number | null
  /** 上次崩溃前未完成的拉取；没有则为 null。 */
  readonly pending: PendingApply | null
  /** 已处理到的服务端 revision。 */
  readonly revision: number
  /** 最近一轮的逐会话结果；尚未执行过为空数组。 */
  readonly sessions: readonly SessionSyncView[]
}

/** 设置页/首启向导读取的非敏感配置。 */
export interface SetupInfo {
  /** 服务端凭据与工作区白名单是否齐全。 */
  readonly configured: boolean
  /** 未配置原因。 */
  readonly reason: string | null
  /** 自部署服务端地址。 */
  readonly serverUrl: string
  /** 本设备短标签。 */
  readonly deviceName: string
  /** 拉取会话挂载的本地工作区路径。 */
  readonly workspacePath: string
  /** 允许同步的工作区路径；空数组表示未配置。 */
  readonly workspaceAllowlist: readonly string[]
  /** 白名单是否已配置。 */
  readonly allowlistConfigured: boolean
  /** 是否按间隔自动同步。 */
  readonly autoSync: boolean
  /** 自动同步间隔（毫秒）。 */
  readonly intervalMs: number
  /** 是否同步子代理会话。 */
  readonly includeSubagents: boolean
  /** 是否已经配置 token；不返回 token 本身。 */
  readonly hasToken: boolean
  /** 是否已经配置口令；不返回口令本身。 */
  readonly hasPassphrase: boolean
}

/** 同步列表里的一个工作区（或未注册的 cwd 分组）。 */
export interface SyncWorkspaceCandidate {
  /** 工作区路径；选择后写入白名单。 */
  readonly path: string
  /** 显示标题：注册表标题，或路径最后一段。 */
  readonly title: string
  /** 该路径下的根会话数。 */
  readonly rootSessions: number
  /** 该路径下根会话的子代理后代数。 */
  readonly subagentSessions: number
  /** 当前白名单是否包含这个路径。 */
  readonly selected: boolean
}

/** 首启/设置页的同步列表。 */
export interface SyncWorkspaceList {
  /** 白名单是否已配置。 */
  readonly allowlistConfigured: boolean
  /** 当前白名单原样返回。 */
  readonly selectedPaths: readonly string[]
  /** 候选工作区；`全选` 即取全部 path。 */
  readonly workspaces: readonly SyncWorkspaceCandidate[]
}
