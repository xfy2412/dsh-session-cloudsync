# 审计日志

> 状态：已实现（2026-11-12）。记录管理端与设备的关键动作，只存元数据。

## 数据

```sql
audit_events(
  id, dataset, at,
  actor_kind,   -- admin | device | system
  actor_id,     -- admin / deviceId / setup
  action,
  target,       -- deviceId / sessionId / null
  detail,       -- JSON 文本；调用方保证不含 token、口令、会话内容
  ip, user_agent
)
```

索引：`(dataset, at DESC)`、`(dataset, action, at DESC)`。

## 动作

| action | 触发 |
|---|---|
| `login` / `login_failed` / `logout` | 管理台登录/退出 |
| `setup.password` / `setup.quota` / `setup.device` / `setup.complete` | 初始化向导 |
| `device.create` / `device.rename` / `device.revoke` | 设备管理 |
| `quota.change` | 修改存储配额 |
| `password.change` / `password.change_failed` | 修改管理密码 |
| `password.reset_cli` | CLI 直接重置管理密码 |
| `session.delete` | 设备调用删除会话接口 |

`detail` 只放展示所需字段，例如改名的 `{from,to}`、配额的 `{from,to}`、设备的 `{label}`。

## API

```text
GET /admin/audit?limit=50&before=<id>&action=<action>
```

- 需要管理台 cookie；
- 按 `id` 倒序，`before` 游标分页；
- 返回 `events` 与 `nextBefore`；
- `actorLabel` 通过 `devices` 当前 label 解析；管理台为「管理台」，初始化为「系统」。

## 管理台

- 「审计」面板：时间 / 动作 / 操作者 / 目标 / 详情；
- 动作筛选、操作者/目标搜索、加载更多；
- 详情列 `title` 里带 IP 与 User-Agent；
- 主刷新与登录成功后重新加载；自动刷新（10s）不重载审计，避免打断筛选。

## 安全与保留

- 不记录密码、token、会话内容；
- IP/UA 用于排查，若部署在反向代理后，取 `X-Forwarded-For` 第一段；
- 当前**没有自动清理**；后续可按保留期清理（建议 90 天）或按动作单独保留。
