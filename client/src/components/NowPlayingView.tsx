import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useOptimisticSlider } from "../hooks/useOptimisticSlider";
import type { MasterVolume, MediaAction, MediaSession } from "../types";
import {
  cleanMediaTitle,
  extrapolatePosition,
  formatTime,
  safeArtworkUrl,
  triggerHaptic,
} from "../utils";
import {
  ExitFullscreenIcon,
  FastForwardAdIcon,
  Forward10Icon,
  FullscreenIcon,
  LayersIcon,
  MusicNoteIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PreviousIcon,
  Replay10Icon,
  VolumeIcon,
  VolumeMutedIcon,
} from "./Icons";

interface NowPlayingViewProps {
  session: MediaSession | null;
  sessionCount: number;
  masterVolume: MasterVolume | null;
  receivedAtMs: number;
  isLoadingInitial: boolean;
  onCommand: (sessionId: string, action: MediaAction, value?: number) => void;
  onVolume: (target: string, opts: { value?: number; muted?: boolean }) => void;
  onOpenSessions: () => void;
}

const STATUS_LABEL_PT: Record<string, string> = {
  PLAYING: "Tocando",
  PAUSED: "Pausado",
  STOPPED: "Parado",
  CHANGING: "Carregando",
  OPENED: "Aberto",
  CLOSED: "Fechado",
  UNKNOWN: "Indefinido",
};

