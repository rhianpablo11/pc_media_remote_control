import { useEffect, useMemo, useState } from "react";
import {
  CompassIcon,
  CloseIcon,
  NowPlayingTabIcon,
  SearchIcon,
  SlidersIcon,
  TouchpadIcon,
} from "./components/Icons";
import { MoreView } from "./components/MoreView";
import { NowPlayingView } from "./components/NowPlayingView";
import { PairingPlaceholder } from "./components/PairingPlaceholder";
import { RemoteInputView } from "./components/RemoteInputView";
import { SearchView } from "./components/SearchView";
import { SessionSheet } from "./components/SessionSheet";
import { VolumeView } from "./components/VolumeView";
import { useMediaHost } from "./hooks/useMediaHost";
import type { ActiveTab, ConnectionStatus, ThemeMode } from "./types";
import { applyThemeMode, loadThemeMode } from "./utils";

function connectionBadgeText(status: ConnectionStatus, isCachedState: boolean): {
  label: string;
  color: string;
} {
  if (status === "connected") {
    return { label: "Conectado", color: "var(--ok)" };
  }
  if (status === "pairing_required") {
    return { label: "Não pareado", color: "var(--danger)" };
  }
  if (status === "reconnecting") {
    return {
      label: isCachedState ? "Reconectando (cache)" : "Reconectando...",
      color: "var(--warn)",
    };
  }
  return {
    label: isCachedState ? "Conectando (cache)" : "Conectando...",
    color: "var(--text-secondary)",
  };
}

