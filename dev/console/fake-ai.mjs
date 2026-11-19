/**
 * 开发面板的本地假模型服务：Anthropic Messages 兼容的 SSE 端点，不调用真实模型。
 *
 * DSH 的 `dsh-llm-deepseek` 走 `POST {baseURL}/v1/messages`；这里按同一套事件序列
 * （message_start / content_block_* / message_delta / message_stop）返回确定性的
 * 文本或 `tool_use`，让面板里的 A/B 在不花模型额度的情况下走完一轮 agent。
 *
 * 行为由有序规则决定：第一条匹配的规则生成回复；没有命中时回显最后一条用户文本。
 * 规则可以从面板覆盖（见 `setRules`），匹配字段：
 * - `contains`：请求里任意用户文本包含该子串；
 * - `lastUserContains`：最后一条用户文本包含该子串；
 * - `hasToolResult`：请求里带 `tool_result` 块时为 true。
 * 回复字段：`text`（支持 `{{user}}` / `{{tool}}` 占位）或 `tool: { name, input }`。
 *
 * @module dev/console/fake-ai
 */
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

const MAX_BODY_BYTES = 32 * 1024 * 1024
const MAX_REQUESTS = 30
const MAX_TEXT = 4000

/** 内置规则；面板可整组替换。 */
export function defaultRules() {
  return [
    {
      name: 'compaction',
      when: { lastUserContains: 'automatically generated checkpoint' },
      reply: { text: '## Summary\n- 本地假模型生成的压缩占位摘要。' },
    },
    {
      name: 'compaction-engine',
      when: { systemContains: 'compaction engine' },
      reply: { text: '## Summary\n- 本地假模型生成的压缩占位摘要。' },
    },
    {
      name: 'tool-result',
      when: { lastMessageIsToolResult: true },
      reply: { text: '工具已返回：{{tool}}' },
    },
    {
      name: 'env-tool',
      when: { lastUserContains: '/env' },
      reply: { tool: { name: 'get_env', input: {} } },
    },
    {
      name: 'device-change',
      when: { contains: '<device-change' },
      reply: { text: '已收到设备切换提示（<device-change>）。' },
    },
    {
      name: 'echo',
      when: {},
      reply: { text: '收到：{{user}}' },
    },
  ]
}

/**
 * 启动假模型服务。
 * @param {{ host?: string, port?: number }} [options] - 监听地址与端口（0 表示随机）。
 * @returns {Promise<{ url: string, port: number, snapshot: () => object, setRules: (rules: unknown) => object, resetRules: () => object, reset: () => void, close: () => Promise<void> }>}
 */
