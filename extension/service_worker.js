import {
  DEFAULT_WS_URL,
  KEEPALIVE_PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  WATCHDOG_ALARM_NAME,
  buildOpenUrl,
  computeReconnectDelayMs,
  isTrackableWebUrl,
  mergeTabEntry,
  serializeTabsForHost,
} from "./service_worker_helpers.js";
import {
  extractYtInitialData,
  isValidVideoId,
  parseSearchResults,
} from "./youtube_search_parser.js";

const tabStates = new Map();
const tabFrameStates = new Map();
const pendingPlayTabs = new Map();
let ws = null;
let reconnectTimer = null;
let keepaliveTimer = null;
let pongWatchTimer = null;
let reconnectAttempt = 0;

const diagnostics = {
  connected: false,
  wsUrl: DEFAULT_WS_URL,
  lastConnectedAt: null,
  lastDisconnectedAt: null,
  lastPongAt: null,
  pingCount: 0,
  pongCount: 0,
  reconnectCount: 0,
  lastMetadataProbe: null,
};

async function persistDiagnostics() {
  try {
    await chrome.storage.local.set({
      pcMediaDiagnostics: {
        ...diagnostics,
        activeTabCount: tabStates.size,
      },
    });
  } catch {
    // Storage writes may fail cleanly during extension teardown
  }
}

function clearSocketTimers() {
  if (keepaliveTimer !== null) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  if (pongWatchTimer !== null) {
    clearTimeout(pongWatchTimer);
    pongWatchTimer = null;
  }
}

function sendJson(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }
  ws.send(JSON.stringify(payload));
  return true;
}

function sendExtensionState() {
  const tabs = serializeTabsForHost(tabStates.values());
  return sendJson({
    type: "extension_state",
    tabs,
  });
}

function sendAck(requestId, ok, reason) {
  if (!requestId) return;
  sendJson({
    type: "extension_ack",
    requestId,
    ok: Boolean(ok),
    reason: reason || undefined,
  });
}

function scheduleReconnect() {
  if (reconnectTimer !== null) {
    return;
  }
  const delayMs = computeReconnectDelayMs(reconnectAttempt);
  reconnectAttempt += 1;
  diagnostics.reconnectCount += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delayMs);
}

function startKeepaliveLoop() {
  clearSocketTimers();
  keepaliveTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    diagnostics.pingCount += 1;
    sendJson({ type: "ping", ts: Date.now() });

    if (pongWatchTimer !== null) {
      clearTimeout(pongWatchTimer);
    }
    pongWatchTimer = setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        console.warn("[PC Media Control] Pong timeout — reconectando WebSocket");
        ws.close();
      }
    }, PONG_TIMEOUT_MS);
  }, KEEPALIVE_PING_INTERVAL_MS);
}

async function ensureContentScriptsAndPollTab(tab) {
  if (!tab || !tab.id || !isTrackableWebUrl(tab.url)) {
    return;
  }
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "request_media_state" });
    if (resp && resp.snapshot) {
      const entry = mergeTabEntry(tab.id, resp.snapshot, tab);
      if (entry) {
        tabStates.set(tab.id, entry);
      }
    }
    return;
  } catch {
    // Tab was probably already open before the extension started; inject now.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["main_world_bridge.js"],
      world: "MAIN",
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content_helpers.js", "content.js"],
      world: "ISOLATED",
    });
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "request_media_state" });
    if (resp && resp.snapshot) {
      const entry = mergeTabEntry(tab.id, resp.snapshot, tab);
      if (entry) {
        tabStates.set(tab.id, entry);
      }
    }
  } catch {
    // Protected or closed tab; ignore safely
  }
}

async function pollAllOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    const existingIds = new Set(tabs.map((t) => t.id).filter(Boolean));
    for (const cachedId of Array.from(tabStates.keys())) {
      if (!existingIds.has(cachedId)) {
        tabStates.delete(cachedId);
      }
    }
    await Promise.all(tabs.map((tab) => ensureContentScriptsAndPollTab(tab)));
    sendExtensionState();
  } catch (err) {
    console.warn("[PC Media Control] Falha ao consultar abas:", err);
  }
}

async function sendMessageToTab(tabId, payload, frameId = undefined) {
  try {
    const options = typeof frameId === "number" && frameId > 0 ? { frameId } : undefined;
    return await chrome.tabs.sendMessage(tabId, payload, options);
  } catch {
    return null;
  }
}

