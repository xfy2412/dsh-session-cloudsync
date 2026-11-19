#!/usr/bin/env node
/**
 * 通过 DSH 的 HTTP Remote API 发一条真实用户消息（不经过浏览器）。
 *
 * 流程与 Web 客户端一致：
 * 1. 从 dev:panel 状态里取 A/B 的入口 URL（含 launch token）；
 * 2. `GET /connect?token=…&interactions=none` 换 API Cookie；
 * 3. `POST /api/session/list` 找会话；
 * 4. `POST /api/session/prompt` 投递一条 `{ type: 'text' }` 消息；
 * 5. 等面板里的假模型记录新增请求（默认等到收到回复或超时）。
 *
 * 用法：
 *   node dev/console/send-message.mjs --text "你好" --session "Benchmark 69k"
 *   node dev/console/send-message.mjs --text "/env" --side a
 *
 * 参数：
 *   --panel <url>    面板地址，默认 http://127.0.0.1:3092
 *   --side <a|b>     实例，默认 a
 *   --session <id|标题>  目标会话；缺省用列表里活动最靠前的一个
 *   --text <内容>    消息正文（必填）
 *   --timeout <ms>   等待假模型请求的上限，默认 20000
 *   --no-wait        投递后立即退出，不等待假模型记录
 */
import { randomUUID } from 'node:crypto'

/** 解析 `--key value`。 */
function parseArgs(argv) {
  const options = { panel: 'http://127.0.0.1:3092', side: 'a', timeout: 20_000, wait: true, model: 'deepseek-official/deepseek-flash' }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (key === '--panel') { options.panel = value; index += 1 } else if (key === '--side') { options.side = value; index += 1 } else if (key === '--session') { options.session = value; index += 1 } else if (key === '--text') { options.text = value; index += 1 } else if (key === '--timeout') { options.timeout = Number(value); index += 1 } else if (key === '--model') { options.model = value; index += 1 } else if (key === '--no-wait') { options.wait = false }
  }
  if (typeof options.text !== 'string' || options.text.trim() === '') throw new Error('需要 --text')
  if (options.side !== 'a' && options.side !== 'b') throw new Error('--side 只能是 a 或 b')
  if (!Number.isFinite(options.timeout) || options.timeout <= 0) throw new Error('--timeout 非法')
  return options
}

/** 发一个 JSON 请求；保留 Set-Cookie。 */
async function call(url, { method = 'GET', cookie, body, redirect = 'manual' } = {}) {
  const headers = { accept: 'application/json' }
  if (cookie !== undefined) headers.cookie = cookie
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(url, {
    method,
    headers,
    ...body === undefined ? {} : { body: JSON.stringify(body) },
    redirect,
  })
  const setCookie = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  const text = await response.text()
  let json
  try { json = text === '' ? undefined : JSON.parse(text) } catch { json = undefined }
  return { status: response.status, setCookie, json, text }
}

/** 从 Set-Cookie 里取 `name=value`。 */
function cookiePair(setCookie) {
  for (const value of setCookie) {
    const pair = value.split(';', 1)[0]?.trim()
    if (pair?.startsWith('dsh-auth-')) return pair
  }
  return undefined
}

/** 用 launch token 换 API Cookie。 */
async function connect(base, token) {
  const response = await call(`${base}/connect?token=${encodeURIComponent(token)}&interactions=none`)
  const cookie = cookiePair(response.setCookie)
  if (cookie === undefined) {
    throw new Error(`/connect 没有返回 dsh-auth Cookie（HTTP ${response.status}）：${response.text.slice(0, 200)}`)
  }
  return cookie
}

