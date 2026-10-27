# dscs-server

DSH Session CloudSync 的自部署服务端。

## 安装

```sh
npm i -g dscs-server
dscs-server serve --data-dir /var/lib/dscs --host 127.0.0.1 --port 8787
```

首次启动会在控制台打印一次性初始化密钥，同时写入数据目录的 `onboarding-code.json`。打开 `http://127.0.0.1:8787/admin` 完成管理密码、配额和设备初始化。

Linux/macOS 也可以使用仓库的 `scripts/install.sh`；Windows 使用 `scripts/install.ps1`。安装脚本会把版本装到独立目录，并可选注册 systemd 或计划任务。

## 要求

- Node.js >= 24；
- 默认只监听 `127.0.0.1`，公网部署请放在 TLS 反代后；
- 数据目录包含 SQLite 与 blob 文件，升级前请备份；
- 服务端不持有明文会话内容，只存不透明密文；
- 协议说明见仓库 `docs/architecture/PROTOCOL.md`。

## 许可证

AGPL-3.0-only。
