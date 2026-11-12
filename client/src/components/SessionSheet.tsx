import { useEffect, useMemo } from "react";
import type { MediaSession } from "../types";
import { cleanMediaTitle, safeArtworkUrl } from "../utils";
import { CheckIcon, CloseIcon, MusicNoteIcon } from "./Icons";

interface SessionSheetProps {
  open: boolean;
  sessions: MediaSession[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onClose: () => void;
  onOpenFallbackTab: () => void;
}

export function SessionSheet({
  open,
  sessions,
  activeSessionId,
  onSelect,
  onClose,
  onOpenFallbackTab,
}: SessionSheetProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => {
      const aPlaying = a.status === "PLAYING" ? 1 : 0;
      const bPlaying = b.status === "PLAYING" ? 1 : 0;
      if (aPlaying !== bPlaying) return bPlaying - aPlaying;
      if (a.id === activeSessionId) return -1;
      if (b.id === activeSessionId) return 1;
      return 0;
    });
  }, [sessions, activeSessionId]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="Sessões de mídia disponíveis"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[430px] rounded-t-[28px] p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-xl"
        style={{
          backgroundColor: "var(--surface)",
          borderTop: "1px solid var(--separator)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold" style={{ color: "var(--text)" }}>
              Sessões ativas
            </h2>
            <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
              Escolha a aba do Chrome ou aplicativo para controlar
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar seletor de sessões"
            className="touch-btn flex h-11 w-11 items-center justify-center rounded-full"
            style={{
              backgroundColor: "var(--surface-elevated)",
              color: "var(--text)",
            }}
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[56dvh] space-y-2.5 overflow-y-auto pr-0.5">
          {sortedSessions.length === 0 ? (
            <p className="py-6 text-center text-sm" style={{ color: "var(--text-secondary)" }}>
              Nenhuma sessão ativa detectada no momento.
            </p>
          ) : (
            sortedSessions.map((s) => {
              const selected = s.id === activeSessionId;
              const isPlaying = s.status === "PLAYING";
              const thumb = safeArtworkUrl(s.artworkUrl);
              const title = cleanMediaTitle(s.title);
              const appLabel = s.source === "chrome" ? "Chrome" : s.app.replace(/\.exe$/i, "");
              const channelSubtitle = s.artist || s.album || "Sem canal";

              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    onSelect(s.id);
                    onClose();
                  }}
                  className="touch-btn flex w-full items-center gap-3 rounded-2xl p-3 text-left transition-all"
                  style={{
                    backgroundColor: selected ? "var(--accent-soft)" : "var(--surface-elevated)",
                    border: selected ? "1px solid var(--accent)" : "1px solid transparent",
                  }}
                >
                  {thumb ? (
                    <img
                      src={thumb}
                      alt=""
                      className="h-12 w-12 shrink-0 rounded-xl object-cover"
                    />
                  ) : (
                    <div
                      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl"
                      style={{
                        backgroundColor: "var(--surface)",
                        color: "var(--text-secondary)",
                      }}
                    >
                      <MusicNoteIcon className="h-5 w-5" />
                    </div>
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1">
                      <p
                        className="truncate text-sm font-semibold leading-tight"
                        style={{ color: "var(--text)" }}
                      >
                        {title || "Sem título"}
                      </p>
                      {isPlaying ? (
                        <div
                          className="flex h-3.5 w-3.5 shrink-0 items-end justify-center gap-[2px] pb-0.5"
                          title="Tocando agora"
                        >
                          <span
                            className="w-[2.5px] h-3 rounded-full animate-eq-1"
                            style={{ backgroundColor: "var(--ok)" }}
                          />
                          <span
                            className="w-[2.5px] h-3 rounded-full animate-eq-2"
                            style={{ backgroundColor: "var(--ok)" }}
                          />
                          <span
                            className="w-[2.5px] h-3 rounded-full animate-eq-3"
                            style={{ backgroundColor: "var(--ok)" }}
                          />
                        </div>
                      ) : (
                        <span
                          className="shrink-0 text-[11px] font-medium"
                          style={{ color: "var(--text-secondary)" }}
                        >
                          Pausado
                        </span>
                      )}
                    </div>

                    <p className="mt-0.5 truncate text-xs" style={{ color: "var(--text-secondary)" }}>
                      <span>{channelSubtitle}</span>
                      <span className="opacity-60 font-normal"> • {appLabel}</span>
                    </p>
                  </div>

                  {selected ? (
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                      style={{
                        backgroundColor: "var(--accent)",
                        color: "var(--accent-contrast)",
                      }}
                    >
                      <CheckIcon className="h-4 w-4" />
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>

        <button
          type="button"
          onClick={() => {
            onClose();
            onOpenFallbackTab();
          }}
          className="touch-btn mt-3 flex w-full items-center justify-center rounded-2xl px-4 text-sm font-medium"
          style={{
            backgroundColor: "var(--surface-elevated)",
            color: "var(--text)",
          }}
        >
          Usar teclas globais (VLC / fallback)
        </button>
      </div>
    </div>
  );
}
