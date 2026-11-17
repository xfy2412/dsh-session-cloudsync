/**
 * 设备切换提示：在 `agent/pre-step` 里注入一条 `<device-change>` 上下文。
 *
 * 不能用 `agent.inject()`：它在调用时就写 `agent/inbox/spliced`，用户不继续会话也会
 * 落盘并同步。pre-step 里放进 `decision.messages` 的消息，loop 只在步骤准入时才写成
 * `user/message`，所以用户不发消息就什么都不写。
 *
 * @module dsh-session-cloudsync/device-notice
 */
import { randomUUID } from 'node:crypto'

/** 本插件注入消息的 source.kind；不是 `user`，所以不算人工提问。 */
export const DEVICE_CHANGE_SOURCE_KIND = 'session-cloudsync'

/** 模型可见文本的包裹标签。 */
export const DEVICE_CHANGE_TAG = 'device-change'

/** 注入消息的最小结构（DSH `UserMessage` 的运行时形状）。 */
export interface DeviceChangeMessage {
  readonly role: 'user'
  readonly id: string
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly source: {
    readonly kind: typeof DEVICE_CHANGE_SOURCE_KIND
    readonly form: 'notice'
    readonly summary: string
    readonly deviceId: string
    readonly deviceName: string
  }
}

/** 构造 `<device-change>` 提示。 */
export function deviceChangeMessage(
  device: { readonly deviceId: string; readonly name: string },
  toolName: string,
  id: string = randomUUID(),
): DeviceChangeMessage {
  const name = singleLine(device.name)
  return {
    role: 'user',
    id,
    content: [{
      type: 'text',
      text: `<${DEVICE_CHANGE_TAG} device="${xmlAttribute(name)}" deviceId="${xmlAttribute(device.deviceId)}">\n`
        + `用户的工作设备已切换到 ${name}，如需了解本机环境事实请使用工具 ${toolName}。\n`
        + `</${DEVICE_CHANGE_TAG}>`,
    }],
    source: {
      kind: DEVICE_CHANGE_SOURCE_KIND,
      form: 'notice',
      summary: `设备已切换到 ${name}`,
      deviceId: device.deviceId,
      deviceName: name,
    },
  }
}

/** 会话事件的最小结构。 */
export interface SessionEventLike {
  readonly type: string
  readonly data?: unknown
}

/** 决策消息的最小结构（只需要透传）。 */
export interface MessagesDecisionLike {
  readonly messages: readonly unknown[]
}

/**
 * 从会话日志尾部找最近一条设备切换提示的 `deviceId`。
 *
 * 只看 `user/message` 里 `source.kind` 是本插件的消息；第一次命中就停，
 * 不会越过它去找更早的提示。
 * @param events - `session.snapshotEvents()`。
 * @returns 最近提示的设备 id；没有提示时 undefined。
 */
export function lastDeviceChangeDeviceId(events: readonly SessionEventLike[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'user/message') continue
    if (event.data === null || typeof event.data !== 'object') continue
    const source = (event.data as { readonly source?: unknown }).source
    if (source === null || typeof source !== 'object') continue
    const record = source as Record<string, unknown>
    if (record['kind'] !== DEVICE_CHANGE_SOURCE_KIND) continue
    return typeof record['deviceId'] === 'string' ? record['deviceId'] : undefined
  }
  return undefined
}

/**
 * 是否需要注入：最近一条提示不是本机，或本机从未注入过。
 * @param events - 会话日志。
 * @param deviceId - 本机设备 id。
 * @returns 需要注入时为 true。
 */
export function shouldInjectDeviceNotice(events: readonly SessionEventLike[], deviceId: string): boolean {
  return lastDeviceChangeDeviceId(events) !== deviceId
}

/**
 * 把提示插到决策消息最前面（排在用户消息之前）。
 * @param decision - 下游返回的 `enter` 决策。
 * @param message - 提示消息。
 * @returns 新决策。
 */
export function prependDeviceChange<T extends MessagesDecisionLike>(decision: T, message: DeviceChangeMessage): T {
  return { ...decision, messages: [message, ...decision.messages] }
}

/**
 * 去换行并压缩空白；设备名来自用户配置，不能破坏提示结构。
 * @param value - 原始文本。
 * @returns 单行文本。
 */
function singleLine(value: string): string {
  return value.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim()
}

/**
 * XML 属性转义；模型读到的仍是可读文本。
 * @param value - 原始值。
 * @returns 转义后的属性值。
 */
function xmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
