# Linux 图形应用插件模板 / Linux GUI App Plugin Templates

这里是可以直接打包安装的 Linux 图形应用插件。每个目录只有 `manifest.json` 与图标，真正的程序留在目标主机上，
由 QxSSH 在独立虚拟显示里运行，窗口内通过 H.264（或 JPEG 兜底）呈现画面。

| 目录 | 应用 | 说明 |
| --- | --- | --- |
| `wechat` | 微信 | 需要目标主机已安装微信 Linux 版（命令通常是 `wechat`，部分发行版为 `weixin`） |
| `qq` | QQ | 需要目标主机已安装 QQ Linux 版（新版命令通常是 `qq`） |
| `wps` | WPS Office | 需要目标主机已安装 WPS Linux 版（命令 `wps`） |
| `blender36` | Blender 3.6 LTS | 首次启动自动下载官方 3.6.23 运行时 |
| `blender45` | Blender 4.5 LTS | 官方没有 4.6 版本，4.x 维护分支是 4.5（首次启动下载 4.5.13） |
| `blender53` | Blender 5.3 LTS | 首次启动自动下载官方 5.3.0 运行时 |

## 目标主机准备

图形会话需要以下组件（缺失时启动会给出对应的安装命令）：

```bash
# Debian / Ubuntu
sudo apt-get install -y xvfb ffmpeg x11-xserver-utils python3 xclip openbox
# Fedora
sudo dnf install -y xorg-x11-server-Xvfb ffmpeg xrandr python3 xclip openbox
# Arch
sudo pacman -S --noconfirm xorg-server-xvfb ffmpeg xorg-xrandr python3 xclip openbox
```

## 打包与安装

```bash
# 打包任意一个模板
go run ./tools/packgui -dir examples/gui-apps/wechat -out dist/wechat.qxp

# 从目标主机上的 .desktop 现场生成（在目标主机上执行）
go run ./tools/packgui -desktop /usr/share/applications/wechat.desktop -id wechat -out dist/wechat.qxp
```

生成的 `.qxp` 在桌面「应用管理器 → 安装应用」中上传即可。

## 需要按实际环境调整的地方

- **启动命令**：不同发行版的桌面文件 `Exec` 可能不同（`wechat` / `weixin`、`qq` / `linuxqq`、`wps` / `wpp`）。
  先运行 `command -v wechat` 之类的检查，再改 `gui.command`。
- **软件渲染**：`softwareGL: true` 会让 Mesa 走 llvmpipe。Blender 在没有 GPU 的服务器上必须开；有 GPU 的主机可以改成
  `false` 以使用（会被转发到浏览器的）硬件加速。
- **分辨率与码率**：`gui.screen` 越大、`bitrateKbps` 越高越清晰，但带宽占用也越高。窗口内是等比缩放，改分辨率需要重启会话。
- **中文输入**：键鼠按物理键位注入，中文请用窗口工具栏的剪贴板按钮粘贴。

## Limits

- Keyboard events map by physical key position to X11 keysyms; paste non-ASCII text via the clipboard buttons.
- The canvas scales uniformly; changing resolution requires restarting the session.
- Blender is rendered through Mesa llvmpipe when there is no GPU, so heavy scenes are slow by nature.
