/**
 * 同步状态快照：宿主内部状态到客户端可读 JSON 的稳定投影。
 *
 * 快照只含非敏感字段，可以直接由 `/api/session-cloudsync/status` 返回；token /
 * passphrase 永远不出现在这里。
 *
 * @module dsh-session-cloudsync/status
 */
import type { PendingApply, SyncErrorKind } from './engine.ts'

/** 一个方向的稳定阶段。 */
export type SyncDirectionPhase =
  | 'planned'
  | 'transferring'
  | 'committing'
  | 'applying'
  | 'done'
  | 'up-to-date'
  | 'deferred'
  | 'skipped'
  | 'failed'

/** 一个会话在最近一轮同步中的一个方向。 */
export interface SyncDirectionStatus {
  /** 会话 id。 */
  readonly sessionId: string
  /** 这个结果来自推送还是拉取。 */
  readonly direction: 'push' | 'pull'
  /** 稳定阶段。 */
  readonly phase: SyncDirectionPhase
  /** 引擎原始状态，保留给诊断和精确标签。 */
  readonly status: string
  /** 本方向计划处理的事件数。 */
  readonly totalEvents: number
  /** 本方向已完成的事件数。 */
  readonly doneEvents: number
  /** 尚未完成/等待其他方向的事件数（例如 push 看到 remote-ahead）。 */
  readonly pendingEvents?: number
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

/** 一个会话的聚合阶段。 */
export type SyncSessionPhase =
  | 'planned'
  | 'running'
  | 'done'
  | 'deferred'
  | 'blocked'
  | 'failed'
  | 'skipped'

/** 一个会话在所有方向上的聚合状态。 */
export interface SyncSessionStatus {
  /** 会话 id。 */
  readonly sessionId: string
  /** 聚合阶段。 */
  readonly phase: SyncSessionPhase
  /** 推送方向。 */
  readonly push?: SyncDirectionStatus
  /** 拉取方向。 */
  readonly pull?: SyncDirectionStatus
  /** 尚未完成的事件数。 */
  readonly pending: { readonly upload: number; readonly download: number }
  /** 两个方向计划处理的事件总数。 */
  readonly totalEvents: number
  /** 两个方向已完成的事件总数。 */
  readonly doneEvents: number
  /** 会话是否在本进程 live。 */
  readonly live: boolean
  /** 本地尾巴是否开放。 */
  readonly tailOpen: boolean
  /** 推送是否看到远端领先。 */
  readonly remoteAhead: boolean
  /** 是否等待 cwd 决策。 */
  readonly cwdPending: boolean
  /** 未映射的远端工作区。 */
  readonly unmapped?: { readonly workspaceKey: string; readonly label?: string }
  /** 分叉阻塞。 */
  readonly blocked?: BlockedSessionView
  /** 用户对分叉的决定。 */
  readonly decision?: BlockedDecisionView
  /** 最后更新时间。 */
  readonly updatedAt: number
}

/** 当前一轮同步的元数据。 */
export interface SyncRunView {
  /** 递增的 run id。 */
  readonly id: number
  /** 触发来源。 */
  readonly trigger: 'startup' | 'auto' | 'manual'
  /** 当前状态。 */
  readonly state: 'idle' | 'running' | 'finished'
  /** 开始时间。 */
  readonly startedAt: number | null
  /** 结束时间。 */
  readonly finishedAt: number | null
}

/** 调度器的客户端视图。 */
export interface SyncSchedulerView {
  /** 是否开启自动同步。 */
  readonly autoSync: boolean
  /** 自动同步间隔。 */
  readonly intervalMs: number
  /** 下一次自动同步时间。 */
  readonly nextRunAt: number | null
  /** 退避截止时间。 */
  readonly backoffUntil: number | null
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

/** 全局单写者租约状态；本机没有 held 时只拉取、不上传。 */
export interface DeviceLeaseView {
  /** 当前租约状态。 */
  readonly state: 'held' | 'foreign' | 'lost' | 'unconfigured'
  /** 租约到期时间。 */
  readonly leaseUntil?: number
  /** 持有该租约的设备（服务端返回错误时通常不可得）。 */
  readonly ownerDeviceId?: string
  /** 最近一次成功续租时间。 */
  readonly lastRenewAt?: number
  /** 最近一次申请/续租错误。 */
  readonly error?: string
}

/** 客户端轮询的完整同步状态。 */
export interface SyncStatus {
  /** 状态 schema 版本；当前为 2。 */
  readonly schemaVersion: 2
  /** 单调整数；客户端只接受更大的值。 */
  readonly statusVersion: number
  /** serverUrl / token / passphrase 是否齐全。 */
  readonly configured: boolean
  /** 未配置时的原因；已配置为 null。 */
  readonly reason: string | null
  /** 当前是否有一轮同步在执行。 */
  readonly running: boolean
  /** 当前/最近一轮的元数据。 */
  readonly run: SyncRunView
  /** 调度器视图。 */
  readonly scheduler: SyncSchedulerView
  /** 全局单写者租约；缺失即只读。 */
  readonly deviceLease: DeviceLeaseView
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
  /** 逐个会话的聚合视图；每个 sessionId 只出现一次。 */
  readonly sessions: readonly SyncSessionStatus[]
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
