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

const tabStates = new Map();
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

function sendAck(requestId, ok) {
  if (!requestId) return;
  sendJson({
    type: "extension_ack",
    requestId,
    ok: Boolean(ok),
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
    await chrome.tabs.sendMessage(tab.id, { type: "request_media_state" });
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

async function sendMessageToTab(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch {
    return null;
  }
}

async function handleHostCommand(msg) {
  const tabId = Number(msg.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    sendAck(msg.requestId, false);
    return;
  }
  const response = await sendMessageToTab(tabId, {
    type: "media_command",
    action: msg.action,
    value: msg.value,
  });
  sendAck(msg.requestId, Boolean(response && response.ok));
}

async function handleHostVolume(msg) {
  const tabId = Number(msg.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    sendAck(msg.requestId, false);
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
      sendAck(msg.requestId, false);
      return;
    }
  }

  let elementApplied = true;
  if (typeof msg.value === "number" || msg.muted === false) {
    const res = await sendMessageToTab(tabId, {
      type: "tab_media_volume",
      value: typeof msg.value === "number" ? msg.value : undefined,
      unmuteElement: msg.muted === false,
    });
    elementApplied = Boolean(res && res.ok);
  }

  sendExtensionState();
  await persistDiagnostics();
  sendAck(msg.requestId, tabMuteApplied || elementApplied);
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
    const entry = mergeTabEntry(tabId, message.payload, sender.tab);
    if (!entry) {
      if (tabStates.delete(tabId)) {
        sendExtensionState();
        void persistDiagnostics();
      }
      return false;
    }

    if (entry.metadataProbe) {
      diagnostics.lastMetadataProbe = entry.metadataProbe;
    }
    tabStates.set(tabId, entry);
    sendExtensionState();
    void persistDiagnostics();
    return false;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabStates.delete(tabId)) {
    sendExtensionState();
    void persistDiagnostics();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && !isTrackableWebUrl(changeInfo.url)) {
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
