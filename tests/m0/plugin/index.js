// M0 实验插件：验证"外部写入 + attachSession"能否让运行中的宿主/客户端看见新会话。
//
// 加载时注册 GET /m0/ingest；请求到达时才执行 ingest——这样可以先把客户端打开，
// 再手动触发，精确观察"会话出现"是实时的、还是需要刷新页面。
//
// 环境变量：
//   M0_SESSION_ID 会话 id（默认 session-m0-ingest）
//   M0_WORKSPACE  工作区目录名（默认 m0-workspace，位于 <DSH_HOME> 下）
//   M0_TITLE      会话标题（默认 M0 ingest probe）
export const name = 'dsh-session-sync-m0'

export const inject = ['sessions', 'sessionPersistence', 'workspaceRegistry', 'webServer']

const SESSION_ID = process.env.M0_SESSION_ID ?? 'session-m0-ingest'
const WORKSPACE_DIR = process.env.M0_WORKSPACE ?? 'm0-workspace'
const TITLE = process.env.M0_TITLE ?? 'M0 ingest probe'

let busy = false

/** 同时写 stdout 与宿主 logger。 */
function log(ctx, message) {
  console.log(`[m0] ${message}`)
  try {
    ctx.logger.info(`[m0] ${message}`)
  } catch {
    // 某些环境没有 logger，忽略。
  }
}

/** 造一份通过官方校验器的最小 v4 会话事件流。 */
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
      data: {
        content: [{ type: 'text', text: 'M0 ingest probe' }],
        source: { kind: 'user' },
        role: 'user',
        id: 'm0-user-1',
      },
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
          id: 'm0-assistant-1',
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
 * 执行一次 ingest 实验。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {{ sessionId: string, workspaceDir: string, title: string }} options - 本次实验参数。
 * @returns {Promise<Record<string, unknown>>} 实验摘要。
 */
async function run(ctx, options) {
  const { sessionId: SESSION_ID, workspaceDir: WORKSPACE_DIR, title: TITLE } = options
  const homePath = ctx.get('dshHomePath')
  const cwd = typeof homePath === 'function'
    ? homePath(WORKSPACE_DIR)
    : (process.env.M0_CWD ?? process.cwd())
  const fs = await import('node:fs')
  fs.mkdirSync(cwd, { recursive: true })

  const existing = await ctx.sessionPersistence.stat(SESSION_ID)
  let created = false
  if (existing === undefined) {
    const now = Date.now()
    const header = {
      version: 4,
      id: SESSION_ID,
      createdAt: now,
      cwd,
      isSeeded: false,
      delegationDepth: 0,
      agentPreset: 'standard',
    }
    const handle = await ctx.sessionPersistence.create(header)
    await handle.append(buildEvents(now, TITLE))
    await handle.flush()
    // 关掉写句柄：否则会话仍被视为"有写者"，后续复活会拿到 session/writer-held。
    await handle.close()
    created = true
    log(ctx, `已写入会话 ${SESSION_ID}（cwd=${cwd}）`)
  } else {
    log(ctx, `会话已存在（revision=${String(existing.revision)}）`)
  }

  const workspace = (await ctx.workspaceRegistry.resolveByPath(cwd))
    ?? (await ctx.workspaceRegistry.create(cwd, 'M0 ingest'))
  await workspace.attachSession(SESSION_ID)
  log(ctx, `已 attach 到工作区 ${String(workspace.id)}`)

  const summary = { sessionId: SESSION_ID, created, workspaceId: String(workspace.id), attached: true }
  const query = ctx.get('sessionQuery')
  if (query !== undefined) {
    const records = await query.listSessions()
    const record = records.find((entry) => String(entry.header.id) === SESSION_ID)
    summary['listed'] = record !== undefined
    summary['live'] = record?.live
    summary['persisted'] = record?.persisted
    const snapshot = await query.readSession(SESSION_ID)
    summary['events'] = snapshot.events.length
    log(ctx, `listSessions 命中=${record !== undefined}；readSession 事件数=${snapshot.events.length}`)
  }
  if (options.warm) {
    // 试试"复活"：resolveAgent 是 resolve-or-resume，成功即会创建 live Session。
    const controller = ctx.get('sessionController')
    if (controller === undefined) {
      summary['warm'] = 'no-session-controller'
    } else {
      try {
        const result = await controller.resolveAgent(SESSION_ID)
        // 不要 JSON.stringify 整个结果：里面可能是 Cordis 服务代理，读 toJSON 会抛。
        const keys = typeof result === 'object' && result !== null ? Object.keys(result) : []
        summary['warm'] = 'resolved'
        log(ctx, `resolveAgent 成功；返回键=[${keys.join(',')}]`)
      } catch (error) {
        summary['warm'] = `error: ${error?.message ?? String(error)}`
        log(ctx, `resolveAgent 失败：${error?.stack ?? String(error)}`)
      }
    }
  }
  return summary
}

/**
 * 注册插件与实验路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 */
export function apply(ctx) {
  log(ctx, `实验插件已加载；GET /m0/ingest 触发（${SESSION_ID} @ ${WORKSPACE_DIR}）`)
  ctx.webServer.register({
    kind: 'exact',
    path: '/m0/ingest',
    handler: async (req, res) => {
      if (busy) {
        res.writeHead(409, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'busy' }))
        return
      }
      busy = true
      try {
        // 允许用查询参数覆盖，便于在"页面已打开"之后创建全新的会话/工作区。
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const options = {
          sessionId: url.searchParams.get('id') ?? SESSION_ID,
          workspaceDir: url.searchParams.get('dir') ?? WORKSPACE_DIR,
          title: url.searchParams.get('title') ?? TITLE,
          warm: url.searchParams.get('warm') === '1',
        }
        const summary = await run(ctx, options)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(summary))
      } catch (error) {
        const message = error?.stack ?? String(error)
        log(ctx, `实验失败：${message}`)
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: message }))
      } finally {
        busy = false
      }
    },
  })
}