async function handleHostCommand(msg) {
  const tabId = Number(msg.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    sendAck(msg.requestId, false, "invalid_tab_id");
    return;
  }
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    sendAck(msg.requestId, false, "tab_closed");
    return;
  }
  if (!tab) {
    sendAck(msg.requestId, false, "tab_closed");
    return;
  }
  if (tab.discarded) {
    sendAck(msg.requestId, false, "tab_discarded");
    return;
  }

  let response = null;
  try {
    const targetFrameId = tabStates.get(tabId)?._frameId;
    const msgPromise = sendMessageToTab(
      tabId,
      {
        type: "media_command",
        action: msg.action,
        value: msg.value,
      },
      targetFrameId
    );
    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => resolve({ ok: false, reason: "timeout" }), 1800)
    );
    response = await Promise.race([msgPromise, timeoutPromise]);
  } catch {
    response = { ok: false, reason: "no_media_element" };
  }

  if (response && response.ok) {
    sendAck(msg.requestId, true, response.reason);
  } else if (
    msg.action === "toggle_fullscreen" ||
    msg.action === "fullscreen"
  ) {
    try {
      if (typeof tab.windowId === "number") {
        const win = await chrome.windows.get(tab.windowId);
        const nextState = win.state === "fullscreen" ? "normal" : "fullscreen";
        await chrome.windows.update(tab.windowId, { state: nextState, focused: true });
        sendAck(msg.requestId, true, `window_${nextState}`);
        return;
      }
    } catch (err) {
      sendAck(msg.requestId, false, err?.message || "fullscreen_failed");
      return;
    }
    sendAck(msg.requestId, false, response?.reason || "command_failed");
  } else {
    sendAck(msg.requestId, false, response?.reason || "command_failed");
  }
}

async function handleHostVolume(msg) {
  const tabId = Number(msg.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    sendAck(msg.requestId, false, "invalid_tab_id");
    return;
  }
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    sendAck(msg.requestId, false, "tab_closed");
    return;
  }
  if (!tab) {
    sendAck(msg.requestId, false, "tab_closed");
    return;
  }
  if (tab.discarded) {
    sendAck(msg.requestId, false, "tab_discarded");
    return;
  }

  let tabMuteApplied = false;
  if (typeof msg.muted === "boolean") {
    try {
      const updated = await chrome.tabs.update(tabId, { muted: msg.muted });
      tabMuteApplied = true;
      const current = tabStates.get(tabId);
      if (current) {
        current.tabMuted = Boolean(updated?.mutedInfo?.muted ?? msg.muted);
        if (msg.muted === false) {
          current.elementMuted = false;
        }
        current.muted = current.tabMuted || Boolean(current.elementMuted);
      }
    } catch {
      sendAck(msg.requestId, false, "tab_mute_failed");
      return;
    }
  }

  let elementApplied = true;
  let elementReason;
  if (typeof msg.value === "number" || msg.muted === false) {
    const targetFrameId = tabStates.get(tabId)?._frameId;
    const res = await sendMessageToTab(
      tabId,
      {
        type: "tab_media_volume",
        value: typeof msg.value === "number" ? msg.value : undefined,
        unmuteElement: msg.muted === false,
      },
      targetFrameId
    );
    elementApplied = Boolean(res && res.ok);
    elementReason = res?.reason;
  }

  sendExtensionState();
  await persistDiagnostics();
  const ok = tabMuteApplied || elementApplied;
  sendAck(msg.requestId, ok, ok ? undefined : (elementReason || "volume_failed"));
}

async function handleHostSearch(msg) {
  const requestId = msg.requestId;
  const query = typeof msg.query === "string" ? msg.query.trim() : "";
  if (!query) {
    sendJson({
      type: "search_results",
      requestId,
      ok: false,
      query: "",
      results: [],
      reason: "empty_query",
    });
    return;
  }

  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const resp = await fetch(searchUrl, {
      credentials: "include",
      headers: {
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });

    if (!resp.ok) {
      sendJson({
        type: "search_results",
        requestId,
        ok: false,
        query,
        results: [],
        reason: `http_${resp.status}`,
      });
      return;
    }

    const htmlText = await resp.text();
    const initialData = extractYtInitialData(htmlText);
    if (!initialData) {
      sendJson({
        type: "search_results",
        requestId,
        ok: false,
        query,
        results: [],
        reason: "yt_initial_data_not_found",
      });
      return;
    }

    const results = parseSearchResults(initialData, 25);
    sendJson({
      type: "search_results",
      requestId,
      ok: true,
      query,
      results,
    });
  } catch (err) {
    sendJson({
      type: "search_results",
      requestId,
      ok: false,
      query,
      results: [],
      reason: err?.message || "fetch_failed",
    });
  }
}

