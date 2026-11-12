import { useEffect, useState } from "react";
import type { MasterVolume, MediaAction, MediaSession } from "../types";
import {
  cleanMediaTitle,
  extrapolatePosition,
  formatTime,
  safeArtworkUrl,
  triggerHaptic,
} from "../utils";
import {
  FastForwardAdIcon,
  Forward10Icon,
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
  const [dragVol, setDragVol] = useState<number | null>(null);

  useEffect(() => {
    setDragPos(null);
  }, [session?.id]);

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

  const masterLevel = dragVol ?? masterVolume?.level ?? 0.5;
  const masterPct = Math.round(masterLevel * 100);
  const masterMuted = masterVolume?.muted ?? false;

  const originName = session
    ? session.source === "chrome"
      ? "Chrome"
      : session.app.replace(/\.exe$/i, "")
    : "Central";

  const cleanTitle = cleanMediaTitle(session?.title);

  const commitSeek = (nextPos: number) => {
    if (!session) return;
    setDragPos(null);
    onCommand(session.id, "seek", nextPos);
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="card-surface p-5 sm:p-6 shadow-[0_4px_20px_rgba(0,0,0,0.04)]">
        <div className="mb-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="inline-flex shrink-0 items-center rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap"
              style={{
                backgroundColor: "var(--surface-elevated)",
                color: "var(--text)",
              }}
            >
              {originName}
            </span>
            {session ? (
              <span
                className="text-xs font-medium"
                style={{ color: isPlaying ? "var(--accent)" : "var(--text-secondary)" }}
              >
                {STATUS_LABEL_PT[session.status] ?? session.status}
              </span>
            ) : null}
          </div>

          <button
            type="button"
            onClick={onOpenSessions}
            aria-label="Selecionar sessão de mídia"
            className="touch-btn inline-flex items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold shrink-0"
            style={{
              backgroundColor: "var(--accent-soft)",
              color: "var(--accent)",
            }}
          >
            <LayersIcon className="h-4 w-4" />
            <span>Sessões ({sessionCount})</span>
          </button>
        </div>

        {!session ? (
          <div className="flex flex-col items-center py-12 text-center">
            <div
              className="mb-4 flex h-24 w-24 items-center justify-center rounded-[24px]"
              style={{
                backgroundColor: "var(--surface-elevated)",
                color: "var(--text-secondary)",
              }}
            >
              <MusicNoteIcon className="h-10 w-10" />
            </div>
            <h2 className="text-lg font-semibold" style={{ color: "var(--text)" }}>
              {isLoadingInitial ? "Conectando ao PC..." : "Nenhuma mídia tocando"}
            </h2>
            <p className="mt-1.5 max-w-[28ch] text-sm" style={{ color: "var(--text-secondary)" }}>
              {isLoadingInitial
                ? "Buscando sessões ativas no notebook."
                : "Inicie YouTube, Spotify ou outro player no notebook para controlar por aqui."}
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {/* Featured Wide Artwork */}
            <div
              className="relative mx-auto w-full aspect-square max-h-[300px] overflow-hidden rounded-[24px] shadow-[0_10px_28px_rgba(0,0,0,0.14)]"
              style={{
                backgroundColor: "var(--surface-elevated)",
                border: "1px solid var(--separator)",
              }}
            >
              {artwork ? (
                <img
                  src={artwork}
                  alt={cleanTitle || "Capa da mídia"}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div
                  className="flex h-full w-full items-center justify-center"
                  style={{ color: "var(--text-secondary)" }}
                >
                  <MusicNoteIcon className="h-16 w-16 opacity-75" />
                </div>
              )}
            </div>

            {/* Title & Artist/Channel */}
            <div className="mt-5 text-left">
              <h2
                className="line-clamp-2 text-[21px] font-bold leading-snug tracking-tight"
                style={{ color: "var(--text)" }}
              >
                {cleanTitle || "Sem título"}
              </h2>
              <p
                className="mt-1 truncate text-[15px] font-medium"
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
                    color: "var(--accent)",
                    border: "1px solid var(--accent)",
                  }}
                >
                  <FastForwardAdIcon className="h-4 w-4" />
                  <span>Pular anúncio</span>
                </button>
              </div>
            ) : null}

            {/* Position Slider */}
            <div className="mt-3">
              <input
                type="range"
                aria-label="Posição de reprodução"
                className="media-slider"
                min={0}
                max={hasDuration ? session.duration : Math.max(100, currentPos)}
                step={0.5}
                value={Math.min(
                  currentPos,
                  hasDuration ? session.duration : Math.max(100, currentPos),
                )}
                disabled={!session.controls.seek || !hasDuration}
                onChange={(e) => setDragPos(Number(e.target.value))}
                onPointerUp={(e) => commitSeek(Number((e.target as HTMLInputElement).value))}
                onTouchEnd={(e) => commitSeek(Number((e.target as HTMLInputElement).value))}
                onKeyUp={(e) => commitSeek(Number((e.target as HTMLInputElement).value))}
              />
              <div
                className="-mt-1 flex items-center justify-between text-xs font-medium tabular-nums"
                style={{ color: "var(--text-secondary)" }}
              >
                <span>{formatTime(currentPos)}</span>
                <span>{hasDuration ? formatTime(session.duration) : "--:--"}</span>
              </div>
            </div>

            {/* Playback Controls — 72px main Play/Pause + grouped secondary */}
            <div className="mt-4 flex items-center justify-center gap-3">
              <button
                type="button"
                aria-label="Anterior"
                disabled={!session.controls.previous}
                onClick={() => onCommand(session.id, "previous")}
                className="touch-btn flex h-12 w-12 items-center justify-center rounded-full disabled:opacity-30"
                style={{
                  backgroundColor: "var(--surface-elevated)",
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
                className="touch-btn flex h-12 w-12 items-center justify-center rounded-full disabled:opacity-30"
                style={{
                  backgroundColor: "var(--surface-elevated)",
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
                className="touch-btn flex h-[72px] w-[72px] items-center justify-center rounded-full shadow-[0_4px_16px_var(--accent-soft)] disabled:opacity-30"
                style={{
                  backgroundColor: "var(--accent)",
                  color: "var(--accent-contrast)",
                }}
              >
                {isPlaying ? (
                  <PauseIcon className="h-8 w-8" />
                ) : (
                  <PlayIcon className="h-8 w-8 translate-x-0.5" />
                )}
              </button>

              <button
                type="button"
                aria-label="Avançar 10 segundos"
                disabled={!session.controls.seek}
                onClick={() => onCommand(session.id, "seek_relative", 10)}
                className="touch-btn flex h-12 w-12 items-center justify-center rounded-full disabled:opacity-30"
                style={{
                  backgroundColor: "var(--surface-elevated)",
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
                className="touch-btn flex h-12 w-12 items-center justify-center rounded-full disabled:opacity-30"
                style={{
                  backgroundColor: "var(--surface-elevated)",
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
      <section className="card-surface px-5 py-4 shadow-[0_4px_20px_rgba(0,0,0,0.04)]" aria-label="Volume geral do PC">
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
              color: masterMuted ? "var(--accent)" : "var(--text)",
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
            onChange={(e) => {
              const next = Number(e.target.value);
              setDragVol(next);
              onVolume("master", { value: next });
            }}
            onPointerUp={() => setDragVol(null)}
            onTouchEnd={() => setDragVol(null)}
          />
        </div>
      </section>
    </div>
  );
}
