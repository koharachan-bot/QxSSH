# 常用权限

以 `manifest.json` 的 `permissions` 数组逐条申请。

| 权限 | 危险级 | 用途 |
| --- | --- | --- |
| `hosts:read` | 1 | 读主机列表（几乎必选） |
| `exec:run` | 3 | 在远端主机执行命令 |
| `exec:stream` | 3 | 流式执行并实时收输出 |
| `term:open` | 3 | 打开交互终端 |
| `local:exec` | 3 | 在运行 QxSSH 的机器上执行命令 |
| `server:read` | 1 | 浏览远端目录（SFTP） |
| `server:download` / `server:upload` | 2 | 下载 / 上传文件 |
| `server:delete` | 3 | 删除远端文件 |
| `storage:read` / `storage:write` | 1 / 2 | 应用私有存储 |
| `secret:read` / `secret:write` | 2 | 应用私有机密（加密落库） |
| `prefs:self:read` / `prefs:self:write` | 1 | 应用私有偏好 |
| `ui:notify` | 1 | 桌面通知 |
| `tunnel:local` | 3 | 建端口转发 |
| `gui:launch` | 3 | 运行 Linux 图形应用 |

原则：**只申请真正用到的**。装的时候用户能看到完整清单，写多了会被拒装。
