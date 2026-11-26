package gui

import (
	"context"
	"errors"
	"fmt"
	"path"
	"strings"

	"qxssh/internal/logging"
)

// installDest 计算运行时的安装目录。默认放在家目录下的持久位置，
// 这样同一台主机上的多次会话（以及 Blender 的多个版本）不会重复下载。
func installDest(home, appID string, in *Install) string {
	base := path.Join(home, ".local", "share", "qxssh", "runtimes", appID)
	if in == nil || in.Dest == "" {
		return base
	}
	d := strings.TrimSpace(in.Dest)
	d = strings.ReplaceAll(d, "$HOME", home)
	d = strings.ReplaceAll(d, "~", home)
	if !strings.HasPrefix(d, "/") {
		d = path.Join(base, d)
	}
	return path.Clean(d)
}

// applyInstall 把清单里的启动命令指向已安装的运行时：命令名不带路径时
// （例如 blender）替换成安装目录里的绝对路径，避免依赖目标主机的 PATH。
func applyInstall(spec Spec, dest string, in *Install) Spec {
	if in == nil {
		return spec
	}
	bin := strings.TrimSpace(in.Bin)
	if bin == "" && len(spec.Command) > 0 {
		bin = path.Base(spec.Command[0])
	}
	if bin == "" {
		return spec
	}
	target := path.Join(dest, bin)
	out := spec
	if len(out.Command) == 0 {
		out.Command = []string{target}
		return out
	}
	if !strings.Contains(out.Command[0], "/") {
		cmd := append([]string{target}, out.Command[1:]...)
		out.Command = cmd
	}
	return out
}

// ensureRuntime 在目标主机上准备运行时（例如 Blender 的官方 tar.xz）。
// 已经装好就直接返回；否则下载、可选校验 SHA-256、解压。
func ensureRuntime(ctx context.Context, t Target, in *Install, dest, appID string, log *logging.Logger) error {
	bin := strings.TrimSpace(in.Bin)
	if bin == "" {
		return errors.New("manifest.gui.install.bin 不能为空")
	}
	if log != nil {
		log.Info("gui runtime ensure", "app", appID, "dest", dest)
	}

	sources := in.Sources()
	var b strings.Builder
	b.WriteString("set -eu\n")
	fmt.Fprintf(&b, "DEST=%s\n", ShellQuote(dest))
	fmt.Fprintf(&b, "BIN=%s\n", ShellQuote(bin))
	b.WriteString("if [ -x \"$DEST/$BIN\" ]; then echo QXRUNTIME_READY; exit 0; fi\n")
	b.WriteString("mkdir -p \"$DEST\"\n")
	b.WriteString("TMP=$(mktemp -d)\n")
	b.WriteString("trap 'rm -rf \"$TMP\"' EXIT\n")

	// 逐个源尝试：任一成功即停止。上游删版本、镜像故障都能自动绕过。
	b.WriteString("ok=0\n")
	for i, u := range sources {
		fmt.Fprintf(&b, "if [ $ok -eq 0 ]; then\n")
		fmt.Fprintf(&b, "  echo QXRUNTIME_TRY_%d %s\n", i+1, ShellQuote(u))
		fmt.Fprintf(&b, "  if curl -fL --retry 2 --connect-timeout 20 -o \"$TMP/pkg\" %s 2>/dev/null; then ok=1; fi\n", ShellQuote(u))
		b.WriteString("fi\n")
	}
	b.WriteString("if [ $ok -eq 0 ]; then echo QXRUNTIME_NO_SOURCE; exit 6; fi\n")

	if in.SHA256 != "" {
		fmt.Fprintf(&b, "printf '%%s  %%s\\n' %s \"$TMP/pkg\" | sha256sum -c - >/dev/null\n", ShellQuote(in.SHA256))
	}
	fmt.Fprintf(&b, "tar -xf \"$TMP/pkg\" -C \"$DEST\" --strip-components=%d\n", in.StripComponents)
	b.WriteString("test -x \"$DEST/$BIN\"\n")
	b.WriteString("echo QXRUNTIME_READY\n")

	out, err := t.Run(ctx, b.String())
	if err != nil || !strings.Contains(out, "QXRUNTIME_READY") {
		detail := strings.TrimSpace(out)
		if len(detail) > 800 {
			detail = detail[len(detail)-800:]
		}
		if detail == "" && err != nil {
			detail = err.Error()
		}
		return fmt.Errorf("准备运行时失败（已尝试 %d 个下载源）：%s", len(sources), detail)
	}
	return nil
}
