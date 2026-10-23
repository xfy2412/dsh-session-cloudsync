# cwd 可移植性：跨设备会话里的工作目录

> 状态：**最终设计**（2026-10-21）。插件未公开发布，不考虑历史数据迁移。
> 决策经过见 [DECISIONS.md](DECISIONS.md)；会话身份见 [RECONCILE.md](RECONCILE.md)；
> 用户协议见 [USAGE-AGREEMENT.md](USAGE-AGREEMENT.md)。
>
> 结论先行：**header canonical，`working-directory/change` 保持 raw；不做 cwd
> canonical 投影；`nonPortable` 只是本地警告；修正在接收端追加。**
>
> **修改边界**：只处理 DSH 必需的 cwd 元数据；不修改消息、工具调用参数/结果、附件或
> 其他事件。

## 1. 结论

只从会话头剥离 `cwd`，**不足以**让会话安全跨设备/跨平台恢复。

- 会话头：同步时剥离 cwd，拉取时用本地 workspace canonical path 重建；
- 事件：`working-directory/change` 保持 raw，原样同步；
- 当前 cwd 在工作区外时，本地警告；用户确认后由**接收端**追加一条修正事件；
- 不追求本地文件 checksum 一致，也不承诺整个会话跨平台可用。

## 1.1 cwd 与工作区路径不是一回事

| 概念 | 存在哪里 | 可变性 | 作用 | 同步处理 |
|---|---|---|---|---|
| **workspace path** | DSH workspace 记录 | 创建时 `realpath`，之后不重写 | 工作区实体、会话挂载、UI 分组 | `workspaceKey` + 本地绑定 |
| **session header cwd** | 会话 header | 不可变 | 来源项目目录、初始工作目录、物理日志目录 | 同步时剥离；拉取时用本地路径重建 |
| **current cwd** | `working-directory/change` + projection | 随 `cd` 追加 | 运行时目录、工具执行目录、模型上下文 | **raw 同步，不投影** |
| **tool call path** | 工具参数/结果、消息文本 | 普通事件内容 | 工具自己解释 | **不处理、不改写** |

DSH 源码关系：

- `workspace/src/types.ts`：workspace `path` 是创建目录的 `fs.realpath`，之后不重写；
- `workspace/src/entity.ts` 的 `attachSession()`：会话 header cwd 必须
  `realpathNormalize` 后等于 workspace path，否则拒绝挂载；
- 已挂载会话的 header cwd 和 workspace path 在规范化后是同一个目录，但用途不同：
  workspace path 属于工作区实体，header cwd 属于会话身份；
- `working-directory/change` 是当前目录，可以切到子目录或工作区外；
- `session-persistence-jsonl` 用 header cwd 决定物理日志目录，而不是 current cwd。

“工作区外路径”只指：

> `working-directory/change.cwd` 不在该会话所属工作区的 canonical 根目录之下。

它不是：

- 工具调用/消息里提到的外部路径；
- 远端工作区没有本地绑定（`unmapped`）；
- 另一个独立工作区（不同 `workspaceKey`）；
- 被本地排除的根会话（`excludedSessionIds`）。

### 1.2 canonical 只用于 header，不是文件 checksum

- 同步 header 只保留可移植字段，不包含 cwd；
- `working-directory/change` 不 canonical 化；
- `chainHash` 对 raw 事件计算；
- 本地 session 文件保留本机 header cwd 和 raw 事件；
- 跨设备不比较本地文件字节；不要求本地文件一致；
- 不引入 `@workspace` / `@external`；
- canonical header 不承诺整个会话跨平台可用。

## 2. DSH 源码事实

### 2.1 会话头的 cwd 决定物理位置

`deepseek-harness/packages/session/session-persistence-jsonl/src/format.ts`：

```ts
projectKey(cwd)                 // cwd → 可读目录名
projectDir(root, cwd)           // root/--slug--
sessionDir(root, cwd, id)       // root/--slug--/session-…
```

`materialize()` 也用 `meta.cwd` 决定写入目录。把 WSL 日志直接拷到 Windows，header 里的
Linux cwd 会继续决定 DSH 查找/创建的位置；即使文件放在 Windows 的 sessions 下，路径语义
也不是本机的。

### 2.2 header 校验有平台不对称

`session-format-v3-to-v4/src/validation.ts`：

```ts
if (header.cwd !== undefined && !isAbsolute(header.cwd)) {
  throw new SessionFormatError('format v4 header cwd must be absolute')
}
```

`isAbsolute` 来自 `node:path`，按平台解析：

