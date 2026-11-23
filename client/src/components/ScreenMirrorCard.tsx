import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent,
  type TouchEvent,
} from "react";
import { createPortal } from "react-dom";
import type {
  InputMessagePayload,
  ScreenMetaMessage,
  ScreenMonitorInfo,
  ScreenQualityPreset,
} from "../types";
import {
  buildScreenWebSocketUrl,
  loadAuthToken,
  mapClientPointToNormalized,
  triggerHaptic,
} from "../utils";
import {
  BackspaceIcon,
  CloseIcon,
  CursorIcon,
  EnterKeyIcon,
  ExpandIcon,
  EyeIcon,
  HandTapIcon,
  MonitorIcon,
  RotateIcon,
  ShortcutsIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "./Icons";

interface ScreenMirrorCardProps {
  remoteInputEnabled: boolean;
  available?: boolean;
  onSendInput: (payload: InputMessagePayload, opts?: { expectAck?: boolean }) => boolean;
  onSetRemoteInputEnabled: (enabled: boolean) => boolean;
}

type StreamStatus = "idle" | "connecting" | "streaming" | "paused" | "error";
type MirrorInteractionMode = "touch" | "cursor" | "view";
type FullscreenPanel = "none" | "keyboard" | "shortcuts";

const QUALITY_PRESETS: Record<
  ScreenQualityPreset,
  { label: string; fps: number; maxWidth: number; quality: number }
> = {
  eco: { label: "Eco", fps: 5, maxWidth: 640, quality: 45 },
  normal: { label: "Normal", fps: 10, maxWidth: 960, quality: 60 },
  fluid: { label: "Fluido", fps: 15, maxWidth: 1120, quality: 70 },
};

const PRESET_ORDER: ScreenQualityPreset[] = ["eco", "normal", "fluid"];
const MIN_ZOOM = 1;
const MAX_ZOOM = 3.5;
const ZOOM_STEP = 0.5;
const CURSOR_SENSITIVITY = 1.6;

function clampZoom(val: number): number {
  const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, val));
  return Math.round(clamped * 100) / 100;
}

function resolvePresetValues(preset: ScreenQualityPreset) {
  return QUALITY_PRESETS[preset];
}

