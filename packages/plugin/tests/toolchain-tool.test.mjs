import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerToolchainTool } from '../src/toolchain-tool.ts'

function fakeTools() {
  const definitions = []
  return {
    definitions,
    register(definition) {
      definitions.push(definition)
      return () => {}
    },
    get() { return undefined },
  }
}

function factsOf(toolchain = []) {
  return {
    device: { deviceId: 'device-1', name: 'workstation' },
    os: { platform: 'win32', arch: 'x64', release: '10.0' },
    dsh: { version: '0.2.2', profile: 'web', sessionFormatVersion: 4 },
    node: 'v24.20.0',
    workspaces: [],
    toolchain,
  }
}

test('工具链工具：注册并使用 list/add/remove/set-commands', async () => {
  const calls = []
  const service = {
    facts: async () => {
      calls.push(['facts'])
      return factsOf([{ name: 'node', version: 'v24', path: 'C:/node.exe', source: 'auto' }])
    },
    add: async (input) => {
      calls.push(['add', input])
      return factsOf([{ name: input.name, version: input.version, path: input.path, source: 'authored' }])
    },
    remove: async (name) => {
      calls.push(['remove', name])
      return factsOf([])
    },
    setCommands: async (commands) => {
      calls.push(['commands', commands])
      return factsOf([])
    },
  }
  const tools = fakeTools()
  const registered = registerToolchainTool(tools, service)
  assert.equal(registered.name, 'toolchain_manage')
  const definition = tools.definitions[0]

  const list = await definition.execute({ action: 'list' })
  assert.equal(list.facts.toolchain[0].name, 'node')
  assert.deepEqual(calls[0], ['facts'])

  const added = await definition.execute({
    action: 'add', name: 'go', path: 'C:/Go/bin/go.exe', version: '1.22.3',
  })
  assert.equal(added.facts.toolchain[0].source, 'authored')
  assert.deepEqual(calls[1][1], { name: 'go', path: 'C:/Go/bin/go.exe', version: '1.22.3' })

  await definition.execute({ action: 'remove', name: 'go' })
  await definition.execute({ action: 'set-commands', commands: ['node', 'git'] })
  assert.deepEqual(calls.slice(2), [['remove', 'go'], ['commands', ['node', 'git']]])
})

test('工具链工具：校验 add/action 参数', async () => {
  const service = {
    facts: async () => factsOf(),
    add: async () => factsOf(),
    remove: async () => factsOf(),
    setCommands: async () => factsOf(),
  }
  const tools = fakeTools()
  registerToolchainTool(tools, service)
  const definition = tools.definitions[0]
  await assert.rejects(() => definition.execute({ action: 'add', path: 'C:/x' }), /name/u)
  await assert.rejects(() => definition.execute({ action: 'add', name: 'go' }), /path/u)
  await assert.rejects(() => definition.execute({ action: 'set-commands', commands: [1] }), /字符串数组/u)
  await assert.rejects(() => definition.execute({ action: 'unknown' }), /action/u)
})