export async function startFakeAi(options = {}) {
  const host = options.host ?? '127.0.0.1'
  const state = {
    rules: defaultRules(),
    requests: [],
    requestCount: 0,
    listingCount: 0,
    startedAt: Date.now(),
  }
  const server = createServer((req, res) => {
    void handleRequest(req, res, state).catch((error) => {
      if (!res.headersSent) {
        sendJson(res, 500, { type: 'error', error: { type: 'api_error', message: String(error) } })
      } else {
        res.destroy()
      }
    })
  })
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(options.port ?? 0, host, () => {
      server.off('error', rejectPromise)
      resolvePromise()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const url = `http://${host}:${port}`
  return {
    url,
    port,
    snapshot: () => ({ ...snapshotOf(state), url, port }),
    setRules: (rules) => {
      state.rules = normalizeRules(rules)
      return { ...snapshotOf(state), url, port }
    },
    resetRules: () => {
      state.rules = defaultRules()
      return { ...snapshotOf(state), url, port }
    },
    reset: () => {
      state.requests = []
      state.requestCount = 0
    },
    close: () => new Promise((resolvePromise) => {
      server.close(() => resolvePromise())
      server.closeAllConnections?.()
    }),
  }
}

/** 面板读取的快照（请求历史 + 当前规则）。 */
function snapshotOf(state) {
  return {
    requestCount: state.requestCount,
    listingCount: state.listingCount,
    startedAt: state.startedAt,
    requests: state.requests.map((request) => ({ ...request })),
    rules: state.rules.map((rule) => ({ ...rule })),
  }
}

/**
 * 校验并规范化面板传入的规则。
 * @param {unknown} input - 规则数组。
 * @returns {Array<object>} 规范化后的规则。
 * @throws 输入不是数组、或某条规则缺少可用回复时抛出。
 */
export function normalizeRules(input) {
  if (!Array.isArray(input)) throw new Error('rules 必须是数组')
  return input.map((raw, index) => {
    if (raw === null || typeof raw !== 'object') throw new Error(`第 ${index + 1} 条规则不是对象`)
    const reply = raw.reply
    if (reply === null || typeof reply !== 'object') throw new Error(`第 ${index + 1} 条规则缺少 reply`)
    const when = raw.when === undefined ? {} : raw.when
    if (when === null || typeof when !== 'object') throw new Error(`第 ${index + 1} 条规则的 when 不是对象`)
    const normalizedReply = {}
    if (typeof reply.text === 'string' && reply.text !== '') normalizedReply.text = reply.text
    if (reply.tool !== undefined) {
      const tool = reply.tool
      if (tool === null || typeof tool !== 'object' || typeof tool.name !== 'string' || tool.name.trim() === '') {
        throw new Error(`第 ${index + 1} 条规则的 tool.name 非法`)
      }
      normalizedReply.tool = {
        name: tool.name.trim(),
        input: tool.input !== null && typeof tool.input === 'object' && !Array.isArray(tool.input) ? tool.input : {},
      }
    }
    if (normalizedReply.text === undefined && normalizedReply.tool === undefined) {
      throw new Error(`第 ${index + 1} 条规则需要 reply.text 或 reply.tool`)
    }
    const normalizedWhen = {}
    if (typeof when.contains === 'string' && when.contains !== '') normalizedWhen.contains = when.contains
    if (typeof when.systemContains === 'string' && when.systemContains !== '') normalizedWhen.systemContains = when.systemContains
    if (typeof when.lastUserContains === 'string' && when.lastUserContains !== '') normalizedWhen.lastUserContains = when.lastUserContains
    if (typeof when.hasToolResult === 'boolean') normalizedWhen.hasToolResult = when.hasToolResult
    if (typeof when.lastMessageIsToolResult === 'boolean') normalizedWhen.lastMessageIsToolResult = when.lastMessageIsToolResult
    return {
      name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : `rule-${index + 1}`,
      when: normalizedWhen,
      reply: normalizedReply,
    }
  })
}

/**
 * 处理一个 HTTP 请求。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {object} state - 服务状态。
 */
async function handleRequest(req, res, state) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    state.listingCount += 1
    sendJson(res, 200, {
      data: [{ type: 'model', id: 'deepseek-flash', display_name: 'Fake DeepSeek Flash' }],
      has_more: false,
      first_id: 'deepseek-flash',
      last_id: 'deepseek-flash',
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/v1/files') {
    sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'fake-ai does not accept file uploads' } })
    return
  }
  if (req.method !== 'POST' || url.pathname !== '/v1/messages') {
    sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: `unknown path ${url.pathname}` } })
    return
  }
  const body = JSON.parse(await readBody(req))
  const context = contextOf(body, req)
  const reply = decide(state.rules, context, body)
  record(state, context, reply)
  await streamReply(res, body, reply, context)
}

/**
 * 读请求体（带上限）。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<string>} UTF-8 请求体。
 */
function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectPromise)
  })
}

/**
 * 从 Messages 请求里提取规则需要的上下文。
 * @param {object} body - 请求 JSON。
 * @param {import('node:http').IncomingMessage} req - 请求（读 session id）。
 * @returns {object} 上下文与记录字段。
 */
function contextOf(body, req) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const userTexts = []
  const toolResults = []
  let lastUserText = ''
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const blocks = contentBlocksOf(message.content)
    const texts = blocks.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text)
    if (message.role === 'user') {
      if (texts.length > 0) {
        lastUserText = texts.join('\n')
        userTexts.push(lastUserText)
      }
      for (const block of blocks) {
        if (block.type !== 'tool_result') continue
        toolResults.push(toolResultText(block))
      }
    }
  }
  return {
    lastUserText,
    allUserText: userTexts.join('\n'),
    toolResultText: toolResults.at(-1) ?? '',
    hasToolResult: toolResults.length > 0,
    lastMessageIsToolResult: lastMessageHasToolResult(messages),
    messageCount: messages.length,
    system: typeof body.system === 'string'
      ? body.system
      : contentBlocksOf(body.system).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n'),
    model: typeof body.model === 'string' ? body.model : '',
    sessionId: String(req.headers['x-deepseek-harness-session-id'] ?? ''),
    compact: req.headers['x-deepseek-harness-compact'] === '1',
    toolNames: (Array.isArray(body.tools) ? body.tools : [])
      .map((tool) => tool !== null && typeof tool === 'object' ? tool.name : undefined)
      .filter((name) => typeof name === 'string'),
  }
}

/**
 * 最后一条消息本身是否带 tool_result；历史里出现过 tool_result 不算。
 * @param {Array<object>} messages - Messages 请求的消息数组。
 * @returns {boolean} 最后一条消息是否带 tool_result。
 */
function lastMessageHasToolResult(messages) {
  const last = messages.at(-1)
  if (last === null || typeof last !== 'object') return false
  return contentBlocksOf(last.content).some((block) => block.type === 'tool_result')
}

/**
 * 把 content 统一成块数组。
 * @param {unknown} content - 字符串或块数组。
 * @returns {Array<object>} 块数组。
 */
function contentBlocksOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content.filter((block) => block !== null && typeof block === 'object') : []
}

/**
 * 取 tool_result 的可读文本。
 * @param {object} block - tool_result 块。
 * @returns {string} 文本。
 */
function toolResultText(block) {
  const content = block.content
  if (typeof content === 'string') return content
  return contentBlocksOf(content).filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n')
}

