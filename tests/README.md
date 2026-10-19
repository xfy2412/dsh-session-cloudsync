# 测试约定：隔离的 DSH home 与夹具

任何会碰 DSH 数据目录的测试，都必须经 `helpers/tmp-home.mjs` 创建临时 home。这个仓库里的任何代码都**不许**读写用户真实的 `~/.dsh`。

## 为什么要这样

测试如果直接用真实 home，可能：

- 把夹具会话写进真实会话日志（污染甚至损坏日志）；
- 重写 `storages/workspace.json`（丢掉工作区分组）；
- 读到真实凭据，或触发属于用户的倒计时。

下面这些规则由帮助函数在代码里强制，写错会**直接报错**，而不是悄悄动到真实数据。

## `createTempHome()` 强制的规则

1. 临时 home 位于 `<仓库>/.tmp/`（已被 git 忽略）。每次运行一个 `.tmp/<label>-<随机>/`，里面有 `home/`（DSH_HOME）和 `data/`（服务端数据目录）。
2. 解析后的真实路径必须仍在 `<仓库>/.tmp/` 之内。
3. 不得等于 `~/.dsh`、外层传入的 `DSH_HOME`、或仓库根。
4. 测试写入会话后，`assertOnlySessions()` 会回读 home；出现预期之外的会话 id 立刻失败。
5. `git check-ignore .tmp/probe` 必须成功——谁删了忽略规则，测试就失败，防止夹具日志被提交。
6. 超过 24 小时的旧目录会在下次运行时清掉；`KEEP_TMP=1` 保留当次现场。

## 夹具

`fixtures/sessions/*.jsonl` 是手工构造、字节确定的日志（固定 id 与时间戳，内容为合成文本），用于在不碰真实数据的前提下测试帧解析、前缀/分叉判定与投影折叠。

- `v4-minimal.jsonl`：header + 一段有代表性的对话（消息、工具调用/结果、turn/step 边界、一条未知的 `ignorable` 记录）。
- `v4-with-plugin-record.jsonl`：同样的形状，外加本插件的 `plugin:dsh-session-sync/device` 记录。
- `v5-newer.jsonl`：header 声明更高的格式代际；读者必须**拒绝**它，而不是猜。
- `v4-coverage.jsonl`：**从隔离开发实例的真实录制派生**的覆盖夹具。结构、事件类型、工具名、参数键、结果内容块都照搬录制，但所有自由文本 / 路径 / URL / 命令都替换成占位符；生成后断言纯 ASCII、无盘符、无 URL。它覆盖 35 种事件与 35 种工具（含失败结果与 `image` 内容块）。

`fixtures/shapes/recorded-coverage.json` 是录制的**形状清单**（只含类型、键名与计数，不含内容），覆盖夹具与它的一致性由 `packages/shared/tests/coverage.test.ts` 校验。

`*.jsonl.zstd` 由 `tests/tools/make-fixtures.ts` 用本仓库自己的帧写入器生成。**DSH 必须能读我们自己写的帧**——这正是同步引擎依赖的往返契约。

真实日志永不入库。录制与再生成：

```sh
# 1) 在隔离实例里录一段（或复用已有录制）
# 2) 盘点形状（只打印类型/键名/计数）
node tests/tools/inspect-session.ts <日志…>
# 3) 从录制派生覆盖夹具（会做 ASCII/路径/URL 泄漏断言）
node tests/tools/make-coverage-fixture.ts <日志…>
# 4) 重新生成 .zstd
node tests/tools/make-fixtures.ts
```

要本地验证真实日志，把 `DSH_SYNC_REAL_LOG` 指向仓库外的一份副本（只用大小/性能测试，不入 CI）。

## 官方校验器（devDependency）

测试直接用官方 npm 包校验夹具，不复制、不软链：`packages/shared` 的 devDependencies 钉住
`@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-session-persistence`（当前 `0.2.1-rc.2`）及其 peer
（`cordis` / `dsh-brand` / `dsh-scope` / `dsh-timeout`）。升级 DSH 时同步升这几个版本，再 `pnpm install`。

校验链与真实读取路径一致：版本闸门 → `validateStoredEvents`（行/载荷准入）→ `assertContiguous`（序号）→
`Session.fromRestore`（表面关系重放）。对应测试是 `packages/shared/tests/validity.test.ts`。
