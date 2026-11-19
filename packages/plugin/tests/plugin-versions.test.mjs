import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sanitizePluginSnapshots, snapshotsFromBundles } from '../src/plugin-versions.ts'

test('bundle 快照只收已安装、可读版本的 bundle，排除当前插件并排序', () => {
  const snapshots = snapshotsFromBundles([
    { name: 'z-plugin', version: '2.0.0', installed: true, enabled: true, source: 'z-plugin@2.0.0' },
    { name: 'dsh-session-cloudsync', version: '0.1.5', installed: true, enabled: true, source: 'link:D:/repo' },
    { name: 'a-plugin', version: '1.0.0', installed: true, enabled: false, source: 'a-plugin@^1' },
    { name: 'official', version: '1.0.0', installed: false, enabled: true },
    { name: 'no-version', installed: true, enabled: true },
  ])
  assert.deepEqual(snapshots, [
    { name: 'a-plugin', version: '1.0.0', source: 'a-plugin@^1', enabled: false },
    { name: 'z-plugin', version: '2.0.0', source: 'z-plugin@2.0.0', enabled: true },
  ])
})

test('本机图标进入 UI 视图，Vault 快照校验会丢掉图标', () => {
  const icon = 'data:image/svg+xml;base64,PHN2Zy8+'
  const [view] = snapshotsFromBundles([
    { name: 'icon-plugin', version: '1.0.0', installed: true, enabled: true, meta: { icon } },
  ])
  assert.equal(view.icon, icon)
  const [vault] = sanitizePluginSnapshots([view])
  assert.deepEqual(vault, { name: 'icon-plugin', version: '1.0.0', enabled: true })
})

test('Vault 插件快照校验：跳过坏项、去重并保留 source/enabled', () => {
  assert.deepEqual(sanitizePluginSnapshots([
    { name: 'a', version: '1.0.0', source: 'file:D:/a', enabled: false },
    { name: 'a', version: '2.0.0' },
    { name: '', version: '1.0.0' },
    { name: 'b', version: '' },
    { name: 'c', version: '3.0.0', enabled: true },
    'nope',
  ]), [
    { name: 'a', version: '1.0.0', source: 'file:D:/a', enabled: false },
    { name: 'c', version: '3.0.0', enabled: true },
  ])
  assert.deepEqual(sanitizePluginSnapshots('nope'), [])
})
