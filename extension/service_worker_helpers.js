/**
 * Pure ES-module helpers for the MV3 service worker.
 * Tested directly via Node's built-in test runner.
 */

export const DEFAULT_WS_URL = "ws://127.0.0.1:8765/ws/extension";
export const KEEPALIVE_PING_INTERVAL_MS = 20_000;
export const PONG_TIMEOUT_MS = 10_000;
export const WATCHDOG_ALARM_NAME = "pcmedia-ws-watchdog";

export function isTrackableWebUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function computeReconnectDelayMs(attempt) {
  const safeAttempt = Math.max(0, Number(attempt) || 0);
  const raw = 1000 * Math.pow(2, safeAttempt);
  return Math.min(15_000, raw);
}

export function buildOpenUrl(msg) {
  if (!msg || typeof msg !== "object") return null;

  if (msg.mode === "youtube_search") {
    const query = typeof msg.query === "string" ? msg.query.trim() : "";
    if (!query) return null;
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  }

  if (msg.mode === "url") {
    const rawUrl = typeof msg.url === "string" ? msg.url.trim() : "";
    if (!rawUrl) return null;
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null;
      }
      return parsed.href;
    } catch {
      return null;
    }
  }

  return null;
}

export function mergeTabEntry(tabId, contentPayload, chromeTab = null) {
  if (!contentPayload || !contentPayload.hasMedia) {
    return null;
  }
  const tabMuted = Boolean(chromeTab?.mutedInfo?.muted);
  const elementMuted = Boolean(contentPayload.elementMuted);
  const muted = tabMuted || elementMuted;
  const active = Boolean(chromeTab?.active);

  return {
    tabId,
    url: contentPayload.url || chromeTab?.url || "",
    title: contentPayload.title || chromeTab?.title || "",
    artist: contentPayload.artist || "",
    album: contentPayload.album || "",
    artworkUrl: contentPayload.artworkUrl || chromeTab?.favIconUrl || null,
    status: contentPayload.status || "PAUSED",
    position: Number(contentPayload.position || 0),
    duration: Number(contentPayload.duration || 0),
    volume: typeof contentPayload.volume === "number" ? contentPayload.volume : 1,
    muted,
    tabMuted,
    elementMuted,
    active,
    isFullscreen: Boolean(contentPayload.isFullscreen),
    controls: contentPayload.controls || {
      play: true,
      pause: true,
      toggle: true,
      next: false,
      previous: false,
      seek: true,
      skipAd: false,
      fullscreen: true,
    },
    metadataProbe: contentPayload.metadataProbe || null,
  };
}

export function serializeTabsForHost(tabEntries) {
  const list = Array.from(tabEntries || []).filter((item) => item && item.tabId > 0);
  list.sort((a, b) => {
    const aPlaying = a.status === "PLAYING" ? 1 : 0;
    const bPlaying = b.status === "PLAYING" ? 1 : 0;
    if (aPlaying !== bPlaying) return bPlaying - aPlaying;
    if (Boolean(a.active) !== Boolean(b.active)) return a.active ? -1 : 1;
    return a.tabId - b.tabId;
  });

  return list.map((item) => ({
    tabId: item.tabId,
    title: item.title,
    artist: item.artist,
    album: item.album,
    artworkUrl: item.artworkUrl,
    status: item.status,
    position: item.position,
    duration: item.duration,
    volume: item.volume,
    muted: Boolean(item.muted),
    active: Boolean(item.active),
    isFullscreen: Boolean(item.isFullscreen),
    controls: item.controls,
  }));
}
