#!/usr/bin/env python3
"""dsh 电脑操作运行时：纯标准库实现的 Win32 桌面控制。

设计约束（与 Agent Note 及 dsh 的安全约定一致）：
- 只依赖 CPython 标准库（ctypes / zlib / struct / json），不引入任何第三方包。
- 不做 shell 解释，所有参数经由 JSON 传入，杜绝命令注入。
- 只执行显式请求的动作，不主动读写用户的文件（截图产物写到调用方指定路径）。
- 任何失败都以 ``{"ok": false, ...}`` 返回，进程退出码保持 0，便于调用方区分
  "动作被拒绝/失败" 与 "运行时本身崩溃"。

协议：
    调用方在 argv[1] 传入一行 JSON 请求（或从 stdin 读一行），
    脚本向 stdout 写一行 JSON 结果。

请求字段（公共）：
    action: screenshot | display | pointer | move | click | drag | type | key | scroll
    out:    仅 screenshot 使用，PNG 的绝对输出路径。

结果字段（成功）：
    ok, action, 以及各动作自己的维度信息。
结果字段（失败）：
    ok=false, action, error, code。

@module dsh-computer-python/runtime
"""

from __future__ import annotations

import ctypes
import json
import os
import struct
import sys
import time
import zlib
from ctypes import wintypes

# ---------------------------------------------------------------------------
# Win32 常量
# ---------------------------------------------------------------------------

SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79
SM_CXSCREEN = 0
SM_CYSCREEN = 1

SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0
BI_RGB = 0

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_HWHEEL = 0x1000

KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
KEYEVENTF_SCANCODE = 0x0008

WHEEL_DELTA = 120

# 允许的动作集合，白名单之外一律拒绝。
ACTIONS = {
    "screenshot",
    "display",
    "pointer",
    "move",
    "click",
    "drag",
    "type",
    "key",
    "scroll",
}

# 鼠标按键 -> (按下标志, 抬起标志)
BUTTON_FLAGS = {
    "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
}

# 组合键名称 -> 虚拟键码。只暴露常用键，避免把整张键盘表搬进来。
VK_NAMES = {
    "backspace": 0x08,
    "tab": 0x09,
    "enter": 0x0D,
    "return": 0x0D,
    "shift": 0x10,
    "ctrl": 0x11,
    "control": 0x11,
    "alt": 0x12,
    "pause": 0x13,
    "capslock": 0x14,
    "esc": 0x1B,
    "escape": 0x1B,
    "space": 0x20,
    "pageup": 0x21,
    "pagedown": 0x22,
    "end": 0x23,
    "home": 0x24,
    "left": 0x25,
    "up": 0x26,
    "right": 0x27,
    "down": 0x28,
    "printscreen": 0x2C,
    "insert": 0x2D,
    "delete": 0x2E,
    "del": 0x2E,
    "win": 0x5B,
    "meta": 0x5B,
    "cmd": 0x5B,
    "numlock": 0x90,
    "scrolllock": 0x91,
    "f1": 0x70,
    "f2": 0x71,
    "f3": 0x72,
    "f4": 0x73,
    "f5": 0x74,
    "f6": 0x75,
    "f7": 0x76,
    "f8": 0x77,
    "f9": 0x78,
    "f10": 0x79,
    "f11": 0x7A,
    "f12": 0x7B,
}


