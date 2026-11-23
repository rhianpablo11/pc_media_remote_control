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

    const prefersDark =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = mode === "dark" || (mode === "auto" && prefersDark);
    const themeColor = isDark ? "#08080a" : "#f5f5f7";

    const metas = document.querySelectorAll('meta[name="theme-color"]');
    metas.forEach((meta) => {
      if (mode === "auto") {
        const media = meta.getAttribute("media") || "";
        meta.setAttribute("content", media.includes("dark") ? "#08080a" : "#f5f5f7");
      } else {
        meta.setAttribute("content", themeColor);
      }
    });
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

export function buildScreenWebSocketUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/screen`;
}

export function mapClientPointToNormalized(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  naturalWidth: number,
  naturalHeight: number,
  rotationDeg: 0 | 90 = 0,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0 || naturalWidth <= 0 || naturalHeight <= 0) {
    return null;
  }
  const containerAspect = rect.width / rect.height;
  const imageAspect =
    rotationDeg === 90 ? naturalHeight / naturalWidth : naturalWidth / naturalHeight;

  let renderW = rect.width;
  let renderH = rect.height;
  let offsetX = 0;
  let offsetY = 0;

  if (imageAspect > containerAspect) {
    renderW = rect.width;
    renderH = rect.width / imageAspect;
    offsetY = (rect.height - renderH) / 2;
  } else if (imageAspect < containerAspect) {
    renderH = rect.height;
    renderW = rect.height * imageAspect;
    offsetX = (rect.width - renderW) / 2;
  }

  let rawX: number;
  let rawY: number;
  if (rotationDeg === 90) {
    rawX = (clientY - rect.top - offsetY) / renderH;
    rawY = 1 - (clientX - rect.left - offsetX) / renderW;
  } else {
    rawX = (clientX - rect.left - offsetX) / renderW;
    rawY = (clientY - rect.top - offsetY) / renderH;
  }

  const x = Math.max(0, Math.min(1, rawX));
  const y = Math.max(0, Math.min(1, rawY));
  return {
    x: Number(x.toFixed(4)),
    y: Number(y.toFixed(4)),
  };
}

export function isLoopbackHost(): boolean {
  if (typeof window === "undefined") return true;
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

export function computeReconnectDelayMs(attempt: number): number {
  const safe = Math.max(0, attempt);
  return Math.min(12_000, 1000 * Math.pow(2, safe));
}

const AUTH_TOKEN_KEY = "pcmedia_auth_token_v1";
const DEVICE_ID_KEY = "pcmedia_device_id_v1";

export function loadAuthToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveAuthToken(token: string, deviceId?: string): void {
  try {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    if (deviceId) {
      localStorage.setItem(DEVICE_ID_KEY, deviceId);
    }
  } catch {
    // Ignore storage quota
  }
}

export function clearAuthToken(): void {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(DEVICE_ID_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function getPairingCodeFromUrl(): string | null {
  if (typeof window === "undefined" || !window.location.search) return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("pair");
    return code ? code.trim() : null;
  } catch {
    return null;
  }
}

export function clearPairingCodeFromUrl(): void {
  if (typeof window === "undefined" || !window.history.replaceState) return;
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("pair");
    window.history.replaceState({}, document.title, url.pathname + (url.search || ""));
  } catch {
    // Ignore history errors
  }
}

export async function pairDeviceApi(
  codeOrPin: string,
  deviceName?: string,
): Promise<{ ok: boolean; error?: string; token?: string; deviceId?: string }> {
  try {
    const resp = await fetch("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: codeOrPin.trim(),
        deviceName: deviceName || (typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 48) : "Celular"),
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      return { ok: false, error: data.error || "Falha no pareamento." };
    }
    if (data.token) {
      saveAuthToken(data.token, data.deviceId);
      return { ok: true, token: data.token, deviceId: data.deviceId };
    }
    return { ok: false, error: "Resposta do servidor não continha token." };
  } catch (err) {
    return { ok: false, error: "Erro de conexão ao parear." };
  }
}

export async function fetchPairedDevicesApi(token: string | null): Promise<any[]> {
  try {
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const resp = await fetch("/api/devices", { headers });
    if (!resp.ok) return [];
    return await resp.json();
  } catch {
    return [];
  }
}

export async function revokeDeviceApi(deviceId: string, token: string | null): Promise<boolean> {
  try {
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const resp = await fetch(`/api/devices/${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
      headers,
    });
    return resp.ok;
  } catch {
    return false;
  }
}