async function handleHostPlayVideo(msg) {
  const requestId = msg.requestId;
  const videoId = typeof msg.videoId === "string" ? msg.videoId.trim() : "";
  if (!isValidVideoId(videoId)) {
    sendAck(requestId, false, "invalid_video_id");
    return;
  }

  const targetUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const mode = msg.mode === "new_tab" ? "new_tab" : "current_tab";
  const shouldFullscreen = Boolean(msg.fullscreen);

  // If previous video was in fullscreen, preserve fullscreen unless explicitly requested false
  let preserveFullscreen = shouldFullscreen;
  if (msg.fullscreen === undefined || msg.fullscreen === null) {
    if (msg.tabId && tabStates.has(Number(msg.tabId))) {
      preserveFullscreen = Boolean(tabStates.get(Number(msg.tabId))?.isFullscreen);
    } else {
      for (const entry of tabStates.values()) {
        if (entry.active && entry.isFullscreen) {
          preserveFullscreen = true;
          break;
        }
      }
    }
  }

  try {
    let targetTab = null;

    if (mode === "current_tab") {
      if (msg.tabId && Number.isInteger(Number(msg.tabId))) {
        const candidate = await chrome.tabs.get(Number(msg.tabId)).catch(() => null);
        if (candidate && !candidate.discarded) {
          targetTab = candidate;
        }
      }

      if (!targetTab) {
        for (const [id, entry] of tabStates.entries()) {
          if (entry.url && entry.url.includes("youtube.com")) {
            const candidate = await chrome.tabs.get(id).catch(() => null);
            if (candidate && !candidate.discarded) {
              targetTab = candidate;
              if (entry.active || entry.status === "PLAYING") break;
            }
          }
        }
      }

      if (targetTab && targetTab.id) {
        await chrome.tabs.update(targetTab.id, { url: targetUrl, active: true });
        if (typeof targetTab.windowId === "number") {
          await chrome.windows.update(targetTab.windowId, { focused: true }).catch(() => {});
          if (preserveFullscreen) {
            await chrome.windows.update(targetTab.windowId, { state: "fullscreen" }).catch(() => {});
          }
        }
        pendingPlayTabs.set(targetTab.id, { fullscreen: preserveFullscreen, ts: Date.now() });
        sendAck(requestId, true, "navigated_existing_tab");
        return;
      }
    }

    const createdTab = await chrome.tabs.create({ url: targetUrl, active: true });
    if (createdTab && typeof createdTab.windowId === "number") {
      await chrome.windows.update(createdTab.windowId, { focused: true }).catch(() => {});
      if (preserveFullscreen) {
        await chrome.windows.update(createdTab.windowId, { state: "fullscreen" }).catch(() => {});
      }
    }
    if (createdTab && createdTab.id) {
      pendingPlayTabs.set(createdTab.id, { fullscreen: preserveFullscreen, ts: Date.now() });
    }
    sendAck(requestId, true, "created_new_tab");
  } catch (err) {
    sendAck(requestId, false, err?.message || "play_video_failed");
  }
}

async function handleHostOpen(msg) {
  const targetUrl = buildOpenUrl(msg);
  if (!targetUrl) {
    sendAck(msg.requestId, false);
    return;
  }
  try {
    const created = await chrome.tabs.create({ url: targetUrl, active: true });
    if (created && typeof created.windowId === "number") {
      await chrome.windows.update(created.windowId, { focused: true }).catch(() => {});
    }
    sendAck(msg.requestId, true);
  } catch {
    sendAck(msg.requestId, false);
  }
}

async function handleHostMessage(rawData) {
  let msg;
  try {
    msg = JSON.parse(rawData);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "pong") {
    if (pongWatchTimer !== null) {
      clearTimeout(pongWatchTimer);
      pongWatchTimer = null;
    }
    diagnostics.pongCount += 1;
    diagnostics.lastPongAt = new Date().toISOString();
    await persistDiagnostics();
    return;
  }

  if (msg.type === "command") {
    await handleHostCommand(msg);
    return;
  }

  if (msg.type === "volume") {
    await handleHostVolume(msg);
    return;
  }

  if (msg.type === "open") {
    await handleHostOpen(msg);
    return;
  }

  if (msg.type === "search") {
    await handleHostSearch(msg);
    return;
  }

  if (msg.type === "play_video") {
    await handleHostPlayVideo(msg);
    return;
  }
}