class ComputerRuntimeError(Exception):
    """带稳定错误码的运行时失败。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# ctypes 结构体
# ---------------------------------------------------------------------------


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", ctypes.c_long),
        ("biHeight", ctypes.c_long),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", ctypes.c_long),
        ("biYPelsPerMeter", ctypes.c_long),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", ctypes.c_long),
        ("dy", ctypes.c_long),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class INPUT_UNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("union", INPUT_UNION)]


# ---------------------------------------------------------------------------
# 平台绑定：只在 Windows 上初始化，其它平台保持 None 以便给出清晰错误
# ---------------------------------------------------------------------------

IS_WINDOWS = sys.platform == "win32"

if IS_WINDOWS:  # pragma: no cover - 平台分支
    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32
    user32.SetProcessDPIAware()
    user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
    user32.GetCursorPos.restype = wintypes.BOOL
    user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
    user32.SetCursorPos.restype = wintypes.BOOL
    user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
    user32.SendInput.restype = wintypes.UINT
else:  # pragma: no cover - 平台分支
    user32 = None
    gdi32 = None


def require_windows() -> None:
    """非 Windows 平台直接失败，避免调用方误以为动作已执行。"""
    if not IS_WINDOWS:
        raise ComputerRuntimeError(
            "UNSUPPORTED_PLATFORM",
            f"computer runtime 目前只实现了 Windows 桌面控制，当前平台是 {sys.platform}",
        )


# ---------------------------------------------------------------------------
# 截图
# ---------------------------------------------------------------------------


def virtual_screen() -> tuple[int, int, int, int]:
    """返回虚拟屏幕的 (x, y, width, height)，坐标系为物理像素。"""
    return (
        user32.GetSystemMetrics(SM_XVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_YVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_CXVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_CYVIRTUALSCREEN),
    )


def capture_bgra() -> tuple[int, int, bytes]:
    """把整个虚拟屏幕拷进内存位图，返回 (width, height, BGRA 字节)。"""
    origin_x, origin_y, width, height = virtual_screen()
    if width <= 0 or height <= 0:
        raise ComputerRuntimeError("CAPTURE_FAILED", "虚拟屏幕尺寸为 0，当前会话可能没有可用桌面")

    screen_dc = user32.GetDC(0)
    if not screen_dc:
        raise ComputerRuntimeError("CAPTURE_FAILED", "无法获取屏幕设备上下文")
    mem_dc = gdi32.CreateCompatibleDC(screen_dc)
    bitmap = gdi32.CreateCompatibleBitmap(screen_dc, width, height)
    if not mem_dc or not bitmap:
        gdi32.DeleteDC(mem_dc)
        user32.ReleaseDC(0, screen_dc)
        raise ComputerRuntimeError("CAPTURE_FAILED", "创建兼容位图失败")
    try:
        gdi32.SelectObject(mem_dc, bitmap)
        if not gdi32.BitBlt(mem_dc, 0, 0, width, height, screen_dc, origin_x, origin_y, SRCCOPY):
            raise ComputerRuntimeError("CAPTURE_FAILED", "BitBlt 拷贝屏幕内容失败")
        info = BITMAPINFO()
        info.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        info.bmiHeader.biWidth = width
        # 负高度表示自上而下的 DIB，省去调用方翻转行序。
        info.bmiHeader.biHeight = -height
        info.bmiHeader.biPlanes = 1
        info.bmiHeader.biBitCount = 32
        info.bmiHeader.biCompression = BI_RGB
        buffer = ctypes.create_string_buffer(width * height * 4)
        lines = gdi32.GetDIBits(mem_dc, bitmap, 0, height, buffer, ctypes.byref(info), DIB_RGB_COLORS)
        if lines != height:
            raise ComputerRuntimeError(
                "CAPTURE_FAILED",
                f"GetDIBits 只取回 {lines}/{height} 行像素",
            )
        return width, height, buffer.raw
    finally:
        gdi32.DeleteObject(bitmap)
        gdi32.DeleteDC(mem_dc)
        user32.ReleaseDC(0, screen_dc)


def encode_png(width: int, height: int, bgra: bytes, level: int = 6) -> bytes:
    """把 BGRA 像素编码成 8 位 RGB 的 PNG（标准库 zlib + struct）。"""
    row_bytes = width * 4
    raw = bytearray()
    for row in range(height):
        raw.append(0)  # 过滤器类型 0（None）
        line = bgra[row * row_bytes:(row + 1) * row_bytes]
        # BGRA -> RGB
        raw.extend(bytes(b for index in range(0, len(line), 4) for b in (line[index + 2], line[index + 1], line[index])))

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), level))
        + chunk(b"IEND", b"")
    )


def action_screenshot(request: dict) -> dict:
    """截取整个虚拟屏幕并写入请求指定的 PNG 路径。"""
    out = request.get("out")
    if not isinstance(out, str) or out.strip() == "":
        raise ComputerRuntimeError("INVALID_REQUEST", "screenshot 需要字符串字段 out（PNG 输出路径）")
    origin_x, origin_y, _, _ = virtual_screen()
    width, height, bgra = capture_bgra()
    png = encode_png(width, height, bgra)
    directory = os.path.dirname(os.path.abspath(out))
    if directory and not os.path.isdir(directory):
        raise ComputerRuntimeError("INVALID_REQUEST", f"输出目录不存在：{directory}")
    with open(out, "wb") as handle:
        handle.write(png)
    return {
        "originX": origin_x,
        "originY": origin_y,
        "width": width,
        "height": height,
        "bytes": len(png),
    }


# ---------------------------------------------------------------------------
# 指针与输入
# ---------------------------------------------------------------------------


def read_pointer() -> tuple[int, int]:
    point = wintypes.POINT()
    if not user32.GetCursorPos(ctypes.byref(point)):
        raise ComputerRuntimeError("INPUT_FAILED", "读取鼠标位置失败")
    return point.x, point.y


def move_pointer(x: int, y: int) -> None:
    if not user32.SetCursorPos(int(x), int(y)):
        raise ComputerRuntimeError("INPUT_FAILED", f"移动鼠标到 ({x}, {y}) 失败")


def send_inputs(inputs: list) -> None:
    """一次提交一组 INPUT 事件，少于全部提交即视为失败。"""
    count = len(inputs)
    if count == 0:
        return
    array = (INPUT * count)(*inputs)
    sent = user32.SendInput(count, array, ctypes.sizeof(INPUT))
    if sent != count:
        raise ComputerRuntimeError("INPUT_FAILED", f"SendInput 只提交了 {sent}/{count} 个事件")


def mouse_button(button: str, down: bool) -> INPUT:
    flags = BUTTON_FLAGS.get(button)
    if flags is None:
        raise ComputerRuntimeError(
            "INVALID_REQUEST",
            f"未知鼠标按键 {button!r}，可用：{', '.join(sorted(BUTTON_FLAGS))}",
        )
    entry = INPUT()
    entry.type = INPUT_MOUSE
    entry.union.mi.dwFlags = flags[0] if down else flags[1]
    return entry


def wheel_event(flags: int, delta: int) -> INPUT:
    entry = INPUT()
    entry.type = INPUT_MOUSE
    entry.union.mi.dwFlags = flags
    entry.union.mi.mouseData = ctypes.c_ulong(delta & 0xFFFFFFFF)
    return entry


def unicode_key(character: str, down: bool) -> INPUT:
    entry = INPUT()
    entry.type = INPUT_KEYBOARD
    entry.union.ki.wScan = ord(character)
    entry.union.ki.dwFlags = KEYEVENTF_UNICODE | (0 if down else KEYEVENTF_KEYUP)
    return entry


def virtual_key(name: str) -> tuple[int, bool]:
    """把组合键名称解析成 (虚拟键码, 是否扩展键)。"""
    key = name.strip().lower()
    if key in VK_NAMES:
        code = VK_NAMES[key]
        extended = code in (0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C)
        return code, extended
    if len(key) == 1:
        character = key.upper()
        # 单字符直接走虚拟键码，配合按下状态天然支持 Shift 组合。
        code = user32.VkKeyScanA(ord(character))
        if code == -1:
            raise ComputerRuntimeError("INVALID_REQUEST", f"无法把 {name!r} 映射成虚拟键码")
        return code & 0xFF, False
    raise ComputerRuntimeError("INVALID_REQUEST", f"未知按键名称 {name!r}")


def key_event(code: int, down: bool, extended: bool = False) -> INPUT:
    entry = INPUT()
    entry.type = INPUT_KEYBOARD
    entry.union.ki.wVk = code
    flags = 0 if down else KEYEVENTF_KEYUP
    if extended:
        flags |= KEYEVENTF_EXTENDEDKEY
    entry.union.ki.dwFlags = flags
    return entry


def require_number(request: dict, field: str) -> int:
    value = request.get(field)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ComputerRuntimeError("INVALID_REQUEST", f"字段 {field} 必须是数字")
    return int(round(value))


def optional_point_named(request: dict, x_field: str, y_field: str) -> tuple[int, int] | None:
    """读取可选的具名坐标对；两个字段必须同时给出，缺失则返回 None。

    drag 的起点用 fromX/fromY，其余动作用 x/y，所以字段名要由调用方指定，
    否则 drag 永远读不到起点并误报「缺少起点」。
    """
    has_x = x_field in request and request[x_field] is not None
    has_y = y_field in request and request[y_field] is not None
    if not has_x and not has_y:
        return None
    if not (has_x and has_y):
        raise ComputerRuntimeError("INVALID_REQUEST", f"定位需要同时给出 {x_field} 与 {y_field}")
    return require_number(request, x_field), require_number(request, y_field)


def optional_point(request: dict) -> tuple[int, int] | None:
    """读取可选的 x/y；两者必须同时给出。"""
    return optional_point_named(request, "x", "y")


def settle(seconds: float = 0.03) -> None:
    """给目标窗口一点时间处理刚送达的事件。"""
    time.sleep(seconds)


def action_display(_request: dict) -> dict:
    """返回显示器几何信息，供模型把截图坐标换算回屏幕坐标。"""
    origin_x, origin_y, width, height = virtual_screen()
    return {
        "originX": origin_x,
        "originY": origin_y,
        "width": width,
        "height": height,
        "primaryWidth": user32.GetSystemMetrics(SM_CXSCREEN),
        "primaryHeight": user32.GetSystemMetrics(SM_CYSCREEN),
    }


def action_pointer(_request: dict) -> dict:
    x, y = read_pointer()
    return {"x": x, "y": y}


def action_move(request: dict) -> dict:
    point = optional_point(request)
    if point is None:
        raise ComputerRuntimeError("INVALID_REQUEST", "move 需要 x 与 y")
    move_pointer(*point)
    settle()
    x, y = read_pointer()
    return {"x": x, "y": y}


def action_click(request: dict) -> dict:
    button = request.get("button") or "left"
    clicks = request.get("clicks", 1)
    if isinstance(clicks, bool) or not isinstance(clicks, int) or clicks < 1 or clicks > 3:
        raise ComputerRuntimeError("INVALID_REQUEST", "clicks 必须是 1..3 的整数")
    point = optional_point(request)
    if point is not None:
        move_pointer(*point)
        settle(0.02)
    events = []
    for _ in range(clicks):
        events.append(mouse_button(button, True))
        events.append(mouse_button(button, False))
    send_inputs(events)
    settle()
    x, y = read_pointer()
    return {"x": x, "y": y, "button": button, "clicks": clicks}


def action_drag(request: dict) -> dict:
    button = request.get("button") or "left"
    duration_ms = request.get("durationMs", 350)
    if isinstance(duration_ms, bool) or not isinstance(duration_ms, (int, float)) or duration_ms < 0:
        raise ComputerRuntimeError("INVALID_REQUEST", "durationMs 必须是非负数字")
    start = optional_point_named(request, "fromX", "fromY")
    if start is None:
        raise ComputerRuntimeError("INVALID_REQUEST", "drag 需要 fromX/fromY 作为起点")
    has_to = ("toX" in request and request["toX"] is not None) and ("toY" in request and request["toY"] is not None)
    if not has_to:
        raise ComputerRuntimeError("INVALID_REQUEST", "drag 需要 toX/toY 作为终点")
    target = (require_number(request, "toX"), require_number(request, "toY"))

    move_pointer(*start)
    settle(0.05)
    send_inputs([mouse_button(button, True)])
    steps = max(8, int(duration_ms / 16))
    for step in range(1, steps + 1):
        ratio = step / steps
        move_pointer(start[0] + (target[0] - start[0]) * ratio, start[1] + (target[1] - start[1]) * ratio)
        time.sleep(max(duration_ms / steps, 1) / 1000.0)
    send_inputs([mouse_button(button, False)])
    settle()
    return {
        "fromX": start[0],
        "fromY": start[1],
        "toX": target[0],
        "toY": target[1],
        "button": button,
    }


def utf16_units(character: str) -> list[int]:
    """把一个字符拆成 UTF-16 码元，代理对必须分开发送才不会被截断。"""
    encoded = character.encode("utf-16-le")
    return [int.from_bytes(encoded[index:index + 2], "little") for index in range(0, len(encoded), 2)]


def action_type(request: dict) -> dict:
    text = request.get("text")
    if not isinstance(text, str):
        raise ComputerRuntimeError("INVALID_REQUEST", "type 需要字符串字段 text")
    if text == "":
        raise ComputerRuntimeError("INVALID_REQUEST", "type 的 text 不能为空")
    if len(text) > 4000:
        raise ComputerRuntimeError("INVALID_REQUEST", "单次 type 的 text 不能超过 4000 个字符")
    point = optional_point(request)
    if point is not None:
        move_pointer(*point)
        settle(0.05)
    events = []
    for character in text:
        if character == "\n":
            events.append(key_event(0x0D, True))
            events.append(key_event(0x0D, False))
            continue
        if character == "\t":
            events.append(key_event(0x09, True))
            events.append(key_event(0x09, False))
            continue
        # KEYEVENTF_UNICODE 直接投递字符码，绕开键盘布局，中文与 emoji 都能输入。
        for unit in utf16_units(character):
            entry_down = INPUT()
            entry_down.type = INPUT_KEYBOARD
            entry_down.union.ki.wScan = unit
            entry_down.union.ki.dwFlags = KEYEVENTF_UNICODE
            entry_up = INPUT()
            entry_up.type = INPUT_KEYBOARD
            entry_up.union.ki.wScan = unit
            entry_up.union.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
            events.append(entry_down)
            events.append(entry_up)
    send_inputs(events)
    settle()
    return {"characters": len(text)}


def action_key(request: dict) -> dict:
    keys = request.get("keys")
    if not isinstance(keys, list) or not keys:
        raise ComputerRuntimeError("INVALID_REQUEST", "key 需要非空的 keys 数组，例如 [\"ctrl\", \"c\"]")
    if len(keys) > 4 or not all(isinstance(item, str) for item in keys):
        raise ComputerRuntimeError("INVALID_REQUEST", "keys 最多 4 个字符串按键")
    resolved = [virtual_key(name) for name in keys]
    point = optional_point(request)
    if point is not None:
        move_pointer(*point)
        settle(0.05)
    events = [key_event(code, True, extended) for code, extended in resolved]
    events += [key_event(code, False, extended) for code, extended in reversed(resolved)]
    send_inputs(events)
    settle()
    return {"keys": [name.lower() for name in keys]}


def action_scroll(request: dict) -> dict:
    delta_y = request.get("deltaY", 0)
    delta_x = request.get("deltaX", 0)
    if isinstance(delta_y, bool) or not isinstance(delta_y, (int, float)):
        raise ComputerRuntimeError("INVALID_REQUEST", "deltaY 必须是数字")
    if isinstance(delta_x, bool) or not isinstance(delta_x, (int, float)):
        raise ComputerRuntimeError("INVALID_REQUEST", "deltaX 必须是数字")
    point = optional_point(request)
    if point is not None:
        move_pointer(*point)
        settle(0.05)
    events = []
    if delta_y:
        # Win32 里正的 mouseData 表示「滚轮向前」，也就是内容向上滚；
        # 而对外契约（与 DOM WheelEvent 一致）是正数向下滚，所以在边界处取反。
        events.append(wheel_event(MOUSEEVENTF_WHEEL, -int(delta_y)))
    if delta_x:
        # 横向相反：正的 mouseData 就是向右滚，与契约方向一致，不取反。
        events.append(wheel_event(MOUSEEVENTF_HWHEEL, int(delta_x)))
    if not events:
        raise ComputerRuntimeError("INVALID_REQUEST", "scroll 需要 deltaX 或 deltaY 中至少一个非零值")
    send_inputs(events)
    settle()
    x, y = read_pointer()
    return {"x": x, "y": y, "deltaX": int(delta_x), "deltaY": int(delta_y)}


HANDLERS = {
    "screenshot": action_screenshot,
    "display": action_display,
    "pointer": action_pointer,
    "move": action_move,
    "click": action_click,
    "drag": action_drag,
    "type": action_type,
    "key": action_key,
    "scroll": action_scroll,
}


def dispatch(request: dict) -> dict:
    """校验并执行一个请求，返回结果字典（不含 ok 字段）。"""
    require_windows()
    action = request.get("action")
    if not isinstance(action, str) or action not in ACTIONS:
        raise ComputerRuntimeError(
            "INVALID_REQUEST",
            f"未知动作 {action!r}，可用：{', '.join(sorted(ACTIONS))}",
        )
    return HANDLERS[action](request)


def read_request() -> dict:
    """从 argv[1] 或 stdin 读取唯一一行 JSON 请求。"""
    raw = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.readline()
    if raw is None or raw.strip() == "":
        raise ComputerRuntimeError("INVALID_REQUEST", "没有收到请求，请通过 argv[1] 或 stdin 传入一行 JSON")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ComputerRuntimeError("INVALID_REQUEST", f"请求不是合法 JSON：{error}") from error
    if not isinstance(parsed, dict):
        raise ComputerRuntimeError("INVALID_REQUEST", "请求必须是 JSON 对象")
    return parsed


def main(argv: list[str] | None = None) -> int:
    del argv
    request: dict = {}
    try:
        request = read_request()
        result = dispatch(request)
    except ComputerRuntimeError as error:
        payload = {"ok": False, "action": request.get("action"), "error": error.message, "code": error.code}
    except Exception as error:  # noqa: BLE001 - 兜底，避免把 traceback 混进 stdout 协议
        payload = {
            "ok": False,
            "action": request.get("action") if isinstance(request, dict) else None,
            "error": f"{type(error).__name__}: {error}",
            "code": "RUNTIME_FAILED",
        }
    else:
        payload = {"ok": True, "action": request.get("action"), **result}
    # stdout 只承载协议行；日志一律走 stderr，二者不混用。
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
