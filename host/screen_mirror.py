"""Lightweight on-demand screen mirror capture for Windows monitors via mss + Pillow."""

from __future__ import annotations

import asyncio
import ctypes
import hashlib
import io
import logging
from concurrent.futures import ThreadPoolExecutor
from ctypes import wintypes
from dataclasses import dataclass, replace
from typing import Any, Protocol

from PIL import Image, ImageDraw

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class MonitorInfo:
    """Metadata describing an active desktop monitor."""

    id: int
    name: str
    left: int
    top: int
    width: int
    height: int
    primary: bool = False

    def to_dict(self) -> dict[str, Any]:
        """Serialize monitor descriptor to JSON-compatible dictionary."""
        return {
            "id": self.id,
            "name": self.name,
            "left": self.left,
            "top": self.top,
            "width": self.width,
            "height": self.height,
            "primary": self.primary,
        }


@dataclass(frozen=True, slots=True)
class VirtualBounds:
    """Bounding box spanning the entire Windows virtual desktop."""

    left: int
    top: int
    width: int
    height: int


@dataclass(frozen=True, slots=True)
class ScreenFrame:
    """Encoded JPEG frame plus metadata and digest for duplicate skipping."""

    jpeg_bytes: bytes
    width: int
    height: int
    monitor_id: int
    digest: bytes


class ScreenCaptureProvider(Protocol):
    """Contract for enumerating monitors and capturing JPEG desktop frames."""

    async def list_monitors(self) -> list[MonitorInfo]:
        """Return active monitors available for capture."""
        ...

    async def get_virtual_bounds(self) -> VirtualBounds:
        """Return bounding box spanning the full multi-monitor desktop."""
        ...

    async def capture_jpeg(
        self,
        monitor_id: int = 1,
        max_width: int = 960,
        quality: int = 60,
        include_cursor: bool = True,
    ) -> ScreenFrame | None:
        """Capture and JPEG-encode a frame of the requested monitor."""
        ...

    def close(self) -> None:
        """Release capture resources cleanly."""
        ...


class _POINT(ctypes.Structure):
    _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]


def get_cursor_position() -> tuple[int, int] | None:
    """Return current Windows desktop cursor coordinates (x, y), or None if unavailable."""
    windll = getattr(ctypes, "windll", None)
    if windll is None:
        return None
    u32 = getattr(windll, "user32", None)
    if u32 is None or not hasattr(u32, "GetCursorPos"):
        return None
    pt = _POINT()
    try:
        if u32.GetCursorPos(ctypes.byref(pt)):
            return int(pt.x), int(pt.y)
    except Exception:
        return None
    return None


def draw_cursor_on_image(
    img: Image.Image,
    cursor_px: tuple[int, int],
    monitor: MonitorInfo,
) -> None:
    """Draw a high-contrast pointer overlay onto img if cursor_px falls inside monitor."""
    if monitor.width <= 0 or monitor.height <= 0 or img.width <= 0 or img.height <= 0:
        return
    cx, cy = cursor_px
    if not (
        monitor.left <= cx < monitor.left + monitor.width
        and monitor.top <= cy < monitor.top + monitor.height
    ):
        return

    rel_x = (cx - monitor.left) / monitor.width
    rel_y = (cy - monitor.top) / monitor.height
    ix = max(0, min(img.width - 1, round(rel_x * img.width)))
    iy = max(0, min(img.height - 1, round(rel_y * img.height)))

    scale = max(0.85, min(1.5, img.width / 800.0))
    offsets = [
        (0.0, 0.0),
        (0.0, 16.0),
        (4.0, 12.2),
        (7.2, 18.0),
        (9.4, 16.8),
        (6.4, 11.2),
        (11.4, 11.2),
    ]
    poly = [(ix + round(dx * scale), iy + round(dy * scale)) for dx, dy in offsets]
    draw = ImageDraw.Draw(img)
    draw.polygon(poly, fill=(255, 255, 255), outline=(17, 24, 39), width=max(1, round(scale * 1.4)))


def encode_rgb_to_jpeg_frame(
    img: Image.Image,
    monitor_id: int,
    quality: int = 60,
) -> ScreenFrame:
    """Compute a fast frame digest and encode an RGB PIL image as JPEG bytes."""
    clamped_q = max(25, min(85, int(quality)))
    rgb_img = img if img.mode == "RGB" else img.convert("RGB")
    digest = hashlib.blake2b(rgb_img.tobytes(), digest_size=8).digest()
    buf = io.BytesIO()
    rgb_img.save(buf, format="JPEG", quality=clamped_q, optimize=False, subsampling="4:2:0")
    return ScreenFrame(
        jpeg_bytes=buf.getvalue(),
        width=rgb_img.width,
        height=rgb_img.height,
        monitor_id=monitor_id,
        digest=digest,
    )


