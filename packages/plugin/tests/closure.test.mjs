import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildSessionTree,
  pathAllowed,
  pathKeyOf,
  planSessionClosure,
} from '../src/closure.ts'

/** 造一个快照。 */
function snap(id, options = {}) {
  return {
    header: {
      id,
      createdAt: options.createdAt ?? 0,
      ...options.cwd === undefined ? {} : { cwd: options.cwd },
      ...options.origin === undefined ? {} : { origin: options.origin },
      ...options.parentSession === undefined ? {} : { parentSession: options.parentSession },
    },
  }
}

test('闭包：根 + 子代理后代按深度从深到浅，根最后', () => {
  const root = snap('root', { cwd: 'D:/work', createdAt: 1 })
  const child = snap('child', { cwd: 'D:/work', origin: 'subagent', parentSession: 'root', createdAt: 2 })
  const grandchild = snap('grand', { cwd: 'D:/other', origin: 'subagent', parentSession: 'child', createdAt: 3 })

  const plan = planSessionClosure([root, child, grandchild], {
    includeSubagents: true,
    workspaceAllowlist: ['D:/work'],
  })

  assert.deepEqual(plan.skipped, [])
  assert.deepEqual(plan.planned.map((entry) => [entry.snapshot.header.id, entry.depth, entry.isSubagent]), [
    ['grand', 2, true],
    ['child', 1, true],
    ['root', 0, false],
  ])
  assert.deepEqual(new Set(plan.planned.map((entry) => entry.rootId)), new Set(['root']))
})

test('闭包：fork 是独立根，只有 origin=subagent 才算后代', () => {
  const source = snap('source', { cwd: 'D:/work', createdAt: 1 })
  const fork = snap('fork', { cwd: 'D:/work', parentSession: 'source', createdAt: 2 })
  const forkChild = snap('fork-child', { cwd: 'D:/work', origin: 'subagent', parentSession: 'fork', createdAt: 3 })

  const tree = buildSessionTree([source, fork, forkChild])
  assert.deepEqual(tree.roots.map((entry) => entry.root.header.id), ['source', 'fork'])
  assert.equal(tree.orphans.length, 0)

  const plan = planSessionClosure([source, fork, forkChild], {
    includeSubagents: true,
    workspaceAllowlist: ['D:/work'],
  })
  assert.deepEqual(plan.planned.map((entry) => entry.snapshot.header.id), ['source', 'fork-child', 'fork'])
})

test('闭包：缺父会话或父链成环的子代理被跳过', () => {
  const orphan = snap('orphan', { cwd: 'D:/work', origin: 'subagent', parentSession: 'missing' })
  const a = snap('a', { cwd: 'D:/work', origin: 'subagent', parentSession: 'b' })
  const b = snap('b', { cwd: 'D:/work', origin: 'subagent', parentSession: 'a' })

  const tree = buildSessionTree([orphan, a, b])
  assert.equal(tree.roots.length, 0)
  assert.deepEqual(tree.orphans.map((entry) => entry.snapshot.header.id).sort(), ['a', 'b', 'orphan'])
  assert.match(tree.orphans.find((entry) => entry.snapshot.header.id === 'orphan').reason, /找不到父会话/u)
  assert.match(tree.orphans.find((entry) => entry.snapshot.header.id === 'a').reason, /成环/u)

  const plan = planSessionClosure([orphan, a, b], {
    includeSubagents: true,
    workspaceAllowlist: ['D:/work'],
  })
  assert.equal(plan.planned.length, 0)
  assert.equal(plan.skipped.length, 3)
})

test('闭包：根不在白名单时整棵子树都不推', () => {
  const root = snap('root', { cwd: 'D:/work' })
  const child = snap('child', { cwd: 'D:/work', origin: 'subagent', parentSession: 'root' })
  const plan = planSessionClosure([root, child], {
    includeSubagents: true,
    workspaceAllowlist: ['D:/other'],
  })
  assert.equal(plan.planned.length, 0)
  assert.deepEqual(plan.skipped.map((entry) => [entry.snapshot.header.id, entry.reason]), [
    ['root', '工作区不在同步白名单'],
    ['child', '根会话不在同步白名单'],
  ])
})

test('闭包：关闭子代理时只推根，后代标为跳过', () => {
  const root = snap('root', { cwd: 'D:/work' })
  const child = snap('child', { cwd: 'D:/work', origin: 'subagent', parentSession: 'root' })
  const plan = planSessionClosure([root, child], {
    includeSubagents: false,
    workspaceAllowlist: ['D:/work'],
  })
  assert.deepEqual(plan.planned.map((entry) => entry.snapshot.header.id), ['root'])
  assert.deepEqual(plan.skipped.map((entry) => entry.snapshot.header.id), ['child'])
})

test('路径：空 cwd/空白名单不命中，Windows 大小写与斜杠归一', () => {
  assert.equal(pathAllowed(undefined, ['D:/work']), false)
  assert.equal(pathAllowed('   ', ['D:/work']), false)
  assert.equal(pathAllowed('D:/work', []), false)
  assert.equal(pathAllowed('D:/work', ['D:/work/']), true)
  assert.equal(pathKeyOf('D:\\Work\\'), pathKeyOf('D:/Work'))
  if (process.platform === 'win32') {
    assert.equal(pathAllowed('d:/WORK', ['D:/work']), true)
  }
})
