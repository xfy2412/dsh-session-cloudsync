// M0 全链路实验（宿主半）：写会话 → attach → 预热，并把状态暴露给客户端半轮询。
//
// GET /m0/ingest?id=&dir=&title=&warm=1  执行一次 ingest，revision +1
// GET /m0/state                          返回最近一次 ingest 的状态与 revision

export const name = 'dsh-session-cloudsync-m0-e2e'

export const inject = ['sessions', 'sessionPersistence', 'workspaceRegistry', 'webServer']

const DEFAULTS = {
  sessionId: 'session-m0-e2e',
  workspaceDir: 'm0-e2e-workspace',
  title: 'M0 E2E probe',
}

let revision = 0
let latest = { revision, sessionId: null, listed: false, warm: null }

/** 写 JSON 响应。 */
function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

/** 造一份合法的最小 v4 事件流。 */
function buildEvents(now, title) {
  const at = (offset) => now + offset
  return [
    { type: 'permission/preset', seq: 0, time: at(0), data: { preset: 'workspace-write' } },
    { type: 'turn/start', seq: 1, time: at(1), data: { turn: 1 } },
    { type: 'step/start', seq: 2, time: at(2), data: { turn: 1, step: 1 } },
    {
      type: 'user/message',
      seq: 3,
      time: at(3),
      data: { content: [{ type: 'text', text: title }], source: { kind: 'user' }, role: 'user', id: 'm0e2e-user' },
      surfaceOp: 'append',
    },
    {
      type: 'assistant/message',
      seq: 4,
      time: at(4),
      data: {
        turn: 1,
        step: 1,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 },
        stream: [],
        message: {
          id: 'm0e2e-assistant',
          role: 'assistant',
          source: { kind: 'model', provider: 'm0', model: 'm0' },
          content: [{ type: 'text', text: 'ack' }],
        },
      },
      surfaceOp: 'append',
    },
    { type: 'session/title', seq: 5, time: at(5), data: { title, messageSeqs: [3], source: { kind: 'fallback' } } },
    { type: 'step/end', seq: 6, time: at(6), data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 7, time: at(7), data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/**
 * 执行一次全链路 ingest。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {{ sessionId: string, workspaceDir: string, title: string, warm: boolean }} options - 参数。
 * @returns {Promise<Record<string, unknown>>} 状态摘要。
 */
async function ingest(ctx, options) {
  const homePath = ctx.get('dshHomePath')
  const cwd = typeof homePath === 'function' ? homePath(options.workspaceDir) : process.cwd()
  const fs = await import('node:fs')
  fs.mkdirSync(cwd, { recursive: true })

  const existing = await ctx.sessionPersistence.stat(options.sessionId)
  if (existing === undefined) {
    const now = Date.now()
    const handle = await ctx.sessionPersistence.create({
      version: 4,
      id: options.sessionId,
      createdAt: now,
      cwd,
      isSeeded: false,
      delegationDepth: 0,
      agentPreset: 'standard',
    })
    await handle.append(buildEvents(now, options.title))
    await handle.flush()
    // 必须先关写句柄，否则无法复活（session/writer-held）。
    await handle.close()
  }

  const workspace = (await ctx.workspaceRegistry.resolveByPath(cwd)) ?? (await ctx.workspaceRegistry.create(cwd, 'M0 E2E'))
  await workspace.attachSession(options.sessionId)

  let warm = 'skipped'
  if (options.warm) {
    const controller = ctx.get('sessionController')
    if (controller === undefined) {
      warm = 'no-session-controller'
    } else {
      try {
        await controller.resolveAgent(options.sessionId)
        warm = 'resolved'
      } catch (error) {
        warm = `error: ${error?.message ?? String(error)}`
      }
    }
  }

  const query = ctx.get('sessionQuery')
  const records = query === undefined ? [] : await query.listSessions()
  const listed = records.some((entry) => String(entry.header.id) === options.sessionId)
  return { sessionId: options.sessionId, workspaceId: String(workspace.id), cwd, listed, warm }
}

/**
 * 注册实验路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 */
export function apply(ctx) {
  ctx.webServer.register({
    kind: 'exact',
    path: '/m0/ingest',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const options = {
          sessionId: url.searchParams.get('id') ?? DEFAULTS.sessionId,
          workspaceDir: url.searchParams.get('dir') ?? DEFAULTS.workspaceDir,
          title: url.searchParams.get('title') ?? DEFAULTS.title,
          warm: url.searchParams.get('warm') === '1',
        }
        const state = await ingest(ctx, options)
        revision += 1
        latest = { revision, ...state }
        console.log(`[m0-e2e] ingest revision=${revision} ${JSON.stringify(state)}`)
        sendJson(res, 200, latest)
      } catch (error) {
        console.error('[m0-e2e] ingest failed', error)
        sendJson(res, 500, { error: error?.message ?? String(error) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/m0/state',
    handler: (_req, res) => sendJson(res, 200, latest),
  })
}