export function NowPlayingView({
  session,
  sessionCount,
  masterVolume,
  receivedAtMs,
  isLoadingInitial,
  onCommand,
  onVolume,
  onOpenSessions,
}: NowPlayingViewProps) {
  const [tickNowMs, setTickNowMs] = useState<number>(() => Date.now());
  const [dragPos, setDragPos] = useState<number | null>(null);
  const seekLockUntilRef = useRef<number>(0);

  const masterSlider = useOptimisticSlider({
    serverValue: masterVolume?.level ?? 0.5,
    onCommit: (val) => onVolume("master", { value: val }),
    throttleMs: 70,
    lockDurationMs: 400,
  });

  useEffect(() => {
    if (Date.now() >= seekLockUntilRef.current) {
      setDragPos(null);
    }
  }, [session?.id, session?.position]);

  useEffect(() => {
    if (!session || session.status !== "PLAYING" || dragPos !== null) {
      return;
    }
    setTickNowMs(Date.now());
    const timer = window.setInterval(() => {
      setTickNowMs(Date.now());
    }, 250);
    return () => window.clearInterval(timer);
  }, [session?.id, session?.status, session?.position, dragPos]);

  const artwork = safeArtworkUrl(session?.artworkUrl);
  const [failedArtworkUrl, setFailedArtworkUrl] = useState<string | null>(null);
  const effectiveArtwork = artwork && artwork !== failedArtworkUrl ? artwork : null;
  const isPlaying = session?.status === "PLAYING";
  const hasDuration = Boolean(session && session.duration > 0);
  const currentPos = session
    ? dragPos ??
      extrapolatePosition({
        position: session.position,
        duration: session.duration,
        status: session.status,
        receivedAtMs,
        nowMs: tickNowMs,
      })
    : 0;

  const seekMax = hasDuration ? session!.duration : Math.max(100, currentPos);
  const seekValue = Math.min(currentPos, seekMax);
  const seekPct = hasDuration && seekMax > 0 ? Math.min(100, Math.max(0, (seekValue / seekMax) * 100)) : 0;

  const masterLevel = masterSlider.value;
  const masterPct = Math.round(masterLevel * 100);
  const masterMuted = masterVolume?.muted ?? false;
  const masterSliderPct = masterMuted ? 0 : Math.min(100, Math.max(0, masterLevel * 100));

  const originName = session
    ? session.source === "chrome"
      ? "Chrome"
      : session.app.replace(/\.exe$/i, "")
    : "Central";

  const cleanTitle = cleanMediaTitle(session?.title);

  const commitSeek = (nextPos: number) => {
    if (!session) return;
    setDragPos(nextPos);
    seekLockUntilRef.current = Date.now() + 500;
    onCommand(session.id, "seek", nextPos);
  };

  return (
    <div className="flex flex-col gap-3.5">
      <section className="card-surface p-4 min-[360px]:p-5">
        <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="inline-flex shrink-0 items-center rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap"
              style={{
                backgroundColor: "var(--surface-elevated)",
                border: "1px solid var(--hairline)",
                color: "var(--text)",
              }}
            >
              {originName}
            </span>
            {session ? (
              <span
                className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs font-semibold"
                style={{ color: isPlaying ? "var(--accent-text)" : "var(--text-secondary)" }}
              >
                {isPlaying ? (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: "var(--accent-text)" }}
                    aria-hidden="true"
                  />
                ) : null}
                <span>{STATUS_LABEL_PT[session.status] ?? session.status}</span>
              </span>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {session && (session.controls.fullscreen ?? true) ? (
              <button
                type="button"
                onClick={() => onCommand(session.id, "toggle_fullscreen")}
                aria-label={session.isFullscreen ? "Sair da tela cheia" : "Tela cheia"}
                title={session.isFullscreen ? "Sair da tela cheia" : "Tela cheia"}
                className="touch-btn inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 min-[360px]:px-3 py-1 text-xs font-semibold"
                style={{
                  backgroundColor: session.isFullscreen ? "var(--accent)" : "var(--surface-elevated)",
                  border: session.isFullscreen ? "1px solid transparent" : "1px solid var(--hairline)",
                  color: session.isFullscreen ? "var(--accent-contrast)" : "var(--text)",
                }}
              >
                {session.isFullscreen ? (
                  <ExitFullscreenIcon className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <FullscreenIcon className="h-3.5 w-3.5 shrink-0" />
                )}
                <span>Tela cheia</span>
              </button>
            ) : null}

            <button
              type="button"
              onClick={onOpenSessions}
              aria-label="Selecionar sessão de mídia"
              className="touch-btn inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 min-[360px]:px-3.5 text-xs font-semibold"
              style={{
                backgroundColor: "var(--accent-soft)",
                border: "1px solid var(--hairline)",
                color: "var(--accent-text)",
              }}
            >
              <LayersIcon className="h-4 w-4 shrink-0" />
              <span className="tabular-nums">Sessões ({sessionCount})</span>
            </button>
          </div>
        </div>

        {!session ? (
          <div className="flex flex-col items-center py-10 text-center">
            <div
              className="mb-4 flex h-20 w-20 items-center justify-center rounded-[22px] border"
              style={{
                backgroundColor: "var(--surface-elevated)",
                borderColor: "var(--hairline)",
                color: "var(--text-secondary)",
              }}
            >
              <MusicNoteIcon className="h-9 w-9" />
            </div>
            <h2 className="text-lg font-semibold" style={{ color: "var(--text)" }}>
              {isLoadingInitial ? "Conectando ao PC..." : "Nenhuma mídia tocando"}
            </h2>
            <p className="mt-1.5 max-w-[30ch] text-sm text-pretty" style={{ color: "var(--text-secondary)" }}>
              {isLoadingInitial
                ? "Buscando sessões ativas no notebook."
                : "Inicie YouTube, Spotify ou outro player no notebook para controlar por aqui."}
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {/* Cinema-proportioned Artwork Stage */}
            <div
              className="relative mx-auto aspect-[16/10] max-h-[168px] min-[400px]:max-h-[184px] w-full overflow-hidden rounded-[20px]"
              style={{
                backgroundColor: "var(--surface-elevated)",
                border: "1px solid var(--hairline)",
                boxShadow: "var(--shadow-media)",
              }}
            >
              {effectiveArtwork ? (
                <img
                  src={effectiveArtwork}
                  alt={cleanTitle || "Capa da mídia"}
                  width={640}
                  height={400}
                  decoding="async"
                  onError={() => setFailedArtworkUrl(effectiveArtwork)}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div
                  className="flex h-full w-full items-center justify-center"
                  style={{ color: "var(--text-secondary)" }}
                >
                  <MusicNoteIcon className="h-14 w-14 opacity-70" />
                </div>
              )}

              {isPlaying ? (
                <div
                  className="absolute bottom-2.5 right-2.5 flex h-7 items-center gap-[3px] rounded-full px-2.5 backdrop-blur-md"
                  style={{ backgroundColor: "var(--pill-duration-bg)" }}
                  aria-hidden="true"
                >
                  <span className="h-3 w-[2.5px] rounded-full bg-white animate-eq-1" />
                  <span className="h-3 w-[2.5px] rounded-full bg-white animate-eq-2" />
                  <span className="h-3 w-[2.5px] rounded-full bg-white animate-eq-3" />
                </div>
              ) : null}
            </div>

            {/* Title & Artist/Channel */}
            <div className="mt-4 text-left">
              <h2
                className="line-clamp-2 text-[20px] font-bold leading-snug tracking-tight"
                style={{ color: "var(--text)" }}
              >
                {cleanTitle || "Sem título"}
              </h2>
              <p
                className="mt-0.5 truncate text-sm font-medium"
                style={{ color: "var(--text-secondary)" }}
              >
                {[session.artist, session.album].filter(Boolean).join(" • ") ||
                  (session.source === "chrome" ? "Aba do Chrome" : originName)}
              </p>
            </div>

            {session.controls.skipAd ? (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => onCommand(session.id, "skip_ad")}
                  className="touch-btn flex w-full items-center justify-center gap-2 rounded-2xl px-4 text-sm font-semibold"
                  style={{
                    backgroundColor: "var(--accent-soft)",
                    color: "var(--accent-text)",
                    border: "1px solid var(--accent-text)",
                  }}
                >
                  <FastForwardAdIcon className="h-4 w-4" />
                  <span>Pular anúncio</span>
                </button>
              </div>
            ) : null}

            {/* Position Slider */}
            <div className="mt-2.5">
              <input
                type="range"
                aria-label="Posição de reprodução"
                className="media-slider"
                min={0}
                max={seekMax}
                step={0.5}
                value={seekValue}
                disabled={!session.controls.seek || !hasDuration}
                style={{ "--slider-pct": `${seekPct.toFixed(1)}%` } as CSSProperties}
                onChange={(e) => setDragPos(Number(e.target.value))}
                onPointerUp={(e) => commitSeek(Number((e.target as HTMLInputElement).value))}
                onTouchEnd={(e) => commitSeek(Number((e.target as HTMLInputElement).value))}
                onKeyUp={(e) => commitSeek(Number((e.target as HTMLInputElement).value))}
              />
              <div
                className="-mt-1.5 flex items-center justify-between text-xs font-medium tabular-nums"
                style={{ color: "var(--text-secondary)" }}
              >
                <span>{formatTime(currentPos)}</span>
                <span>{hasDuration ? formatTime(session.duration) : "--:--"}</span>
              </div>
            </div>

            {/* Playback Controls — Hero Play/Pause + crisp tonal secondary deck */}
            <div className="mt-3.5 flex items-center justify-center gap-1.5 min-[360px]:gap-3">
              <button
                type="button"
                aria-label="Anterior"
                disabled={!session.controls.previous}
                onClick={() => onCommand(session.id, "previous")}
                className="touch-btn flex h-11 w-11 min-[360px]:h-12 min-[360px]:w-12 shrink-0 items-center justify-center rounded-full disabled:opacity-35"
                style={{
                  backgroundColor: "var(--surface-elevated)",
                  border: "1px solid var(--hairline)",
                  color: "var(--text)",
                }}
              >
                <PreviousIcon className="h-5 w-5" />
              </button>

              <button
                type="button"
                aria-label="Voltar 10 segundos"
                disabled={!session.controls.seek}
                onClick={() => onCommand(session.id, "seek_relative", -10)}
                className="touch-btn flex h-11 w-11 min-[360px]:h-12 min-[360px]:w-12 shrink-0 items-center justify-center rounded-full disabled:opacity-35"
                style={{
                  backgroundColor: "var(--surface-elevated)",
                  border: "1px solid var(--hairline)",
                  color: "var(--text)",
                }}
              >
                <Replay10Icon className="h-6 w-6" />
              </button>

              <button
                type="button"
                aria-label={isPlaying ? "Pausar" : "Reproduzir"}
                disabled={
                  !session.controls.toggle && !session.controls.play && !session.controls.pause
                }
                onClick={() => {
                  const action: MediaAction = isPlaying
                    ? session.controls.pause
                      ? "pause"
                      : "toggle"
                    : session.controls.play
                      ? "play"
                      : "toggle";
                  onCommand(session.id, action);
                }}
                className="touch-btn flex h-14 w-14 min-[360px]:h-[68px] min-[360px]:w-[68px] shrink-0 items-center justify-center rounded-full disabled:opacity-35"
                style={{
                  backgroundColor: "var(--accent)",
                  color: "var(--accent-contrast)",
                  boxShadow: "var(--shadow-play)",
                }}
              >
                {isPlaying ? (
                  <PauseIcon className="h-7 w-7 min-[360px]:h-8 min-[360px]:w-8" />
                ) : (
                  <PlayIcon className="h-7 w-7 min-[360px]:h-8 min-[360px]:w-8 translate-x-0.5" />
                )}
              </button>

              <button
                type="button"
                aria-label="Avançar 10 segundos"
                disabled={!session.controls.seek}
                onClick={() => onCommand(session.id, "seek_relative", 10)}
                className="touch-btn flex h-11 w-11 min-[360px]:h-12 min-[360px]:w-12 shrink-0 items-center justify-center rounded-full disabled:opacity-35"
                style={{
                  backgroundColor: "var(--surface-elevated)",
                  border: "1px solid var(--hairline)",
                  color: "var(--text)",
                }}
              >
                <Forward10Icon className="h-6 w-6" />
              </button>

              <button
                type="button"
                aria-label="Próximo"
                disabled={!session.controls.next}
                onClick={() => onCommand(session.id, "next")}
                className="touch-btn flex h-11 w-11 min-[360px]:h-12 min-[360px]:w-12 shrink-0 items-center justify-center rounded-full disabled:opacity-35"
                style={{
                  backgroundColor: "var(--surface-elevated)",
                  border: "1px solid var(--hairline)",
                  color: "var(--text)",
                }}
              >
                <NextIcon className="h-5 w-5" />
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Master Volume Section */}
      <section className="card-surface px-5 py-3.5" aria-label="Volume geral do PC">
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <span className="text-sm font-semibold" style={{ color: "var(--text)" }}>
              Volume Geral
            </span>
            {masterVolume?.deviceName ? (
              <p className="truncate text-xs" style={{ color: "var(--text-secondary)" }}>
                {masterVolume.deviceName}
              </p>
            ) : null}
          </div>
          <span
            className="text-sm font-semibold tabular-nums"
            style={{ color: masterMuted ? "var(--danger)" : "var(--text-secondary)" }}
          >
            {masterMuted ? "Mudo" : `${masterPct}%`}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label={masterMuted ? "Ativar som geral" : "Silenciar som geral"}
            disabled={!masterVolume}
            onClick={() => {
              triggerHaptic(8);
              onVolume("master", { muted: !masterMuted });
            }}
            className="touch-btn flex h-11 w-11 shrink-0 items-center justify-center rounded-full disabled:opacity-40"
            style={{
              backgroundColor: masterMuted ? "var(--accent-soft)" : "var(--surface-elevated)",
              border: "1px solid var(--hairline)",
              color: masterMuted ? "var(--accent-text)" : "var(--text)",
            }}
          >
            {masterMuted || masterLevel === 0 ? (
              <VolumeMutedIcon className="h-5 w-5" />
            ) : (
              <VolumeIcon className="h-5 w-5" />
            )}
          </button>

          <input
            type="range"
            aria-label="Controle de volume geral"
            className="media-slider"
            min={0}
            max={1}
            step={0.01}
            disabled={!masterVolume}
            value={masterLevel}
            style={{ "--slider-pct": `${masterSliderPct.toFixed(1)}%` } as CSSProperties}
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
    </div>
  );
}