export function App() {
  const {
    state,
    isCachedState,
    receivedAtMs,
    connectionStatus,
    errorMessage,
    dismissError,
    sendCommand,
    sendVolume,
    selectSession,
    sendOpen,
    searchYouTube,
    playVideo,
    sendInput,
    setRemoteInputEnabled,
    reconnectNow,
    pairWithPin,
    pairedDevices,
    refreshPairedDevices,
    revokeDevice,
    diagnostic,
    clearTokenAndRepair,
  } = useMediaHost();

  const [activeTab, setActiveTab] = useState<ActiveTab>("now_playing");
  const [sessionsOpen, setSessionsOpen] = useState<boolean>(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => loadThemeMode());

  useEffect(() => {
    applyThemeMode(themeMode);
  }, [themeMode]);

  const sessions = state?.sessions ?? [];
  const activeSession = useMemo(() => {
    if (sessions.length === 0) return null;
    if (state?.activeSessionId) {
      const found = sessions.find((s) => s.id === state.activeSessionId);
      if (found) return found;
    }
    return sessions[0];
  }, [sessions, state?.activeSessionId]);

  const chromeSessions = useMemo(
    () => sessions.filter((s) => s.source === "chrome"),
    [sessions],
  );

  const badge = connectionBadgeText(connectionStatus, isCachedState);

  return (
    <div
      className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col"
      style={{ backgroundColor: "var(--bg)", color: "var(--text)" }}
    >
      <header className="flex items-center justify-between gap-3 px-5 pb-3 pt-[calc(1rem+env(safe-area-inset-top))]">
        <div className="min-w-0">
          <h1 className="truncate text-[22px] font-bold tracking-tight" style={{ color: "var(--text)" }}>
            Central de Mídia
          </h1>
        </div>

        <span
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold"
          style={{
            backgroundColor: "var(--surface)",
            border: "1px solid var(--separator)",
            color: badge.color,
          }}
        >
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: badge.color }}
            aria-hidden="true"
          />
          <span>{badge.label}</span>
        </span>
      </header>

      <main className="flex-1 px-4 pb-28">
        {errorMessage ? (
          <div
            role="alert"
            className="mb-4 flex items-center justify-between gap-2 rounded-2xl px-4 py-3 text-sm font-medium"
            style={{
              backgroundColor: "var(--surface)",
              border: "1px solid var(--danger)",
              color: "var(--danger)",
            }}
          >
            <span className="min-w-0 flex-1">{errorMessage}</span>
            <button
              type="button"
              onClick={dismissError}
              aria-label="Fechar aviso de erro"
              className="touch-btn flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
              style={{ color: "var(--danger)" }}
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </div>
        ) : null}

        {connectionStatus === "pairing_required" ? (
          <PairingPlaceholder onRetry={reconnectNow} onPairWithPin={pairWithPin} />
        ) : activeTab === "now_playing" ? (
          <NowPlayingView
            session={activeSession}
            sessionCount={sessions.length}
            masterVolume={state?.masterVolume ?? null}
            receivedAtMs={receivedAtMs}
            isLoadingInitial={state === null && connectionStatus === "connecting"}
            onCommand={sendCommand}
            onVolume={sendVolume}
            onOpenSessions={() => setSessionsOpen(true)}
          />
        ) : activeTab === "search" ? (
          <SearchView
            extensionConnected={state?.extensionConnected ?? false}
            onSearch={searchYouTube}
            onPlayVideo={playVideo}
            onOpenFallback={(q) => sendOpen("youtube_search", { query: q })}
          />
        ) : activeTab === "volume" ? (
          <VolumeView
            masterVolume={state?.masterVolume ?? null}
            chromeSessions={chromeSessions}
            audioSessions={state?.audioSessions ?? []}
            onVolume={sendVolume}
          />
        ) : activeTab === "remote" ? (
          <RemoteInputView
            remoteInputEnabled={state?.remoteInputEnabled ?? false}
            onSendInput={sendInput}
            onSetRemoteInputEnabled={setRemoteInputEnabled}
            onOpenSettings={() => setActiveTab("more")}
          />
        ) : (
          <MoreView
            extensionConnected={state?.extensionConnected ?? false}
            connectionStatus={connectionStatus}
            themeMode={themeMode}
            onThemeChange={setThemeMode}
            onOpen={sendOpen}
            onCommand={sendCommand}
            onReconnect={reconnectNow}
            remoteInputEnabled={state?.remoteInputEnabled ?? false}
            onSetRemoteInputEnabled={setRemoteInputEnabled}
            pairedDevices={pairedDevices}
            onRefreshDevices={refreshPairedDevices}
            onRevokeDevice={revokeDevice}
            diagnostic={diagnostic}
            onClearTokenAndRepair={clearTokenAndRepair}
          />
        )}
      </main>

      <nav
        aria-label="Navegação principal"
        className="fixed bottom-0 left-1/2 z-40 grid w-full max-w-[430px] -translate-x-1/2 grid-cols-5 border-t px-1.5 pt-1.5 pb-[calc(0.45rem+env(safe-area-inset-bottom))]"
        style={{
          backgroundColor: "var(--surface)",
          borderColor: "var(--separator)",
        }}
      >
        <button
          type="button"
          onClick={() => setActiveTab("now_playing")}
          aria-current={activeTab === "now_playing" ? "page" : undefined}
          className="touch-btn flex min-h-[52px] flex-col items-center justify-center gap-0.5 rounded-2xl text-[11px] font-semibold"
          style={{
            color: activeTab === "now_playing" ? "var(--accent)" : "var(--text-secondary)",
          }}
        >
          <NowPlayingTabIcon className="h-5 w-5" />
          <span>Tocando</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("search")}
          aria-current={activeTab === "search" ? "page" : undefined}
          className="touch-btn flex min-h-[52px] flex-col items-center justify-center gap-0.5 rounded-2xl text-[11px] font-semibold"
          style={{
            color: activeTab === "search" ? "var(--accent)" : "var(--text-secondary)",
          }}
        >
          <SearchIcon className="h-5 w-5" />
          <span>Buscar</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("volume")}
          aria-current={activeTab === "volume" ? "page" : undefined}
          className="touch-btn flex min-h-[52px] flex-col items-center justify-center gap-0.5 rounded-2xl text-[11px] font-semibold"
          style={{
            color: activeTab === "volume" ? "var(--accent)" : "var(--text-secondary)",
          }}
        >
          <SlidersIcon className="h-5 w-5" />
          <span>Volume</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("remote")}
          aria-current={activeTab === "remote" ? "page" : undefined}
          className="touch-btn flex min-h-[52px] flex-col items-center justify-center gap-0.5 rounded-2xl text-[11px] font-semibold"
          style={{
            color: activeTab === "remote" ? "var(--accent)" : "var(--text-secondary)",
          }}
        >
          <TouchpadIcon className="h-5 w-5" />
          <span>Controle</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("more")}
          aria-current={activeTab === "more" ? "page" : undefined}
          className="touch-btn flex min-h-[52px] flex-col items-center justify-center gap-0.5 rounded-2xl text-[11px] font-semibold"
          style={{
            color: activeTab === "more" ? "var(--accent)" : "var(--text-secondary)",
          }}
        >
          <CompassIcon className="h-5 w-5" />
          <span>Mais</span>
        </button>
      </nav>

      <SessionSheet
        open={sessionsOpen}
        sessions={sessions}
        activeSessionId={activeSession?.id ?? state?.activeSessionId ?? null}
        onSelect={selectSession}
        onClose={() => setSessionsOpen(false)}
        onOpenFallbackTab={() => setActiveTab("more")}
      />
    </div>
  );
}

export default App;
