import { useEffect, useState, type FormEvent } from "react";
import type { ConnectionStatus, DiagnosticInfo, MediaAction, PairedDevicePublic, ThemeMode } from "../types";
import { NextIcon, PauseIcon, PlayIcon, PreviousIcon } from "./Icons";

interface MoreViewProps {
  extensionConnected: boolean;
  connectionStatus: ConnectionStatus;
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  onOpen: (mode: "youtube_search" | "url", payload: { query?: string; url?: string }) => boolean;
  onCommand: (sessionId: string, action: MediaAction) => void;
  onReconnect: () => void;
  pairedDevices?: PairedDevicePublic[];
  onRefreshDevices?: () => void;
  onRevokeDevice?: (deviceId: string) => void;
  diagnostic?: DiagnosticInfo;
  onClearTokenAndRepair?: () => void;
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
  pairedDevices = [],
  onRefreshDevices,
  onRevokeDevice,
  diagnostic,
  onClearTokenAndRepair,
}: MoreViewProps) {
  const [ytQuery, setYtQuery] = useState("");
  const [openUrl, setOpenUrl] = useState("");
  const [revokingId, setRevokingId] = useState<string | null>(null);

  useEffect(() => {
    if (onRefreshDevices) {
      onRefreshDevices();
    }
  }, [onRefreshDevices]);

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

  const handleRevoke = async (id: string) => {
    if (!onRevokeDevice) return;
    setRevokingId(id);
    try {
      await onRevokeDevice(id);
    } finally {
      setRevokingId(null);
    }
  };

  const statusLabel =
    connectionStatus === "connected"
      ? extensionConnected
        ? "Conectado (Host + Extensão)"
        : "Conectado (Extensão offline)"
      : connectionStatus === "connecting"
        ? "Conectando..."
        : connectionStatus === "reconnecting"
          ? "Reconectando..."
          : "Não pareado";

  return (
    <div className="flex flex-col gap-4">
      {/* 1. Abrir no Chrome */}
      <section className="card-surface p-5 shadow-[0_4px_20px_rgba(0,0,0,0.04)]">
        <h2 className="mb-3 text-base font-semibold" style={{ color: "var(--text)" }}>
          Abrir no Chrome
        </h2>

        <form onSubmit={submitYoutube} className="mb-3 flex gap-2">
          <input
            type="search"
            value={ytQuery}
            onChange={(e) => setYtQuery(e.target.value)}
            placeholder="Buscar no YouTube"
            aria-label="Buscar no YouTube"
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
            placeholder="Colar link"
            aria-label="Colar link"
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

      {/* 2. Teclas globais de mídia (Fallback VLC / players sem GSMTC) */}
      <section className="card-surface p-5 shadow-[0_4px_20px_rgba(0,0,0,0.04)]">
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

      {/* 3. Conexão com o PC */}
      <section className="card-surface flex items-center justify-between gap-3 p-5 shadow-[0_4px_20px_rgba(0,0,0,0.04)]">
        <div className="min-w-0">
          <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>
            Conexão com o PC
          </h2>
          <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
            {statusLabel}
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

      {/* 3.1 Diagnóstico de Conexão (depuração no mobile sem cabo) */}
      <section className="card-surface p-5 shadow-[0_4px_20px_rgba(0,0,0,0.04)]">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>
            Diagnóstico de Conexão
          </h2>
          <span
            className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
            style={{
              backgroundColor: "var(--surface-elevated)",
              color: connectionStatus === "connected" ? "var(--ok)" : "var(--warn)",
            }}
          >
            {connectionStatus}
          </span>
        </div>
        <p className="mb-3 text-xs" style={{ color: "var(--text-secondary)" }}>
          Informações em tempo real para depuração na rede local.
        </p>

        <div
          className="flex flex-col gap-2 rounded-2xl p-3 text-xs font-mono"
          style={{ backgroundColor: "var(--surface-elevated)", color: "var(--text)" }}
        >
          <div className="flex flex-col">
            <span
              className="text-[10px] font-bold uppercase tracking-wider"
              style={{ color: "var(--text-secondary)" }}
            >
              URL WebSocket
            </span>
            <span className="break-all">{diagnostic?.wsUrl || "—"}</span>
          </div>
          <div className="flex justify-between border-t border-[var(--separator)] pt-2">
            <span style={{ color: "var(--text-secondary)" }}>Host / Origem:</span>
            <span className="truncate max-w-[200px] text-right">{diagnostic?.clientHost || (typeof window !== "undefined" ? window.location.host : "—")}</span>
          </div>
          <div className="flex justify-between border-t border-[var(--separator)] pt-2">
            <span style={{ color: "var(--text-secondary)" }}>Ambiente:</span>
            <span>{diagnostic?.isLoopback ? "Loopback (Localhost)" : "Rede Local (LAN)"}</span>
          </div>
          <div className="flex justify-between border-t border-[var(--separator)] pt-2">
            <span style={{ color: "var(--text-secondary)" }}>Token Autenticação:</span>
            <span>{diagnostic?.hasToken ? `Salvo (${diagnostic.tokenPrefix})` : "Ausente"}</span>
          </div>
          <div className="flex justify-between border-t border-[var(--separator)] pt-2">
            <span style={{ color: "var(--text-secondary)" }}>Último Fechamento:</span>
            <span>
              {diagnostic?.lastCloseCode !== null && diagnostic?.lastCloseCode !== undefined
                ? `${diagnostic.lastCloseCode} (${diagnostic.lastCloseReason || "sem motivo"})`
                : "Nenhum"}
            </span>
          </div>
          {diagnostic?.lastCloseTimestamp ? (
            <div className="flex justify-between border-t border-[var(--separator)] pt-2">
              <span style={{ color: "var(--text-secondary)" }}>Horário Fechamento:</span>
              <span>{diagnostic.lastCloseTimestamp}</span>
            </div>
          ) : null}
          {diagnostic?.lastError ? (
            <div className="flex flex-col border-t border-[var(--separator)] pt-2 text-[var(--danger)]">
              <span className="text-[10px] font-bold uppercase tracking-wider">Último Erro do Host:</span>
              <span className="break-words font-sans text-xs">{diagnostic.lastError}</span>
            </div>
          ) : null}
        </div>

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={onReconnect}
            className="touch-btn flex-1 rounded-xl py-2 text-xs font-semibold"
            style={{
              backgroundColor: "var(--surface-elevated)",
              color: "var(--accent)",
            }}
          >
            Reconectar Socket
          </button>
          {onClearTokenAndRepair ? (
            <button
              type="button"
              onClick={onClearTokenAndRepair}
              className="touch-btn flex-1 rounded-xl py-2 text-xs font-semibold"
              style={{
                backgroundColor: "var(--surface-elevated)",
                color: "var(--danger)",
              }}
            >
              Limpar Pareamento
            </button>
          ) : null}
        </div>
      </section>

      {/* 4. Dispositivos Pareados */}
      <section className="card-surface p-5 shadow-[0_4px_20px_rgba(0,0,0,0.04)]">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>
            Dispositivos Pareados
          </h2>
          {onRefreshDevices ? (
            <button
              type="button"
              onClick={onRefreshDevices}
              className="touch-btn rounded-xl px-2.5 py-1 text-xs font-medium"
              style={{ color: "var(--accent)" }}
            >
              Atualizar
            </button>
          ) : null}
        </div>
        <p className="mb-3 text-xs" style={{ color: "var(--text-secondary)" }}>
          Aparelhos autorizados a controlar este PC na rede local.
        </p>

        {pairedDevices.length === 0 ? (
          <p className="text-xs italic" style={{ color: "var(--text-secondary)" }}>
            Nenhum outro aparelho registrado.
          </p>
        ) : (
          <div className="flex flex-col divide-y divide-[var(--separator)]">
            {pairedDevices.map((dev) => (
              <div key={dev.id} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1 pr-3">
                  <div className="truncate text-sm font-medium" style={{ color: "var(--text)" }}>
                    {dev.name}
                  </div>
                  <div className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                    {dev.lastSeenAt ? `Último acesso: ${dev.lastSeenAt.slice(0, 10)}` : "Ativo"}
                  </div>
                </div>
                {onRevokeDevice ? (
                  <button
                    type="button"
                    onClick={() => handleRevoke(dev.id)}
                    disabled={revokingId === dev.id}
                    className="touch-btn shrink-0 rounded-xl px-3 py-1.5 text-xs font-semibold transition-opacity disabled:opacity-40"
                    style={{
                      backgroundColor: "var(--surface-elevated)",
                      color: "var(--danger)",
                    }}
                  >
                    {revokingId === dev.id ? "Revogando..." : "Revogar"}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 5. Aparência */}
      <section className="card-surface p-5 shadow-[0_4px_20px_rgba(0,0,0,0.04)]">
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
    </div>
  );
}
