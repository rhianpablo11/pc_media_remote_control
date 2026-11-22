import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type TouchEvent,
} from "react";
import type { InputMessagePayload, ModifierKey } from "../types";
import { triggerHaptic } from "../utils";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  BackspaceIcon,
  EnterKeyIcon,
  KeyboardIcon,
  LockIcon,
} from "./Icons";

interface RemoteInputViewProps {
  remoteInputEnabled: boolean;
  onSendInput: (payload: InputMessagePayload, opts?: { expectAck?: boolean }) => boolean;
  onSetRemoteInputEnabled: (enabled: boolean) => boolean;
  onOpenSettings?: () => void;
}

type SensitivityOption = 0.9 | 1.5 | 2.2;
type KeyboardMode = "batch" | "live";

const SENSITIVITY_KEY = "pc_media_touchpad_sensitivity";
const PAD_HEIGHT_KEY = "pc_media_touchpad_height";
const MIN_PAD_HEIGHT = 180;
const MAX_PAD_HEIGHT = 640;
const DEFAULT_PAD_HEIGHT = 320;

const SENSITIVITY_OPTIONS: { value: SensitivityOption; label: string }[] = [
  { value: 0.9, label: "0.9x" },
  { value: 1.5, label: "1.5x" },
  { value: 2.2, label: "2.2x" },
];
const PAD_SIZE_PRESETS: { height: number; label: string }[] = [
  { height: 220, label: "P" },
  { height: 320, label: "M" },
  { height: 440, label: "G" },
  { height: 560, label: "Max" },
];

function clampPadHeight(val: number): number {
  return Math.max(MIN_PAD_HEIGHT, Math.min(MAX_PAD_HEIGHT, Math.round(val)));
}

function loadPadHeight(): number {
  try {
    const raw = localStorage.getItem(PAD_HEIGHT_KEY);
    if (raw !== null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        return clampPadHeight(parsed);
      }
    }
  } catch {
    // Ignore storage unavailability
  }
  return DEFAULT_PAD_HEIGHT;
}

function loadSensitivity(): SensitivityOption {
  try {
    const raw = Number(localStorage.getItem(SENSITIVITY_KEY));
    if (raw === 0.9 || raw === 1.5 || raw === 2.2) return raw;
  } catch {
    // Ignore storage unavailability
  }
  return 1.5;
}

function clampDelta(val: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, val));
}