class MssScreenCaptureProvider:
    """Thread-safe MSS desktop capture provider running on a dedicated GDI worker thread."""

    def __init__(self) -> None:
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="screen-mirror")
        self._sct: Any = None
        self._closed = False

    def _get_sct(self) -> Any:
        if self._closed:
            raise RuntimeError("MssScreenCaptureProvider encerrado.")
        if self._sct is None:
            import mss

            self._sct = mss.mss()
        return self._sct

    def _list_monitors_sync(self) -> list[MonitorInfo]:
        sct = self._get_sct()
        raw_list = list(sct.monitors)
        if not raw_list:
            return []
        entries = raw_list[1:] if len(raw_list) > 1 else raw_list[:1]
        monitors: list[MonitorInfo] = []
        for idx, raw in enumerate(entries, start=1):
            w = int(raw["width"])
            h = int(raw["height"])
            left = int(raw["left"])
            top = int(raw["top"])
            monitors.append(
                MonitorInfo(
                    id=idx,
                    name=f"Tela {idx} ({w}x{h})",
                    left=left,
                    top=top,
                    width=w,
                    height=h,
                    primary=(left == 0 and top == 0),
                )
            )
        if monitors and not any(m.primary for m in monitors):
            monitors[0] = replace(monitors[0], primary=True)
        return monitors

    def _get_virtual_bounds_sync(self) -> VirtualBounds:
        sct = self._get_sct()
        raw = sct.monitors[0]
        return VirtualBounds(
            left=int(raw["left"]),
            top=int(raw["top"]),
            width=max(1, int(raw["width"])),
            height=max(1, int(raw["height"])),
        )

    def _capture_jpeg_sync(
        self,
        monitor_id: int = 1,
        max_width: int = 960,
        quality: int = 60,
        include_cursor: bool = True,
    ) -> ScreenFrame | None:
        if self._closed:
            return None
        monitors = self._list_monitors_sync()
        if not monitors:
            return None
        target = next((m for m in monitors if m.id == monitor_id), monitors[0])

        clamped_w = max(320, min(1280, int(max_width)))
        clamped_q = max(25, min(85, int(quality)))

        sct = self._get_sct()
        raw = sct.grab(
            {
                "left": target.left,
                "top": target.top,
                "width": target.width,
                "height": target.height,
            }
        )
        img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
        if img.width > clamped_w and img.width > 0:
            new_h = max(1, round(img.height * (clamped_w / img.width)))
            img = img.resize((clamped_w, new_h), Image.Resampling.BILINEAR)

        if include_cursor:
            cursor_pos = get_cursor_position()
            if cursor_pos is not None:
                draw_cursor_on_image(img, cursor_pos, target)

        return encode_rgb_to_jpeg_frame(img, monitor_id=target.id, quality=clamped_q)

    async def list_monitors(self) -> list[MonitorInfo]:
        """List available desktop monitors without blocking the event loop."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, self._list_monitors_sync)

    async def get_virtual_bounds(self) -> VirtualBounds:
        """Read full virtual desktop bounds without blocking the event loop."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, self._get_virtual_bounds_sync)

    async def capture_jpeg(
        self,
        monitor_id: int = 1,
        max_width: int = 960,
        quality: int = 60,
        include_cursor: bool = True,
    ) -> ScreenFrame | None:
        """Capture and JPEG-encode a screen frame on the dedicated capture thread."""
        if self._closed:
            return None
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            self._executor,
            self._capture_jpeg_sync,
            monitor_id,
            max_width,
            quality,
            include_cursor,
        )

    def _close_sct_sync(self) -> None:
        if self._sct is not None:
            try:
                self._sct.close()
            except Exception:  # noqa: BLE001
                pass
            finally:
                self._sct = None

    def close(self) -> None:
        """Close the underlying MSS session on its owning thread and shut down executor."""
        if self._closed:
            return
        self._closed = True
        try:
            if self._sct is not None:
                fut = self._executor.submit(self._close_sct_sync)
                fut.result(timeout=1.5)
        except Exception:  # noqa: BLE001
            pass
        finally:
            self._executor.shutdown(wait=False, cancel_futures=True)
