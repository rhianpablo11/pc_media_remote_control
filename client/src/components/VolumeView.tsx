import { useMemo, useState } from "react";
import type { AudioSession, MasterVolume, MediaSession } from "../types";
import { cleanMediaTitle, triggerHaptic } from "../utils";
import { VolumeIcon, VolumeMutedIcon } from "./Icons";

interface VolumeViewProps {
  masterVolume: MasterVolume | null;
  chromeSessions: MediaSession[];
  audioSessions: AudioSession[];
  onVolume: (target: string, opts: { value?: number; muted?: boolean }) => void;
}

const IRRELEVANT_SYSTEM_NAMES = new Set([
  "systemsounds",
  "sons do sistema",
  "windowsterminal.exe",
  "windowsterminal",
  "terminal",
  "powershell.exe",
  "powershell",
  "cmd.exe",
  "cmd",
  "conhost.exe",
  "conhost",
  "openconsole.exe",
  "openconsole",
  "bash.exe",
  "wsl.exe",
]);

const CHROME_PROCESS_NAMES = new Set([
  "chrome.exe",
  "chrome",
  "google chrome",
]);

export function VolumeView({
  masterVolume,
  chromeSessions,
  audioSessions,
  onVolume,
}: VolumeViewProps) {
  const [draftValues, setDraftValues] = useState<Record<string, number>>({});

  const setDraft = (target: string, val: number) => {
    setDraftValues((prev) => ({ ...prev, [target]: val }));
    onVolume(target, { value: val });
  };

  const clearDraft = (target: string) => {
    setDraftValues((prev) => {
      if (!(target in prev)) return prev;
      const copy = { ...prev };
      delete copy[target];
      return copy;
    });
  };

  const filteredAudioSessions = useMemo(() => {
    return audioSessions.filter((app) => {
      // 1. Ocultar apps sem sessão de áudio ativa
      if (!app.active) return false;

      // 2. Ocultar entradas de sistema irrelevantes (Sons do Sistema, terminal, etc.)
      const proc = app.processName.toLowerCase();
      const name = app.app.toLowerCase();
      if (IRRELEVANT_SYSTEM_NAMES.has(proc) || IRRELEVANT_SYSTEM_NAMES.has(name)) {
        return false;
      }

      // 3. Evitar que Chrome apareça duplicado como 'aba' e como 'app'
      if (
        chromeSessions.length > 0 &&
        (CHROME_PROCESS_NAMES.has(proc) || CHROME_PROCESS_NAMES.has(name))
      ) {
        return false;
      }

      return true;
    });
  }, [audioSessions, chromeSessions.length]);

  const masterVal = draftValues.master ?? masterVolume?.level ?? 0.5;
  const masterMuted = masterVolume?.muted ?? false;

  return (
    <div className="flex flex-col gap-4">
      {/* Master Volume */}
      <section className="card-surface p-5 shadow-[0_4px_20px_rgba(0,0,0,0.04)]">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>
              Volume Geral
            </h2>
            <p className="truncate text-xs" style={{ color: "var(--text-secondary)" }}>
              {masterVolume?.deviceName || "Dispositivo padrão do Windows"}
            </p>
          </div>
          <span
            className="text-sm font-semibold tabular-nums"
            style={{ color: masterMuted ? "var(--danger)" : "var(--text)" }}
          >
            {masterMuted ? "Mudo" : `${Math.round(masterVal * 100)}%`}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label={masterMuted ? "Ativar som geral" : "Silenciar volume geral"}
            disabled={!masterVolume}
            onClick={() => {
              triggerHaptic(8);
              onVolume("master", { muted: !masterMuted });
            }}
            className="touch-btn flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
            style={{
              backgroundColor: masterMuted ? "var(--accent-soft)" : "var(--surface-elevated)",
              color: masterMuted ? "var(--accent)" : "var(--text)",
            }}
          >
            {masterMuted || masterVal === 0 ? (
              <VolumeMutedIcon className="h-5 w-5" />
            ) : (
              <VolumeIcon className="h-5 w-5" />
            )}
          </button>
          <input
            type="range"
            aria-label="Slider do volume geral"
            className="media-slider"
            min={0}
            max={1}
            step={0.01}
            disabled={!masterVolume}
            value={masterVal}
            onChange={(e) => setDraft("master", Number(e.target.value))}
            onPointerUp={() => clearDraft("master")}
            onTouchEnd={() => clearDraft("master")}
          />
        </div>
      </section>

      {/* Chrome Tabs Volume */}
      <section className="card-surface p-5 shadow-[0_4px_20px_rgba(0,0,0,0.04)]">
        <h2 className="mb-3 text-base font-semibold" style={{ color: "var(--text)" }}>
          Abas do Chrome
        </h2>
        {chromeSessions.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            Nenhuma aba com mídia conectada pela extensão.
          </p>
        ) : (
          <div className="space-y-4">
            {chromeSessions.map((tab, idx) => {
              const current = draftValues[tab.id] ?? tab.volume ?? 1;
              const isMuted = Boolean(tab.muted);
              const title = cleanMediaTitle(tab.title);
              return (
                <div
                  key={tab.id}
                  className={idx > 0 ? "pt-4 border-t border-[var(--separator)]/40" : ""}
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold" style={{ color: "var(--text)" }}>
                        {title || "Aba sem título"}
                      </p>
                      <p className="truncate text-xs" style={{ color: "var(--text-secondary)" }}>
                        {tab.artist || "Google Chrome"}
                      </p>
                    </div>
                    <span
                      className="shrink-0 text-xs font-semibold tabular-nums"
                      style={{ color: isMuted ? "var(--danger)" : "var(--text-secondary)" }}
                    >
                      {isMuted ? "Aba muda" : `${Math.round(current * 100)}%`}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      aria-label={isMuted ? `Ativar som de ${title}` : `Silenciar aba ${title}`}
                      onClick={() => {
                        triggerHaptic(8);
                        onVolume(tab.id, { muted: !isMuted });
                      }}
                      className="touch-btn flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
                      style={{
                        backgroundColor: isMuted ? "var(--accent-soft)" : "var(--surface-elevated)",
                        color: isMuted ? "var(--accent)" : "var(--text)",
                      }}
                    >
                      {isMuted ? (
                        <VolumeMutedIcon className="h-5 w-5" />
                      ) : (
                        <VolumeIcon className="h-5 w-5" />
                      )}
                    </button>
                    <input
                      type="range"
                      aria-label={`Volume da aba ${title}`}
                      className="media-slider"
                      min={0}
                      max={1}
                      step={0.01}
                      disabled={tab.volume === null}
                      value={current}
                      onChange={(e) => setDraft(tab.id, Number(e.target.value))}
                      onPointerUp={() => clearDraft(tab.id)}
                      onTouchEnd={() => clearDraft(tab.id)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Windows Native Apps Volume (Filtered: only active, no system spam, no duplicate Chrome) */}
      <section className="card-surface p-5 shadow-[0_4px_20px_rgba(0,0,0,0.04)]">
        <h2 className="mb-3 text-base font-semibold" style={{ color: "var(--text)" }}>
          Aplicativos (Windows)
        </h2>
        {filteredAudioSessions.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            Nenhum outro aplicativo com áudio ativo no momento.
          </p>
        ) : (
          <div className="space-y-4">
            {filteredAudioSessions.map((app, idx) => {
              const current = draftValues[app.id] ?? app.volume;
              return (
                <div
                  key={app.id}
                  className={idx > 0 ? "pt-4 border-t border-[var(--separator)]/40" : ""}
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <div className="min-w-0 flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: "var(--ok)" }}
                      />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold" style={{ color: "var(--text)" }}>
                          {app.app}
                        </p>
                        <p className="truncate text-xs" style={{ color: "var(--text-secondary)" }}>
                          {app.processName}
                        </p>
                      </div>
                    </div>
                    <span
                      className="shrink-0 text-xs font-semibold tabular-nums"
                      style={{ color: app.muted ? "var(--danger)" : "var(--text-secondary)" }}
                    >
                      {app.muted ? "Mudo" : `${Math.round(current * 100)}%`}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      aria-label={app.muted ? `Ativar som de ${app.app}` : `Silenciar ${app.app}`}
                      onClick={() => {
                        triggerHaptic(8);
                        onVolume(app.id, { muted: !app.muted });
                      }}
                      className="touch-btn flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
                      style={{
                        backgroundColor: app.muted ? "var(--accent-soft)" : "var(--surface-elevated)",
                        color: app.muted ? "var(--accent)" : "var(--text)",
                      }}
                    >
                      {app.muted ? (
                        <VolumeMutedIcon className="h-5 w-5" />
                      ) : (
                        <VolumeIcon className="h-5 w-5" />
                      )}
                    </button>
                    <input
                      type="range"
                      aria-label={`Volume de ${app.app}`}
                      className="media-slider"
                      min={0}
                      max={1}
                      step={0.01}
                      value={current}
                      onChange={(e) => setDraft(app.id, Number(e.target.value))}
                      onPointerUp={() => clearDraft(app.id)}
                      onTouchEnd={() => clearDraft(app.id)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
