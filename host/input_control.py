"""Win32 SendInput hardware-level mouse and Unicode keyboard automation."""

from __future__ import annotations

import asyncio
import ctypes
from collections.abc import Sequence
from ctypes import wintypes
from typing import Any, Literal

MouseButton = Literal["left", "right", "middle"]

ULONG_PTR = ctypes.c_uint64 if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_uint32

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

VK_TAB = 0x09
VK_RETURN = 0x0D
VK_DELETE = 0x2E

MAX_UNICODE_TEXT_LEN = 500


class MOUSEINPUT(ctypes.Structure):
    """Win32 MOUSEINPUT struct."""

    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class KEYBDINPUT(ctypes.Structure):
    """Win32 KEYBDINPUT struct."""

    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class HARDWAREINPUT(ctypes.Structure):
    """Win32 HARDWAREINPUT struct."""

    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class _INPUT_UNION(ctypes.Union):
    _fields_ = [
        ("mi", MOUSEINPUT),
        ("ki", KEYBDINPUT),
        ("hi", HARDWAREINPUT),
    ]


class INPUT(ctypes.Structure):
    """Win32 INPUT struct passed to user32.SendInput (40 bytes on x64)."""

    _anonymous_ = ("union",)
    _fields_ = [
        ("type", wintypes.DWORD),
        ("union", _INPUT_UNION),
    ]


# Map lowercase key names to (virtual_key_code, is_extended_key)
ALLOWED_REMOTE_KEYS: dict[str, tuple[int, bool]] = {
    "enter": (0x0D, False),
    "backspace": (0x08, False),
    "delete": (0x2E, True),
    "tab": (0x09, False),
    "escape": (0x1B, False),
    "space": (0x20, False),
    "up": (0x26, True),
    "down": (0x28, True),
    "left": (0x25, True),
    "right": (0x27, True),
    "home": (0x24, True),
    "end": (0x23, True),
    "page_up": (0x21, True),
    "page_down": (0x22, True),
    "f": (0x46, False),
    "f5": (0x74, False),
    "f11": (0x7A, False),
    "win": (0x5B, True),
}

# Populate alphanumeric keys for shortcut combinations (e.g. ctrl+c, ctrl+v, ctrl+t, alt+...)
for _ch_ord in range(ord("a"), ord("z") + 1):
    ALLOWED_REMOTE_KEYS[chr(_ch_ord)] = (0x41 + (_ch_ord - ord("a")), False)
for _num_ord in range(ord("0"), ord("9") + 1):
    ALLOWED_REMOTE_KEYS[chr(_num_ord)] = (0x30 + (_num_ord - ord("0")), False)

MODIFIER_VKS: dict[str, tuple[int, bool]] = {
    "ctrl": (0x11, False),
    "alt": (0x12, False),
    "shift": (0x10, False),
    "win": (0x5B, True),
}

_MOUSE_FLAGS: dict[MouseButton, tuple[int, int]] = {
    "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
}


def is_dangerous_key_combo(key: str, modifiers: Sequence[str] | None = None) -> bool:
    """Reject privileged OS interruption combos like Ctrl+Alt+Delete."""
    norm_key = key.strip().lower()
    norm_mods = {m.strip().lower() for m in (modifiers or ())}
    return norm_key == "delete" and "ctrl" in norm_mods and "alt" in norm_mods


def _get_user32() -> Any | None:
    windll = getattr(ctypes, "windll", None)
    if windll is None:
        return None
    u32 = getattr(windll, "user32", None)
    if u32 is None:
        return None
    try:
        send_fn = u32.SendInput
        if getattr(send_fn, "argtypes", None) is None:
            send_fn.argtypes = (wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int)
            send_fn.restype = wintypes.UINT
    except Exception:
        pass
    return u32


def _send_inputs(inputs: list[INPUT]) -> bool:
    if not inputs:
        return True
    u32 = _get_user32()
    if u32 is None:
        return False
    arr = (INPUT * len(inputs))(*inputs)
    try:
        sent = u32.SendInput(len(inputs), arr, ctypes.sizeof(INPUT))
        return int(sent) > 0
    except Exception:
        return False


def _make_mouse_input(dx: int = 0, dy: int = 0, data: int = 0, flags: int = 0) -> INPUT:
    return INPUT(
        type=INPUT_MOUSE,
        mi=MOUSEINPUT(
            dx=int(dx),
            dy=int(dy),
            mouseData=int(data) & 0xFFFFFFFF,
            dwFlags=int(flags),
            time=0,
            dwExtraInfo=0,
        ),
    )


def _make_key_input(vk: int = 0, scan: int = 0, flags: int = 0) -> INPUT:
    return INPUT(
        type=INPUT_KEYBOARD,
        ki=KEYBDINPUT(
            wVk=int(vk) & 0xFFFF,
            wScan=int(scan) & 0xFFFF,
            dwFlags=int(flags),
            time=0,
            dwExtraInfo=0,
        ),
    )


def _key_event_pair(vk: int, extended: bool = False, u32: Any | None = None) -> tuple[INPUT, INPUT]:
    ext_flag = KEYEVENTF_EXTENDEDKEY if extended else 0
    scan = 0
    if u32 is not None and hasattr(u32, "MapVirtualKeyW"):
        try:
            scan = int(u32.MapVirtualKeyW(vk, 0))
        except Exception:
            scan = 0
    down = _make_key_input(vk=vk, scan=scan, flags=ext_flag)
    up = _make_key_input(vk=vk, scan=scan, flags=ext_flag | KEYEVENTF_KEYUP)
    return down, up