/**
 * 生成回复：标题请求单独处理，其余按规则匹配。
 * @param {Array<object>} rules - 规则。
 * @param {object} context - 请求上下文。
 * @param {object} body - 请求 JSON。
 * @returns {{ text?: string, tool?: { name: string, input: object } }} 回复。
 */
function decide(rules, context, body) {
  if (context.system.includes('Create a concise title for an AI coding-assistant session')) {
    return { text: 'Dev 会话' }
  }
  for (const rule of rules) {
    if (!matches(rule.when, context)) continue
    const reply = rule.reply
    if (reply.tool !== undefined) return { tool: { ...reply.tool } }
    return { text: expandTemplate(reply.text, context) }
  }
  return { text: context.lastUserText === '' ? '收到。' : `收到：${truncate(context.lastUserText, 300)}` }
}

/**
 * 规则匹配。
 * @param {object} when - 规则条件。
 * @param {object} context - 请求上下文。
 * @returns {boolean} 是否命中。
 */
function matches(when, context) {
  if (when.contains !== undefined && !context.allUserText.includes(when.contains)) return false
  if (when.systemContains !== undefined && !context.system.includes(when.systemContains)) return false
  if (when.lastUserContains !== undefined && !context.lastUserText.includes(when.lastUserContains)) return false
  if (when.hasToolResult !== undefined && context.hasToolResult !== when.hasToolResult) return false
  if (when.lastMessageIsToolResult !== undefined
    && context.lastMessageIsToolResult !== when.lastMessageIsToolResult) return false
  return true
}

/**
 * 展开回复模板。
 * @param {string} text - 模板。
 * @param {object} context - 请求上下文。
 * @returns {string} 文本。
 */
function expandTemplate(text, context) {
  return text
    .replaceAll('{{user}}', truncate(context.lastUserText, 300))
    .replaceAll('{{tool}}', truncate(context.toolResultText, 4000))
    .replaceAll('{{count}}', String(context.messageCount))
}

/**
 * 记录一次请求（只保留可读摘要，不存完整 system prompt）。
 * @param {object} state - 服务状态。
 * @param {object} context - 请求上下文。
 * @param {object} reply - 回复。
 */
function record(state, context, reply) {
  state.requestCount += 1
  state.requests.push({
    id: randomUUID(),
    at: Date.now(),
    model: context.model,
    sessionId: context.sessionId,
    compact: context.compact,
    messageCount: context.messageCount,
    lastUserText: truncate(context.lastUserText, 500),
    toolResultText: truncate(context.toolResultText, 4000),
    sawDeviceChange: context.allUserText.includes('<device-change'),
    hasToolResult: context.hasToolResult,
    lastMessageIsToolResult: context.lastMessageIsToolResult,
    toolNames: context.toolNames.slice(0, 40),
    reply: reply.tool === undefined
      ? { kind: 'text', text: truncate(reply.text, 4000) }
      : { kind: 'tool', name: reply.tool.name },
  })
  if (state.requests.length > MAX_REQUESTS) state.requests.splice(0, state.requests.length - MAX_REQUESTS)
}

/**
 * 写 SSE 回复。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {object} body - 请求 JSON。
 * @param {object} reply - 回复。
 * @param {object} context - 请求上下文。
 */
async function streamReply(res, body, reply, context) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const model = context.model === '' ? 'fake-model' : context.model
  const inputTokens = Math.max(1, Math.ceil((JSON.stringify(body).length) / 4))
  const text = reply.text ?? ''
  const outputTokens = reply.tool === undefined ? Math.max(1, Math.ceil(text.length / 4)) : 8
  writeEvent(res, {
    type: 'message_start',
    message: {
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  })
  if (reply.tool !== undefined) {
    writeEvent(res, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: `toolu_${randomUUID()}`, name: reply.tool.name, input: reply.tool.input },
    })
    writeEvent(res, { type: 'content_block_stop', index: 0 })
  } else {
    writeEvent(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    for (const chunk of chunksOf(text)) {
      writeEvent(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } })
    }
    writeEvent(res, { type: 'content_block_stop', index: 0 })
  }
  writeEvent(res, {
    type: 'message_delta',
    delta: { stop_reason: reply.tool === undefined ? 'end_turn' : 'tool_use', stop_sequence: null },
    usage: { output_tokens: outputTokens },
  })
  writeEvent(res, { type: 'message_stop' })
  res.end()
}

/** 把长文本切成 24 字符左右的小块，模拟流式。 */
function chunksOf(text) {
  const size = 24
  const chunks = []
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size))
  return chunks.length === 0 ? [''] : chunks
}

/** 写一个 SSE 事件；`event` 与 `data.type` 保持一致。 */
function writeEvent(res, event) {
  if (res.writableEnded) return
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}

/** 写 JSON 响应。 */
function sendJson(res, status, body) {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** 截断文本。 */
function truncate(text, limit) {
  if (typeof text !== 'string') return ''
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}