/** 调一个 Remote 方法；args 的键必须是生成的参数名。 */
async function invoke(base, cookie, method, args = {}) {
  const rpcId = randomUUID()
  const response = await call(`${base}/api/${method}`, {
    method: 'POST',
    cookie,
    body: { type: 'client-request', rpcId, method, payload: { args } },
    redirect: 'follow',
  })
  if (response.status !== 200) throw new Error(`${method} 返回 HTTP ${response.status}：${response.text.slice(0, 300)}`)
  if (response.json === undefined || response.json.type !== 'server-response' || response.json.rpcId !== rpcId) {
    throw new Error(`${method} 响应包络非法：${response.text.slice(0, 300)}`)
  }
  if (response.json.result?.ok !== true) {
    const error = response.json.result?.error ?? {}
    throw new Error(`${method} 失败：${error.code ?? 'unknown'} ${error.message ?? ''}`)
  }
  return response.json.result.value
}

/** 面板状态里取某一侧的 base URL 与 token。 */
async function sideOf(panel, side) {
  const state = await call(`${panel}/api/state`)
  if (state.status !== 200 || state.json?.sides === undefined) throw new Error(`读取面板状态失败：HTTP ${state.status}`)
  const found = state.json.sides.find((item) => item.id === side)
  if (found?.url === undefined || found.url === null) throw new Error(`实例 ${side} 未启动`)
  const url = new URL(found.url)
  const token = url.searchParams.get('token')
  if (token === null || token === '') throw new Error(`实例 ${side} 的 URL 里没有 token`)
  return { base: url.origin, token }
}

/** 轮询假模型记录，直到请求数追上目标。 */
async function waitForRequests(panel, before, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = before
  let idleSince = Date.now()
  while (Date.now() < deadline) {
    const state = await call(`${panel}/api/fake-ai`)
    if (state.status === 200 && state.json?.value !== undefined) {
      const requests = state.json.value.requests
      const count = state.json.value.requestCount
      if (count > last) {
        last = count
        idleSince = Date.now()
        if (count >= before + expected) break
      } else if (count > before && Date.now() - idleSince > 1_500) {
        break
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  const state = await call(`${panel}/api/fake-ai`)
  const requests = state.json?.value?.requests ?? []
  const added = Math.max(0, (state.json?.value?.requestCount ?? before) - before)
  return requests.slice(-Math.min(added, requests.length))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const { base, token } = await sideOf(options.panel, options.side)
  const cookie = await connect(base, token)
  const before = (await call(`${options.panel}/api/fake-ai`)).json?.value?.requestCount ?? 0

  const list = await invoke(base, cookie, 'session/list', { _request: {} })
  const items = Array.isArray(list?.items) ? list.items : []
  const target = options.session === undefined
    ? items[0]
    : items.find((item) => item.sessionId === options.session || item.title === options.session || item.sessionId.startsWith(options.session))
  if (target === undefined) {
    throw new Error(`没有找到会话 ${options.session ?? ''}；可用：${items.map((item) => `${item.sessionId}(${item.title ?? ''})`).join(', ')}`)
  }
  const sessionId = target.sessionId
  console.log(`目标会话：${sessionId}（${target.title ?? '无标题'}）`)

  const [provider, model] = options.model.split('/')
  if (provider !== undefined && provider !== '' && model !== undefined && model !== '') {
    const selected = await invoke(base, cookie, 'session/selectModel', {
      request: { sessionId, provider, model },
    })
    console.log(`模型：${JSON.stringify(selected.selected ?? selected)}`)
  }

  const accepted = await invoke(base, cookie, 'session/prompt', {
    request: {
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: options.text }],
      clientTimeZone: 'Asia/Shanghai',
    },
  })
  console.log(`已投递：${JSON.stringify(accepted)}`)

  if (!options.wait) return
  const requests = await waitForRequests(options.panel, before, 2, options.timeout)
  console.log(`假模型新增请求：${requests.length}`)
  if (requests.length === 0) {
    const state = await invoke(base, cookie, 'session/state', { request: { sessionId } })
    console.log(`会话状态：${JSON.stringify(state).slice(0, 2000)}`)
  }
  for (const request of requests) {
    console.log(JSON.stringify({
      model: request.model,
      sawDeviceChange: request.sawDeviceChange,
      hasToolResult: request.hasToolResult,
      lastUserText: request.lastUserText,
      reply: request.reply,
    }, null, 2))
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