- Linux：`D:\work` 不是绝对路径 → 拒绝；
- Windows：`/home/user` 被当作绝对路径 → 接受，但会解析到当前盘根。

### 2.3 `working-directory/change` 是必需事件

`working-directory/src/index.ts`：

```ts
'working-directory/change': {
  cwd: string       // absolute directory
}
```

- 该事件在 `known-event-types` 的必需事件集合里，不是 `ignorable`，不能丢弃；
- projection 的 `apply` 直接取 `event.data.cwd`；
- `ensure()` 在当前目录不可用时恢复并 append 一条本地 `working-directory/change`。

`ensure()` 只检查 **projection 的当前/最后 cwd**，不会逐个检查历史事件：

- projection 初始值是 header cwd，后续每个 change 覆盖它，最终状态是最后一条 change；
- 最后一条 cwd 指向的目录存在 → 不降级，即使更早的事件指向已不存在的位置；
- 最后一条 cwd 不存在 → 回退到 `header.cwd ?? defaultDirectory`，并 append 本地 cwd 事件；
- 例外：最后一条 cwd 的字符串在当前平台不是合法绝对路径时，可能在 projection 恢复阶段
  就校验失败，轮不到 `ensure()` 降级。

触发来源不是 shell 的 `cd`：

- `tool-working-directory` 的 `working_directory` 工具带 `cd` 时调用
  `ctx.workingDirectory.set()`；
- worktree、SDK 的 set-directory、子代理创建时指定 cwd 也会调用 `set()`；
- `ensure()` 在会话没有记录 cwd 或原目录消失时恢复并 append；
- `pwsh`/`bash` 里的 `cd` 只改变该 shell 进程的目录，不改变 DSH workingDirectory。

它值得单独记事件，因为当前工作目录是 **model-visible 状态**：DSH 会把它注入
system-prompt context，工具也用它解析相对路径；session log 的契约是
“model-visible ⟺ logged”。

**`ensure()` 不是迁移标记**：它只做本地目录一致性恢复，可能发生在首条用户消息之前，
不能区分设备迁移/目录删除/仓库移动，也不提供工具链信息。迁移通知应走独立的
`agent/pre-step`/system-reminder。

`working_directory` 工具带 `cd` 的典型场景是模型想改变后续工具调用的会话级目录：

- monorepo 里切到子项目，避免每个命令写长路径；
- 在多个项目目录间切换上下文；
- 需要让后续文件/命令工具默认使用另一个目录；
- SDK/自动化、worktree、子代理创建时显式设置 cwd（可能不经模型工具）。

单条 `pwsh` 命令里的 `cd` 只在 shell 内生效，不触发本事件。

projection 的 `directorySchema` 也是 `isAbsolute`：

```ts
const directorySchema = z.string().min(1).refine(isAbsolute).nullable()
```

因此 Linux 上恢复带 `D:\work` 的 projection state 会校验失败；Windows 上 `/home/user`
会通过 schema 但解析到错误的本机目录。

## 3. 实验记录

环境：WSL `Ubuntu-24.04`，Node `v24.20.0`；Windows Node `24.x`；DSH `0.2.1-rc.2`
（从 `/mnt/c/.../@deepseek-ai/dsh` 读取已发布包）。

### 3.1 路径判定

```text
WSL:      path.isAbsolute('D:\\work')   → false
WSL:      path.isAbsolute('/home/user') → true
Windows:  path.isAbsolute('D:\\work')   → true
Windows:  path.isAbsolute('/home/user') → true
```

### 3.2 v4 header 校验

```text
WSL 校验 cwd = D:\work        → REJECT: format v4 header cwd must be absolute
Windows 校验 cwd = /home/user → accepted
```

### 3.3 working-directory schema

```text
WSL: D:\work → rejected, /home/user → accepted
Windows: 两者都 accepted
```

**限制说明**：验证了路径判定、header 校验和 projection schema；没有启动完整 DSH 复现 UI 报错。
源码路径（`working-directory` 的 `apply` / `ensure` / `restore`）足以确定事件层风险。

## 4. 影响矩阵

| 场景 | header | working-directory 事件 | 结果 |
|---|---|---|---|
| WSL → Windows，原始拷贝 | `/home` 通过 | `/home` 通过 schema 但解析错位 | 可加载但工作目录错误；`ensure` 可能追加本机路径 |
| WSL → Windows，经本插件同步 | 本地 workspace path | `/home` 仍是远端 raw 路径 | 加载通常通过；恢复时目录错误/追加本地 change |
| Windows → WSL，原始拷贝 | `D:\work` 被拒 | `D:\work` schema 拒绝 | header 先失败 |
| Windows → WSL，经本插件同步 | 本地 workspace path | `D:\work` 仍是远端 raw 路径 | header 通过；projection/恢复可能失败 |
| 同 OS、不同根目录 | 本地 header | 远端绝对路径不存在 | `ensure` 恢复并追加本地 change |

