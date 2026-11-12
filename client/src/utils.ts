import type { MediaStatus, StateMessage, ThemeMode } from "./types";

const STATE_CACHE_KEY = "pcmedia_last_state_v1";
const THEME_STORAGE_KEY = "pcmedia_theme_mode_v1";

export function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function cleanMediaTitle(rawTitle: string | null | undefined): string {
  if (!rawTitle) return "";
  return rawTitle.replace(/^\(\d+\+?\)\s*/, "").trim();
}

export function safeArtworkUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
    return null;
  } catch {
    return null;
  }
}

export function extrapolatePosition(params: {
  position: number;
  duration: number;
  status: MediaStatus;
  receivedAtMs: number;
  nowMs?: number;
}): number {
  const base = Math.max(0, Number.isFinite(params.position) ? params.position : 0);
  const dur = Math.max(0, Number.isFinite(params.duration) ? params.duration : 0);
  if (params.status !== "PLAYING") {
    return dur > 0 ? Math.min(dur, base) : base;
  }
  const now = params.nowMs ?? Date.now();
  const elapsedSec = Math.max(0, (now - params.receivedAtMs) / 1000);
  const extrapolated = base + elapsedSec;
  return dur > 0 ? Math.min(dur, extrapolated) : extrapolated;
}

export function triggerHaptic(durationMs = 10): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(durationMs);
    }
  } catch {
    // Ignore unsupported vibration calls
  }
}

export function loadThemeMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "auto") {
      return stored;
    }
  } catch {
    // Ignore storage errors
  }
  return "auto";
}

export function applyThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Ignore storage errors
  }
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = mode;
  }
}

export function loadCachedState(): StateMessage | null {
  try {
    const raw = localStorage.getItem(STATE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StateMessage;
    if (parsed && parsed.type === "state" && parsed.v === 1) {
      return parsed;
    }
  } catch {
    // Ignore malformed cache
  }
  return null;
}

export function saveCachedState(state: StateMessage): void {
  try {
    localStorage.setItem(STATE_CACHE_KEY, JSON.stringify(state));
  } catch {
    // Ignore quota errors
  }
}

export function buildWebSocketUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

export function computeReconnectDelayMs(attempt: number): number {
  const safe = Math.max(0, attempt);
  return Math.min(12_000, 1000 * Math.pow(2, safe));
}