export function ScreenMirrorCard({
  remoteInputEnabled,
  available = true,
  onSendInput,
  onSetRemoteInputEnabled,
}: ScreenMirrorCardProps) {
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [preset, setPreset] = useState<ScreenQualityPreset>("normal");
  const [monitors, setMonitors] = useState<ScreenMonitorInfo[]>([]);
  const [activeMonitor, setActiveMonitor] = useState<number>(1);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [interactionMode, setInteractionMode] = useState<MirrorInteractionMode>("touch");
  const [expanded, setExpanded] = useState(false);
  const [rotated90, setRotated90] = useState(false);
  const [hudHidden, setHudHidden] = useState(false);
  const [fsPanel, setFsPanel] = useState<FullscreenPanel>("none");
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [dragLocked, setDragLocked] = useState(false);
  const [fsText, setFsText] = useState("");
  const [fsLockConfirm, setFsLockConfirm] = useState(false);
  const [tapIndicator, setTapIndicator] = useState<{
    xPct: number;
    yPct: number;
    key: number;
  } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inlineStageRef = useRef<HTMLDivElement | null>(null);
  const modalStageRef = useRef<HTMLDivElement | null>(null);
  const inlineImgRef = useRef<HTMLImageElement | null>(null);
  const modalImgRef = useRef<HTMLImageElement | null>(null);
  const naturalSizeRef = useRef<{ width: number; height: number }>({ width: 16, height: 9 });
  const dragLockedRef = useRef(false);
  const activeMonitorRef = useRef(activeMonitor);
  activeMonitorRef.current = activeMonitor;
  const presetRef = useRef(preset);
  presetRef.current = preset;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const panRef = useRef(pan);
  panRef.current = pan;
  const rotated90Ref = useRef(rotated90);
  rotated90Ref.current = rotated90;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const pendingAbsMoveRef = useRef<{ x: number; y: number } | null>(null);
  const pendingRelMoveRef = useRef({ dx: 0, dy: 0 });
  const pendingScrollDyRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const tapTimerRef = useRef<number | null>(null);
  const lockTimerRef = useRef<number | null>(null);
  const touchActiveRef = useRef(false);
  const gestureRef = useRef({
    active: false,
    maxFingers: 0,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    twoStartDist: 0,
    twoStartZoom: 1,
    twoCenterX: 0,
    twoCenterY: 0,
    pinchTriggered: false,
    travelPx: 0,
    startedAt: 0,
    lastTapAt: 0,
    longPressFired: false,
  });

  const revokeFrameUrl = useCallback(() => {
    if (
      objectUrlRef.current &&
      typeof URL !== "undefined" &&
      typeof URL.revokeObjectURL === "function"
    ) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setFrameUrl(null);
  }, []);

  const clearTimersAndRaf = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (tapTimerRef.current !== null) {
      window.clearTimeout(tapTimerRef.current);
      tapTimerRef.current = null;
    }
    if (lockTimerRef.current !== null) {
      window.clearTimeout(lockTimerRef.current);
      lockTimerRef.current = null;
    }
    if (rafIdRef.current !== null) {
      window.cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  const getActiveStage = useCallback(() => {
    return expandedRef.current ? modalStageRef.current : inlineStageRef.current;
  }, []);

  const clampPanValues = useCallback(
    (nextPan: { x: number; y: number }, targetZoom: number): { x: number; y: number } => {
      if (targetZoom <= 1.01) {
        return { x: 0, y: 0 };
      }
      const stageEl = getActiveStage();
      const stageW = stageEl?.clientWidth || 320;
      const stageH = stageEl?.clientHeight || 200;
      const maxX = Math.max(40, ((targetZoom - 1) / 2) * stageW);
      const maxY = Math.max(40, ((targetZoom - 1) / 2) * stageH);
      return {
        x: Math.max(-maxX, Math.min(maxX, Math.round(nextPan.x))),
        y: Math.max(-maxY, Math.min(maxY, Math.round(nextPan.y))),
      };
    },
    [getActiveStage],
  );

  const resetZoomAndPan = useCallback(() => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const setZoomClamped = useCallback(
    (nextZoomVal: number, nextPanCandidate?: { x: number; y: number }) => {
      const clampedZ = clampZoom(nextZoomVal);
      const clampedP = clampPanValues(nextPanCandidate ?? panRef.current, clampedZ);
      zoomRef.current = clampedZ;
      panRef.current = clampedP;
      setZoom(clampedZ);
      setPan(clampedP);
    },
    [clampPanValues],
  );

  const sendStreamConfig = useCallback(
    (overrides?: {
      monitor?: number;
      preset?: ScreenQualityPreset;
      paused?: boolean;
    }) => {
      const sock = wsRef.current;
      if (!sock || sock.readyState !== WebSocket.OPEN) return;
      const cfg = resolvePresetValues(overrides?.preset ?? presetRef.current);
      sock.send(
        JSON.stringify({
          v: 1,
          type: "screen_config",
          monitor: overrides?.monitor ?? activeMonitorRef.current,
          fps: cfg.fps,
          maxWidth: cfg.maxWidth,
          quality: cfg.quality,
          paused: overrides?.paused ?? false,
        }),
      );
    },
    [],
  );

  const exitFullscreenModal = useCallback(() => {
    setExpanded(false);
    setRotated90(false);
    setHudHidden(false);
    setFsPanel("none");
    setFsLockConfirm(false);
    resetZoomAndPan();
  }, [resetZoomAndPan]);

  const stopMirror = useCallback(() => {
    setActive(false);
    exitFullscreenModal();
    setStatus("idle");
    setErrorMsg(null);
    clearTimersAndRaf();
    if (dragLockedRef.current) {
      dragLockedRef.current = false;
      setDragLocked(false);
      onSendInput({ action: "mouse_up", button: "left" });
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    revokeFrameUrl();
  }, [clearTimersAndRaf, exitFullscreenModal, onSendInput, revokeFrameUrl]);

  // Body scroll lock + best-effort native Fullscreen API when expanded
  useEffect(() => {
    if (!expanded || typeof document === "undefined") {
      return undefined;
    }
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const dialogEl = dialogRef.current as (HTMLDivElement & {
      requestFullscreen?: () => Promise<void> | void;
    }) | null;
    if (dialogEl && typeof dialogEl.requestFullscreen === "function") {
      try {
        const res = dialogEl.requestFullscreen();
        if (res && typeof (res as Promise<void>).catch === "function") {
          (res as Promise<void>).catch(() => {});
        }
      } catch {
        // Ignore fullscreen rejection in unsupported environments
      }
    }

    return () => {
      document.body.style.overflow = prevOverflow;
      try {
        if (document.fullscreenElement && typeof document.exitFullscreen === "function") {
          const res = document.exitFullscreen();
          if (res && typeof (res as Promise<void>).catch === "function") {
            (res as Promise<void>).catch(() => {});
          }
        }
      } catch {
        // Ignore exitFullscreen error
      }
      try {
        const orient = (
          screen as Screen & { orientation?: { unlock?: () => void } }
        )?.orientation;
        orient?.unlock?.();
      } catch {
        // Ignore orientation unlock error
      }
    };
  }, [expanded]);

  // Manage /ws/screen lifecycle only while active === true
  useEffect(() => {
    if (!active) {
      return undefined;
    }

    let disposed = false;
    setStatus("connecting");
    setErrorMsg(null);

    let socket: WebSocket;
    try {
      socket = new WebSocket(buildScreenWebSocketUrl());
      socket.binaryType = "blob";
    } catch {
      setStatus("error");
      setErrorMsg("Não foi possível iniciar a conexão do espelho.");
      return undefined;
    }

    wsRef.current = socket;

    socket.onopen = () => {
      if (disposed) {
        socket.close();
        return;
      }
      const token = loadAuthToken();
      if (token) {
        socket.send(JSON.stringify({ v: 1, type: "auth", token }));
      }
      const cfg = resolvePresetValues(presetRef.current);
      socket.send(
        JSON.stringify({
          v: 1,
          type: "screen_config",
          monitor: activeMonitorRef.current,
          fps: cfg.fps,
          maxWidth: cfg.maxWidth,
          quality: cfg.quality,
          paused: document.visibilityState === "hidden",
        }),
      );
    };

    socket.onmessage = (event) => {
      if (disposed) return;

      if (typeof event.data === "string") {
        try {
          const parsed = JSON.parse(event.data) as
            | ScreenMetaMessage
            | { type: string; message?: string };
          if (parsed.type === "screen_meta") {
            const meta = parsed as ScreenMetaMessage;
            if (Array.isArray(meta.monitors) && meta.monitors.length > 0) {
              setMonitors(meta.monitors);
            }
            if (typeof meta.activeMonitor === "number") {
              setActiveMonitor(meta.activeMonitor);
            }
            setStatus(meta.paused ? "paused" : "streaming");
          } else if (parsed.type === "error") {
            setStatus("error");
            setErrorMsg(parsed.message || "Falha ao transmitir a tela do PC.");
          }
        } catch {
          // Ignore malformed JSON control frame
        }
        return;
      }

      // Binary JPEG frame
      let blob: Blob | null = null;
      if (typeof Blob !== "undefined" && event.data instanceof Blob) {
        blob = event.data;
      } else if (event.data instanceof ArrayBuffer) {
        blob = new Blob([event.data], { type: "image/jpeg" });
      } else if (ArrayBuffer.isView(event.data)) {
        const src = new Uint8Array(
          event.data.buffer,
          event.data.byteOffset,
          event.data.byteLength,
        );
        const copy = new Uint8Array(src.byteLength);
        copy.set(src);
        blob = new Blob([copy], { type: "image/jpeg" });
      }

      if (
        blob &&
        typeof URL !== "undefined" &&
        typeof URL.createObjectURL === "function"
      ) {
        const nextUrl = URL.createObjectURL(blob);
        if (objectUrlRef.current && typeof URL.revokeObjectURL === "function") {
          URL.revokeObjectURL(objectUrlRef.current);
        }
        objectUrlRef.current = nextUrl;
        setFrameUrl(nextUrl);
      }
      setStatus("streaming");
    };

    socket.onclose = (ev) => {
      if (wsRef.current === socket) {
        wsRef.current = null;
      }
      if (disposed) return;
      if (ev.code === 4001 || ev.code === 1013) {
        setStatus("error");
        setErrorMsg(ev.reason || "Espelho desconectado pelo host.");
      } else {
        setStatus("error");
        setErrorMsg("Transmissão da tela encerrada.");
      }
    };

    const handleVisibility = () => {
      const hidden = document.visibilityState === "hidden";
      sendStreamConfig({ paused: hidden });
      setStatus((prev) => {
        if (prev === "error" || prev === "idle") return prev;
        return hidden ? "paused" : "streaming";
      });
    };

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      clearTimersAndRaf();
      socket.close();
      if (wsRef.current === socket) {
        wsRef.current = null;
      }
      revokeFrameUrl();
    };
  }, [active, clearTimersAndRaf, revokeFrameUrl, sendStreamConfig]);

  useEffect(() => {
    if (!remoteInputEnabled && dragLockedRef.current) {
      dragLockedRef.current = false;
      setDragLocked(false);
      onSendInput({ action: "mouse_up", button: "left" });
    }
  }, [remoteInputEnabled, onSendInput]);

  useEffect(() => {
    return () => {
      clearTimersAndRaf();
      if (dragLockedRef.current) {
        dragLockedRef.current = false;
        onSendInput({ action: "mouse_up", button: "left" });
      }
    };
  }, [clearTimersAndRaf, onSendInput]);

  const flushMirrorMotion = useCallback(() => {
    rafIdRef.current = null;
    const absTarget = pendingAbsMoveRef.current;
    if (absTarget) {
      pendingAbsMoveRef.current = null;
      onSendInput(
        {
          action: "mouse_move_abs",
          x: absTarget.x,
          y: absTarget.y,
          monitor: activeMonitorRef.current,
        },
        { expectAck: false },
      );
    }

    const relDx = Math.trunc(pendingRelMoveRef.current.dx);
    const relDy = Math.trunc(pendingRelMoveRef.current.dy);
    if (relDx !== 0 || relDy !== 0) {
      pendingRelMoveRef.current.dx -= relDx;
      pendingRelMoveRef.current.dy -= relDy;
      onSendInput(
        {
          action: "mouse_move",
          dx: Math.max(-500, Math.min(500, relDx)),
          dy: Math.max(-500, Math.min(500, relDy)),
        },
        { expectAck: false },
      );
    }

    const scrollDy = Math.trunc(pendingScrollDyRef.current);
    if (scrollDy !== 0) {
      pendingScrollDyRef.current -= scrollDy;
      onSendInput(
        {
          action: "mouse_scroll",
          dx: 0,
          dy: Math.max(-1200, Math.min(1200, scrollDy)),
        },
        { expectAck: false },
      );
    }
  }, [onSendInput]);

  const scheduleMirrorFlush = useCallback(() => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = window.requestAnimationFrame(flushMirrorMotion);
  }, [flushMirrorMotion]);

  const mapPointer = useCallback((clientX: number, clientY: number) => {
    const imgEl = expandedRef.current ? modalImgRef.current : inlineImgRef.current;
    if (!imgEl) return null;
    const rect = imgEl.getBoundingClientRect();
    const natW = imgEl.naturalWidth || naturalSizeRef.current.width || 16;
    const natH = imgEl.naturalHeight || naturalSizeRef.current.height || 9;
    const rot: 0 | 90 = expandedRef.current && rotated90Ref.current ? 90 : 0;
    return {
      norm: mapClientPointToNormalized(clientX, clientY, rect, natW, natH, rot),
      rect,
    };
  }, []);

  const showTapDot = useCallback(
    (clientX: number, clientY: number) => {
      const stageEl = getActiveStage();
      if (!stageEl) return;
      const rect = stageEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      let xPct: number;
      let yPct: number;
      if (expandedRef.current && rotated90Ref.current) {
        xPct = ((clientY - rect.top) / rect.height) * 100;
        yPct = (1 - (clientX - rect.left) / rect.width) * 100;
      } else {
        xPct = ((clientX - rect.left) / rect.width) * 100;
        yPct = ((clientY - rect.top) / rect.height) * 100;
      }

      const key = Date.now() + Math.random();
      setTapIndicator({
        xPct: Math.max(0, Math.min(100, xPct)),
        yPct: Math.max(0, Math.min(100, yPct)),
        key,
      });
      if (tapTimerRef.current !== null) {
        window.clearTimeout(tapTimerRef.current);
      }
      tapTimerRef.current = window.setTimeout(() => {
        setTapIndicator(null);
        tapTimerRef.current = null;
      }, 380);
    },
    [getActiveStage],
  );

  const cancelLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const queueCursorRelativeMove = (rawDx: number, rawDy: number) => {
    const rotated = expandedRef.current && rotated90Ref.current;
    const localDx = rotated ? rawDy : rawDx;
    const localDy = rotated ? -rawDx : rawDy;
    const dist = Math.hypot(localDx, localDy);
    const accel = dist > 14 ? 1.45 : 1.0;
    pendingRelMoveRef.current.dx += localDx * CURSOR_SENSITIVITY * accel;
    pendingRelMoveRef.current.dy += localDy * CURSOR_SENSITIVITY * accel;
    scheduleMirrorFlush();
  };

  const handleStageStart = (
    clientX: number,
    clientY: number,
    touchesCount: number,
    twoCenterX?: number,
    twoCenterY?: number,
    twoDist?: number,
  ) => {
    const canPanView = interactionMode === "view" && zoomRef.current > 1.01;
    const canPinchOrPan = touchesCount >= 2;
    const canInteract = remoteInputEnabled && (interactionMode === "touch" || interactionMode === "cursor");
    if (!canInteract && !canPanView && !canPinchOrPan) return;

    const g = gestureRef.current;
    g.maxFingers = Math.max(g.active ? g.maxFingers : 0, touchesCount);

    if (!g.active) {
      g.active = true;
      g.startX = clientX;
      g.startY = clientY;
      g.lastX = clientX;
      g.lastY = clientY;
      g.travelPx = 0;
      g.startedAt = Date.now();
      g.longPressFired = false;
      g.pinchTriggered = false;
    }

    if (
      touchesCount >= 2 &&
      twoCenterX !== undefined &&
      twoCenterY !== undefined &&
      twoDist !== undefined
    ) {
      cancelLongPress();
      g.twoStartDist = twoDist;
      g.twoStartZoom = zoomRef.current;
      g.twoCenterX = twoCenterX;
      g.twoCenterY = twoCenterY;
      return;
    }

    if (touchesCount === 1 && interactionMode === "touch" && remoteInputEnabled) {
      cancelLongPress();
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null;
        if (!gestureRef.current.active || gestureRef.current.maxFingers > 1) return;
        if (gestureRef.current.travelPx < 10) {
          const mapped = mapPointer(clientX, clientY);
          if (mapped?.norm) {
            gestureRef.current.longPressFired = true;
            triggerHaptic(14);
            showTapDot(clientX, clientY);
            onSendInput(
              {
                action: "mouse_move_abs",
                x: mapped.norm.x,
                y: mapped.norm.y,
                monitor: activeMonitorRef.current,
              },
              { expectAck: false },
            );
            onSendInput({ action: "mouse_click", button: "right" });
          }
        }
      }, 450);
    }
  };

  const handleStageMove = (clientX: number, clientY: number) => {
    const g = gestureRef.current;
    if (!g.active) return;

    const dx = clientX - g.lastX;
    const dy = clientY - g.lastY;
    g.lastX = clientX;
    g.lastY = clientY;
    g.travelPx = Math.max(g.travelPx, Math.hypot(clientX - g.startX, clientY - g.startY));

    if (interactionMode === "view" && zoomRef.current > 1.01) {
      const localDx = expandedRef.current && rotated90Ref.current ? dy : dx;
      const localDy = expandedRef.current && rotated90Ref.current ? -dx : dy;
      setZoomClamped(zoomRef.current, {
        x: panRef.current.x + localDx,
        y: panRef.current.y + localDy,
      });
      return;
    }

    if (!remoteInputEnabled) return;

    if (interactionMode === "cursor") {
      queueCursorRelativeMove(dx, dy);
      return;
    }

    if (interactionMode === "touch" && g.travelPx > 8) {
      cancelLongPress();
      const mapped = mapPointer(clientX, clientY);
      if (mapped?.norm) {
        pendingAbsMoveRef.current = mapped.norm;
        scheduleMirrorFlush();
      }
    }
  };

  const handleStageEnd = (clientX: number, clientY: number) => {
    const g = gestureRef.current;
    if (!g.active) return;
    cancelLongPress();
    if (rafIdRef.current !== null) {
      window.cancelAnimationFrame(rafIdRef.current);
    }
    flushMirrorMotion();

    const elapsed = Date.now() - g.startedAt;
    if (!g.pinchTriggered && remoteInputEnabled) {
      if (interactionMode === "cursor" && g.maxFingers === 2 && g.travelPx < 14 && elapsed < 280) {
        triggerHaptic(12);
        onSendInput({ action: "mouse_click", button: "right" });
      } else if (g.maxFingers === 1 && !g.longPressFired && g.travelPx < 10 && elapsed < 280) {
        if (interactionMode === "cursor") {
          const now = Date.now();
          const isDouble = g.lastTapAt > 0 && now - g.lastTapAt < 280;
          g.lastTapAt = isDouble ? 0 : now;
          triggerHaptic(8);
          onSendInput({ action: "mouse_click", button: "left", double: isDouble });
        } else if (interactionMode === "touch") {
          const mapped = mapPointer(clientX, clientY);
          if (mapped?.norm) {
            const now = Date.now();
            const isDouble = g.lastTapAt > 0 && now - g.lastTapAt < 280;
            g.lastTapAt = isDouble ? 0 : now;
            triggerHaptic(8);
            showTapDot(clientX, clientY);
            onSendInput(
              {
                action: "mouse_move_abs",
                x: mapped.norm.x,
                y: mapped.norm.y,
                monitor: activeMonitorRef.current,
              },
              { expectAck: false },
            );
            onSendInput({ action: "mouse_click", button: "left", double: isDouble });
          }
        }
      }
    }

    g.active = false;
    g.maxFingers = 0;
    g.longPressFired = false;
    g.pinchTriggered = false;
  };

  const onTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 0) return;
    touchActiveRef.current = true;
    const t0 = e.touches[0];
    if (e.touches.length >= 2) {
      const t1 = e.touches[1];
      const cx = (t0.clientX + t1.clientX) / 2;
      const cy = (t0.clientY + t1.clientY) / 2;
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      handleStageStart(t0.clientX, t0.clientY, e.touches.length, cx, cy, dist);
      return;
    }
    handleStageStart(t0.clientX, t0.clientY, 1);
  };

  const onTouchMove = (e: TouchEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g.active) return;

    if (e.touches.length >= 2) {
      cancelLongPress();
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const cx = (t0.clientX + t1.clientX) / 2;
      const cy = (t0.clientY + t1.clientY) / 2;
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const centerDx = cx - g.twoCenterX;
      const centerDy = cy - g.twoCenterY;
      g.travelPx += Math.hypot(centerDx, centerDy);

      if (g.twoStartDist > 12 && Math.abs(dist - g.twoStartDist) > 10) {
        g.pinchTriggered = true;
        const targetZoom = g.twoStartZoom * (dist / g.twoStartDist);
        const localDx = expandedRef.current && rotated90Ref.current ? centerDy : centerDx;
        const localDy = expandedRef.current && rotated90Ref.current ? -centerDx : centerDy;
        setZoomClamped(targetZoom, {
          x: panRef.current.x + localDx,
          y: panRef.current.y + localDy,
        });
      } else if (zoomRef.current > 1.05) {
        const localDx = expandedRef.current && rotated90Ref.current ? centerDy : centerDx;
        const localDy = expandedRef.current && rotated90Ref.current ? -centerDx : centerDy;
        setZoomClamped(zoomRef.current, {
          x: panRef.current.x + localDx,
          y: panRef.current.y + localDy,
        });
      } else if (remoteInputEnabled) {
        pendingScrollDyRef.current += centerDy * 5;
        scheduleMirrorFlush();
      }

      g.twoCenterX = cx;
      g.twoCenterY = cy;
      return;
    }

    if (e.touches.length === 1 && g.maxFingers === 1) {
      handleStageMove(e.touches[0].clientX, e.touches[0].clientY);
    }
  };

  const onTouchEnd = (e: TouchEvent<HTMLDivElement>) => {
    if (e.touches.length > 0) return;
    const changed = e.changedTouches[0];
    handleStageEnd(
      changed ? changed.clientX : gestureRef.current.startX,
      changed ? changed.clientY : gestureRef.current.startY,
    );
    window.setTimeout(() => {
      touchActiveRef.current = false;
    }, 60);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch" || touchActiveRef.current) return;
    handleStageStart(e.clientX, e.clientY, 1);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch" || touchActiveRef.current) return;
    handleStageMove(e.clientX, e.clientY);
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch" || touchActiveRef.current) return;
    handleStageEnd(e.clientX, e.clientY);
  };

  const handlePresetChange = (next: ScreenQualityPreset) => {
    triggerHaptic(6);
    setPreset(next);
    presetRef.current = next;
    sendStreamConfig({ preset: next, paused: false });
  };

  const handleMonitorChange = (monitorId: number) => {
    triggerHaptic(6);
    setActiveMonitor(monitorId);
    activeMonitorRef.current = monitorId;
    resetZoomAndPan();
    sendStreamConfig({ monitor: monitorId, paused: false });
  };

  const toggleRotate90 = () => {
    triggerHaptic(8);
    const next = !rotated90;
    setRotated90(next);
    resetZoomAndPan();
    try {
      const orient = (
        screen as Screen & {
          orientation?: { lock?: (o: string) => Promise<void>; unlock?: () => void };
        }
      )?.orientation;
      if (next && orient?.lock) {
        const p = orient.lock("landscape");
        if (p && typeof p.catch === "function") p.catch(() => {});
      } else if (!next && orient?.unlock) {
        orient.unlock();
      }
    } catch {
      // Orientation Lock API unavailable or disallowed — CSS rotation fallback handles it
    }
  };

  const toggleDragLock = () => {
    triggerHaptic(10);
    const next = !dragLocked;
    dragLockedRef.current = next;
    setDragLocked(next);
    onSendInput({ action: next ? "mouse_down" : "mouse_up", button: "left" });
  };

  const handleFsTextSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!fsText) return;
    triggerHaptic(8);
    if (onSendInput({ action: "key_text", text: fsText })) {
      setFsText("");
    }
  };

  const triggerLockPcInMirror = () => {
    if (!fsLockConfirm) {
      triggerHaptic(10);
      setFsLockConfirm(true);
      if (lockTimerRef.current !== null) window.clearTimeout(lockTimerRef.current);
      lockTimerRef.current = window.setTimeout(() => {
        setFsLockConfirm(false);
        lockTimerRef.current = null;
      }, 3500);
      return;
    }
    triggerHaptic(16);
    if (lockTimerRef.current !== null) {
      window.clearTimeout(lockTimerRef.current);
      lockTimerRef.current = null;
    }
    setFsLockConfirm(false);
    onSendInput({ action: "system_action", systemAction: "lock_screen" });
  };

  if (!available) {
    return null;
  }

  const renderZoomControls = (compactDark = false) => (
    <div
      className={`inline-flex items-center gap-0.5 rounded-xl border p-0.5 ${
        compactDark ? "border-white/20 bg-white/10 text-white" : ""
      }`}
      style={
        compactDark
          ? undefined
          : {
              backgroundColor: "var(--surface-elevated)",
              borderColor: "var(--hairline)",
            }
      }
      role="group"
      aria-label="Zoom do espelho"
    >
      <button
        type="button"
        onClick={() => setZoomClamped(zoom - ZOOM_STEP)}
        disabled={zoom <= MIN_ZOOM}
        aria-label="Diminuir zoom do espelho"
        className="rounded-lg px-2 py-1 text-xs font-semibold disabled:opacity-40"
      >
        <ZoomOutIcon className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={resetZoomAndPan}
        aria-label="Resetar zoom do espelho"
        className="rounded-lg px-1.5 py-1 text-[11px] font-semibold tabular-nums"
        style={compactDark ? undefined : { color: "var(--text)" }}
      >
        {zoom.toFixed(1)}x
      </button>
      <button
        type="button"
        onClick={() => setZoomClamped(zoom + ZOOM_STEP)}
        disabled={zoom >= MAX_ZOOM}
        aria-label="Aumentar zoom do espelho"
        className="rounded-lg px-2 py-1 text-xs font-semibold disabled:opacity-40"
      >
        <ZoomInIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );

  const renderViewport = (isModal: boolean) => {
    const canTouchDrag =
      (interactionMode === "view" && zoom > 1.01) ||
      (remoteInputEnabled && (interactionMode === "touch" || interactionMode === "cursor"));

    return (
      <div
        ref={isModal ? modalStageRef : inlineStageRef}
        data-testid={isModal ? "screen-mirror-modal-stage" : "screen-mirror-stage"}
        className={`relative overflow-hidden bg-black ${
          canTouchDrag ? "touch-none select-none cursor-crosshair" : "touch-none select-none"
        } ${
          isModal
            ? "h-full w-full flex items-center justify-center"
            : "aspect-video w-full rounded-[16px]"
        }`}
        style={{
          border: isModal ? undefined : "1px solid var(--hairline)",
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {frameUrl ? (
          <img
            ref={isModal ? modalImgRef : inlineImgRef}
            src={frameUrl}
            alt="Tela do PC ao vivo"
            draggable={false}
            onLoad={(e) => {
              const nw = e.currentTarget.naturalWidth;
              const nh = e.currentTarget.naturalHeight;
              if (nw > 0 && nh > 0) {
                naturalSizeRef.current = { width: nw, height: nh };
              }
            }}
            style={{
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
              transformOrigin: "center center",
              transition: gestureRef.current.active ? "none" : "transform 120ms ease-out",
            }}
            className="h-full w-full object-contain pointer-events-none select-none"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-4 text-center text-white/80">
            <MonitorIcon className="h-7 w-7 opacity-75" />
            <span className="text-xs font-medium">
              {status === "error"
                ? errorMsg || "Erro no espelho da tela."
                : status === "paused"
                  ? "Transmissão pausada em segundo plano."
                  : "Conectando à tela do PC…"}
            </span>
          </div>
        )}

        {tapIndicator ? (
          <span
            key={tapIndicator.key}
            aria-hidden="true"
            className="pointer-events-none absolute h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-sky-400/60 shadow"
            style={{ left: `${tapIndicator.xPct}%`, top: `${tapIndicator.yPct}%` }}
          />
        ) : null}
      </div>
    );
  };

  if (!active) {
    return (
      <section className="card-surface p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <MonitorIcon className="h-4 w-4 shrink-0" style={{ color: "var(--accent-text)" }} />
              <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>
                Espelho da Tela
              </h2>
              <span
                className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                style={{
                  backgroundColor: "var(--surface-elevated)",
                  color: "var(--text-secondary)",
                }}
              >
                Desligado
              </span>
            </div>
            <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>
              Veja a tela do PC ao vivo com zoom, modo paisagem e controle direto sem sair da aba.
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              triggerHaptic(8);
              setActive(true);
            }}
            className="touch-btn shrink-0 rounded-2xl px-3.5 py-2 text-xs font-semibold"
            style={{
              backgroundColor: "var(--accent)",
              color: "var(--accent-contrast)",
            }}
          >
            Ver tela
          </button>
        </div>
      </section>
    );
  }

  const fullscreenModal =
    expanded && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Espelho da tela em tela cheia"
            className="fixed inset-0 z-50 h-dvh w-dvw overflow-hidden bg-black text-white"
          >
            <div
              data-testid="screen-mirror-modal-frame"
              style={
                rotated90
                  ? {
                      position: "fixed",
                      top: "50%",
                      left: "50%",
                      width: "100dvh",
                      height: "100dvw",
                      transform: "translate(-50%, -50%) rotate(90deg)",
                      transformOrigin: "center center",
                    }
                  : { position: "relative", width: "100%", height: "100%" }
              }
            >
              {/* Full-bleed live screen */}
              <div className="absolute inset-0">{renderViewport(true)}</div>

              {hudHidden ? (
                <button
                  type="button"
                  onClick={() => setHudHidden(false)}
                  aria-label="Mostrar controles do espelho"
                  className="absolute right-3 top-3 z-20 rounded-full border border-white/25 bg-black/75 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur-md"
                >
                  Controles
                </button>
              ) : (
                <>
                  {/* Floating Top Bar */}
                  <div className="absolute inset-x-0 top-0 z-20 flex flex-wrap items-center justify-between gap-2 bg-black/75 px-3 py-2 backdrop-blur-md">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <div className="inline-flex rounded-xl border border-white/20 bg-white/10 p-0.5">
                        {PRESET_ORDER.map((key) => {
                          const selected = preset === key;
                          return (
                            <button
                              key={key}
                              type="button"
                              onClick={() => handlePresetChange(key)}
                              className={`rounded-lg px-2 py-1 text-[11px] font-semibold ${
                                selected ? "bg-sky-600 text-white" : "text-white/75"
                              }`}
                            >
                              {QUALITY_PRESETS[key].label}
                            </button>
                          );
                        })}
                      </div>

                      {renderZoomControls(true)}

                      {monitors.length > 1
                        ? monitors.map((mon) => (
                            <button
                              key={mon.id}
                              type="button"
                              onClick={() => handleMonitorChange(mon.id)}
                              className={`rounded-lg px-2 py-1 text-xs font-semibold ${
                                activeMonitor === mon.id
                                  ? "bg-sky-600 text-white"
                                  : "bg-white/15 text-white/85"
                              }`}
                            >
                              T{mon.id}
                            </button>
                          ))
                        : null}
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={toggleRotate90}
                        aria-pressed={rotated90}
                        aria-label="Girar tela deitada"
                        className={`inline-flex items-center gap-1 rounded-xl px-2.5 py-1.5 text-xs font-semibold ${
                          rotated90 ? "bg-sky-600 text-white" : "bg-white/15 text-white"
                        }`}
                      >
                        <RotateIcon className="h-3.5 w-3.5" />
                        <span>Girar</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setFsPanel("none");
                          setHudHidden(true);
                        }}
                        aria-label="Ocultar controles"
                        className="rounded-xl bg-white/15 px-2.5 py-1.5 text-xs font-semibold text-white"
                      >
                        Ocultar
                      </button>

                      <button
                        type="button"
                        onClick={exitFullscreenModal}
                        aria-label="Fechar tela cheia"
                        className="inline-flex items-center gap-1 rounded-xl bg-red-600/85 px-2.5 py-1.5 text-xs font-semibold text-white"
                      >
                        <CloseIcon className="h-3.5 w-3.5" />
                        <span>Fechar</span>
                      </button>
                    </div>
                  </div>

                  {/* Floating Popups (Keyboard / Shortcuts) above Bottom Bar */}
                  {fsPanel !== "none" && remoteInputEnabled ? (
                    <div className="absolute inset-x-3 bottom-14 z-20 rounded-2xl border border-white/20 bg-black/90 p-2.5 backdrop-blur-md">
                      {fsPanel === "keyboard" ? (
                        <div className="flex flex-col gap-2">
                          <form onSubmit={handleFsTextSubmit} className="flex gap-1.5">
                            <input
                              type="text"
                              value={fsText}
                              onChange={(e) => setFsText(e.target.value)}
                              placeholder="Digitar texto no PC…"
                              aria-label="Texto rápido no espelho"
                              className="min-h-[38px] min-w-0 flex-1 rounded-xl border border-white/25 bg-white/10 px-3 text-xs text-white placeholder:text-white/50"
                            />
                            <button
                              type="submit"
                              disabled={!fsText}
                              className="rounded-xl bg-sky-600 px-3 text-xs font-semibold text-white disabled:opacity-40"
                            >
                              Enviar
                            </button>
                            <button
                              type="button"
                              onClick={() => onSendInput({ action: "key_press", key: "backspace" })}
                              aria-label="Apagar no PC"
                              className="rounded-xl bg-white/15 px-2.5 text-xs font-semibold text-white"
                            >
                              <BackspaceIcon className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onSendInput({ action: "key_press", key: "enter" })}
                              aria-label="Enter no PC"
                              className="rounded-xl bg-sky-600 px-2.5 text-xs font-semibold text-white"
                            >
                              <EnterKeyIcon className="h-4 w-4" />
                            </button>
                          </form>
                          <div className="flex flex-wrap gap-1.5">
                            <button
                              type="button"
                              onClick={() => onSendInput({ action: "key_press", key: "escape" })}
                              className="rounded-xl bg-white/15 px-2.5 py-1 text-xs font-semibold text-white"
                            >
                              Esc
                            </button>
                            <button
                              type="button"
                              onClick={() => onSendInput({ action: "key_press", key: "tab" })}
                              className="rounded-xl bg-white/15 px-2.5 py-1 text-xs font-semibold text-white"
                            >
                              Tab
                            </button>
                            <button
                              type="button"
                              onClick={() => onSendInput({ action: "key_press", key: "space" })}
                              className="rounded-xl bg-white/15 px-2.5 py-1 text-xs font-semibold text-white"
                            >
                              Espaço
                            </button>
                            <button
                              type="button"
                              onClick={() => onSendInput({ action: "key_press", key: "f" })}
                              className="rounded-xl bg-white/15 px-2.5 py-1 text-xs font-semibold text-white"
                            >
                              Tela (F)
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              onSendInput({ action: "key_press", key: "tab", modifiers: ["alt"] })
                            }
                            className="rounded-xl bg-white/15 px-2.5 py-1.5 text-xs font-semibold text-white"
                          >
                            Alt+Tab
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              onSendInput({ action: "key_press", key: "d", modifiers: ["win"] })
                            }
                            className="rounded-xl bg-white/15 px-2.5 py-1.5 text-xs font-semibold text-white"
                          >
                            Win+D
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              onSendInput({ action: "key_press", key: "p", modifiers: ["win"] })
                            }
                            className="rounded-xl bg-white/15 px-2.5 py-1.5 text-xs font-semibold text-white"
                          >
                            Projetar (TV)
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              onSendInput({ action: "system_action", systemAction: "open_devices" })
                            }
                            className="rounded-xl bg-white/15 px-2.5 py-1.5 text-xs font-semibold text-white"
                          >
                            Dispositivos
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              onSendInput({ action: "key_press", key: "c", modifiers: ["ctrl"] })
                            }
                            className="rounded-xl bg-white/15 px-2.5 py-1.5 text-xs font-semibold text-white"
                          >
                            Copiar
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              onSendInput({ action: "key_press", key: "v", modifiers: ["ctrl"] })
                            }
                            className="rounded-xl bg-white/15 px-2.5 py-1.5 text-xs font-semibold text-white"
                          >
                            Colar
                          </button>
                          <button
                            type="button"
                            onClick={triggerLockPcInMirror}
                            className={`rounded-xl px-2.5 py-1.5 text-xs font-semibold ${
                              fsLockConfirm ? "bg-red-600 text-white" : "bg-white/15 text-red-300"
                            }`}
                          >
                            {fsLockConfirm ? "Confirmar Bloqueio?" : "Bloquear PC"}
                          </button>
                        </div>
                      )}
                    </div>
                  ) : null}

                  {/* Floating Bottom Action Dock */}
                  <div className="absolute inset-x-0 bottom-0 z-20 flex flex-wrap items-center justify-between gap-1.5 bg-black/75 px-3 py-2 backdrop-blur-md">
                    <div className="inline-flex rounded-xl border border-white/20 bg-white/10 p-0.5">
                      <button
                        type="button"
                        onClick={() => setInteractionMode("touch")}
                        className={`rounded-lg px-2 py-1 text-xs font-semibold ${
                          interactionMode === "touch" ? "bg-sky-600 text-white" : "text-white/75"
                        }`}
                      >
                        Toque
                      </button>
                      <button
                        type="button"
                        onClick={() => setInteractionMode("cursor")}
                        className={`rounded-lg px-2 py-1 text-xs font-semibold ${
                          interactionMode === "cursor" ? "bg-sky-600 text-white" : "text-white/75"
                        }`}
                      >
                        Cursor
                      </button>
                      <button
                        type="button"
                        onClick={() => setInteractionMode("view")}
                        className={`rounded-lg px-2 py-1 text-xs font-semibold ${
                          interactionMode === "view" ? "bg-sky-600 text-white" : "text-white/75"
                        }`}
                      >
                        Só ver
                      </button>
                    </div>

                    {remoteInputEnabled ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onSendInput({ action: "mouse_click", button: "right" })}
                          className="rounded-xl bg-white/15 px-2.5 py-1.5 text-xs font-semibold text-white"
                        >
                          Dir.
                        </button>
                        <button
                          type="button"
                          onClick={toggleDragLock}
                          className={`rounded-xl px-2.5 py-1.5 text-xs font-semibold ${
                            dragLocked ? "bg-sky-500 text-white" : "bg-white/15 text-white"
                          }`}
                        >
                          {dragLocked ? "Soltar" : "Arrastar"}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setFsPanel((p) => (p === "keyboard" ? "none" : "keyboard"))
                          }
                          className={`rounded-xl px-2.5 py-1.5 text-xs font-semibold ${
                            fsPanel === "keyboard" ? "bg-sky-600 text-white" : "bg-white/15 text-white"
                          }`}
                        >
                          Teclado
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setFsPanel((p) => (p === "shortcuts" ? "none" : "shortcuts"))
                          }
                          aria-label="Atalhos no espelho"
                          className={`inline-flex items-center gap-1 rounded-xl px-2.5 py-1.5 text-xs font-semibold ${
                            fsPanel === "shortcuts" ? "bg-sky-600 text-white" : "bg-white/15 text-white"
                          }`}
                        >
                          <ShortcutsIcon className="h-3.5 w-3.5" />
                          <span>Atalhos</span>
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onSetRemoteInputEnabled(true)}
                        className="rounded-xl bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white"
                      >
                        Ativar Mouse
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <section className="card-surface p-3.5 min-[360px]:p-4">
        {/* Header bar */}
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
              style={{
                backgroundColor:
                  status === "error"
                    ? "var(--danger-soft)"
                    : status === "streaming"
                      ? "var(--ok-soft)"
                      : "var(--surface-elevated)",
                color:
                  status === "error"
                    ? "var(--danger)"
                    : status === "streaming"
                      ? "var(--ok)"
                      : "var(--text-secondary)",
              }}
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{
                  backgroundColor:
                    status === "error"
                      ? "var(--danger)"
                      : status === "streaming"
                        ? "var(--ok)"
                        : "var(--text-secondary)",
                }}
                aria-hidden="true"
              />
              <span>
                {status === "streaming"
                  ? `Ao vivo · ${QUALITY_PRESETS[preset].fps} fps`
                  : status === "paused"
                    ? "Pausado"
                    : status === "error"
                      ? "Erro"
                      : "Conectando…"}
              </span>
            </span>

            {/* Quality selector */}
            <div
              className="inline-flex rounded-xl border p-0.5"
              role="group"
              aria-label="Qualidade do espelho"
              style={{
                backgroundColor: "var(--surface-elevated)",
                borderColor: "var(--hairline)",
              }}
            >
              {PRESET_ORDER.map((key) => {
                const selected = preset === key;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => handlePresetChange(key)}
                    className="rounded-lg px-2 py-1 text-xs font-semibold whitespace-nowrap"
                    style={{
                      backgroundColor: selected ? "var(--surface)" : "transparent",
                      color: selected ? "var(--accent-text)" : "var(--text-secondary)",
                      boxShadow: selected ? "var(--shadow-pill)" : "none",
                    }}
                  >
                    {QUALITY_PRESETS[key].label}
                  </button>
                );
              })}
            </div>

            {renderZoomControls(false)}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                triggerHaptic(8);
                setExpanded(true);
              }}
              aria-label="Expandir espelho da tela"
              className="touch-btn inline-flex items-center gap-1 rounded-xl px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap"
              style={{
                backgroundColor: "var(--surface-elevated)",
                border: "1px solid var(--hairline)",
                color: "var(--text)",
              }}
            >
              <ExpandIcon className="h-3.5 w-3.5" />
              <span>Expandir</span>
            </button>

            <button
              type="button"
              onClick={stopMirror}
              className="touch-btn rounded-xl px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap"
              style={{
                backgroundColor: "var(--surface-elevated)",
                border: "1px solid var(--hairline)",
                color: "var(--danger)",
              }}
            >
              Parar
            </button>
          </div>
        </div>

        {/* Monitor selector (only if multi-monitor) */}
        {monitors.length > 1 ? (
          <div className="mb-2.5 flex flex-wrap gap-1.5" role="group" aria-label="Selecionar monitor">
            {monitors.map((mon) => {
              const selected = activeMonitor === mon.id;
              return (
                <button
                  key={mon.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => handleMonitorChange(mon.id)}
                  className="rounded-xl px-2.5 py-1 text-xs font-semibold"
                  style={{
                    backgroundColor: selected ? "var(--accent-soft)" : "var(--surface-elevated)",
                    border: "1px solid var(--hairline)",
                    color: selected ? "var(--accent-text)" : "var(--text-secondary)",
                  }}
                >
                  {mon.name}
                </button>
              );
            })}
          </div>
        ) : null}

        {/* Viewport stage (rendered inline when not expanded in fullscreen modal) */}
        {!expanded ? renderViewport(false) : null}

        {/* Interaction bar */}
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
          <div
            className="inline-flex rounded-xl border p-0.5"
            role="radiogroup"
            aria-label="Modo de interação no espelho"
            style={{
              backgroundColor: "var(--surface-elevated)",
              borderColor: "var(--hairline)",
            }}
          >
            <button
              type="button"
              role="radio"
              aria-checked={interactionMode === "touch"}
              onClick={() => setInteractionMode("touch")}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold whitespace-nowrap"
              style={{
                backgroundColor: interactionMode === "touch" ? "var(--surface)" : "transparent",
                color: interactionMode === "touch" ? "var(--accent-text)" : "var(--text-secondary)",
                boxShadow: interactionMode === "touch" ? "var(--shadow-pill)" : "none",
              }}
            >
              <HandTapIcon className="h-3.5 w-3.5" />
              <span>Toque</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={interactionMode === "cursor"}
              onClick={() => setInteractionMode("cursor")}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold whitespace-nowrap"
              style={{
                backgroundColor: interactionMode === "cursor" ? "var(--surface)" : "transparent",
                color: interactionMode === "cursor" ? "var(--accent-text)" : "var(--text-secondary)",
                boxShadow: interactionMode === "cursor" ? "var(--shadow-pill)" : "none",
              }}
            >
              <CursorIcon className="h-3.5 w-3.5" />
              <span>Cursor</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={interactionMode === "view"}
              onClick={() => setInteractionMode("view")}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold whitespace-nowrap"
              style={{
                backgroundColor: interactionMode === "view" ? "var(--surface)" : "transparent",
                color: interactionMode === "view" ? "var(--accent-text)" : "var(--text-secondary)",
                boxShadow: interactionMode === "view" ? "var(--shadow-pill)" : "none",
              }}
            >
              <EyeIcon className="h-3.5 w-3.5" />
              <span>Só ver</span>
            </button>
          </div>

          <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
            {interactionMode === "cursor"
              ? "Arraste = cursor preciso · 2 dedos = dir./zoom"
              : interactionMode === "view"
                ? zoom > 1
                  ? "Arraste para mover a imagem ampliada"
                  : "Pinça com 2 dedos ou + para dar zoom"
                : "Toque = clique · Segurar = botão direito"}
          </span>
        </div>

        {/* Prompt to enable mouse/keyboard if touching/cursor is active while security lock is off */}
        {interactionMode !== "view" && !remoteInputEnabled ? (
          <div
            className="mt-2.5 flex items-center justify-between gap-2 rounded-2xl border px-3 py-2 text-xs"
            style={{
              backgroundColor: "var(--surface-elevated)",
              borderColor: "var(--hairline)",
              color: "var(--text-secondary)",
            }}
          >
            <span>Ative Mouse e Teclado para controlar pela tela.</span>
            <button
              type="button"
              onClick={() => onSetRemoteInputEnabled(true)}
              className="shrink-0 rounded-xl px-2.5 py-1 text-xs font-semibold"
              style={{
                backgroundColor: "var(--accent)",
                color: "var(--accent-contrast)",
              }}
            >
              Ativar
            </button>
          </div>
        ) : null}
      </section>

      {fullscreenModal}
    </>
  );
}
