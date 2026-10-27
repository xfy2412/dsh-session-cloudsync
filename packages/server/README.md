# dscs-server

DSH Session CloudSync 的自部署服务端。

```sh
npm i -g dscs-server
dscs-server serve --data-dir /var/lib/dscs --host 127.0.0.1 --port 8787
```

首次启动会打印一次性初始化密钥；打开 `/admin` 完成初始化。设备 API 使用 bearer token，Vault/会话内容只存密文。

- 需要 Node.js >= 24；
- 默认只监听 `127.0.0.1`，公网部署请放在 TLS 反代后；
- 数据目录包含 SQLite 与 blob，升级前请备份；
- 服务端协议说明见仓库 `docs/architecture/PROTOCOL.md`；
- 许可证：AGPL-3.0-only。
