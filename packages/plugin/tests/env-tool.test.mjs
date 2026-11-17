import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ENV_TOOL_NAMES, registerEnvTool, renderFacts } from '../src/env-tool.ts'

/** 造一个只做注册/占用判断的假 tools 服务。 */
function fakeTools({ occupied = [], failWith = undefined } = {}) {
  const registered = []
  const disposed = []
  return {
    registered,
    disposed,
    get(name) {
      return occupied.includes(name) ? { name } : undefined
    },
    register(definition) {
      const message = failWith?.(definition.name)
      if (message !== undefined) throw new Error(message)
      registered.push(definition)
      return () => { disposed.push(definition.name) }
    },
  }
}

/** 造一份最小环境事实。 */
function factsOf(overrides = {}) {
  return {
    device: { deviceId: 'device-1', name: 'workstation' },
    os: { platform: 'win32', arch: 'x64', release: '10.0.26100' },
    dsh: { version: '0.2.2-rc.1', profile: 'web', sessionFormatVersion: 4 },
    node: 'v24.20.0',
    workspaces: [{ path: 'D:\\work\\app', label: 'app' }],
    toolchain: [{ name: 'node', version: 'v24.20.0', path: 'C:\\node.exe', source: 'auto' }],
    ...overrides,
  }
}

test('按 get_env → this_env → dscs_env 取第一个可用名', async () => {
  const tools = fakeTools({ occupied: ['get_env'] })
  const tool = registerEnvTool(tools, async () => factsOf())
  assert.equal(tool.name, 'this_env')
  assert.equal(tools.registered.length, 1)
  assert.equal(tools.registered[0].name, 'this_env')
  tool.dispose()
  assert.deepEqual(tools.disposed, ['this_env'])
})

test('注册抛 already registered 时继续尝试下一个名字', () => {
  const tools = fakeTools({
    failWith: (name) => name === 'get_env' ? 'tool "get_env" is already registered' : undefined,
  })
  const tool = registerEnvTool(tools, async () => factsOf())
  assert.equal(tool.name, 'this_env')
  assert.equal(tools.registered[0].name, 'this_env')
})

test('全部名字被占用时只告警并返回 undefined', () => {
  const tools = fakeTools({ occupied: [...ENV_TOOL_NAMES] })
  const warnings = []
  const tool = registerEnvTool(tools, async () => factsOf(), { warn: (message) => { warnings.push(message) } })
  assert.equal(tool, undefined)
  assert.equal(tools.registered.length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /全部被占用/u)
})

test('非撞名的注册错误照常抛出', () => {
  const tools = fakeTools({ failWith: () => 'output schema 非法' })
  assert.throws(() => registerEnvTool(tools, async () => factsOf()), /output schema 非法/u)
})

test('宿主没有 tools 服务时返回 undefined', () => {
  assert.equal(registerEnvTool(undefined, async () => factsOf()), undefined)
})

test('工具 execute 透传 refresh 与中止信号，render 输出本机事实', async () => {
  const tools = fakeTools()
  const calls = []
  const signal = new AbortController().signal
  const tool = registerEnvTool(tools, async (input) => {
    calls.push(input)
    return factsOf()
  })
  const definition = tools.registered[0]
  const value = await definition.execute({ refresh: true }, { signal })
  assert.deepEqual(calls, [{ signal, refresh: true }])
  assert.equal(value.toolchain[0].name, 'node')

  const blocks = definition.output.render({}, value)
  assert.equal(blocks.length, 1)
  const text = blocks[0].text
  assert.match(text, /device: workstation \(device-1\)/u)
  assert.match(text, /DSH: 0\.2\.2-rc\.1 \(profile web\), Node v24\.20\.0, session format 4/u)
  assert.match(text, /D:\\work\\app \(app\)/u)
  assert.match(text, /node v24\.20\.0 — C:\\node\.exe/u)
  assert.equal(definition.name, tool.name)
})

test('没有设备身份、没有工具链时 render 明确说明', () => {
  const text = renderFacts(factsOf({
    device: undefined,
    workspaces: [],
    toolchain: [],
    toolchainError: '宿主没有 shell 服务，工具链未采集',
  }))
  assert.match(text, /device: unknown/u)
  assert.match(text, /workspaces: none registered/u)
  assert.match(text, /toolchain: not collected \(宿主没有 shell 服务/u)
})

test('输出 schema 覆盖工具返回的规范值', () => {
  const tools = fakeTools()
  registerEnvTool(tools, async () => factsOf())
  const schema = tools.registered[0].output.schema
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['os', 'dsh', 'node', 'workspaces', 'toolchain'])
  assert.equal(schema.properties.toolchain.items.properties.source.enum[0], 'auto')
  assert.equal(schema.additionalProperties, false)
})