最危险的不是加载失败，而是 `ensure()` 的自动恢复会追加本地 cwd 事件。接收端修正就是
把这个兜底提前到用户确认之后，并立即同步。

## 5. 最终策略：raw 事件 + 接收端修正

### 5.0 修改边界

- 不改写任何已有事件；
- 只允许在接收端用户确认后 **append** 一条 `working-directory/change`；
- 不改消息、工具调用、附件、事件类型/seq/结构字段；
- 不把工作区外路径映射到工作区根；
- 不做 cwd canonical 投影，不引入 `@workspace` / `@external`。

### 5.1 header

- 同步 header 不含 cwd；
- 拉取时创建本地 header，`cwd` = 本地 workspace canonical path；
- 否则 `attachSession()` 会因 cwd/workspace 不一致拒绝挂载。

### 5.2 事件

- `working-directory/change` 及其 cwd 原样同步；
- 批次哈希对 raw 事件计算；
- 不同路径的历史就是不同历史，不做自动等价；
- 历史里的非本平台路径保留原值，不处理。

### 5.3 `nonPortable` 本地警告

- 依据 projection 的**当前/最后 cwd**，不逐条检查历史；
- 当前 cwd 在工作区外 → 本地提示“跨设备可能无法正确恢复”；
- 不是同步身份、不影响批次哈希、不永久锁死会话；
- 用户可以：
  - 忽略并继续（接受风险）；
  - 确认追加修正；
  - 取消本次操作。

### 5.4 接收端修正

在 pull/apply 后、attach/resume 前：

1. 读 projection 最后 cwd；
2. 若在工作区外或不可用，显示本地警告；
3. 用户确认后，确保本地 workspace root 存在；
4. 向服务端申请租约；
5. 持有租约时确认远端 lastSeq 没有推进；
6. 本地 append 一条 `working-directory/change`，cwd = 本地 workspace canonical root；
7. 立即用租约推送到服务端；
8. 成功后再 attach；失败按 pending/重试处理，不能假装成功；
9. 若租约冲突或远端已推进，放弃本次修正并重新对账。

这条修正事件是普通 raw 事件，会进入历史并同步到其他设备。

### 5.5 已知成本（接受）

- 远端最后 cwd 会变成最后接收设备的路径；
- 多设备来回打开可能产生多次 cwd 修正；
- 源设备再打开时可能再次修正；
- 不同路径的历史不会被自动认成同一会话；
- 不承诺整个会话跨平台可用；
- 不比较本地文件 checksum。

### 5.6 同平台路径不存在的兼容做法

用户可选兼容链接（不自动执行）：

| 情况 | Linux | Windows |
|---|---|---|
| 父目录存在 | `ln -s` | `mklink /J` 目录联接 |
| 父目录不存在 | 先 `mkdir -p` | 先建父目录 |
| 旧盘符/挂载点不存在 | 需要 mount 或改 cwd | 普通 junction 无法创建盘符；需要 `subst`/挂载或改 cwd |
| 权限不足 | 父目录需可写 | junction 通常可；symlink 需管理员/开发者模式 |

`subst` 是当前用户会话级映射，默认不持久；插件不静默执行。

## 6. 测试

- 同一路径、同一 raw 历史 → 批次哈希一致；
- 不同路径 → 不自动认成同一历史；
- header cwd 不参与同步哈希；
- 最后 cwd 在工作区内 → 不警告；
- 最后 cwd 在工作区外 → 本地警告；
- 用户确认 → 追加修正并立即推送；
- 用户取消 → 不追加；
- 租约冲突/推送失败 → pending/重试，不假装成功；
- 修正后 attach 成功；
- 历史外部 cwd 不被改写；
- 消息/工具调用完全不变；
- 不产生 `@workspace` / `@external`。

## 7. 已定

1. **header canonical**：只排除 cwd；
2. **events raw**：`working-directory/change` 不投影；
3. **身份**：lifecycle + canonical header + raw 前缀哈希；
4. **`nonPortable`**：本地警告，基于当前/最后 cwd；
5. **修正**：接收端、用户确认、append-only、租约内立即推送；
6. **不处理**：消息、工具调用、附件、历史路径改写；
7. **不承诺**：本地文件 checksum 一致、整个会话跨平台可用。
