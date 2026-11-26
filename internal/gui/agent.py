#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""QxSSH 图形会话输入代理。

在目标主机的某个 X 显示上注入键鼠事件，并转发剪贴板。它只依赖 Python 标准库
与系统自带的 libX11/libXtst（Xvfb 本身即依赖），因此不需要额外安装 pip 包。

协议：stdin 每行一个 JSON 对象，stdout 每行一个 JSON 响应。
  {"t":"m","x":0.5,"y":0.5}            指针移动到归一化坐标
  {"t":"b","b":1,"d":true}             按钮按下/抬起（1 左 2 中 3 右 4/5 滚轮）
  {"t":"w","dx":0,"dy":-3}             滚轮（步数）
  {"t":"k","k":"a","d":true}           键按下/抬起（X11 keysym 名称）
  {"t":"cb","text":"..."}              写入剪贴板
  {"t":"cbget"}                        读取剪贴板
  {"t":"ping"}                         保活探测
"""

import ctypes
import ctypes.util
import json
import os
import shutil
import subprocess
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_lib(name, soname):
    try:
        return ctypes.CDLL(soname)
    except OSError:
        pass
    found = ctypes.util.find_library(name)
    if found:
        try:
            return ctypes.CDLL(found)
        except OSError:
            return None
    return None


x11 = load_lib("X11", "libX11.so.6")
xtst = load_lib("Xtst", "libXtst.so.6")

if x11 is None or xtst is None:
    emit({"t": "error", "message": "缺少 libX11/libXtst，无法注入输入事件"})
    sys.exit(3)


def bind(lib, name, restype, argtypes):
    fn = getattr(lib, name, None)
    if fn is None:
        return None
    fn.restype = restype
    fn.argtypes = argtypes
    return fn


VoidP = ctypes.c_void_p
Int = ctypes.c_int
UInt = ctypes.c_uint
U8 = ctypes.c_ubyte
ULong = ctypes.c_ulong
CStr = ctypes.c_char_p

XOpenDisplay = bind(x11, "XOpenDisplay", VoidP, [CStr])
XStringToKeysym = bind(x11, "XStringToKeysym", ULong, [CStr])
XKeysymToKeycode = bind(x11, "XKeysymToKeycode", U8, [VoidP, ULong])
XFlush = bind(x11, "XFlush", Int, [VoidP])
XSync = bind(x11, "XSync", Int, [VoidP, Int])
XDisplayWidth = bind(x11, "XDisplayWidth", Int, [VoidP, Int])
XDisplayHeight = bind(x11, "XDisplayHeight", Int, [VoidP, Int])

XTestFakeMotionEvent = bind(xtst, "XTestFakeMotionEvent", Int, [VoidP, Int, Int, Int, ULong])
XTestFakeButtonEvent = bind(xtst, "XTestFakeButtonEvent", Int, [VoidP, UInt, Int, ULong])
XTestFakeKeyEvent = bind(xtst, "XTestFakeKeyEvent", Int, [VoidP, UInt, Int, ULong])

dpy = XOpenDisplay(None)
if not dpy:
    emit({"t": "error", "message": "无法连接 X 显示，请检查 DISPLAY"})
    sys.exit(4)

width = XDisplayWidth(dpy, 0) or 1280
height = XDisplayHeight(dpy, 0) or 800
emit({"t": "ready", "width": width, "height": height})


def clamp(v):
    return max(0, min(65535, int(v)))


def fake_motion(x, y):
    XTestFakeMotionEvent(dpy, -1, clamp(x), clamp(y), 0)
    XFlush(dpy)


def fake_button(button, down):
    XTestFakeButtonEvent(dpy, int(button), 1 if down else 0, 0)
    XFlush(dpy)


# X11 的 keysym 名称大小写敏感（Shift_L 而不是 shift_l）。前端按规范发送，
# 但为了容错也接受这些常见写法，避免修饰键因拼写差异静默失效。
KEYSYM_ALIASES = {
    "shift": "Shift_L", "shift_l": "Shift_L", "shift_r": "Shift_R",
    "control": "Control_L", "control_l": "Control_L", "control_r": "Control_R", "ctrl": "Control_L",
    "alt": "Alt_L", "alt_l": "Alt_L", "alt_r": "Alt_R",
    "meta": "Super_L", "super": "Super_L", "win": "Super_L",
    "esc": "Escape", "enter": "Return", "return": "Return",
    "del": "Delete", "backspace": "BackSpace", "space": "space", "spacebar": "space",
    "left": "Left", "right": "Right", "up": "Up", "down": "Down",
    "pagedown": "Next", "pageup": "Prior",
}


def fake_key(keysym_name, down):
    name = str(keysym_name).strip()
    if name.lower() in KEYSYM_ALIASES:
        name = KEYSYM_ALIASES[name.lower()]
    ks = XStringToKeysym(name.encode("utf-8"))
    if not ks:
        return False
    kc = XKeysymToKeycode(dpy, ks)
    if not kc:
        return False
    XTestFakeKeyEvent(dpy, int(kc), 1 if down else 0, 0)
    XFlush(dpy)
    return True


def xclip(*args, stdin=None):
    if not shutil.which("xclip"):
        return None
    try:
        proc = subprocess.run(
            ["xclip"] + list(args),
            input=stdin,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
        return proc.stdout
    except Exception:
        return None


def set_clipboard(text):
    data = str(text).encode("utf-8")
    xclip("-selection", "clipboard", "-i", stdin=data)


def get_clipboard():
    raw = xclip("-selection", "clipboard", "-o")
    if raw is None:
        return None
    try:
        return raw.decode("utf-8", "replace")
    except Exception:
        return None


def handle(msg):
    t = msg.get("t")
    if t == "m":
        fake_motion(msg.get("x", 0), msg.get("y", 0))
    elif t == "b":
        fake_button(msg.get("b", 1), bool(msg.get("d", True)))
    elif t == "w":
        dy = int(msg.get("dy", 0))
        button = 4 if dy < 0 else 5
        for _ in range(min(abs(dy), 20)):
            fake_button(button, True)
            fake_button(button, False)
    elif t == "k":
        if not fake_key(msg.get("k", ""), bool(msg.get("d", True))):
            emit({"t": "warn", "message": "未知按键：" + str(msg.get("k"))})
    elif t == "cb":
        set_clipboard(msg.get("text", ""))
    elif t == "cbget":
        text = get_clipboard()
        emit({"t": "cb", "text": text if text is not None else ""})
    elif t == "ping":
        emit({"t": "pong"})
    elif t == "size":
        emit({"t": "size", "width": XDisplayWidth(dpy, 0), "height": XDisplayHeight(dpy, 0)})
    else:
        emit({"t": "warn", "message": "未知指令：" + str(t)})


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            emit({"t": "warn", "message": "无法解析指令"})
            continue
        try:
            handle(msg)
        except Exception as exc:  # 单条指令失败不能让整个会话退出
            emit({"t": "warn", "message": str(exc)})
    XSync(dpy, 0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
