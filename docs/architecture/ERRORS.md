# 客户端错误规范

> 状态：草案（2026-11-11）。约束插件在浏览器/状态条/日志中如何表达同步错误，
> 避免把「网络连不上」说成「租约丢失」这类误导。

## 1. 原则

1. **先分类，再展示**：错误先归入稳定 `kind`，UI 文案由 `kind` 决定，不直接拼底层异常。
2. **区分"谁的问题"**：配置 / 网络 / 鉴权 / 租约 / 服务端 / 数据冲突 / 本地状态，
   分别给不同的动作建议。
3. **可重试性只由分类决定**：自动重试只看 `retryable`，不靠字符串匹配。
4. **日志保留原文**：UI 给一行结论，日志保留 `kind + 原始 message + HTTP 状态`。
5. **租约状态不是错误分类**：`lost` 只是"本机当前没有租约"，必须带 `errorKind` 说明原因。

## 2. 错误种类

| kind | 触发 | 自动重试 | UI 一句话 | 用户动作 |
|---|---|---|---|---|
| `config` | 缺 serverUrl/token/passphrase、URL 非法 | 否 | 同步未配置完整 | 打开设置补齐 |
| `network` | fetch 失败、超时、DNS、连接被拒 | 是（退避） | 无法连接服务端 | 检查地址/网络/服务端 |
| `auth` | 401 | 否 | 设备 token 无效或已吊销 | 重新签发 token |
| `forbidden` | 403 | 否 | 当前 token 无权执行该操作 | 检查设备角色 |
| `lease-foreign` | 409 `lease-held` | 是（被动） | 另一台设备持有全局同步锁 | 等对方释放/换设备 |
| `lease-lost` | 本机曾持有或尝试申请但失败 | 是 | **按原因**：网络/鉴权/服务端/配置 | 见原因 |
| `diverged` | 409 `diverged`、链头/前缀不一致 | 否 | 本地与远端历史已分叉 | 处理分叉（忽略/替换） |
| `gone` | 410 | 否 | 远端会话已删除或存档 | 停止同步；需要时重置 |
| `quota` | 507 | 是（处理后可重试） | 服务端存储配额已满 | 扩容/清理 |
| `rate-limited` | 429 | 是（退避） | 请求过于频繁 | 稍后重试 |
| `server` | 5xx | 是（退避） | 服务端错误 | 查看服务端日志 |
| `crypto` | keyId/口令/盐不匹配 | 否 | 同步口令或服务端地址不一致 | 统一口令/地址 |
| `format` | seq/manifest/帧格式错误 | 否 | 数据格式不兼容 | 升级插件/服务端 |
| `local-busy` | 会话 live、写句柄被占 | 是（稍后） | 会话正在运行，稍后自动继续 | 等当前轮结束 |
| `unmapped` | 工作区未绑定 | 否 | 工作区尚未映射 | 去设置建立映射 |
| `reset-pending` | 409 `reset-pending`（重置设计） | 否 | 等待指定设备重建会话 | 在指定设备上同步 |

### 2.1 服务端 HTTP → kind

```text
400 bad-request      → format
401 unauthorized     → auth
403 forbidden        → forbidden
404 not-found        → not-found（附"服务端版本过旧"提示）
409 lease-held       → lease-foreign
409 diverged         → diverged
409 reset-pending    → reset-pending
410 gone             → gone
429 rate-limited     → rate-limited
507 quota            → quota
5xx                  → server
fetch throw/timeout  → network
```

## 3. 租约状态

`DeviceLeaseView`：

```ts
state: 'held' | 'foreign' | 'lost' | 'unconfigured'
errorKind?: 'config' | 'network' | 'auth' | 'forbidden' | 'server' | 'unknown'
```

| state | 含义 | UI |
|---|---|---|
| `held` | 本机持有 | 已持有 |
| `foreign` | 另一设备持有 | 另一台设备持有全局同步锁；本机只拉取 |
| `lost` | 本机暂未持有 | **按 `errorKind`**：无法连接服务端 / token 无效 / 服务端错误 / 配置不全 / 租约丢失（未知） |
| `unconfigured` | 未配置 | 未配置 |

**禁止**：`state === 'lost'` 且 `errorKind === 'network'` 时显示"租约丢失"。
网络失败时租约只是"没拿到"，不是"丢了"。

## 4. 展示面

| 位置 | 内容 | 规则 |
|---|---|---|
| 顶部气泡标题 | 状态 | 只用状态词（同步完成/只读同步/失败） |
| 气泡副标题 | 一行原因 | 租约/网络/分叉按 kind 文案；不拼原始异常 |
| 气泡错误行 | `kind` 文案 + 重试次数 | 原始错误放 title/tooltip |
| 会话状态条 | 本会话方向与原因 | 不显示全局租约错误；显示会话级 blocked/diverged |
| 设置页状态卡 | 可达/鉴权/版本 | 用探测结果，不复用同步错误 |
| Toast | 用户主动操作的即时结果 | 简短；失败带原因 |
| 日志 | `kind: message (status/code)` | 保留原文 |

## 5. 落地清单

- [x] 服务端错误码已经稳定（`bad-request`/`unauthorized`/`diverged`/`lease-held`/`gone`/`quota`/`rate-limited`）；
- [x] `classifySyncError` 作为唯一 HTTP/异常分类入口；
- [ ] `DeviceLeaseView.errorKind`：租约失败时写入分类；
- [ ] 客户端所有租约文案改用统一 helper（气泡、底栏、详情行）；
- [ ] `reset-pending` 错误码（随删除设计实现）；
- [ ] 状态条不再把全局租约错误当成会话错误。
