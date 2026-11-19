import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultRules, normalizeRules, startFakeAi } from '../dev/console/fake-ai.mjs'

/** 解析 SSE 文本为事件数组。 */
function parseSse(text) {
  const events = []
  for (const frame of text.split('\n\n')) {
    const lines = frame.split('\n')
    const eventLine = lines.find((line) => line.startsWith('event: '))
    const dataLine = lines.find((line) => line.startsWith('data: '))
    if (eventLine === undefined || dataLine === undefined) continue
    const event = JSON.parse(dataLine.slice('data: '.length))
    events.push({ event: eventLine.slice('event: '.length), data: event })
  }
  return events
}

/** 发一次 Messages 请求并返回解析后的 SSE。 */
async function messages(url, body) {
  const response = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  })
  assert.equal(response.status, 200)
  return parseSse(await response.text())
}

/** 文本回复内容。 */
function textOf(events) {
  return events
    .filter(({ data }) => data.type === 'content_block_delta' && data.delta.type === 'text_delta')
    .map(({ data }) => data.delta.text)
    .join('')
}

/** 一次简单请求体。 */
function bodyOf(text, extra = {}) {
  return {
    model: 'deepseek-flash',
    max_tokens: 256,
    stream: true,
    system: 'You are a test assistant.',
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    ...extra,
  }
}

test('假模型按规则返回文本、tool_use 与 tool_result 回复，并记录请求', async () => {
  const fake = await startFakeAi({ port: 0 })
  try {
    const echo = await messages(fake.url, bodyOf('你好'))
    assert.deepEqual(echo.map((item) => item.event), [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    assert.equal(echo[0].data.message.role, 'assistant')
    assert.equal(textOf(echo), '收到：你好')
    assert.equal(echo.at(-2).data.delta.stop_reason, 'end_turn')

    fake.setRules([{ when: { lastUserContains: '/env' }, reply: { tool: { name: 'get_env', input: {} } } }])
    const toolCall = await messages(fake.url, bodyOf('/env'))
    const start = toolCall.find((item) => item.data.type === 'content_block_start')
    assert.equal(start.data.content_block.type, 'tool_use')
    assert.equal(start.data.content_block.name, 'get_env')
    assert.deepEqual(start.data.content_block.input, {})
    assert.equal(toolCall.at(-2).data.delta.stop_reason, 'tool_use')

    fake.resetRules()
    const toolResult = await messages(fake.url, {
      model: 'deepseek-flash',
      system: 'You are a test assistant.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '查环境' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_env', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'node v24.20.0' }] }],
        },
      ],
    })
    assert.match(textOf(toolResult), /工具已返回：node v24\.20\.0/u)

    // 历史里有 tool_result 不代表这一轮还是工具续跑；最后一条是新用户文本时，
    // `/env` 仍应触发新的 get_env 调用。
    fake.resetRules()
    const afterToolHistory = await messages(fake.url, {
      model: 'deepseek-flash',
      system: 'You are a test assistant.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '查环境' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_env', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'node v24.20.0' }] }] },
        { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
        { role: 'user', content: [{ type: 'text', text: '/env' }] },
      ],
    })
    assert.equal(afterToolHistory.find((item) => item.data.type === 'content_block_start').data.content_block.name, 'get_env')

    const snapshot = fake.snapshot()
    assert.equal(snapshot.requestCount, 4)
    assert.equal(snapshot.requests[0].reply.kind, 'text')
    assert.equal(snapshot.requests[1].reply.kind, 'tool')
    assert.equal(snapshot.requests[2].lastMessageIsToolResult, true)
    assert.equal(snapshot.requests[3].lastMessageIsToolResult, false)
    assert.equal(snapshot.requests[0].sawDeviceChange, false)

    fake.reset()
    assert.equal(fake.snapshot().requestCount, 0)
  } finally {
    await fake.close()
  }
})

test('假模型识别 <device-change>、标题请求与 /v1/models', async () => {
  const fake = await startFakeAi({ port: 0 })
  try {
    const notice = await messages(fake.url, bodyOf('<device-change device="workstation">已切换</device-change>'))
    assert.match(textOf(notice), /设备切换提示/u)
    assert.equal(fake.snapshot().requests[0].sawDeviceChange, true)

    const title = await messages(fake.url, bodyOf('这段会话在聊同步', {
      system: 'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    }))
    assert.equal(textOf(title), 'Dev 会话')

    const compaction = await messages(fake.url, bodyOf('压缩上面的对话', {
      system: 'You are now acting as a compaction engine for this AI coding assistant.',
    }))
    assert.match(textOf(compaction), /^## Summary/u)

    const models = await fetch(`${fake.url}/v1/models`).then((response) => response.json())
    assert.equal(models.data[0].id, 'deepseek-flash')
    assert.equal(fake.snapshot().listingCount, 1)

    const files = await fetch(`${fake.url}/v1/files`, { method: 'POST', body: '{}' })
    assert.equal(files.status, 400)
  } finally {
    await fake.close()
  }
})

test('规则校验拒绝非法输入，默认规则可恢复', async () => {
  assert.throws(() => normalizeRules('nope'), /rules 必须是数组/u)
  assert.throws(() => normalizeRules([{ reply: {} }]), /需要 reply\.text 或 reply\.tool/u)
  assert.throws(() => normalizeRules([{ reply: { tool: { name: '' } } }]), /tool\.name 非法/u)
  const rules = defaultRules()
  assert.equal(rules.at(-1).name, 'echo')
  const fake = await startFakeAi({ port: 0 })
  try {
    fake.setRules([{ when: { contains: 'x' }, reply: { text: 'ok' } }])
    assert.equal(fake.snapshot().rules.length, 1)
    fake.resetRules()
    assert.deepEqual(fake.snapshot().rules, defaultRules())
  } finally {
    await fake.close()
  }
})
