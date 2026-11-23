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

  useEffect(() => {
    if (typeof window !== "undefined" && window.scrollY > 0) {
      window.scrollTo({ top: 0, behavior: "auto" });
    }
  }, [activeTab]);

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
      <header
        className="sticky top-0 z-30 flex items-center justify-between gap-2 border-b px-4 min-[360px]:px-5 pb-3 pt-[calc(0.85rem+env(safe-area-inset-top))] backdrop-blur-xl"
        style={{
          backgroundColor: "var(--surface-glass)",
          borderColor: "var(--hairline)",
        }}
      >
        <div className="min-w-0">
          <h1
            className="whitespace-nowrap truncate text-[18px] min-[360px]:text-[21px] font-bold tracking-[-0.025em]"
            style={{ color: "var(--text)" }}
          >
            Central de Mídia
          </h1>
        </div>

        <span
          role="status"
          aria-live="polite"
          className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 min-[360px]:px-3 py-1.5 text-[11px] min-[360px]:text-xs font-semibold"
          style={{
            backgroundColor: "var(--surface)",
            border: "1px solid var(--hairline)",
            boxShadow: "var(--shadow-pill)",
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

      <main
        className={
          connectionStatus === "pairing_required"
            ? "flex-1 px-4 pt-3 pb-8"
            : "flex-1 px-4 pt-3 pb-[calc(6rem+env(safe-area-inset-bottom))]"
        }
      >
        {errorMessage ? (
          <div
            role="alert"
            aria-live="polite"
            className="mb-4 flex items-center justify-between gap-2 rounded-2xl px-4 py-3 text-sm font-medium"
            style={{
              backgroundColor: "var(--danger-soft)",
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
          <div key="now_playing" className="view-enter">
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
          </div>
        ) : activeTab === "search" ? (
          <div key="search" className="view-enter">
            <SearchView
              extensionConnected={state?.extensionConnected ?? false}
              onSearch={searchYouTube}
              onPlayVideo={playVideo}
              onOpenFallback={(q) => sendOpen("youtube_search", { query: q })}
            />
          </div>
        ) : activeTab === "volume" ? (
          <div key="volume" className="view-enter">
            <VolumeView
              masterVolume={state?.masterVolume ?? null}
              chromeSessions={chromeSessions}
              audioSessions={state?.audioSessions ?? []}
              onVolume={sendVolume}
            />
          </div>
        ) : activeTab === "remote" ? (
          <div key="remote" className="view-enter">
            <RemoteInputView
              remoteInputEnabled={state?.remoteInputEnabled ?? false}
              screenMirrorAvailable={state?.screenMirrorAvailable ?? true}
              onSendInput={sendInput}
              onSetRemoteInputEnabled={setRemoteInputEnabled}
              onOpenSettings={() => setActiveTab("more")}
            />
          </div>
        ) : (
          <div key="more" className="view-enter">
            <MoreView
              extensionConnected={state?.extensionConnected ?? false}
              connectionStatus={connectionStatus}
              themeMode={themeMode}
              onThemeChange={setThemeMode}
              onOpen={sendOpen}
              onCommand={sendCommand}
              onReconnect={reconnectNow}
              remoteInputEnabled={state?.remoteInputEnabled ?? false}
              tailscaleEnabled={state?.tailscaleEnabled ?? false}
              onSetRemoteInputEnabled={setRemoteInputEnabled}
              pairedDevices={pairedDevices}
              onRefreshDevices={refreshPairedDevices}
              onRevokeDevice={revokeDevice}
              diagnostic={diagnostic}
              onClearTokenAndRepair={clearTokenAndRepair}
            />
          </div>
        )}
      </main>

      {connectionStatus !== "pairing_required" ? (
        <nav
          aria-label="Navegação principal"
          className="fixed bottom-0 left-1/2 z-40 grid w-full max-w-[430px] -translate-x-1/2 grid-cols-5 gap-1 border-t px-2 pt-1.5 pb-[calc(0.45rem+env(safe-area-inset-bottom))] backdrop-blur-xl"
          style={{
            backgroundColor: "var(--surface-glass)",
            borderColor: "var(--hairline)",
          }}
        >
          <button
            type="button"
            onClick={() => setActiveTab("now_playing")}
            aria-current={activeTab === "now_playing" ? "page" : undefined}
            className="touch-btn flex min-h-[50px] flex-col items-center justify-center gap-0.5 rounded-2xl text-[11px] font-semibold"
            style={{
              backgroundColor: activeTab === "now_playing" ? "var(--accent-soft)" : "transparent",
              color: activeTab === "now_playing" ? "var(--accent-text)" : "var(--text-secondary)",
            }}
          >
            <NowPlayingTabIcon className="h-5 w-5" />
            <span>Tocando</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("search")}
            aria-current={activeTab === "search" ? "page" : undefined}
            className="touch-btn flex min-h-[50px] flex-col items-center justify-center gap-0.5 rounded-2xl text-[11px] font-semibold"
            style={{
              backgroundColor: activeTab === "search" ? "var(--accent-soft)" : "transparent",
              color: activeTab === "search" ? "var(--accent-text)" : "var(--text-secondary)",
            }}
          >
            <SearchIcon className="h-5 w-5" />
            <span>Buscar</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("volume")}
            aria-current={activeTab === "volume" ? "page" : undefined}
            className="touch-btn flex min-h-[50px] flex-col items-center justify-center gap-0.5 rounded-2xl text-[11px] font-semibold"
            style={{
              backgroundColor: activeTab === "volume" ? "var(--accent-soft)" : "transparent",
              color: activeTab === "volume" ? "var(--accent-text)" : "var(--text-secondary)",
            }}
          >
            <SlidersIcon className="h-5 w-5" />
            <span>Volume</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("remote")}
            aria-current={activeTab === "remote" ? "page" : undefined}
            className="touch-btn flex min-h-[50px] flex-col items-center justify-center gap-0.5 rounded-2xl text-[11px] font-semibold"
            style={{
              backgroundColor: activeTab === "remote" ? "var(--accent-soft)" : "transparent",
              color: activeTab === "remote" ? "var(--accent-text)" : "var(--text-secondary)",
            }}
          >
            <TouchpadIcon className="h-5 w-5" />
            <span>Controle</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("more")}
            aria-current={activeTab === "more" ? "page" : undefined}
            className="touch-btn flex min-h-[50px] flex-col items-center justify-center gap-0.5 rounded-2xl text-[11px] font-semibold"
            style={{
              backgroundColor: activeTab === "more" ? "var(--accent-soft)" : "transparent",
              color: activeTab === "more" ? "var(--accent-text)" : "var(--text-secondary)",
            }}
          >
            <CompassIcon className="h-5 w-5" />
            <span>Mais</span>
          </button>
        </nav>
      ) : null}

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
