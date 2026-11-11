/**
 * 宿主 HTTP API：把同步控制暴露给 DSH Web 客户端。
 *
 * 只注册精确的 `/api/session-cloudsync/*` 路由，由 `ctx.connection.fetch` 继承
 * DSH Web 的 owner 鉴权；不另外发 token，也不使用裸 `webServer` 路由。
 *
 * @module dsh-session-cloudsync/host-api
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { classifySyncError } from './engine.ts'
import type { CwdCorrectionResult, PassphraseCheck, ServerProbeResult, SyncTestResult } from './engine.ts'
import type { ReplacePlan } from './replace.ts'
import type { SyncRunResult } from './controller.ts'
import type { PerfSnapshot } from './perf.ts'
import type { SessionScopeResult, SessionSyncView, SetupInfo, SyncConfigSnapshot, SyncStatus, SyncWorkspaceList } from './status.ts'

/** 宿主注入的控制面。 */
export interface SyncControl {
  /** 当前状态快照。 */
  status(): SyncStatus
  /** 单会话同步状态：复用只读规划；会话不在同步范围时返回 undefined。 */
  sessionStatus(sessionId: string): Promise<SessionSyncView | undefined>
  /** 进程内最近若干次性能采集快照。 */
  perf(): PerfSnapshot
  /** 所有设置/向导/气泡共用的单一快照。 */
  config(): Promise<SyncConfigSnapshot>
  /** 打开一个状态 SSE 流。 */
  events(request: Request): Promise<Response>
  /** 非敏感配置，供首启/设置页读取；会顺带刷新凭据。 */
  setup(): Promise<SetupInfo>
  /** 同步列表：工作区、会话计数与当前选中项。 */
  workspaces(): Promise<SyncWorkspaceList>
  /** 测试给定服务端地址是否可达；不读取配置、不携带 token。 */
  test(serverUrl: string): Promise<SyncTestResult>
  /** 手动触发一轮同步；已在运行时返回 `already-running`。 */
  syncNow(): Promise<SyncRunResult>
  /** 单会话定向同步；`direction=push` 需要全局写入租约。 */
  syncSession(sessionId: string, direction: 'push' | 'pull'): Promise<SyncRunResult>
  /** 单会话上传开关：等价于设置页白名单；未绑定工作区时返回候选。 */
  sessionScope(sessionId: string, enabled: boolean, choice?: 'create' | string): Promise<SessionScopeResult>
  /** 接收端 cwd 决策：fix 追加修正并推送；skip 直接挂载原会话。 */
  cwdDecision(sessionId: string, action: 'fix' | 'skip'): Promise<CwdCorrectionResult>
  /** 分叉会话的人工决定：ignore 不再自动提示；force 解除写入拦截；restore 恢复阻塞。 */
  resolveBlocked(
    sessionId: string,
    action: 'ignore' | 'force' | 'restore',
    createdAt: number,
    formatVersion: number,
  ): Promise<{ readonly ok: true }>
  /** 生成“远端覆盖本地”的停机脚本；只生成，不执行。 */
  prepareReplace(sessionId: string): Promise<ReplacePlan>
  /** 建立一次性 workspaceKey → localPath 绑定。 */
  bindWorkspace(workspaceKey: string, localPath: string): Promise<SyncWorkspaceList>
  /** 用给定地址与 token 探测服务端；不落盘。 */
  probe(serverUrl: string, token: string): Promise<ServerProbeResult>
  /** 用给定口令验证能否解开云端数据。 */
  verifyPassphrase(serverUrl: string, token: string, passphrase: string): Promise<PassphraseCheck>
  /** 检查路径能否直接绑定/需要创建/只能另选。 */
  resolveWorkspacePath(path: string): Promise<WorkspacePathState>
  /** 必要时建目录，然后注册为 DSH 工作区。 */
  createWorkspace(path: string, title?: string): Promise<CreatedWorkspace>
  /** 打开目录选择器；native 返回路径，browse/不可用返回 kind。 */
  pickDirectory(): Promise<DirectoryPickResult>
}

/** 目标路径的可用形态：直接绑定 / 需要先建目录 / 只能另选。 */
export interface WorkspacePathState {
  readonly path: string
  readonly mode: 'bind' | 'create' | 'pick'
  readonly exists: boolean
  readonly isDirectory: boolean
  readonly writable: boolean
  readonly parentExists: boolean
  readonly parentWritable: boolean
  readonly rootExists: boolean
  readonly sameOs: boolean
}

/** 目录选择器的能力形态。 */
export type DirectoryPickResult =
  | { readonly kind: 'native'; readonly path: string | null }
  | { readonly kind: 'browse' }
  | { readonly kind: 'unavailable' }

