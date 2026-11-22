import { useMemo, type CSSProperties } from "react";
import { useOptimisticSlider } from "../hooks/useOptimisticSlider";
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

interface VolumeRowProps {
  target: string;
  title: string;
  subtitle: string;
  serverVolume: number;
  isMuted: boolean;
  onVolume: (target: string, opts: { value?: number; muted?: boolean }) => void;
  statusDot?: boolean;
  disabled?: boolean;
  muteAriaPrefix?: string;
}

function VolumeRow({
  target,
  title,
  subtitle,
  serverVolume,
  isMuted,
  onVolume,
  statusDot,
  disabled,
  muteAriaPrefix = "",
}: VolumeRowProps) {
  const slider = useOptimisticSlider({
    serverValue: serverVolume,
    onCommit: (val) => onVolume(target, { value: val }),
    throttleMs: 70,
    lockDurationMs: 400,
  });

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="min-w-0 flex items-center gap-2">
          {statusDot ? (
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: "var(--ok)" }}
            />
          ) : null}
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold" style={{ color: "var(--text)" }}>
              {title}
            </p>
            <p className="truncate text-xs" style={{ color: "var(--text-secondary)" }}>
              {subtitle}
            </p>
          </div>
        </div>
        <span
          className="shrink-0 text-xs font-semibold tabular-nums"
          style={{ color: isMuted ? "var(--danger)" : "var(--text-secondary)" }}
        >
          {isMuted ? "Mudo" : `${Math.round(slider.value * 100)}%`}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label={isMuted ? `Ativar som de ${title}` : `Silenciar ${muteAriaPrefix}${title}`}
          onClick={() => {
            triggerHaptic(8);
            onVolume(target, { muted: !isMuted });
          }}
          className="touch-btn flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
          style={{
            backgroundColor: isMuted ? "var(--accent-soft)" : "var(--surface-elevated)",
            border: "1px solid var(--hairline)",
            color: isMuted ? "var(--accent-text)" : "var(--text)",
          }}
        >
          {isMuted || slider.value === 0 ? (
            <VolumeMutedIcon className="h-5 w-5" />
          ) : (
            <VolumeIcon className="h-5 w-5" />
          )}
        </button>
        <input
          type="range"
          aria-label={`Volume de ${title}`}
          className="media-slider"
          min={0}
          max={1}
          step={0.01}
          disabled={disabled}
          value={slider.value}
          style={
            {
              "--slider-pct": `${isMuted ? 0 : Math.round(slider.value * 100)}%`,
            } as CSSProperties
          }
          onPointerDown={slider.onPointerDown}
          onChange={(e) => slider.onChange(Number(e.target.value))}
          onPointerUp={(e) => slider.onPointerUp(Number((e.target as HTMLInputElement).value))}
          onTouchEnd={(e) => slider.onPointerUp(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => slider.onPointerUp(Number((e.target as HTMLInputElement).value))}
        />
      </div>
    </div>
  );
}

export function VolumeView({
  masterVolume,
  chromeSessions,
  audioSessions,
  onVolume,
}: VolumeViewProps) {
  const masterSlider = useOptimisticSlider({
    serverValue: masterVolume?.level ?? 0.5,
    onCommit: (val) => onVolume("master", { value: val }),
    throttleMs: 70,
    lockDurationMs: 400,
  });

  const filteredAudioSessions = useMemo(() => {
    return audioSessions.filter((app) => {
      if (!app.active) return false;

      const proc = app.processName.toLowerCase();
      const name = app.app.toLowerCase();
      if (IRRELEVANT_SYSTEM_NAMES.has(proc) || IRRELEVANT_SYSTEM_NAMES.has(name)) {
        return false;
      }

      if (
        chromeSessions.length > 0 &&
        (CHROME_PROCESS_NAMES.has(proc) || CHROME_PROCESS_NAMES.has(name))
      ) {
        return false;
      }

      return true;
    });
  }, [audioSessions, chromeSessions.length]);

  const masterVal = masterSlider.value;
  const masterMuted = masterVolume?.muted ?? false;

  return (
    <div className="flex flex-col gap-3.5">
      {/* Master Volume */}
      <section className="card-surface p-5">
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
              border: "1px solid var(--hairline)",
              color: masterMuted ? "var(--accent-text)" : "var(--text)",
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
            style={
              {
                "--slider-pct": `${masterMuted ? 0 : Math.round(masterVal * 100)}%`,
              } as CSSProperties
            }
            onPointerDown={masterSlider.onPointerDown}
            onChange={(e) => masterSlider.onChange(Number(e.target.value))}
            onPointerUp={(e) =>
              masterSlider.onPointerUp(Number((e.target as HTMLInputElement).value))
            }
            onTouchEnd={(e) =>
              masterSlider.onPointerUp(Number((e.target as HTMLInputElement).value))
            }
            onKeyUp={(e) => masterSlider.onPointerUp(Number((e.target as HTMLInputElement).value))}
          />
        </div>
      </section>

      {/* Chrome Tabs Volume */}
      <section className="card-surface p-5">
        <h2 className="mb-3 text-base font-semibold" style={{ color: "var(--text)" }}>
          Abas do Chrome
        </h2>
        {chromeSessions.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            Nenhuma aba com mídia conectada pela extensão.
          </p>
        ) : (
          <div className="space-y-4">
            {chromeSessions.map((tab, idx) => (
              <div
                key={tab.id}
                className={idx > 0 ? "border-t pt-4" : ""}
                style={idx > 0 ? { borderColor: "var(--hairline)" } : undefined}
              >
                <VolumeRow
                  target={tab.id}
                  title={cleanMediaTitle(tab.title) || "Aba sem título"}
                  subtitle={tab.artist || "Google Chrome"}
                  serverVolume={tab.volume ?? 1}
                  isMuted={Boolean(tab.muted)}
                  onVolume={onVolume}
                  disabled={tab.volume === null}
                  muteAriaPrefix="aba "
                />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Windows Native Apps Volume */}
      <section className="card-surface p-5">
        <h2 className="mb-3 text-base font-semibold" style={{ color: "var(--text)" }}>
          Aplicativos (Windows)
        </h2>
        {filteredAudioSessions.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            Nenhum outro aplicativo com áudio ativo no momento.
          </p>
        ) : (
          <div className="space-y-4">
            {filteredAudioSessions.map((app, idx) => (
              <div
                key={app.id}
                className={idx > 0 ? "border-t pt-4" : ""}
                style={idx > 0 ? { borderColor: "var(--hairline)" } : undefined}
              >
                <VolumeRow
                  target={app.id}
                  title={app.app}
                  subtitle={app.processName}
                  serverVolume={app.volume}
                  isMuted={Boolean(app.muted)}
                  onVolume={onVolume}
                  statusDot
                />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
