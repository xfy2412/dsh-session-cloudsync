/**
 * 宿主 HTTP API：把同步控制暴露给 DSH Web 客户端。
 *
 * 只注册精确的 `/api/session-sync/*` 路由，由 `ctx.connection.fetch` 继承
 * DSH Web 的 owner 鉴权；不另外发 token，也不使用裸 `webServer` 路由。
 *
 * @module dsh-session-sync/host-api
 */
import { classifySyncError } from './engine.ts'
import type { CwdCorrectionResult, SyncTestResult } from './engine.ts'
import type { SyncRunResult } from './controller.ts'
import type { SetupInfo, SyncStatus, SyncWorkspaceList } from './status.ts'

/** 宿主注入的控制面。 */
export interface SyncControl {
  /** 当前状态快照。 */
  status(): SyncStatus
  /** 非敏感配置，供首启/设置页读取；会顺带刷新凭据。 */
  setup(): Promise<SetupInfo>
  /** 同步列表：工作区、会话计数与当前选中项。 */
  workspaces(): Promise<SyncWorkspaceList>
  /** 测试服务端地址与 token。 */
  test(): Promise<SyncTestResult>
  /** 手动触发一轮同步；已在运行时返回 `already-running`。 */
  syncNow(): Promise<SyncRunResult>
  /** 接收端 cwd 决策：fix 追加修正并推送；skip 直接挂载原会话。 */
  cwdDecision(sessionId: string, action: 'fix' | 'skip'): Promise<CwdCorrectionResult>
  /** 分叉会话的人工决定：ignore 不再自动提示；force 解除写入拦截。 */
  resolveBlocked(
    sessionId: string,
    action: 'ignore' | 'force',
    createdAt: number,
    formatVersion: number,
  ): Promise<{ readonly ok: true }>
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
 * 生成 `/api/session-sync/*` 路由表。
 * @param control - 宿主控制面。
 * @returns 可直接交给 `connection.fetch.register` 的路由。
 */
export function createHostApi(control: SyncControl): readonly HostFetchRoute[] {
  return [
    {
      path: '/api/session-sync/status',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => json({ ok: true, value: control.status() }),
    },
    {
      path: '/api/session-sync/setup',
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
      path: '/api/session-sync/workspaces',
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
      path: '/api/session-sync/test',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          return json({ ok: true, value: await control.test() })
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
      path: '/api/session-sync/sync',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
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
      path: '/api/session-sync/cwd',
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
      path: '/api/session-sync/blocked',
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
          const action = body.action === 'ignore' ? 'ignore' : body.action === 'force' ? 'force' : ''
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
