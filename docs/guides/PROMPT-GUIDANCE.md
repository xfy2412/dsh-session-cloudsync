# Agent 提示词：cwd 与同步可移植性

> 状态：**设计稿，未实现**（2026-10-21）。
> 目标：减少 agent 主动把会话 cwd 切到工作区外，降低 `nonPortable` 会话数量；
> **不是**限制 agent 访问工作区外文件，也**不是**安全边界。
> 相关：[CWD.md](../architecture/CWD.md)、[RECONCILE.md](../sync/RECONCILE.md)、[GLOSSARY.md](GLOSSARY.md)。

## 1. 为什么要提示

同步插件能处理 `working-directory/change`，但工作区外 cwd 只能本地警告 `nonPortable`；
修正由用户确认后在接收端追加。

- 会话仍可同步/备份；
- 不映射到工作区根；
- 不保证跨设备 resume；
- 目标路径不存在时，DSH `ensure()` 可能回退并追加本地 cwd 事件。

这些会话不会“同步失败”，但用户体验会变差。最划算的做法是在 agent **选择 cwd** 时
就减少这种状态，而不是事后修补。

提示词只做引导；真正的文件系统边界仍由 DSH sandbox / 工具权限负责。

## 2. 提示词应该说什么

核心规则：

1. `working_directory` 的 `cd` 只用于**工作区内**的会话级目录切换；
2. 需要访问工作区外的路径时，用绝对路径或**命令级 cwd**，不要改会话 cwd；
3. 用户明确要求在外部目录长期工作时，提示这是非可移植会话，并建议:
   - 用该目录新建会话/工作区；或
   - 接受该会话 `nonPortable`。

**不应该**写：

- “禁止访问工作区外文件”（越权，且不是同步插件的职责）；
- “任何 `cd` 都不允许”（shell 内部 `cd` 本来就不影响会话 cwd）；
- “工作区外路径会被拒绝同步”（实际是允许同步/备份，只是不可移植）。

## 3. 建议的英文提示词

DSH 的模型提示词以英文为主，建议使用：

```text
Session sync: keep the session's working directory inside its workspace.
When you need to inspect or operate on another directory, use absolute paths or a
command-scoped working directory instead of changing the session working directory.
Only change the session cwd to a path outside the workspace when the user explicitly
asks for it; such a session is non-portable and may not resume correctly on another device.
```

约 65 个英文词，作为一条 system-prompt context，不进入每轮重复消息。

中文对照：

> 会话同步：保持会话工作目录在工作区内。需要检查或操作其他目录时，使用绝对路径或
> 命令级工作目录，不要修改会话级工作目录。只有在用户明确要求时，才把会话 cwd 切到
> 工作区外；这种会话不可移植，换设备后可能无法正确恢复。

## 4. 注入位置

建议由本插件通过 `ctx.systemPrompt.context` 注入，而不是改 DSH 官方
`working_directory` 工具的全局描述：

- **默认关闭**，由设置页开关开启；
- 只对启用同步、开关打开、且当前会话工作区在同步范围内的 agent 注入；
- 未配置同步、未选工作区、未进入同步范围时不注入，避免无关 token；
- 文本稳定，便于上下文缓存；
- 不修改 `working_directory` 工具本身的行为，也不拦截调用；
- 如果 `systemPrompt` 服务不存在，静默跳过（可选服务用 `ctx.get`）。

动态提示（已定）：

- 当 projection 的当前 cwd 已经是 `nonPortable` 时，在 `agent/pre-step` 注入一句
  “当前会话在工作区外，换设备可能无法正确恢复；如需长期在此目录工作，建议新建会话”；
- 判断依据是 **projection 的当前/最后 cwd**，不是历史事件里是否出现过外部路径；
- 这条提示只提醒，不阻断；
- 不重复注入，按会话/session 状态去重。

## 5. 和迁移提示的关系

两者是不同职责：

| 提示 | 触发 | 内容 |
|---|---|---|
| **cwd 可移植性提示** | 开关打开 + 同步范围内，每次 system prompt 组装 | 尽量别把会话 cwd 切到工作区外 |
| **迁移提示** | 换设备后首次 pre-step / 首条消息 | 设备变了、工具链变了、工作区笔记 |

`ensure()` 追加的本地 `working-directory/change` **不能**替代迁移提示，反过来迁移提示
也不应该依赖这个事件。

## 6. 示例

### 推荐

```text
# 会话 cwd 保持在 D:\git-repo
# 读取外部目录：
read D:\other\config.json
# 或命令级 cwd：
pwsh: Set-Location D:\other; Get-ChildItem
```

### 不推荐（会产生 nonPortable）

```text
working_directory(cd="D:\other")
# 之后的文件/命令工具默认都在 D:\other
```

### 用户明确要求

用户要求“在 D:\other 里连续工作”时：

- 执行 `working_directory(cd=...)` 是可以的；
- agent 应说明该会话可能无法在其他设备正确 resume；
- 建议用 D:\other 新建会话/工作区，而不是把当前会话拖出去。

## 7. 验收

- 同步范围内 system prompt 含提示，范围外不含；
- 提示不改变工具 schema、不拦截调用；
- `working_directory` 工具行为不变；
- 统计一段时间内 `nonPortable` 会话占比、工作区外 `working_directory` 调用次数；
- 不出现“提示词要求禁止访问外部文件”的过度约束；
- 迁移提示和 cwd 提示不重复注入；
- 当前 cwd 非 nonPortable 时不注入动态提醒；变为 nonPortable 后只提醒一次。

## 8. 已定与待定

已定：

- 提示词默认关闭，由设置页开关开启；
- 注入范围限制在同步已启用且工作区命中的会话；
- 不修改 `working_directory` 工具行为，不做拦截；
- 当前 projection 的 cwd 为 `nonPortable` 时，在 pre-step 做一次动态提醒。

待定：

- 是否按语言本地化（英文提示 + 中文对照）；
- 是否需要对 `working_directory` 工具上游描述也加一句（需单独评审）。
