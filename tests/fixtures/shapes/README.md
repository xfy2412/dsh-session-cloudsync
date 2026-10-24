# 会话形状轨迹

这些文件是大会话的**性能形状**，不是会话内容：

- 事件类型；
- 每个事件的 canonical JSON 字节数；
- `surfaceOp` / `sourceEventSeqs` / `ignorable` 标志；
- 每个事件的 JSON 节点数（近似 planner 序列化结构成本）；
- 每个事件的 `turn` / `step` 坐标；
- 每个 zstd 帧的行数；
- 会话头只保留 formatVersion。

不含消息正文、会话 ID、cwd、URL、工具名或账号信息。可用
`tests/tools/session-trace.ts` 从本地真实日志重新生成；不要提交真实日志本身。

生成器保留消息、header、turn/step、标题等核心事件；带有复杂跨事件生命周期的类型
（tool result、compaction、agent inbox 等）会写成 DSH 允许跳过的 `bench/ignorable`
记录，字节和节点形状保留，但不伪造它们的关系。因此导入后的会话能正常加载，
但不应把它当成真实对话内容使用。

`b0e-69587.trace.json` 由本机最大的一份 v4 日志提取：

```text
事件数       69,587
canonical    267,274,665 B
压缩日志     50,429,382 B
zstd 帧      6,760
事件类型     42
轨迹文件     1,454,477 B
```

生成、基准和导入：

```sh
pnpm bench:generate -- tests/fixtures/shapes/b0e-69587.trace.json \
  --out .tmp/bench/b0e.v4.jsonl.zstd
pnpm bench:sync -- --real <真实日志> --trace tests/fixtures/shapes/b0e-69587.trace.json
# 或在 pnpm dev:panel 里点“导入大会话”
```

当前机器上的校准（同一轮）：

```text
真实       plan 53.0s   seal 6.1s   compressed 50.4MB
生成       plan 40.4s   seal 2.6s   compressed 52.7MB
```

生成器目标是复现 O(n²) 的 planner 量级和字节规模，不是逐微秒复刻真实 JSON 形状。
