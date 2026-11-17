import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DeviceIdentityCache, LocalEnvironment } from '../src/device-info.ts'

/** 造一个返回固定 JSON 的假 fetch。 */
function fakeFetch(payload, status = 200) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    }
  }
  impl.calls = calls
  return impl
}

/** 造一个按命令返回输出的假 shell。 */
function fakeShell(handler) {
  const commands = []
  return {
    commands,
    resolve(request) {
      commands.push(request.command)
      return request
    },
    async execute(spec) {
      return { result: async () => handler(spec.command) }
    },
  }
}

/** 造一份本地环境依赖。 */
function environmentOf(overrides = {}) {
  let clock = 1_000
  return {
    advance(ms) { clock += ms },
    options: {
      identity: () => ({ deviceId: 'device-1', name: 'workstation' }),
      shell: () => undefined,
      workspaces: () => [{ path: 'D:\\work\\app', label: 'app' }],
      commands: () => ['node', 'git'],
      dshVersion: () => '0.2.2-rc.1',
      dshProfile: () => 'web',
      now: () => clock,
      ...overrides,
    },
  }
}

test('设备身份：配置名优先，服务端 label 兜底；TTL 与 token 变化会让缓存失效', async () => {
  let token = 'token-a'
  let deviceName = ''
  const fetchImpl = fakeFetch({ value: { role: 'device', device: { deviceId: 'device-1', label: 'server-name' } } })
  const cache = new DeviceIdentityCache(() => ({
    serverUrl: 'http://127.0.0.1:8787',
    token,
    deviceName,
    fetch: fetchImpl,
  }))
  assert.equal(cache.snapshot(), undefined)
  assert.deepEqual(await cache.refresh(), { deviceId: 'device-1', name: 'server-name' })
  assert.deepEqual(cache.snapshot(), { deviceId: 'device-1', name: 'server-name' })
  assert.match(fetchImpl.calls[0].url, /\/v2\/me$/u)
  assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer token-a')

  deviceName = 'custom-name'
  assert.deepEqual(await cache.refresh(), { deviceId: 'device-1', name: 'custom-name' })

  token = 'token-b'
  assert.equal(cache.snapshot(), undefined, 'token 变了旧身份作废')
  await cache.refresh()
  assert.equal(fetchImpl.calls.length, 2, '首次与换 token 各请求一次；改名不需要重新请求')
})

test('设备身份：TTL 过期后 snapshot 返回 undefined，refresh 失败保留旧值', async () => {
  let clock = 0
  let fail = false
  const fetchImpl = async () => {
    if (fail) throw new Error('offline')
    return { ok: true, status: 200, json: async () => ({ value: { role: 'device', device: { deviceId: 'd', label: 'n' } } }) }
  }
  const cache = new DeviceIdentityCache(() => ({
    serverUrl: 'http://127.0.0.1:8787', token: 't', deviceName: '', fetch: fetchImpl,
  }), { warn() {} }, () => clock)
  await cache.refresh()
  assert.deepEqual(cache.snapshot(), { deviceId: 'd', name: 'n' })
  fail = true
  assert.deepEqual(await cache.refresh(), { deviceId: 'd', name: 'n' }, '失败时返回旧值')
  clock = 11 * 60 * 1000
  assert.equal(cache.snapshot(), undefined, 'TTL 过期')
})

test('设备身份：未配置地址/token 或响应不是设备身份时刷新为 undefined', async () => {
  const empty = new DeviceIdentityCache(() => ({ serverUrl: '', token: '', deviceName: '' }))
  assert.equal(await empty.refresh(), undefined)

  const wrong = new DeviceIdentityCache(() => ({
    serverUrl: 'http://127.0.0.1:8787',
    token: 't',
    deviceName: '',
    fetch: fakeFetch({ value: { role: 'admin' } }),
  }), { warn() {} })
  assert.equal(await wrong.refresh(), undefined)
})

test('环境事实：OS/DSH/工作区/工具链都来自本机，非法命令名被过滤', async () => {
  const shell = fakeShell((command) => command.includes('--version')
    ? { stdout: `${command.split(' ')[0]} 1.2.3\n` }
    : { stdout: '/usr/bin/tool\n' })
  const { options } = environmentOf({
    shell: () => shell,
    commands: () => ['node', 'bad name!', 'git'],
  })
  const facts = await new LocalEnvironment(options).facts()
  assert.deepEqual(facts.device, { deviceId: 'device-1', name: 'workstation' })
  assert.equal(facts.os.platform, process.platform)
  assert.equal(facts.dsh.version, '0.2.2-rc.1')
  assert.equal(facts.dsh.sessionFormatVersion, 4)
  assert.equal(facts.node, process.version)
  assert.deepEqual(facts.workspaces, [{ path: 'D:\\work\\app', label: 'app' }])
  assert.deepEqual(facts.toolchain.map((tool) => tool.name), ['node', 'git'])
  assert.equal(facts.toolchain[0].version, 'node 1.2.3')
  assert.equal(facts.toolchain[0].path, '/usr/bin/tool')
  assert.equal(facts.toolchain[0].source, 'auto')
  assert.equal(facts.toolchainError, undefined)
})

test('工具链：探测失败/超时的命令被跳过，缓存 TTL 内不重复探测，refresh 强制重跑', async () => {
  let nodeCalls = 0
  const shell = fakeShell((command) => {
    if (command.startsWith('node --version')) {
      nodeCalls += 1
      return nodeCalls === 1 ? { timedOut: true } : { stdout: 'v24.20.0\n' }
    }
    if (command.includes('--version')) return { stdout: 'git version 2.45.0\n' }
    return { stdout: '/usr/bin/tool\n' }
  })
  const { options } = environmentOf({ shell: () => shell })
  const environment = new LocalEnvironment(options)
  const first = await environment.facts()
  assert.deepEqual(first.toolchain.map((tool) => tool.name), ['git'], 'node 第一次超时')
  const before = shell.commands.length
  const second = await environment.facts()
  assert.deepEqual(second.toolchain.map((tool) => tool.name), ['git'], '缓存内不重试')
  assert.equal(shell.commands.length, before)
  const third = await environment.facts({ refresh: true })
  assert.deepEqual(third.toolchain.map((tool) => tool.name), ['node', 'git'], 'refresh 后 node 恢复')
})

test('工具链：宿主没有 shell 服务时给出明确原因', async () => {
  const { options } = environmentOf()
  const facts = await new LocalEnvironment(options).facts()
  assert.deepEqual(facts.toolchain, [])
  assert.match(facts.toolchainError, /没有 shell 服务/u)
})

test('环境事实：没有设备身份时省略 device 字段', async () => {
  const { options } = environmentOf({ identity: () => undefined })
  const facts = await new LocalEnvironment(options).facts()
  assert.equal('device' in facts, false)
})