def send_vk_press(
    vk: int,
    extended: bool = False,
    modifiers: Sequence[str] | None = None,
) -> bool:
    """Press and release a virtual key with optional modifier keys held."""
    u32 = _get_user32()
    if u32 is None:
        return False

    norm_mods: list[str] = []
    seen: set[str] = set()
    for mod in modifiers or ():
        clean = mod.strip().lower()
        if clean in MODIFIER_VKS and clean not in seen:
            seen.add(clean)
            norm_mods.append(clean)

    if vk == VK_DELETE and "ctrl" in seen and "alt" in seen:
        return False

    downs: list[INPUT] = []
    ups: list[INPUT] = []
    for mod in norm_mods:
        mod_vk, mod_ext = MODIFIER_VKS[mod]
        m_down, m_up = _key_event_pair(mod_vk, mod_ext, u32)
        downs.append(m_down)
        ups.insert(0, m_up)

    k_down, k_up = _key_event_pair(vk, extended, u32)
    return _send_inputs([*downs, k_down, k_up, *ups])


def send_mouse_move(dx: int, dy: int) -> bool:
    """Move mouse cursor by relative pixels via SendInput."""
    ix, iy = int(dx), int(dy)
    if ix == 0 and iy == 0:
        return True
    return _send_inputs([_make_mouse_input(dx=ix, dy=iy, flags=MOUSEEVENTF_MOVE)])


def send_mouse_click(button: MouseButton = "left", double: bool = False) -> bool:
    """Click a mouse button once or twice via SendInput."""
    flags = _MOUSE_FLAGS.get(button)
    if flags is None:
        return False
    down_flag, up_flag = flags
    seq = [
        _make_mouse_input(flags=down_flag),
        _make_mouse_input(flags=up_flag),
    ]
    if double:
        seq.extend(
            [
                _make_mouse_input(flags=down_flag),
                _make_mouse_input(flags=up_flag),
            ]
        )
    return _send_inputs(seq)


def send_mouse_button(button: MouseButton, state: Literal["down", "up"]) -> bool:
    """Press or release a mouse button for drag operations."""
    flags = _MOUSE_FLAGS.get(button)
    if flags is None:
        return False
    flag = flags[0] if state == "down" else flags[1]
    return _send_inputs([_make_mouse_input(flags=flag)])


def send_mouse_scroll(dx: int = 0, dy: int = 0) -> bool:
    """Scroll vertically (dy) and/or horizontally (dx) via SendInput."""
    inputs: list[INPUT] = []
    if dy != 0:
        inputs.append(_make_mouse_input(data=int(dy), flags=MOUSEEVENTF_WHEEL))
    if dx != 0:
        inputs.append(_make_mouse_input(data=int(dx), flags=MOUSEEVENTF_HWHEEL))
    if not inputs:
        return True
    return _send_inputs(inputs)


def send_unicode_text(text: str) -> bool:
    """Type arbitrary Unicode text via KEYEVENTF_UNICODE without layout/accent loss."""
    u32 = _get_user32()
    if u32 is None:
        return False

    cleaned = text.replace("\x00", "")
    if not cleaned or len(cleaned) > MAX_UNICODE_TEXT_LEN:
        return False

    inputs: list[INPUT] = []
    idx = 0
    while idx < len(cleaned):
        ch = cleaned[idx]
        if ch == "\r":
            if idx + 1 < len(cleaned) and cleaned[idx + 1] == "\n":
                idx += 1
            down, up = _key_event_pair(VK_RETURN, False, u32)
            inputs.extend([down, up])
        elif ch == "\n":
            down, up = _key_event_pair(VK_RETURN, False, u32)
            inputs.extend([down, up])
        elif ch == "\t":
            down, up = _key_event_pair(VK_TAB, False, u32)
            inputs.extend([down, up])
        else:
            raw_utf16 = ch.encode("utf-16-le")
            for offset in range(0, len(raw_utf16), 2):
                unit = int.from_bytes(raw_utf16[offset : offset + 2], "little")
                inputs.append(_make_key_input(vk=0, scan=unit, flags=KEYEVENTF_UNICODE))
                inputs.append(
                    _make_key_input(vk=0, scan=unit, flags=KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)
                )
        idx += 1

    return _send_inputs(inputs)


class WindowsInputProvider:
    """Async RemoteInputProvider implementation backed by Win32 SendInput."""

    async def move_mouse(self, dx: int, dy: int) -> bool:
        return send_mouse_move(dx, dy)

    async def click_mouse(self, button: MouseButton, double: bool = False) -> bool:
        if double:
            return await asyncio.to_thread(send_mouse_click, button, True)
        return send_mouse_click(button, False)

    async def mouse_button(self, button: MouseButton, state: Literal["down", "up"]) -> bool:
        return send_mouse_button(button, state)

    async def scroll_mouse(self, dx: int, dy: int) -> bool:
        return send_mouse_scroll(dx, dy)

    async def type_text(self, text: str) -> bool:
        return await asyncio.to_thread(send_unicode_text, text)

    async def press_key(self, key: str, modifiers: list[str] | None = None) -> bool:
        norm = key.strip().lower()
        entry = ALLOWED_REMOTE_KEYS.get(norm)
        if entry is None or is_dangerous_key_combo(norm, modifiers):
            return False
        vk, extended = entry
        return await asyncio.to_thread(send_vk_press, vk, extended, modifiers)