function connectWebSocket() {
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    ws = new WebSocket(DEFAULT_WS_URL);
  } catch (err) {
    console.warn("[PC Media Control] Erro ao abrir WebSocket:", err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectAttempt = 0;
    diagnostics.connected = true;
    diagnostics.lastConnectedAt = new Date().toISOString();
    startKeepaliveLoop();
    void persistDiagnostics();
    void pollAllOpenTabs();
  };

  ws.onmessage = (event) => {
    void handleHostMessage(event.data);
  };

  ws.onerror = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  };

  ws.onclose = () => {
    clearSocketTimers();
    ws = null;
    diagnostics.connected = false;
    diagnostics.lastDisconnectedAt = new Date().toISOString();
    void persistDiagnostics();
    scheduleReconnect();
  };
}

function recomputeTabState(tabId) {
  const frames = tabFrameStates.get(tabId);
  if (!frames || frames.size === 0) {
    if (tabStates.delete(tabId)) {
      sendExtensionState();
      void persistDiagnostics();
    }
    return;
  }

  let best = null;
  for (const entry of frames.values()) {
    if (!best) {
      best = entry;
      continue;
    }
    if (entry.status === "PLAYING" && best.status !== "PLAYING") {
      best = entry;
    } else if (entry._frameId === 0 && best._frameId !== 0 && best.status !== "PLAYING") {
      best = entry;
    }
  }

  if (best) {
    if (best.metadataProbe) {
      diagnostics.lastMetadataProbe = best.metadataProbe;
    }
    tabStates.set(tabId, best);
    sendExtensionState();
    void persistDiagnostics();
  } else if (tabStates.delete(tabId)) {
    sendExtensionState();
    void persistDiagnostics();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.type === "get_diagnostics") {
    sendResponse({
      ...diagnostics,
      activeTabCount: tabStates.size,
      tabs: serializeTabsForHost(tabStates.values()),
    });
    return false;
  }

  if (message.type === "force_reconnect") {
    if (ws) {
      ws.close();
    } else {
      connectWebSocket();
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "tab_media_state" && sender.tab && sender.tab.id) {
    const tabId = sender.tab.id;
    const frameId = typeof sender.frameId === "number" ? sender.frameId : 0;
    const entry = mergeTabEntry(tabId, message.payload, sender.tab);

    if (entry) {
      entry._frameId = frameId;
      if (!tabFrameStates.has(tabId)) {
        tabFrameStates.set(tabId, new Map());
      }
      tabFrameStates.get(tabId).set(frameId, entry);
    } else if (tabFrameStates.has(tabId)) {
      tabFrameStates.get(tabId).delete(frameId);
    }

    recomputeTabState(tabId);
    return false;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingPlayTabs.delete(tabId);
  tabFrameStates.delete(tabId);
  if (tabStates.delete(tabId)) {
    sendExtensionState();
    void persistDiagnostics();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && pendingPlayTabs.has(tabId)) {
    const pending = pendingPlayTabs.get(tabId);
    pendingPlayTabs.delete(tabId);
    setTimeout(() => {
      sendMessageToTab(tabId, {
        type: "ensure_playback",
        fullscreen: pending?.fullscreen,
      }).catch(() => {});
    }, 600);
  }

  if (changeInfo.url && !isTrackableWebUrl(changeInfo.url)) {
    tabFrameStates.delete(tabId);
    if (tabStates.delete(tabId)) {
      sendExtensionState();
    }
    return;
  }

  const existing = tabStates.get(tabId);
  if (!existing) return;

  let changed = false;
  if (changeInfo.mutedInfo) {
    existing.tabMuted = Boolean(changeInfo.mutedInfo.muted);
    existing.muted = existing.tabMuted || Boolean(existing.elementMuted);
    changed = true;
  }
  if (typeof changeInfo.title === "string" && !existing.title) {
    existing.title = changeInfo.title;
    changed = true;
  }
  if (tab && typeof tab.active === "boolean" && existing.active !== tab.active) {
    existing.active = tab.active;
    changed = true;
  }
  if (changed) {
    sendExtensionState();
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  let changed = false;
  for (const [id, entry] of tabStates.entries()) {
    const shouldBeActive = id === activeInfo.tabId;
    if (entry.active !== shouldBeActive) {
      entry.active = shouldBeActive;
      changed = true;
    }
  }
  if (changed) {
    sendExtensionState();
  }
});

async function ensureWatchdogAlarm() {
  try {
    await chrome.alarms.create(WATCHDOG_ALARM_NAME, { periodInMinutes: 1 });
  } catch (err) {
    console.warn("[PC Media Control] Falha ao registrar alarme:", err);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WATCHDOG_ALARM_NAME) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectWebSocket();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  void ensureWatchdogAlarm();
  connectWebSocket();
  void pollAllOpenTabs();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureWatchdogAlarm();
  connectWebSocket();
  void pollAllOpenTabs();
});

void ensureWatchdogAlarm();
connectWebSocket();
