/**
 * 同步状态快照：宿主内部状态到客户端可读 JSON 的稳定投影。
 *
 * 快照只含非敏感字段，可以直接由 `/api/session-cloudsync/status` 返回；token /
 * passphrase 永远不出现在这里。
 *
 * @module dsh-session-cloudsync/status
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
  /** 最后 cwd 是否在工作区外；只做本地警告，不影响哈希/同步身份。 */
  readonly cwdNonPortable?: boolean
  /** 远端 manifest 的 workspaceKey（若有）。 */
  readonly workspaceKey?: string
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

/** 一个需要人工处理、不能继续写入的会话。 */
export interface BlockedSessionView {
  /** 会话 id。 */
  readonly sessionId: string
  readonly createdAt: number
  readonly formatVersion: number
  /** 为什么阻塞；当前只有分叉会进入这里。 */
  readonly kind: SyncErrorKind
  /** 可读原因。 */
  readonly message: string
  /** 记录时间（epoch ms）。 */
  readonly at: number
}

/** 一个已经由用户决定、当前不再硬阻塞的会话。 */
export interface BlockedDecisionView {
  readonly sessionId: string
  readonly createdAt: number
  readonly formatVersion: number
  readonly action: 'ignore' | 'force'
  readonly message: string
  readonly at: number
}

/** 一个会话的本地租约状态；用于设备独占。 */
export interface SessionLeaseView {
  /** 会话 id。 */
  readonly sessionId: string
  /** 当前租约状态。 */
  readonly state: 'held' | 'foreign' | 'lost' | 'renewing'
  /** 租约到期时间。 */
  readonly leaseUntil?: number
  /** 持有该租约的设备（服务端返回时）。 */
  readonly ownerDeviceId?: string
  /** 最近一次成功续租时间。 */
  readonly lastRenewAt?: number
  /** 最近一次续租/申请错误。 */
  readonly error?: string
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
  /** 活跃会话的设备独占租约。 */
  readonly leases: readonly SessionLeaseView[]
  /** 等待用户决定 cwd 修正/跳过的会话 id。 */
  readonly cwdPending: readonly string[]
  /** 已分叉、必须人工处理的会话；这些会话不能继续写入。 */
  readonly blocked: readonly BlockedSessionView[]
  /** 用户已选择忽略/强行写入的会话；可以恢复为阻塞。 */
  readonly blockedDecisions: readonly BlockedDecisionView[]
  /** 当前一轮的实时逐会话阶段；空闲时为空数组。 */
  readonly live: readonly SessionSyncView[]
}

/** 设置页/首启向导读取的非敏感配置。 */
export interface SetupInfo {
  /** 服务端凭据是否齐全。 */
  readonly configured: boolean
  /** 未配置原因。 */
  readonly reason: string | null
  /** 自部署服务端地址。 */
  readonly serverUrl: string
  /** 本设备短标签。 */
  readonly deviceName: string
  /** 本地排除的根会话 id。 */
  readonly excludedSessionIds: readonly string[]
  /** 是否自动绑定同路径远端工作区。 */
  readonly autoBindSamePath: boolean
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
  /** token 的来源层：凭据 provider 的 source（如 file/env），YAML fallback 为 config；未配置为 null。 */
  readonly tokenSource: string | null
  /** 口令的来源层：凭据 provider 的 source（如 file/env），YAML fallback 为 config；未配置为 null。 */
  readonly passphraseSource: string | null
  /** 客户端应写入的凭据引用名。 */
  readonly credentialRefs: {
    readonly token: string
    readonly passphrase: string
  }
}

/** 同步列表里的一个工作区（或未注册的 cwd 分组）。 */
export interface SyncWorkspaceCandidate {
  /** 工作区路径；映射目标。 */
  readonly path: string
  /** 显示标题：注册表标题，或路径最后一段。 */
  readonly title: string
  /** 本机路径派生的 workspaceKey（V2 映射建议）。 */
  readonly workspaceKey?: string
  /** 该路径下的根会话数。 */
  readonly rootSessions: number
  /** 该路径下根会话的子代理后代数。 */
  readonly subagentSessions: number
}

/** 一个可勾选的根会话。 */
export interface SyncSessionCandidate {
  readonly sessionId: string
  readonly workspacePath: string
  readonly createdAt: number
  readonly formatVersion: number
  readonly eventCount: number
  readonly subagentSessions: number
  /** 是否被本地排除。 */
  readonly excluded: boolean
}

/** 一条本机 workspace 绑定。 */
export interface SyncWorkspaceBinding {
  readonly workspaceKey: string
  readonly localPath: string
  readonly label: string
  readonly createdAt: number
}

/** 一个尚未映射的远端工作区。 */
export interface SyncUnmappedWorkspace {
  readonly workspaceKey: string | null
  /** 远端 workspace/profile 解密出的 label（若有）。 */
  readonly label?: string
  readonly sessions: number
}

/** 首启/设置页的同步列表。 */
export interface SyncWorkspaceList {
  /** 本机注册工作区；映射目标从这里选。 */
  readonly workspaces: readonly SyncWorkspaceCandidate[]
  /** 根会话选择列表。 */
  readonly sessions: readonly SyncSessionCandidate[]
  /** 当前本地排除的根会话 id。 */
  readonly excludedSessionIds: readonly string[]
  /** 本机一次性映射。 */
  readonly bindings: readonly SyncWorkspaceBinding[]
  /** 最近一次拉取中未映射的远端工作区。 */
  readonly unmapped: readonly SyncUnmappedWorkspace[]
}
