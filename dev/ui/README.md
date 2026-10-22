# 会话同步 UI 原型

独立的静态页，用来在改宿主插件之前把设置页、首启向导和同步气泡的样子调好。打开 `index.html` 即可，不需要构建，也不连接任何服务端。

动效约定见 [docs/UI-GUIDELINES.md](../../docs/UI-GUIDELINES.md)：状态变化才动、只动 transform/opacity/grid-template-rows、支持 `prefers-reduced-motion`。

- 顶部工具条切换三个视图：**设置页**、**首启**、**同步气泡**；
- 右侧「预览状态」切换 **已配置 / 未配置 / 同步中 / 错误**；
- 标题旁的 `100×` 开关把气泡 morph、列表展开等过渡统一放慢 100 倍，方便看细节；再点变回 `1×`；
- 滚动条使用 5px 细分隔条 + 透明轨道，和 DSH 主题的滚动条皮肤一致；首启卡片用抬升表面的稍亮 thumb；
- 所有数据都是页面内的 mock，按钮只改本地状态并弹 toast。

## 三个视图

- **设置页**：对应 Plugins 页里 `plugins.bundle.config` 的 bundle 配置页。
  - 连接：服务端地址、设备名称、测试连接；
  - 凭据：token / 口令只显示“已配置/未配置”，留空不改；
  - 同步范围：工作区列表、根会话/子代理计数、全选/清空、未选提示；
  - **远端工作区**：V2.1 映射预览。展示 `workspace/profile` 解密出来的 label、远端会话数、
    已绑定/同路径建议/待映射状态；同路径只预选，确认后才绑定；绑定后只读不可改；
  - 同步行为：自动同步、间隔、子代理闭包开关；
  - 底部：立即同步 + 保存。
- **首启**：`shell.overlay` 里的全屏向导，连接 → 凭据 → 范围 → **映射** → 完成；“稍后”回设置页。
  - 打开时遮罩淡入、向导从顶部轻微放大滑入；关闭时缩小淡出；
  - 下一步/上一步的方向性滑动（下一步从右、上一步从左），步骤圆点有轻微 pop；
  - 映射步骤可跳过，未映射会话不会写入本机。
- **同步气泡**：`shell.overlay` 顶层、**屏幕顶部居中**的一条完整进度条。  - 收起态就是顶部居中的云图标；点击后同一个云图标带着卡片展开，云标志只有一个；再点云图标缩回图标（悬停提示“收起为图标”，Esc 也能收起）；
  - 这个组件独立于设置页/气泡预览的页面视图，常驻 overlay 层，切页面不会重建 DOM；
  - 收起时文字、计数、进度条和列表同步淡出并被卡片裁剪，不使用 `display:none` 瞬消；
  - 标题栏高度、内边距和云尺寸都走同一条 morph 过渡，展开/收起时云不会相对卡片瞬移；
  - 计数和箭头用 `margin-left: auto` 固定在右侧，展开时只随卡片右边界外移，不会先跟标题往左跑；
  - 进度条无间隔切成 N 等份，每份对应一个会话；同步中为黄色，填满为绿色，失败为红色；
  - 会话可以并发推进，视觉上像多线程下载器；
  - 展开/收起逐会话列表也有高度过渡和淡入淡出，不是生硬跳变；
  - 用户主动打开或操作过气泡后，失焦 5 秒再自动收回；焦点或鼠标回到气泡会取消计时，焦点在气泡内时不会收回；

## V2.1 映射预览说明

- mock 了三台远端工作区：一台已绑定、一台同路径建议、一台无同路径匹配；
- 默认选中两个本地工作区，用来演示 `ServerPluginCore` 的同路径预选；
- 点「绑定」后该行立即进入只读状态，模拟“一次性、不可改绑”；
- 「同路径自动绑定」默认关闭；打开后只自动绑定已存在同路径匹配的项；
- 这些都是页面内 mock；真正接入时数据来自 `/workspaces` 的 `bindings` / `unmapped`
  以及 Vault `workspace/profile` 解密结果。

## 接进宿主时对应什么

| 原型里的东西 | 宿主/客户端实现 |
|---|---|
| 初始数据 | `GET /api/session-cloudsync/setup`、`GET /workspaces`、`GET /status` |
| 测试连接 | `POST /api/session-cloudsync/test` |
| 立即同步 | `POST /api/session-cloudsync/sync` |
| 保存连接/范围/行为 | `ctx.remote.settings.update('session-cloudsync', patch)` |
| 保存 token/口令 | `ctx.remote.credentials.set('DSH_SESSION_CLOUDSYNC_TOKEN' / 'DSH_SESSION_CLOUDSYNC_PASSPHRASE', value)` |
| 设置页挂载 | `plugins.bundle.config`，key = `dsh-session-cloudsync` |
| 首启/气泡 | `shell.overlay`（list slot，可点击穿透，条目内再开 pointer events） |

设置页的命名空间来自 `cordis.patch.yml` 里插入的 row id `session-cloudsync`；如果将来改 row id，这里和 `ctx.remote.settings.update` 的 ns 要一起改。

## 注意

- 这是设计稿，不是生产代码：没有鉴权、没有真实错误分类、没有多语言字典。
- 正式客户端用 React 重写；颜色和间距优先复用 DSH 的 `--dsw-alias-*` token，本原型里的色值只是 fallback。
- 气泡在窄屏下会切到底部（见媒体查询），正式实现同样需要避开窗口 chrome 和标题栏。
