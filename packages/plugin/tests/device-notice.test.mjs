import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEVICE_CHANGE_SOURCE_KIND,
  deviceChangeMessage,
  lastDeviceChangeDeviceId,
  prependDeviceChange,
  shouldInjectDeviceNotice,
} from '../src/device-notice.ts'

/** 造一条本插件注入的 user/message 事件。 */
function noticeEvent(deviceId, seq = 1) {
  return {
    type: 'user/message',
    seq,
    data: {
      role: 'user',
      id: `notice-${seq}`,
      content: [{ type: 'text', text: '<device-change>…</device-change>' }],
      source: { kind: DEVICE_CHANGE_SOURCE_KIND, form: 'notice', deviceId },
    },
  }
}

test('提示消息带标签、转义设备名，source 不是 user', () => {
  const message = deviceChangeMessage({ deviceId: 'abc123', name: 'workstation "lab"' }, 'get_env', 'fixed-id')
  assert.equal(message.role, 'user')
  assert.equal(message.id, 'fixed-id')
  const text = message.content[0].text
  assert.match(text, /^<device-change device="workstation &quot;lab&quot;" deviceId="abc123">/u)
  assert.match(text, /用户的工作设备已切换到 workstation "lab"，如需了解本机环境事实请使用工具 get_env。/u)
  assert.equal(message.source.kind, DEVICE_CHANGE_SOURCE_KIND)
  assert.equal(message.source.form, 'notice')
  assert.equal(message.source.deviceId, 'abc123')
  assert.equal(message.source.deviceName, 'workstation "lab"')
})

test('设备名里的换行不会破坏提示结构', () => {
  const message = deviceChangeMessage({ deviceId: 'abc', name: '  workstation\n\tlab  ' }, 'this_env', 'id')
  assert.match(message.content[0].text, /已切换到 workstation lab，/u)
  assert.equal(message.source.deviceName, 'workstation lab')
})

test('判重：没有提示、提示来自别的设备、提示缺 id 都要注入；本机提示不注入', () => {
  assert.equal(lastDeviceChangeDeviceId([]), undefined)
  assert.equal(shouldInjectDeviceNotice([], 'me'), true)
  assert.equal(shouldInjectDeviceNotice([noticeEvent('other')], 'me'), true)
  assert.equal(shouldInjectDeviceNotice([noticeEvent('me')], 'me'), false)
  assert.equal(shouldInjectDeviceNotice([noticeEvent(undefined)], 'me'), true)
})

test('判重只看最近一条提示，不越过它找更早的', () => {
  const events = [noticeEvent('me', 1), { type: 'assistant/message', seq: 2 }, noticeEvent('other', 3)]
  assert.equal(lastDeviceChangeDeviceId(events), 'other')
  assert.equal(shouldInjectDeviceNotice(events, 'me'), true)
  const reversed = [noticeEvent('other', 1), noticeEvent('me', 3)]
  assert.equal(shouldInjectDeviceNotice(reversed, 'me'), false)
})

test('忽略非 user/message、缺 source、其他 source 的事件', () => {
  const events = [
    noticeEvent('other', 1),
    { type: 'tool/result', seq: 2, data: { source: { kind: DEVICE_CHANGE_SOURCE_KIND, deviceId: 'x' } } },
    { type: 'user/message', seq: 3, data: { source: { kind: 'user' } } },
    { type: 'user/message', seq: 4, data: null },
    { type: 'user/message', seq: 5 },
  ]
  assert.equal(lastDeviceChangeDeviceId(events), 'other')
})

test('提示插到决策消息最前面', () => {
  const message = deviceChangeMessage({ deviceId: 'abc', name: 'X' }, 'get_env', 'id')
  const decision = { kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' } }] }
  const next = prependDeviceChange(decision, message)
  assert.equal(next.messages.length, 2)
  assert.equal(next.messages[0], message)
  assert.equal(next.messages[1], decision.messages[0])
  assert.equal(decision.messages.length, 1, '不能修改原决策')
})
