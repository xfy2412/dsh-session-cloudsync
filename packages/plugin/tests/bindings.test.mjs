import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindWorkspace, keyForPath, pathForKey, readBindings } from '../src/bindings.ts'

const KEY_A = 'abcdefghijklmnopqrstuvwx'
const KEY_B = 'zyxwvutsrqponmlkjihgfedc'

test('workspace 绑定一次性且不可改绑', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cloudsync-bindings-'))
  try {
    const first = await bindWorkspace(dir, KEY_A, '/work/a', 'a', 100)
    assert.equal(pathForKey(first, KEY_A), '/work/a')
    assert.equal(keyForPath(first, '/work/a'), KEY_A)
    assert.deepEqual((await readBindings(dir)).bindings[KEY_A].localPath, '/work/a')

    await assert.rejects(() => bindWorkspace(dir, KEY_A, '/work/b', 'b', 101), /已经绑定/)
    await assert.rejects(() => bindWorkspace(dir, KEY_B, '/work/a', 'a', 101), /推送身份/)
    assert.equal((await readBindings(dir)).bindings[KEY_B], undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
