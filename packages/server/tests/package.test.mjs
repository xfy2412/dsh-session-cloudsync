import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('发布包的 bin 路径已经过 npm 规范化', () => {
  // npm 会把以 ./ 开头的 bin 路径当成无效脚本并静默移除。
  assert.equal(manifest.bin?.['dscs-server'], 'dist/index.js')
})

test('发布包的 repository 与 provenance 仓库一致', () => {
  assert.equal(manifest.repository?.url, 'git+https://github.com/xfy2412/dsh-session-cloudsync.git')
  assert.equal(manifest.repository?.directory, 'packages/server')
})

test('发布包包含管理台/初始化页使用的 logo 与 favicon', () => {
  assert.ok(manifest.files.includes('assets'))
  assert.equal(existsSync(new URL('../assets/logo-dark.svg', import.meta.url)), true)
  assert.equal(existsSync(new URL('../assets/favicon.svg', import.meta.url)), true)
})