/** 新建工作区结果。 */
export interface CreatedWorkspace {
  readonly path: string
  readonly title: string
  readonly created: boolean
}

/**
 * 面向客户端的使用协议文档。
 *
 * 仓库文档是唯一来源：发布构建把 `docs/guides/USAGE-AGREEMENT.md` 复制到
 * `lib/agreement.md`；源码直跑时回退到仓库文档。hash 就是客户端记录的已读版本。
 */
export interface AgreementDocument {
  /** Markdown 正文。 */
  readonly markdown: string
  /** 正文的 sha256，内容变化即版本变化。 */
  readonly hash: string
  /** 文档里声明的生效日期；缺失时回退为 hash 前缀。 */
  readonly version: string
}

/** 发布包内路径 + 源码直跑时的仓库文档回退。 */
const AGREEMENT_FILES = [
  new URL('./agreement.md', import.meta.url),
  new URL('../../../docs/guides/USAGE-AGREEMENT.md', import.meta.url),
]

/**
 * 读取并标识当前使用协议。
 * @returns 正文、内容 hash 与生效日期。
 * @throws 两个候选路径都不可读时抛出。
 */
export function readAgreementDocument(): AgreementDocument {
  let markdown: string | undefined
  let lastError: unknown
  for (const file of AGREEMENT_FILES) {
    try {
      markdown = readFileSync(file, 'utf8')
      break
    } catch (error: unknown) {
      lastError = error
    }
  }
  if (markdown === undefined) throw lastError instanceof Error ? lastError : new Error('使用协议文件不存在')
  // 不同平台的 checkout 可能带 CRLF；hash 必须只反映内容变化。
  markdown = markdown.replace(/\r\n/g, '\n')
  const hash = createHash('sha256').update(markdown).digest('hex')
  const version = /^> 生效日期：([^\n。]+)/m.exec(markdown)?.[1]?.trim() ?? hash.slice(0, 12)
  return { markdown, hash, version }
}

/** connection.fetch 接受的精确路由。 */
export interface HostFetchRoute {
  /** `/api` 下的绝对路径。 */
  readonly path: string
  /** 本路由声明的方法。 */
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
  /** 请求体按 JSON 缓冲。 */
  readonly requestBody: 'buffered'
  /** Fetch 形态的处理函数。 */
  readonly fetch: (request: Request) => Promise<Response>
}

/** 响应包络：成功带 value，失败带 error。 */
interface Envelope<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly code: string; readonly message: string }
}

/**
 * 生成 `/api/session-cloudsync/*` 路由表。
 * @param control - 宿主控制面。
 * @returns 可直接交给 `connection.fetch.register` 的路由。
 */
