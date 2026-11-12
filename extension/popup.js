const statusEl = document.getElementById("status");
const tabsCountEl = document.getElementById("tabs-count");
const pingsEl = document.getElementById("pings");
const lastPongEl = document.getElementById("last-pong");
const probeIsoEl = document.getElementById("probe-iso");
const probeMainEl = document.getElementById("probe-main");
const reconnectBtn = document.getElementById("reconnect-btn");

function refresh() {
  chrome.runtime.sendMessage({ type: "get_diagnostics" }, (diag) => {
    if (chrome.runtime.lastError || !diag) {
      statusEl.textContent = "Service Worker inativo";
      statusEl.className = "val err";
      return;
    }
    statusEl.textContent = diag.connected ? "Conectado (127.0.0.1:8765)" : "Desconectado";
    statusEl.className = `val ${diag.connected ? "ok" : "err"}`;
    tabsCountEl.textContent = String(diag.activeTabCount ?? 0);
    pingsEl.textContent = `${diag.pingCount ?? 0} / ${diag.pongCount ?? 0}`;
    lastPongEl.textContent = diag.lastPongAt
      ? new Date(diag.lastPongAt).toLocaleTimeString("pt-BR")
      : "—";

    const probe = diag.lastMetadataProbe;
    if (probe) {
      probeIsoEl.textContent = probe.isolatedReadable ? "Legível" : "Null / indisponível";
      probeMainEl.textContent = `${probe.mainReadable ? "MAIN sim" : "MAIN não"} · ${
        probe.domReadable ? "DOM sim" : "DOM não"
      }`;
    }
  });
}

reconnectBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "force_reconnect" }, () => {
    setTimeout(refresh, 300);
  });
});

refresh();
setInterval(refresh, 1500);
