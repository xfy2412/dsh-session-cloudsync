/**
 * 宿主 HTTP API：把同步控制暴露给 DSH Web 客户端。
 *
 * 只注册精确的 `/api/session-sync/*` 路由，由 `ctx.connection.fetch` 继承
 * DSH Web 的 owner 鉴权；不另外发 token，也不使用裸 `webServer` 路由。
 *
 * @module dsh-session-sync/host-api
 */
import { classifySyncError } from './engine.ts'
import type { SyncRunResult } from './controller.ts'
import type { SetupInfo, SyncStatus, SyncWorkspaceList } from './status.ts'

/** 宿主注入的控制面。 */
export interface SyncControl {
  /** 当前状态快照。 */
  status(): SyncStatus
  /** 非敏感配置，供首启/设置页读取。 */
  setup(): SetupInfo
  /** 同步列表：工作区、会话计数与当前选中项。 */
  workspaces(): Promise<SyncWorkspaceList>
  /** 手动触发一轮同步；已在运行时返回 `already-running`。 */
  syncNow(): Promise<SyncRunResult>
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
      fetch: async () => json({ ok: true, value: control.setup() }),
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
