import { useState, type FormEvent } from "react";
import type { ConnectionStatus, MediaAction, ThemeMode } from "../types";
import { NextIcon, PauseIcon, PlayIcon, PreviousIcon } from "./Icons";

interface MoreViewProps {
  extensionConnected: boolean;
  connectionStatus: ConnectionStatus;
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  onOpen: (mode: "youtube_search" | "url", payload: { query?: string; url?: string }) => boolean;
  onCommand: (sessionId: string, action: MediaAction) => void;
  onReconnect: () => void;
}

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "auto", label: "Automático" },
  { value: "light", label: "Claro" },
  { value: "dark", label: "Escuro" },
];

export function MoreView({
  extensionConnected,
  connectionStatus,
  themeMode,
  onThemeChange,
  onOpen,
  onCommand,
  onReconnect,
}: MoreViewProps) {
  const [ytQuery, setYtQuery] = useState("");
  const [openUrl, setOpenUrl] = useState("");

  const submitYoutube = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = ytQuery.trim();
    if (!trimmed) return;
    if (onOpen("youtube_search", { query: trimmed })) {
      setYtQuery("");
    }
  };

  const submitUrl = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = openUrl.trim();
    if (!trimmed) return;
    if (onOpen("url", { url: trimmed })) {
      setOpenUrl("");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="card-surface p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>
            Abrir no Chrome
          </h2>
          <span
            className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
            style={{
              backgroundColor: "var(--surface-elevated)",
              color: extensionConnected ? "var(--ok)" : "var(--text-secondary)",
            }}
          >
            {extensionConnected ? "Extensão conectada" : "Extensão offline"}
          </span>
        </div>

        <form onSubmit={submitYoutube} className="mb-3 flex gap-2">
          <input
            type="search"
            value={ytQuery}
            onChange={(e) => setYtQuery(e.target.value)}
            placeholder="Buscar vídeo no YouTube..."
            aria-label="Buscar vídeo no YouTube"
            disabled={!extensionConnected}
            className="min-h-[44px] min-w-0 flex-1 rounded-2xl px-3.5 text-sm outline-none disabled:opacity-50"
            style={{
              backgroundColor: "var(--surface-elevated)",
              color: "var(--text)",
              border: "1px solid var(--separator)",
            }}
          />
          <button
            type="submit"
            disabled={!extensionConnected || !ytQuery.trim()}
            className="touch-btn shrink-0 rounded-2xl px-4 text-sm font-semibold disabled:opacity-40"
            style={{
              backgroundColor: "var(--accent)",
              color: "var(--accent-contrast)",
            }}
          >
            Buscar
          </button>
        </form>

        <form onSubmit={submitUrl} className="flex gap-2">
          <input
            type="url"
            value={openUrl}
            onChange={(e) => setOpenUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
            aria-label="Abrir URL em nova aba"
            disabled={!extensionConnected}
            className="min-h-[44px] min-w-0 flex-1 rounded-2xl px-3.5 text-sm outline-none disabled:opacity-50"
            style={{
              backgroundColor: "var(--surface-elevated)",
              color: "var(--text)",
              border: "1px solid var(--separator)",
            }}
          />
          <button
            type="submit"
            disabled={!extensionConnected || !openUrl.trim()}
            className="touch-btn shrink-0 rounded-2xl px-4 text-sm font-semibold disabled:opacity-40"
            style={{
              backgroundColor: "var(--surface-elevated)",
              color: "var(--text)",
              border: "1px solid var(--separator)",
            }}
          >
            Abrir
          </button>
        </form>
      </section>

      <section className="card-surface p-5">
        <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>
          Teclas globais de mídia
        </h2>
        <p className="mb-3 mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>
          Fallback para players sem sessão GSMTC, como VLC 3.x.
        </p>
        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => onCommand("windows:fallback", "previous")}
            className="touch-btn flex items-center justify-center gap-1.5 rounded-2xl px-3 text-xs font-semibold"
            style={{
              backgroundColor: "var(--surface-elevated)",
              color: "var(--text)",
            }}
          >
            <PreviousIcon className="h-4 w-4" />
            <span>Anterior</span>
          </button>

          <button
            type="button"
            onClick={() => onCommand("windows:fallback", "toggle")}
            className="touch-btn flex items-center justify-center gap-1 rounded-2xl px-3 text-xs font-semibold"
            style={{
              backgroundColor: "var(--accent)",
              color: "var(--accent-contrast)",
            }}
          >
            <PlayIcon className="h-4 w-4" />
            <PauseIcon className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => onCommand("windows:fallback", "next")}
            className="touch-btn flex items-center justify-center gap-1.5 rounded-2xl px-3 text-xs font-semibold"
            style={{
              backgroundColor: "var(--surface-elevated)",
              color: "var(--text)",
            }}
          >
            <span>Próximo</span>
            <NextIcon className="h-4 w-4" />
          </button>
        </div>
      </section>

      <section className="card-surface p-5">
        <h2 className="mb-3 text-base font-semibold" style={{ color: "var(--text)" }}>
          Aparência
        </h2>
        <div
          className="grid grid-cols-3 gap-1.5 rounded-2xl p-1"
          style={{ backgroundColor: "var(--surface-elevated)" }}
          role="radiogroup"
          aria-label="Tema do aplicativo"
        >
          {THEME_OPTIONS.map((opt) => {
            const active = themeMode === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onThemeChange(opt.value)}
                className="touch-btn rounded-xl px-2 text-xs font-semibold"
                style={{
                  backgroundColor: active ? "var(--surface)" : "transparent",
                  color: active ? "var(--accent)" : "var(--text-secondary)",
                  boxShadow: active ? "0 1px 3px rgba(0, 0, 0, 0.12)" : "none",
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </section>

      <section className="card-surface flex items-center justify-between gap-3 p-5">
        <div className="min-w-0">
          <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>
            Conexão com o PC
          </h2>
          <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
            Estado: {connectionStatus === "connected" ? "Conectado" : connectionStatus === "connecting" ? "Conectando..." : connectionStatus === "reconnecting" ? "Reconectando..." : "Não pareado"}
          </p>
        </div>
        <button
          type="button"
          onClick={onReconnect}
          className="touch-btn shrink-0 rounded-2xl px-4 text-xs font-semibold"
          style={{
            backgroundColor: "var(--surface-elevated)",
            color: "var(--accent)",
          }}
        >
          Reconectar
        </button>
      </section>
    </div>
  );
}
