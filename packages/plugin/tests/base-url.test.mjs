import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeBase } from '../src/engine.ts'

test('normalizeBase：scheme/host 小写、默认端口与尾斜杠归一', () => {
  assert.equal(normalizeBase('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787')
  assert.equal(normalizeBase('  HTTP://Example.COM:80/base/  '), 'http://example.com/base')
  assert.equal(normalizeBase('https://example.com:443'), 'https://example.com')
  assert.equal(normalizeBase('http://127.0.0.1:8787/base//'), 'http://127.0.0.1:8787/base')
})

test('normalizeBase：非法协议、查询串与空值返回空', () => {
  assert.equal(normalizeBase('ftp://example.com'), '')
  assert.equal(normalizeBase('http://example.com/?x=1'), '')
  assert.equal(normalizeBase('http://example.com/#hash'), '')
  assert.equal(normalizeBase('   '), '')
})