export function createHostApi(control: SyncControl): readonly HostFetchRoute[] {
  return [
    {
      path: '/api/session-cloudsync/status',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => json({ ok: true, value: control.status() }),
    },
    {
      path: '/api/session-cloudsync/session-status',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        try {
          const sessionId = new URL(request.url).searchParams.get('id')?.trim() ?? ''
          if (sessionId === '') {
            return json({ ok: false, error: { code: 'bad-request', message: '需要 id 参数' } }, 400)
          }
          return json({ ok: true, value: await control.sessionStatus(sessionId) })
        } catch (error: unknown) {
          const classified = classifySyncError(error)
          return json({
            ok: false,
            error: { code: classified.kind, message: classified.message },
          }, 500)
        }
      },
    },
    {
      path: '/api/session-cloudsync/perf',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => json({ ok: true, value: control.perf() }),
    },
    {
      path: '/api/session-cloudsync/config',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          return json({ ok: true, value: await control.config() })
        } catch (error: unknown) {
          const classified = classifySyncError(error)
          return json({
            ok: false,
            error: { code: classified.kind, message: classified.message },
          }, 500)
        }
      },
    },
    {
      path: '/api/session-cloudsync/agreement',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          return json({ ok: true, value: readAgreementDocument() })
        } catch (error: unknown) {
          return json({
            ok: false,
            error: {
              code: 'agreement-unavailable',
              message: error instanceof Error ? error.message : String(error),
            },
          }, 500)
        }
      },
    },
    {
      path: '/api/session-cloudsync/events',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request) => control.events(request),
    },
    {
      path: '/api/session-cloudsync/setup',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          return json({ ok: true, value: await control.setup() })
        } catch (error: unknown) {
          const classified = classifySyncError(error)
          return json({
            ok: false,
            error: { code: classified.kind, message: classified.message },
          }, 500)
        }
      },
    },
    {
      path: '/api/session-cloudsync/workspaces',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          return json({ ok: true, value: await control.workspaces() })
        } catch (error: unknown) {
          const classified = classifySyncError(error)
          return json({
            ok: false,
            error: { code: classified.kind, message: classified.message },
          }, 500)
        }
      },
    },
    {
      path: '/api/session-cloudsync/test',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        try {
          const body = await request.json().catch(() => ({})) as { readonly serverUrl?: unknown }
          const serverUrl = typeof body.serverUrl === 'string' ? body.serverUrl.trim() : ''
          if (serverUrl === '') {
            return json({ ok: false, error: { code: 'bad-request', message: '需要 serverUrl' } }, 400)
          }
          return json({ ok: true, value: await control.test(serverUrl) })
        } catch (error: unknown) {
          const classified = classifySyncError(error)
          return json({
            ok: false,
            error: { code: classified.kind, message: classified.message },
          }, 500)
        }
      },
    },
    {
      path: '/api/session-cloudsync/probe',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        try {
          const body = await request.json() as { readonly serverUrl?: unknown; readonly token?: unknown }
          const serverUrl = typeof body.serverUrl === 'string' ? body.serverUrl.trim() : ''
          const token = typeof body.token === 'string' ? body.token.trim() : ''
          // token 允许为空：控制面会回退到已保存的凭据，设置页用它刷新状态。
          if (serverUrl === '') {
            return json({ ok: false, error: { code: 'bad-request', message: '需要 serverUrl' } }, 400)
          }
          return json({ ok: true, value: await control.probe(serverUrl, token) })
        } catch (error: unknown) {
          const classified = classifySyncError(error)
          return json({ ok: false, error: { code: classified.kind, message: classified.message } }, 400)
        }
      },
    },
    {
      path: '/api/session-cloudsync/verify-passphrase',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        try {
          const body = await request.json() as {
            readonly serverUrl?: unknown
            readonly token?: unknown
            readonly passphrase?: unknown
          }
          const serverUrl = typeof body.serverUrl === 'string' ? body.serverUrl.trim() : ''
          const token = typeof body.token === 'string' ? body.token.trim() : ''
          const passphrase = typeof body.passphrase === 'string' ? body.passphrase : ''
          // token 允许为空：控制面会回退到已保存的凭据，设置页用它验证口令。
          if (serverUrl === '' || passphrase === '') {
            return json({ ok: false, error: { code: 'bad-request', message: '需要 serverUrl 与 passphrase' } }, 400)
          }
          return json({ ok: true, value: await control.verifyPassphrase(serverUrl, token, passphrase) })
        } catch (error: unknown) {
          const classified = classifySyncError(error)
          return json({ ok: false, error: { code: classified.kind, message: classified.message } }, 400)
        }
      },
    },
    {
      path: '/api/session-cloudsync/workspaces/resolve',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        try {
          const body = await request.json() as { readonly path?: unknown }
          const path = typeof body.path === 'string' ? body.path.trim() : ''
          if (path === '') {
            return json({ ok: false, error: { code: 'bad-request', message: '需要 path' } }, 400)
          }
          return json({ ok: true, value: await control.resolveWorkspacePath(path) })
        } catch (error: unknown) {
          const classified = classifySyncError(error)
          return json({ ok: false, error: { code: classified.kind, message: classified.message } }, 400)
        }
      },
    },
    {
      path: '/api/session-cloudsync/workspaces/create',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        try {
          const body = await request.json() as { readonly path?: unknown; readonly title?: unknown }
          const path = typeof body.path === 'string' ? body.path.trim() : ''
          const title = typeof body.title === 'string' ? body.title.trim() : undefined
          if (path === '') {
            return json({ ok: false, error: { code: 'bad-request', message: '需要 path' } }, 400)
          }
          return json({ ok: true, value: await control.createWorkspace(path, title) })
        } catch (error: unknown) {
          const classified = classifySyncError(error)
          return json({ ok: false, error: { code: classified.kind, message: classified.message } }, 400)
        }
      },
    },
    {
      path: '/api/session-cloudsync/directory/pick',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          return json({ ok: true, value: await control.pickDirectory() })
        } catch (error: unknown) {
          const classified = classifySyncError(error)
          return json({ ok: false, error: { code: classified.kind, message: classified.message } }, 400)
        }
      },
    },
    {
      path: '/api/session-cloudsync/sync',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        try {
          const text = await request.text()
          if (text.trim() !== '') {
            const body = JSON.parse(text) as { readonly sessionId?: unknown; readonly direction?: unknown }
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
            const direction = body.direction === 'push' ? 'push' : body.direction === 'pull' ? 'pull' : ''
            if (sessionId !== '' || direction !== '') {
              if (sessionId === '' || direction === '') {
                return json({ ok: false, error: { code: 'bad-request', message: '需要 sessionId 与 direction=push|pull' } }, 400)
              }
              return json({ ok: true, value: await control.syncSession(sessionId, direction) })
            }
          }
          return json({ ok: true, value: await control.syncNow() })
        } catch (error: unknown) {
          const classified = classifySyncError(error)
          return json({
            ok: false,
            error: { code: classified.kind, message: classified.message },
          }, 500)
        }
      },
    },
    {
      path: '/api/session-cloudsync/session-scope',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        try {
          const body = await request.json() as {
            readonly sessionId?: unknown
            readonly enabled?: unknown
            readonly choice?: unknown
          }
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
          if (sessionId === '' || typeof body.enabled !== 'boolean') {
            return json({ ok: false, error: { code: 'bad-request', message: '需要 sessionId 与 enabled' } }, 400)
          }
          const choice = body.choice === 'create'
            ? 'create'
            : typeof body.choice === 'string' && body.choice.trim() !== '' ? body.choice.trim() : undefined
          return json({ ok: true, value: await control.sessionScope(sessionId, body.enabled, choice) })
        } catch (error: unknown) {
          const classified = classifySyncError(error)
          return json({
            ok: false,
            error: { code: classified.kind, message: classified.message },
          }, 500)
        }
      },
    },
    {
      path: '/api/session-cloudsync/cwd',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        try {
          const body = await request.json() as { readonly sessionId?: unknown; readonly action?: unknown }
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
          const action = body.action === 'skip' ? 'skip' : body.action === 'fix' ? 'fix' : ''
          if (sessionId === '' || action === '') {
            return json({ ok: false, error: { code: 'bad-request', message: '需要 sessionId 与 action=fix|skip' } }, 400)
          }
          return json({ ok: true, value: await control.cwdDecision(sessionId, action) })
        } catch (error: unknown) {
          const classified = classifySyncError(error)
          return json({
            ok: false,
            error: { code: classified.kind, message: classified.message },
          }, 500)
        }
      },
    },
    {
      path: '/api/session-cloudsync/blocked',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        try {
          const body = await request.json() as {
            readonly sessionId?: unknown
            readonly action?: unknown
            readonly createdAt?: unknown
            readonly formatVersion?: unknown
          }
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
          const action = body.action === 'ignore'
            ? 'ignore'
            : body.action === 'force'
              ? 'force'
              : body.action === 'restore' ? 'restore' : ''
          const createdAt = typeof body.createdAt === 'number' && Number.isSafeInteger(body.createdAt) ? body.createdAt : undefined
          const formatVersion = typeof body.formatVersion === 'number' && Number.isSafeInteger(body.formatVersion) ? body.formatVersion : undefined
          if (sessionId === '' || action === '' || createdAt === undefined || formatVersion === undefined) {
            return json({ ok: false, error: { code: 'bad-request', message: '需要 sessionId、action 与生命周期字段' } }, 400)
          }
          return json({ ok: true, value: await control.resolveBlocked(sessionId, action, createdAt, formatVersion) })
        } catch (error: unknown) {
          const classified = classifySyncError(error)
          return json({
            ok: false,
            error: { code: classified.kind, message: classified.message },
          }, 500)
        }
      },
    },
    {
      path: '/api/session-cloudsync/replace',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        try {
          const body = await request.json() as { readonly sessionId?: unknown }
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
          if (sessionId === '') {
            return json({ ok: false, error: { code: 'bad-request', message: '需要 sessionId' } }, 400)
          }
          return json({ ok: true, value: await control.prepareReplace(sessionId) })
        } catch (error: unknown) {
          const classified = classifySyncError(error)
          return json({
            ok: false,
            error: { code: classified.kind, message: classified.message },
          }, 500)
        }
      },
    },
    {
      path: '/api/session-cloudsync/workspaces/bind',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        try {
          const body = await request.json() as { readonly workspaceKey?: unknown; readonly localPath?: unknown }
          const workspaceKey = typeof body.workspaceKey === 'string' ? body.workspaceKey.trim() : ''
          const localPath = typeof body.localPath === 'string' ? body.localPath.trim() : ''
          const keyPattern = /^[A-Za-z0-9_-]{16,64}$/u
          if (!keyPattern.test(workspaceKey) || localPath === '') {
            return json({ ok: false, error: { code: 'bad-request', message: '需要合法 workspaceKey 与 localPath' } }, 400)
          }
          return json({ ok: true, value: await control.bindWorkspace(workspaceKey, localPath) })
        } catch (error: unknown) {
          const classified = classifySyncError(error)
          return json({
            ok: false,
            error: { code: classified.kind, message: classified.message },
          }, 400)
        }
      },
    },
  ]
}

/**
 * 序列化成不缓存的 JSON 响应。
 * @param body - 响应包络。
 * @param status - HTTP 状态码。
 * @returns Fetch Response。
 */
function json(body: Envelope<unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
