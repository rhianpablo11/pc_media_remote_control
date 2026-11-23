import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent,
  type TouchEvent,
} from "react";
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
  EnterKeyIcon,
  ExpandIcon,
  EyeIcon,
  HandTapIcon,
  MonitorIcon,
} from "./Icons";

interface ScreenMirrorCardProps {
  remoteInputEnabled: boolean;
  available?: boolean;
  onSendInput: (payload: InputMessagePayload, opts?: { expectAck?: boolean }) => boolean;
  onSetRemoteInputEnabled: (enabled: boolean) => boolean;
}

type StreamStatus = "idle" | "connecting" | "streaming" | "paused" | "error";

const QUALITY_PRESETS: Record<
  ScreenQualityPreset,
  { label: string; fps: number; maxWidth: number; quality: number }
> = {
  eco: { label: "Eco", fps: 5, maxWidth: 640, quality: 45 },
  normal: { label: "Normal", fps: 10, maxWidth: 960, quality: 60 },
  fluid: { label: "Fluido", fps: 15, maxWidth: 1120, quality: 70 },
};

const PRESET_ORDER: ScreenQualityPreset[] = ["eco", "normal", "fluid"];

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
  const [interactionMode, setInteractionMode] = useState<"touch" | "view">("touch");
  const [expanded, setExpanded] = useState(false);
  const [dragLocked, setDragLocked] = useState(false);
  const [fsText, setFsText] = useState("");
  const [tapIndicator, setTapIndicator] = useState<{
    xPct: number;
    yPct: number;
    key: number;
  } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const inlineImgRef = useRef<HTMLImageElement | null>(null);
  const modalImgRef = useRef<HTMLImageElement | null>(null);
  const naturalSizeRef = useRef<{ width: number; height: number }>({ width: 16, height: 9 });
  const dragLockedRef = useRef(false);
  const activeMonitorRef = useRef(activeMonitor);
  activeMonitorRef.current = activeMonitor;
  const presetRef = useRef(preset);
  presetRef.current = preset;

  const pendingMoveRef = useRef<{ x: number; y: number } | null>(null);
  const pendingScrollDyRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const tapTimerRef = useRef<number | null>(null);
  const touchActiveRef = useRef(false);
  const gestureRef = useRef({
    active: false,
    maxFingers: 0,
    startX: 0,
    startY: 0,
    twoCenterY: 0,
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
    if (rafIdRef.current !== null) {
      window.cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

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

  const stopMirror = useCallback(() => {
    setActive(false);
    setExpanded(false);
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
  }, [clearTimersAndRaf, onSendInput, revokeFrameUrl]);

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
          const parsed = JSON.parse(event.data) as ScreenMetaMessage | { type: string; message?: string };
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
      if (dragLockedRef.current) {
        dragLockedRef.current = false;
        onSendInput({ action: "mouse_up", button: "left" });
      }
    };
  }, [onSendInput]);

  const flushMirrorMotion = useCallback(() => {
    rafIdRef.current = null;
    const moveTarget = pendingMoveRef.current;
    if (moveTarget) {
      pendingMoveRef.current = null;
      onSendInput(
        {
          action: "mouse_move_abs",
          x: moveTarget.x,
          y: moveTarget.y,
          monitor: activeMonitorRef.current,
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

  const mapPointer = (clientX: number, clientY: number) => {
    const imgEl = expanded ? modalImgRef.current : inlineImgRef.current;
    if (!imgEl) return null;
    const rect = imgEl.getBoundingClientRect();
    const natW = imgEl.naturalWidth || naturalSizeRef.current.width || 16;
    const natH = imgEl.naturalHeight || naturalSizeRef.current.height || 9;
    return {
      norm: mapClientPointToNormalized(clientX, clientY, rect, natW, natH),
      rect,
    };
  };

  const showTapDot = (clientX: number, clientY: number, rect: DOMRect) => {
    if (rect.width <= 0 || rect.height <= 0) return;
    const xPct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
    const yPct = Math.max(0, Math.min(100, ((clientY - rect.top) / rect.height) * 100));
    const key = Date.now() + Math.random();
    setTapIndicator({ xPct, yPct, key });
    if (tapTimerRef.current !== null) {
      window.clearTimeout(tapTimerRef.current);
    }
    tapTimerRef.current = window.setTimeout(() => {
      setTapIndicator(null);
      tapTimerRef.current = null;
    }, 380);
  };

  const cancelLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handleStageStart = (clientX: number, clientY: number, touchesCount: number, twoCenterY?: number) => {
    if (interactionMode !== "touch" || !remoteInputEnabled) return;
    const g = gestureRef.current;
    g.maxFingers = Math.max(g.active ? g.maxFingers : 0, touchesCount);

    if (!g.active) {
      g.active = true;
      g.startX = clientX;
      g.startY = clientY;
      g.travelPx = 0;
      g.startedAt = Date.now();
      g.longPressFired = false;
    }

    if (touchesCount >= 2 && twoCenterY !== undefined) {
      cancelLongPress();
      g.twoCenterY = twoCenterY;
      return;
    }

    if (touchesCount === 1) {
      cancelLongPress();
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null;
        if (!gestureRef.current.active || gestureRef.current.maxFingers > 1) return;
        if (gestureRef.current.travelPx < 10) {
          const mapped = mapPointer(clientX, clientY);
          if (mapped?.norm) {
            gestureRef.current.longPressFired = true;
            triggerHaptic(14);
            showTapDot(clientX, clientY, mapped.rect);
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

  const handleStageEnd = (clientX: number, clientY: number) => {
    const g = gestureRef.current;
    if (!g.active) return;
    cancelLongPress();
    if (rafIdRef.current !== null) {
      window.cancelAnimationFrame(rafIdRef.current);
    }
    flushMirrorMotion();

    const elapsed = Date.now() - g.startedAt;
    if (
      !g.longPressFired &&
      g.maxFingers === 1 &&
      g.travelPx < 10 &&
      elapsed < 280 &&
      interactionMode === "touch" &&
      remoteInputEnabled
    ) {
      const mapped = mapPointer(clientX, clientY);
      if (mapped?.norm) {
        const now = Date.now();
        const isDouble = g.lastTapAt > 0 && now - g.lastTapAt < 280;
        g.lastTapAt = isDouble ? 0 : now;
        triggerHaptic(8);
        showTapDot(clientX, clientY, mapped.rect);
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

    g.active = false;
    g.maxFingers = 0;
    g.longPressFired = false;
  };

  const onTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    if (interactionMode !== "touch" || !remoteInputEnabled || e.touches.length === 0) return;
    touchActiveRef.current = true;
    const t0 = e.touches[0];
    const twoCy =
      e.touches.length >= 2 ? (e.touches[0].clientY + e.touches[1].clientY) / 2 : undefined;
    handleStageStart(t0.clientX, t0.clientY, e.touches.length, twoCy);
  };

  const onTouchMove = (e: TouchEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g.active || interactionMode !== "touch" || !remoteInputEnabled) return;

    if (e.touches.length >= 2) {
      cancelLongPress();
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const dy = cy - g.twoCenterY;
      g.twoCenterY = cy;
      g.travelPx += Math.abs(dy);
      pendingScrollDyRef.current += dy * 5;
      scheduleMirrorFlush();
      return;
    }

    if (e.touches.length === 1 && g.maxFingers === 1) {
      const t = e.touches[0];
      g.travelPx = Math.max(g.travelPx, Math.hypot(t.clientX - g.startX, t.clientY - g.startY));
      if (g.travelPx > 8) {
        cancelLongPress();
        const mapped = mapPointer(t.clientX, t.clientY);
        if (mapped?.norm) {
          pendingMoveRef.current = mapped.norm;
          scheduleMirrorFlush();
        }
      }
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
    if (
      e.pointerType === "touch" ||
      touchActiveRef.current ||
      interactionMode !== "touch" ||
      !remoteInputEnabled
    ) {
      return;
    }
    handleStageStart(e.clientX, e.clientY, 1);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (
      !g.active ||
      e.pointerType === "touch" ||
      touchActiveRef.current ||
      interactionMode !== "touch" ||
      !remoteInputEnabled
    ) {
      return;
    }
    g.travelPx = Math.max(g.travelPx, Math.hypot(e.clientX - g.startX, e.clientY - g.startY));
    if (g.travelPx > 8) {
      cancelLongPress();
      const mapped = mapPointer(e.clientX, e.clientY);
      if (mapped?.norm) {
        pendingMoveRef.current = mapped.norm;
        scheduleMirrorFlush();
      }
    }
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
    sendStreamConfig({ monitor: monitorId, paused: false });
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

  if (!available) {
    return null;
  }

  const renderViewport = (isModal: boolean) => {
    const touchInteractive = interactionMode === "touch" && remoteInputEnabled;
    return (
      <div
        data-testid={isModal ? "screen-mirror-modal-stage" : "screen-mirror-stage"}
        className={`relative overflow-hidden bg-black ${touchInteractive ? "touch-none select-none cursor-crosshair" : ""} ${
          isModal ? "h-full w-full flex items-center justify-center" : "aspect-video w-full rounded-[16px]"
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
              Veja a tela do PC em tempo real e toque direto para clicar, sem interromper o touchpad separado.
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
              className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-semibold whitespace-nowrap"
              style={{
                backgroundColor: interactionMode === "touch" ? "var(--surface)" : "transparent",
                color: interactionMode === "touch" ? "var(--accent-text)" : "var(--text-secondary)",
                boxShadow: interactionMode === "touch" ? "var(--shadow-pill)" : "none",
              }}
            >
              <HandTapIcon className="h-3.5 w-3.5" />
              <span>Toque na tela</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={interactionMode === "view"}
              onClick={() => setInteractionMode("view")}
              className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-semibold whitespace-nowrap"
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
            Toque = clique · Segurar = botão direito
          </span>
        </div>

        {/* Prompt to enable mouse/keyboard if touching is active while security lock is off */}
        {interactionMode === "touch" && !remoteInputEnabled ? (
          <div
            className="mt-2.5 flex items-center justify-between gap-2 rounded-2xl border px-3 py-2 text-xs"
            style={{
              backgroundColor: "var(--surface-elevated)",
              borderColor: "var(--hairline)",
              color: "var(--text-secondary)",
            }}
          >
            <span>Ative Mouse e Teclado para tocar direto na tela.</span>
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

      {/* Fullscreen expanded modal */}
      {expanded ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Espelho da tela em tela cheia"
          className="fixed inset-0 z-50 flex flex-col bg-black text-white"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/15 bg-black/90 px-3 py-2">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold text-emerald-400">
                {QUALITY_PRESETS[preset].label} · {QUALITY_PRESETS[preset].fps} fps
              </span>
              {monitors.length > 1
                ? monitors.map((mon) => (
                    <button
                      key={mon.id}
                      type="button"
                      onClick={() => handleMonitorChange(mon.id)}
                      className={`rounded-lg px-2 py-1 text-xs font-semibold ${
                        activeMonitor === mon.id ? "bg-sky-600 text-white" : "bg-white/10 text-white/80"
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
                onClick={() => setInteractionMode((m) => (m === "touch" ? "view" : "touch"))}
                className="rounded-xl bg-white/15 px-2.5 py-1 text-xs font-semibold text-white"
              >
                {interactionMode === "touch" ? "Modo: Toque" : "Modo: Só ver"}
              </button>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                aria-label="Fechar tela cheia"
                className="inline-flex items-center gap-1 rounded-xl bg-white/15 px-2.5 py-1 text-xs font-semibold text-white"
              >
                <CloseIcon className="h-3.5 w-3.5" />
                <span>Fechar</span>
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1">{renderViewport(true)}</div>

          {remoteInputEnabled ? (
            <div className="flex flex-col gap-2 border-t border-white/15 bg-black/90 px-3 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onSendInput({ action: "mouse_click", button: "right" })}
                  className="rounded-xl bg-white/15 px-2.5 py-1.5 text-xs font-semibold text-white"
                >
                  Clique Dir.
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
                  onClick={() => onSendInput({ action: "key_press", key: "escape" })}
                  className="rounded-xl bg-white/15 px-2.5 py-1.5 text-xs font-semibold text-white"
                >
                  Esc
                </button>
                <button
                  type="button"
                  onClick={() => onSendInput({ action: "key_press", key: "backspace" })}
                  aria-label="Apagar no PC"
                  className="rounded-xl bg-white/15 px-2.5 py-1.5 text-xs font-semibold text-white"
                >
                  <BackspaceIcon className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onSendInput({ action: "key_press", key: "enter" })}
                  aria-label="Enter no PC"
                  className="rounded-xl bg-sky-600 px-2.5 py-1.5 text-xs font-semibold text-white"
                >
                  <EnterKeyIcon className="h-4 w-4" />
                </button>
              </div>

              <form onSubmit={handleFsTextSubmit} className="flex gap-1.5">
                <input
                  type="text"
                  value={fsText}
                  onChange={(e) => setFsText(e.target.value)}
                  placeholder="Digitar texto rápido…"
                  aria-label="Texto rápido no espelho"
                  className="min-h-[38px] min-w-0 flex-1 rounded-xl border border-white/20 bg-white/10 px-3 text-xs text-white placeholder:text-white/50"
                />
                <button
                  type="submit"
                  disabled={!fsText}
                  className="rounded-xl bg-sky-600 px-3 text-xs font-semibold text-white disabled:opacity-40"
                >
                  Enviar
                </button>
              </form>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 border-t border-white/15 bg-black/90 px-3 py-2 text-xs text-white/80">
              <span>Mouse e teclado desativados.</span>
              <button
                type="button"
                onClick={() => onSetRemoteInputEnabled(true)}
                className="rounded-xl bg-sky-600 px-3 py-1 font-semibold text-white"
              >
                Ativar
              </button>
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}