export function RemoteInputView({
  remoteInputEnabled,
  onSendInput,
  onSetRemoteInputEnabled,
  onOpenSettings,
}: RemoteInputViewProps) {
  const [sensitivity, setSensitivity] = useState<SensitivityOption>(() => loadSensitivity());
  const [padHeight, setPadHeight] = useState<number>(() => loadPadHeight());
  const [dragLocked, setDragLocked] = useState(false);
  const [keyboardMode, setKeyboardMode] = useState<KeyboardMode>("batch");
  const [batchText, setBatchText] = useState("");
  const [liveText, setLiveText] = useState("");

  const dragLockedRef = useRef(false);
  const padHeightRef = useRef(padHeight);
  padHeightRef.current = padHeight;
  const resizeDragRef = useRef({ active: false, startY: 0, startHeight: DEFAULT_PAD_HEIGHT });
  const pendingMoveRef = useRef({ dx: 0, dy: 0 });
  const pendingScrollRef = useRef({ dx: 0, dy: 0 });
  const rafIdRef = useRef<number | null>(null);

  const touchActiveRef = useRef(false);
  const padGestureRef = useRef({
    active: false,
    fingerCount: 0,
    maxFingers: 0,
    lastX: 0,
    lastY: 0,
    twoCenterX: 0,
    twoCenterY: 0,
    travelPx: 0,
    startedAt: 0,
    lastTapAt: 0,
    ignoreSingleMoveAfterMulti: false,
  });
  const scrollStripRef = useRef({ active: false, lastY: 0 });
  const livePrevRef = useRef("");
  const liveComposingRef = useRef(false);

  const flushMotion = useCallback(() => {
    rafIdRef.current = null;
    const moveDx = Math.trunc(pendingMoveRef.current.dx);
    const moveDy = Math.trunc(pendingMoveRef.current.dy);
    if (moveDx !== 0 || moveDy !== 0) {
      pendingMoveRef.current.dx -= moveDx;
      pendingMoveRef.current.dy -= moveDy;
      onSendInput(
        {
          action: "mouse_move",
          dx: clampDelta(moveDx, 500),
          dy: clampDelta(moveDy, 500),
        },
        { expectAck: false },
      );
    }

    const scrollDx = Math.trunc(pendingScrollRef.current.dx);
    const scrollDy = Math.trunc(pendingScrollRef.current.dy);
    if (scrollDx !== 0 || scrollDy !== 0) {
      pendingScrollRef.current.dx -= scrollDx;
      pendingScrollRef.current.dy -= scrollDy;
      onSendInput(
        {
          action: "mouse_scroll",
          dx: clampDelta(scrollDx, 1200),
          dy: clampDelta(scrollDy, 1200),
        },
        { expectAck: false },
      );
    }
  }, [onSendInput]);

  const scheduleMotionFlush = useCallback(() => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = window.requestAnimationFrame(flushMotion);
  }, [flushMotion]);

  const handleSensitivityChange = (next: SensitivityOption) => {
    setSensitivity(next);
    try {
      localStorage.setItem(SENSITIVITY_KEY, String(next));
    } catch {
      // Ignore storage error
    }
  };

  const persistPadHeight = (nextHeight: number) => {
    const clamped = clampPadHeight(nextHeight);
    try {
      localStorage.setItem(PAD_HEIGHT_KEY, String(clamped));
    } catch {
      // Ignore storage error
    }
    return clamped;
  };

  const handleSizePreset = (nextHeight: number) => {
    triggerHaptic(6);
    const clamped = persistPadHeight(nextHeight);
    setPadHeight(clamped);
  };

  const onResizeTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 0) return;
    touchActiveRef.current = true;
    resizeDragRef.current = {
      active: true,
      startY: e.touches[0].clientY,
      startHeight: padHeightRef.current,
    };
  };

  const onResizeTouchMove = (e: TouchEvent<HTMLDivElement>) => {
    if (!resizeDragRef.current.active || e.touches.length === 0) return;
    const next = clampPadHeight(
      resizeDragRef.current.startHeight + (e.touches[0].clientY - resizeDragRef.current.startY),
    );
    setPadHeight(next);
  };

  const onResizeTouchEnd = (e: TouchEvent<HTMLDivElement>) => {
    if (!resizeDragRef.current.active || e.touches.length > 0) return;
    resizeDragRef.current.active = false;
    persistPadHeight(padHeightRef.current);
    window.setTimeout(() => {
      touchActiveRef.current = false;
    }, 60);
  };

  const onResizePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch" || touchActiveRef.current) return;
    resizeDragRef.current = {
      active: true,
      startY: e.clientY,
      startHeight: padHeightRef.current,
    };
  };

  const onResizePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!resizeDragRef.current.active || e.pointerType === "touch" || touchActiveRef.current) return;
    const next = clampPadHeight(
      resizeDragRef.current.startHeight + (e.clientY - resizeDragRef.current.startY),
    );
    setPadHeight(next);
  };

  const onResizePointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!resizeDragRef.current.active || e.pointerType === "touch") return;
    resizeDragRef.current.active = false;
    persistPadHeight(padHeightRef.current);
  };

  // Auto-release held left mouse button when disabled or unmounted
  useEffect(() => {
    if (!remoteInputEnabled && dragLockedRef.current) {
      dragLockedRef.current = false;
      setDragLocked(false);
      onSendInput({ action: "mouse_up", button: "left" });
    }
  }, [remoteInputEnabled, onSendInput]);

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      if (dragLockedRef.current) {
        dragLockedRef.current = false;
        onSendInput({ action: "mouse_up", button: "left" });
      }
    };
  }, [onSendInput]);

  const queuePointerMove = (rawDx: number, rawDy: number) => {
    const dist = Math.hypot(rawDx, rawDy);
    const accel = dist > 14 ? 1.35 : 1.0;
    pendingMoveRef.current.dx += rawDx * sensitivity * accel;
    pendingMoveRef.current.dy += rawDy * sensitivity * accel;
    scheduleMotionFlush();
  };

  const queuePointerScroll = (rawDx: number, rawDy: number) => {
    pendingScrollRef.current.dx += rawDx * 4;
    pendingScrollRef.current.dy += rawDy * 5;
    scheduleMotionFlush();
  };

  const emitTapClick = (button: "left" | "right") => {
    const now = Date.now();
    const g = padGestureRef.current;
    if (button === "left") {
      const isDouble = g.lastTapAt > 0 && now - g.lastTapAt < 280;
      g.lastTapAt = isDouble ? 0 : now;
      triggerHaptic(8);
      onSendInput({ action: "mouse_click", button: "left", double: isDouble });
      return;
    }
    triggerHaptic(12);
    onSendInput({ action: "mouse_click", button: "right" });
  };

  // Touch handlers for Trackpad surface
  const onPadTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    if (!remoteInputEnabled) return;
    touchActiveRef.current = true;
    const g = padGestureRef.current;
    const touches = e.touches;
    g.fingerCount = touches.length;
    g.maxFingers = Math.max(g.active ? g.maxFingers : 0, touches.length);

    if (!g.active) {
      g.active = true;
      g.travelPx = 0;
      g.startedAt = Date.now();
      g.ignoreSingleMoveAfterMulti = false;
    }

    if (touches.length === 1) {
      g.lastX = touches[0].clientX;
      g.lastY = touches[0].clientY;
    } else if (touches.length >= 2) {
      g.ignoreSingleMoveAfterMulti = true;
      g.twoCenterX = (touches[0].clientX + touches[1].clientX) / 2;
      g.twoCenterY = (touches[0].clientY + touches[1].clientY) / 2;
    }
  };

  const onPadTouchMove = (e: TouchEvent<HTMLDivElement>) => {
    const g = padGestureRef.current;
    if (!remoteInputEnabled || !g.active) return;
    const touches = e.touches;

    if (touches.length >= 2) {
      const cx = (touches[0].clientX + touches[1].clientX) / 2;
      const cy = (touches[0].clientY + touches[1].clientY) / 2;
      const dx = cx - g.twoCenterX;
      const dy = cy - g.twoCenterY;
      g.twoCenterX = cx;
      g.twoCenterY = cy;
      g.travelPx += Math.hypot(dx, dy);
      queuePointerScroll(dx, dy);
      return;
    }

    if (touches.length === 1 && !g.ignoreSingleMoveAfterMulti) {
      const dx = touches[0].clientX - g.lastX;
      const dy = touches[0].clientY - g.lastY;
      g.lastX = touches[0].clientX;
      g.lastY = touches[0].clientY;
      g.travelPx += Math.hypot(dx, dy);
      queuePointerMove(dx, dy);
    }
  };

  const onPadTouchEnd = (e: TouchEvent<HTMLDivElement>) => {
    const g = padGestureRef.current;
    if (!g.active) return;

    if (e.touches.length === 1) {
      g.lastX = e.touches[0].clientX;
      g.lastY = e.touches[0].clientY;
      g.fingerCount = 1;
      return;
    }

    if (e.touches.length === 0) {
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
      }
      flushMotion();

      const elapsed = Date.now() - g.startedAt;
      if (g.maxFingers === 2 && g.travelPx < 12 && elapsed < 260) {
        emitTapClick("right");
      } else if (g.maxFingers === 1 && g.travelPx < 8 && elapsed < 240) {
        emitTapClick("left");
      }

      g.active = false;
      g.fingerCount = 0;
      g.maxFingers = 0;
      g.ignoreSingleMoveAfterMulti = false;
      window.setTimeout(() => {
        touchActiveRef.current = false;
      }, 60);
    }
  };

  // Pointer fallback for mouse/pen or single-pointer environments
  const onPadPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!remoteInputEnabled || e.pointerType === "touch" || touchActiveRef.current) return;
    const g = padGestureRef.current;
    g.active = true;
    g.fingerCount = 1;
    g.maxFingers = 1;
    g.lastX = e.clientX;
    g.lastY = e.clientY;
    g.travelPx = 0;
    g.startedAt = Date.now();
    g.ignoreSingleMoveAfterMulti = false;
  };

  const onPadPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = padGestureRef.current;
    if (!remoteInputEnabled || !g.active || e.pointerType === "touch" || touchActiveRef.current) {
      return;
    }
    const dx = e.clientX - g.lastX;
    const dy = e.clientY - g.lastY;
    g.lastX = e.clientX;
    g.lastY = e.clientY;
    g.travelPx += Math.hypot(dx, dy);
    queuePointerMove(dx, dy);
  };

  const onPadPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const g = padGestureRef.current;
    if (!g.active || e.pointerType === "touch" || touchActiveRef.current) return;
    if (rafIdRef.current !== null) {
      window.cancelAnimationFrame(rafIdRef.current);
    }
    flushMotion();
    const elapsed = Date.now() - g.startedAt;
    if (g.travelPx < 8 && elapsed < 240) {
      emitTapClick("left");
    }
    g.active = false;
    g.fingerCount = 0;
    g.maxFingers = 0;
  };

  // Scroll strip handlers
  const onScrollTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    if (!remoteInputEnabled || e.touches.length === 0) return;
    touchActiveRef.current = true;
    scrollStripRef.current = { active: true, lastY: e.touches[0].clientY };
  };

  const onScrollTouchMove = (e: TouchEvent<HTMLDivElement>) => {
    if (!remoteInputEnabled || !scrollStripRef.current.active || e.touches.length === 0) return;
    const y = e.touches[0].clientY;
    const dy = y - scrollStripRef.current.lastY;
    scrollStripRef.current.lastY = y;
    queuePointerScroll(0, dy);
  };

  const onScrollTouchEnd = (e: TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 0) {
      scrollStripRef.current.active = false;
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
      }
      flushMotion();
      window.setTimeout(() => {
        touchActiveRef.current = false;
      }, 60);
    }
  };

  const onScrollPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!remoteInputEnabled || e.pointerType === "touch" || touchActiveRef.current) return;
    scrollStripRef.current = { active: true, lastY: e.clientY };
  };

  const onScrollPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!remoteInputEnabled || !scrollStripRef.current.active || e.pointerType === "touch") return;
    const dy = e.clientY - scrollStripRef.current.lastY;
    scrollStripRef.current.lastY = e.clientY;
    queuePointerScroll(0, dy);
  };

  const onScrollPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch" || !scrollStripRef.current.active) return;
    scrollStripRef.current.active = false;
    if (rafIdRef.current !== null) {
      window.cancelAnimationFrame(rafIdRef.current);
    }
    flushMotion();
  };

  const toggleDragHold = () => {
    triggerHaptic(10);
    const next = !dragLocked;
    dragLockedRef.current = next;
    setDragLocked(next);
    onSendInput({ action: next ? "mouse_down" : "mouse_up", button: "left" });
  };

  const sendSpecialKey = (key: string, modifiers?: ModifierKey[]) => {
    triggerHaptic(8);
    onSendInput({ action: "key_press", key, modifiers });
  };

  const handleBatchSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!batchText) return;
    triggerHaptic(8);
    if (onSendInput({ action: "key_text", text: batchText })) {
      setBatchText("");
    }
  };

  const handleBatchSendEnter = () => {
    triggerHaptic(10);
    if (batchText) {
      onSendInput({ action: "key_text", text: batchText });
      setBatchText("");
    }
    onSendInput({ action: "key_press", key: "enter" });
  };

  const applyLiveDiff = (nextVal: string) => {
    const prev = livePrevRef.current;
    if (nextVal === prev) return;
    if (nextVal.startsWith(prev)) {
      const added = nextVal.slice(prev.length);
      if (added) {
        onSendInput({ action: "key_text", text: added }, { expectAck: false });
      }
    } else if (prev.startsWith(nextVal)) {
      const removed = prev.length - nextVal.length;
      for (let i = 0; i < removed; i += 1) {
        onSendInput({ action: "key_press", key: "backspace" }, { expectAck: false });
      }
    } else {
      for (let i = 0; i < prev.length; i += 1) {
        onSendInput({ action: "key_press", key: "backspace" }, { expectAck: false });
      }
      if (nextVal) {
        onSendInput({ action: "key_text", text: nextVal }, { expectAck: false });
      }
    }
    livePrevRef.current = nextVal;
  };

  const handleLiveChange = (nextVal: string) => {
    setLiveText(nextVal);
    if (!liveComposingRef.current) {
      applyLiveDiff(nextVal);
    }
  };

  const handleLiveKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && liveText === "") {
      e.preventDefault();
      sendSpecialKey("backspace");
    } else if (e.key === "Enter") {
      e.preventDefault();
      sendSpecialKey("enter");
      setLiveText("");
      livePrevRef.current = "";
    }
  };

  if (!remoteInputEnabled) {
    return (
      <div className="flex flex-col gap-3.5">
        <section className="card-surface flex flex-col items-center p-6 text-center">
          <div
            className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border"
            style={{
              backgroundColor: "var(--surface-elevated)",
              borderColor: "var(--hairline)",
              color: "var(--text-secondary)",
            }}
          >
            <LockIcon className="h-8 w-8" />
          </div>
          <h2 className="text-lg font-semibold" style={{ color: "var(--text)" }}>
            Mouse e teclado desativados
          </h2>
          <p className="mt-1.5 max-w-[32ch] text-sm text-pretty" style={{ color: "var(--text-secondary)" }}>
            Por segurança, o controle remoto de cursor e teclado começa desligado. Ative abaixo ou
            no ícone da bandeja do Windows.
          </p>

          <div className="mt-5 flex w-full flex-col gap-2.5">
            <button
              type="button"
              onClick={() => onSetRemoteInputEnabled(true)}
              className="touch-btn w-full rounded-2xl px-4 py-3 text-sm font-semibold"
              style={{
                backgroundColor: "var(--accent)",
                color: "var(--accent-contrast)",
              }}
            >
              Ativar Mouse e Teclado
            </button>
            {onOpenSettings ? (
              <button
                type="button"
                onClick={onOpenSettings}
                className="touch-btn w-full rounded-2xl px-4 py-3 text-xs font-semibold"
                style={{
                  backgroundColor: "var(--surface-elevated)",
                  color: "var(--text)",
                  border: "1px solid var(--hairline)",
                }}
              >
                Ir para Configurações
              </button>
            ) : null}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3.5">
      {/* 1. Touchpad card */}
      <section className="card-surface p-3.5 min-[360px]:p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
              style={{
                backgroundColor: "var(--ok-soft)",
                color: "var(--ok)",
              }}
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: "var(--ok)" }}
                aria-hidden="true"
              />
              <span>Ativo</span>
            </span>

            <div
              className="inline-flex rounded-xl border p-0.5"
              role="group"
              aria-label="Sensibilidade do touchpad"
              style={{
                backgroundColor: "var(--surface-elevated)",
                borderColor: "var(--hairline)",
              }}
            >
              {SENSITIVITY_OPTIONS.map((opt) => {
                const selected = sensitivity === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => handleSensitivityChange(opt.value)}
                    className="rounded-lg px-2 py-1 text-xs font-semibold tabular-nums whitespace-nowrap"
                    style={{
                      backgroundColor: selected ? "var(--surface)" : "transparent",
                      color: selected ? "var(--accent-text)" : "var(--text-secondary)",
                      boxShadow: selected ? "var(--shadow-pill)" : "none",
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            <div
              className="inline-flex rounded-xl border p-0.5"
              role="group"
              aria-label="Tamanho do touchpad"
              style={{
                backgroundColor: "var(--surface-elevated)",
                borderColor: "var(--hairline)",
              }}
            >
              {PAD_SIZE_PRESETS.map((preset) => {
                const selected = Math.abs(padHeight - preset.height) <= 12;
                return (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => handleSizePreset(preset.height)}
                    className="rounded-lg px-2 py-1 text-xs font-semibold whitespace-nowrap"
                    style={{
                      backgroundColor: selected ? "var(--surface)" : "transparent",
                      color: selected ? "var(--accent-text)" : "var(--text-secondary)",
                      boxShadow: selected ? "var(--shadow-pill)" : "none",
                    }}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>

          <button
            type="button"
            onClick={() => onSetRemoteInputEnabled(false)}
            className="touch-btn rounded-xl px-3 py-1.5 text-xs font-semibold whitespace-nowrap"
            style={{
              backgroundColor: "var(--surface-elevated)",
              border: "1px solid var(--hairline)",
              color: "var(--danger)",
            }}
          >
            Desativar
          </button>
        </div>

        {/* Touchpad + Vertical Scroll Strip */}
        <div
          data-testid="touchpad-container"
          className="trackpad-surface flex overflow-hidden rounded-[18px]"
          style={{
            border: "1px solid var(--separator)",
            height: `${padHeight}px`,
          }}
        >
          <div
            role="application"
            aria-label="Área do touchpad"
            className="touch-none select-none flex flex-1 flex-col items-center justify-center p-4 text-center"
            onTouchStart={onPadTouchStart}
            onTouchMove={onPadTouchMove}
            onTouchEnd={onPadTouchEnd}
            onTouchCancel={onPadTouchEnd}
            onPointerDown={onPadPointerDown}
            onPointerMove={onPadPointerMove}
            onPointerUp={onPadPointerUp}
            onPointerCancel={onPadPointerUp}
          >
            <span className="text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>
              Arraste com 1 dedo para mover o cursor
            </span>
            <span className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>
              Toque = clique • 2 dedos = rolar ou toque direito
            </span>
          </div>

          <div
            role="scrollbar"
            aria-label="Barra de rolagem vertical"
            aria-orientation="vertical"
            aria-valuenow={50}
            className="touch-none select-none flex w-11 shrink-0 flex-col items-center justify-between border-l py-3 text-[10px] font-semibold"
            style={{
              backgroundColor: "var(--surface)",
              borderColor: "var(--hairline)",
              color: "var(--text-secondary)",
            }}
            onTouchStart={onScrollTouchStart}
            onTouchMove={onScrollTouchMove}
            onTouchEnd={onScrollTouchEnd}
            onTouchCancel={onScrollTouchEnd}
            onPointerDown={onScrollPointerDown}
            onPointerMove={onScrollPointerMove}
            onPointerUp={onScrollPointerUp}
            onPointerCancel={onScrollPointerUp}
          >
            <span aria-hidden="true">▲</span>
            <span className="text-[10px] uppercase tracking-wider [writing-mode:vertical-rl]">
              Rolar
            </span>
            <span aria-hidden="true">▼</span>
          </div>
        </div>

        {/* Drag handle to resize touchpad height smoothly */}
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Redimensionar altura do touchpad"
          aria-valuenow={padHeight}
          aria-valuemin={MIN_PAD_HEIGHT}
          aria-valuemax={MAX_PAD_HEIGHT}
          className="touch-none select-none mt-1.5 flex h-6 w-full cursor-ns-resize items-center justify-center gap-2"
          onTouchStart={onResizeTouchStart}
          onTouchMove={onResizeTouchMove}
          onTouchEnd={onResizeTouchEnd}
          onTouchCancel={onResizeTouchEnd}
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
        >
          <span
            className="h-1 w-12 rounded-full"
            style={{ backgroundColor: "var(--separator)" }}
            aria-hidden="true"
          />
          <span className="text-xs font-medium tabular-nums" style={{ color: "var(--text-secondary)" }}>
            {padHeight}px
          </span>
        </div>

        {/* Mouse Action Buttons */}
        <div className="mt-1.5 grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => {
              triggerHaptic(8);
              onSendInput({ action: "mouse_click", button: "left" });
            }}
            className="touch-key kbd-key rounded-2xl px-2 text-xs font-semibold whitespace-nowrap"
          >
            Clique Esq.
          </button>

          <button
            type="button"
            aria-pressed={dragLocked}
            onClick={toggleDragHold}
            className="touch-key rounded-2xl px-2 text-xs font-semibold whitespace-nowrap"
            style={{
              backgroundColor: dragLocked ? "var(--accent)" : "var(--surface-elevated)",
              border: "1px solid var(--hairline)",
              boxShadow: dragLocked ? "none" : "var(--kbd-bevel)",
              color: dragLocked ? "var(--accent-contrast)" : "var(--text)",
            }}
          >
            {dragLocked ? "Soltar" : "Arrastar"}
          </button>

          <button
            type="button"
            onClick={() => {
              triggerHaptic(10);
              onSendInput({ action: "mouse_click", button: "right" });
            }}
            className="touch-key kbd-key rounded-2xl px-2 text-xs font-semibold whitespace-nowrap"
          >
            Clique Dir.
          </button>
        </div>
      </section>

      {/* 2. Remote Keyboard card */}
      <section className="card-surface p-3.5 min-[360px]:p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex shrink-0 items-center gap-2">
            <KeyboardIcon className="h-4 w-4 shrink-0" style={{ color: "var(--accent-text)" }} />
            <h2 className="whitespace-nowrap text-base font-semibold" style={{ color: "var(--text)" }}>
              Teclado Remoto
            </h2>
          </div>

          <div
            className="inline-flex shrink-0 rounded-xl border p-0.5"
            role="radiogroup"
            aria-label="Modo de digitação"
            style={{
              backgroundColor: "var(--surface-elevated)",
              borderColor: "var(--hairline)",
            }}
          >
            <button
              type="button"
              role="radio"
              aria-checked={keyboardMode === "batch"}
              onClick={() => setKeyboardMode("batch")}
              className="whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-semibold"
              style={{
                backgroundColor: keyboardMode === "batch" ? "var(--surface)" : "transparent",
                color: keyboardMode === "batch" ? "var(--accent-text)" : "var(--text-secondary)",
                boxShadow: keyboardMode === "batch" ? "var(--shadow-pill)" : "none",
              }}
            >
              Enviar texto
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={keyboardMode === "live"}
              onClick={() => {
                setLiveText("");
                livePrevRef.current = "";
                setKeyboardMode("live");
              }}
              className="whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-semibold"
              style={{
                backgroundColor: keyboardMode === "live" ? "var(--surface)" : "transparent",
                color: keyboardMode === "live" ? "var(--accent-text)" : "var(--text-secondary)",
                boxShadow: keyboardMode === "live" ? "var(--shadow-pill)" : "none",
              }}
            >
              Tempo real
            </button>
          </div>
        </div>

        {keyboardMode === "batch" ? (
          <form onSubmit={handleBatchSubmit} className="flex gap-1.5 min-[360px]:gap-2">
            <input
              type="text"
              name="remote-batch-text"
              autoComplete="off"
              value={batchText}
              onChange={(e) => setBatchText(e.target.value)}
              placeholder="Digite para o PC..."
              aria-label="Digitar texto para o PC"
              className="field-input min-h-[44px] min-w-0 flex-1 rounded-2xl px-3 min-[360px]:px-3.5 text-sm"
            />
            <button
              type="submit"
              disabled={!batchText}
              className="touch-btn btn-primary shrink-0 rounded-2xl px-3 min-[360px]:px-3.5 text-xs font-semibold"
            >
              Enviar
            </button>
            <button
              type="button"
              onClick={handleBatchSendEnter}
              aria-label="Enviar texto e apertar Enter"
              title="Enviar + Enter"
              className="touch-btn kbd-key flex shrink-0 items-center justify-center rounded-2xl px-2.5 min-[360px]:px-3 text-xs font-semibold"
            >
              <EnterKeyIcon className="h-4 w-4 shrink-0" />
            </button>
          </form>
        ) : (
          <div className="flex flex-col gap-1.5">
            <input
              type="text"
              name="remote-live-text"
              autoComplete="off"
              value={liveText}
              onChange={(e) => handleLiveChange(e.target.value)}
              onKeyDown={handleLiveKeyDown}
              onCompositionStart={() => {
                liveComposingRef.current = true;
              }}
              onCompositionEnd={(e) => {
                liveComposingRef.current = false;
                applyLiveDiff(e.currentTarget.value);
              }}
              placeholder="Digite em tempo real..."
              aria-label="Digitar texto para o PC"
              className="field-input min-h-[44px] w-full rounded-2xl px-3.5 text-sm"
            />
            <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
              Cada caractere ou Enter é enviado imediatamente ao computador.
            </span>
          </div>
        )}

        {/* Quick Special Keys & Shortcuts */}
        <div className="mt-3 flex flex-col gap-2">
          <div className="grid grid-cols-4 gap-1.5 min-[360px]:gap-2">
            <button
              type="button"
              onClick={() => sendSpecialKey("escape")}
              className="touch-key kbd-key rounded-2xl px-1.5 text-xs font-semibold whitespace-nowrap"
            >
              Esc
            </button>
            <button
              type="button"
              onClick={() => sendSpecialKey("tab")}
              className="touch-key kbd-key rounded-2xl px-1.5 text-xs font-semibold whitespace-nowrap"
            >
              Tab
            </button>
            <button
              type="button"
              aria-label="Apagar"
              onClick={() => sendSpecialKey("backspace")}
              className="touch-key kbd-key flex items-center justify-center rounded-2xl px-1.5 text-xs font-semibold"
            >
              <BackspaceIcon className="h-4 w-4 shrink-0" />
            </button>
            <button
              type="button"
              aria-label="Enter"
              onClick={() => sendSpecialKey("enter")}
              className="touch-key flex items-center justify-center gap-1 rounded-2xl border px-1.5 text-[11px] min-[360px]:text-xs font-semibold whitespace-nowrap"
              style={{
                backgroundColor: "var(--accent-soft)",
                borderColor: "var(--hairline)",
                color: "var(--accent-text)",
              }}
            >
              <EnterKeyIcon className="h-3.5 w-3.5 shrink-0" />
              <span>Enter</span>
            </button>
          </div>

          <div className="grid grid-cols-5 gap-1.5 min-[360px]:gap-2">
            <button
              type="button"
              aria-label="Seta esquerda"
              onClick={() => sendSpecialKey("left")}
              className="touch-key kbd-key flex items-center justify-center rounded-2xl"
            >
              <ArrowLeftIcon className="h-4 w-4 shrink-0" />
            </button>
            <button
              type="button"
              aria-label="Seta cima"
              onClick={() => sendSpecialKey("up")}
              className="touch-key kbd-key flex items-center justify-center rounded-2xl"
            >
              <ArrowUpIcon className="h-4 w-4 shrink-0" />
            </button>
            <button
              type="button"
              aria-label="Seta baixo"
              onClick={() => sendSpecialKey("down")}
              className="touch-key kbd-key flex items-center justify-center rounded-2xl"
            >
              <ArrowDownIcon className="h-4 w-4 shrink-0" />
            </button>
            <button
              type="button"
              aria-label="Seta direita"
              onClick={() => sendSpecialKey("right")}
              className="touch-key kbd-key flex items-center justify-center rounded-2xl"
            >
              <ArrowRightIcon className="h-4 w-4 shrink-0" />
            </button>
            <button
              type="button"
              onClick={() => sendSpecialKey("space")}
              className="touch-key kbd-key rounded-2xl px-1 text-[11px] min-[360px]:text-xs font-semibold whitespace-nowrap truncate"
            >
              Espaço
            </button>
          </div>

          <div className="grid grid-cols-5 gap-1.5">
            <button
              type="button"
              onClick={() => sendSpecialKey("tab", ["alt"])}
              className="touch-key kbd-key rounded-xl px-1 text-[10px] min-[360px]:text-xs font-semibold whitespace-nowrap truncate"
            >
              Alt+Tab
            </button>
            <button
              type="button"
              onClick={() => sendSpecialKey("f")}
              aria-label="Tecla F tela cheia"
              className="touch-key kbd-key rounded-xl px-1 text-[10px] min-[360px]:text-xs font-semibold whitespace-nowrap truncate"
            >
              Tela (F)
            </button>
            <button
              type="button"
              onClick={() => sendSpecialKey("c", ["ctrl"])}
              className="touch-key kbd-key rounded-xl px-1 text-[10px] min-[360px]:text-xs font-semibold whitespace-nowrap truncate"
            >
              Copiar
            </button>
            <button
              type="button"
              onClick={() => sendSpecialKey("v", ["ctrl"])}
              className="touch-key kbd-key rounded-xl px-1 text-[10px] min-[360px]:text-xs font-semibold whitespace-nowrap truncate"
            >
              Colar
            </button>
            <button
              type="button"
              onClick={() => sendSpecialKey("win")}
              className="touch-key kbd-key rounded-xl px-1 text-[10px] min-[360px]:text-xs font-semibold whitespace-nowrap truncate"
            >
              Win
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
