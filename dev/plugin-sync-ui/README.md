# 跨设备插件 UI 原型

纯静态 HTML，不接后端；用于确认表格布局、拖拽和变更流程。

## 打开

```powershell
Start-Process .\dev\plugin-sync-ui\index.html
```

或起任意静态服务器后访问 `dev/plugin-sync-ui/index.html`。

## 交互

- **点击设备列头**：把该设备存在的插件版本全部设为待应用；底部 toast 可撤销。
- **拖拽版本卡片到本机列**：选中该版本作为本机目标；也可以直接点击卡片选中/取消。
- **本机列**：实线卡片是当前版本；有变更时下面出现虚线“待应用”卡片和 `当前 → 目标`。
- **应用变更**：直接执行（原型里串行模拟）；`dsh-everything-find` 固定模拟失败，用来展示失败态。
- **清空暂存**：只清掉当前选中/拖拽产生的待应用变更，不动已安装版本。
- **红色卡片**：来源为 `file:`/`link:` 或声明了 DSH 不兼容；拖拽/点击不会进入待应用。
- **本地较新**：显示「本地较新」，不做自动降级。

## 颜色与能力

- 原型颜色直接取服务器调色板（`#5b88ff`/`#5ed392`/`#f0b64a`/`#c084fc` 等）；
- 真实接入时，本机颜色来自 `/v2/me` 的 `device.color`，其他设备来自 `/v2/peers`；
- 只有 `/health` 声明 `plugin-version-sync` 才请求 `/v2/peers`；没有颜色时按
  `deviceId` 哈希回退到调色板。

## 原型数据

- 设备：本机、X2411、Laptop、registry 最新；
- 插件：`dsh-context`、`dsh-everything-find`、SSH 远程主机、`dsh-whale-widget`、
  `dsh-my-local-plugin`、`dsh-legacy-hooks`；
- 覆盖：升级、安装、一致、本地较新、仅本地、file 来源不可执行、DSH 不兼容。

改 `index.html` 里的 `devices` / `plugins` 数组即可换数据。
