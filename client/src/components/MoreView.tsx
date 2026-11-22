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
  remoteInputEnabled?: boolean;
  onSetRemoteInputEnabled?: (enabled: boolean) => boolean;
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
  remoteInputEnabled = false,
  onSetRemoteInputEnabled,
  pairedDevices = [],
  onRefreshDevices,
  onRevokeDevice,
  diagnostic,
  onClearTokenAndRepair,
}: MoreViewProps) {
  const [openUrl, setOpenUrl] = useState("");
  const [revokingId, setRevokingId] = useState<string | null>(null);

  useEffect(() => {
    if (onRefreshDevices) {
      onRefreshDevices();
    }
  }, [onRefreshDevices]);

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
    <div className="flex flex-col gap-3.5">
      {/* 1. Abrir link no Chrome */}
      <section className="card-surface p-5">
        <h2 className="mb-3 text-base font-semibold" style={{ color: "var(--text)" }}>
          Abrir link no Chrome
        </h2>

        <form onSubmit={submitUrl} className="flex gap-2">
          <input
            type="url"
            name="open-url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={openUrl}
            onChange={(e) => setOpenUrl(e.target.value)}
            placeholder="Colar link"
            aria-label="Colar link"
            disabled={!extensionConnected}
            className="field-input min-h-[44px] min-w-0 flex-1 rounded-2xl px-3.5 text-sm disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!extensionConnected || !openUrl.trim()}
            className="touch-btn shrink-0 rounded-2xl px-4 text-sm font-semibold disabled:opacity-40"
            style={{
              backgroundColor: "var(--surface-elevated)",
              border: "1px solid var(--hairline)",
              color: "var(--text)",
            }}
          >
            Abrir
          </button>
        </form>
      </section>

      {/* 2. Teclas globais de mídia (Fallback VLC / players sem GSMTC) */}
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
            className="touch-btn kbd-key flex items-center justify-center gap-1.5 rounded-2xl px-3 text-xs font-semibold"
          >
            <PreviousIcon className="h-4 w-4" />
            <span>Anterior</span>
          </button>

          <button
            type="button"
            onClick={() => onCommand("windows:fallback", "toggle")}
            aria-label="Reproduzir ou pausar fallback"
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
            className="touch-btn kbd-key flex items-center justify-center gap-1.5 rounded-2xl px-3 text-xs font-semibold"
          >
            <span>Próximo</span>
            <NextIcon className="h-4 w-4" />
          </button>
        </div>
      </section>

      {/* 3.0 Segurança: Mouse e Teclado Remoto */}
      {onSetRemoteInputEnabled ? (
        <section className="card-surface flex items-center justify-between gap-3 p-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>
                Mouse e Teclado Remoto
              </h2>
              <span
                className="rounded-full px-2 py-0.5 text-xs font-semibold"
                style={{
                  backgroundColor: remoteInputEnabled ? "var(--ok-soft)" : "var(--surface-elevated)",
                  color: remoteInputEnabled ? "var(--ok)" : "var(--text-secondary)",
                }}
              >
                {remoteInputEnabled ? "Ativado" : "Desativado"}
              </span>
            </div>
            <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>
              Desativado por padrão para segurança. Permite controlar o cursor e digitar pelo celular.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={remoteInputEnabled}
            aria-label="Ativar mouse e teclado remoto"
            onClick={() => onSetRemoteInputEnabled(!remoteInputEnabled)}
            className="ios-switch"
          />
        </section>
      ) : null}

      {/* 3. Conexão com o PC */}
      <section className="card-surface flex items-center justify-between gap-3 p-5">
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
            border: "1px solid var(--hairline)",
            color: "var(--accent-text)",
          }}
        >
          Reconectar
        </button>
      </section>

      {/* 3.1 Diagnóstico de Conexão (depuração no mobile sem cabo) */}
      <section className="card-surface p-5">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>
            Diagnóstico de Conexão
          </h2>
          <span
            className="rounded-full px-2.5 py-0.5 text-xs font-semibold"
            style={{
              backgroundColor: connectionStatus === "connected" ? "var(--ok-soft)" : "var(--surface-elevated)",
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
          className="flex flex-col gap-2 rounded-2xl border p-3.5 text-xs font-mono tabular-nums"
          style={{
            backgroundColor: "var(--surface-elevated)",
            borderColor: "var(--hairline)",
            color: "var(--text)",
          }}
        >
          <div className="flex flex-col">
            <span
              className="text-[11px] font-bold uppercase tracking-wider"
              style={{ color: "var(--text-secondary)" }}
            >
              URL WebSocket
            </span>
            <span className="break-all">{diagnostic?.wsUrl || "—"}</span>
          </div>
          <div className="flex justify-between border-t pt-2" style={{ borderColor: "var(--hairline)" }}>
            <span style={{ color: "var(--text-secondary)" }}>Host / Origem:</span>
            <span className="max-w-[200px] truncate text-right">{diagnostic?.clientHost || (typeof window !== "undefined" ? window.location.host : "—")}</span>
          </div>
          <div className="flex justify-between border-t pt-2" style={{ borderColor: "var(--hairline)" }}>
            <span style={{ color: "var(--text-secondary)" }}>Ambiente:</span>
            <span>{diagnostic?.isLoopback ? "Loopback (Localhost)" : "Rede Local (LAN)"}</span>
          </div>
          <div className="flex justify-between border-t pt-2" style={{ borderColor: "var(--hairline)" }}>
            <span style={{ color: "var(--text-secondary)" }}>Token Autenticação:</span>
            <span>{diagnostic?.hasToken ? "Salvo" : "Ausente"}</span>
          </div>
          <div className="flex justify-between border-t pt-2" style={{ borderColor: "var(--hairline)" }}>
            <span style={{ color: "var(--text-secondary)" }}>RTT (Ida + Volta):</span>
            <span>
              {diagnostic?.lastRttMs !== null && diagnostic?.lastRttMs !== undefined
                ? `${diagnostic.lastRttMs} ms`
                : "—"}
            </span>
          </div>
          <div className="flex justify-between border-t pt-2" style={{ borderColor: "var(--hairline)" }}>
            <span style={{ color: "var(--text-secondary)" }}>Execução no Host:</span>
            <span>
              {diagnostic?.lastHostExecMs !== null && diagnostic?.lastHostExecMs !== undefined
                ? `${diagnostic.lastHostExecMs} ms`
                : "—"}
            </span>
          </div>
          <div className="flex justify-between border-t pt-2" style={{ borderColor: "var(--hairline)" }}>
            <span style={{ color: "var(--text-secondary)" }}>Rede Wi-Fi estimada:</span>
            <span>
              {diagnostic?.lastNetworkMs !== null && diagnostic?.lastNetworkMs !== undefined
                ? `${diagnostic.lastNetworkMs} ms`
                : "—"}
            </span>
          </div>
          <div className="flex justify-between border-t pt-2" style={{ borderColor: "var(--hairline)" }}>
            <span style={{ color: "var(--text-secondary)" }}>Diagnóstico Gargalo:</span>
            <span className="max-w-[200px] truncate text-right font-sans">
              {diagnostic?.bottleneckSummary || "Normal (<150ms)"}
            </span>
          </div>
          <div className="flex justify-between border-t pt-2" style={{ borderColor: "var(--hairline)" }}>
            <span style={{ color: "var(--text-secondary)" }}>Último Fechamento:</span>
            <span>
              {diagnostic?.lastCloseCode !== null && diagnostic?.lastCloseCode !== undefined
                ? `${diagnostic.lastCloseCode} (${diagnostic.lastCloseReason || "sem motivo"})`
                : "Nenhum"}
            </span>
          </div>
          {diagnostic?.lastCloseTimestamp ? (
            <div className="flex justify-between border-t pt-2" style={{ borderColor: "var(--hairline)" }}>
              <span style={{ color: "var(--text-secondary)" }}>Horário Fechamento:</span>
              <span>{diagnostic.lastCloseTimestamp}</span>
            </div>
          ) : null}
          {diagnostic?.lastError ? (
            <div className="flex flex-col border-t pt-2" style={{ borderColor: "var(--hairline)", color: "var(--danger)" }}>
              <span className="text-[11px] font-bold uppercase tracking-wider">Último Erro do Host:</span>
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
              border: "1px solid var(--hairline)",
              color: "var(--accent-text)",
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
                border: "1px solid var(--hairline)",
                color: "var(--danger)",
              }}
            >
              Limpar Pareamento
            </button>
          ) : null}
        </div>
      </section>

      {/* 4. Dispositivos Pareados */}
      <section className="card-surface p-5">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>
            Dispositivos Pareados
          </h2>
          {onRefreshDevices ? (
            <button
              type="button"
              onClick={onRefreshDevices}
              className="touch-btn rounded-xl px-2.5 py-1 text-xs font-medium"
              style={{ color: "var(--accent-text)" }}
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
          <div className="flex flex-col divide-y" style={{ borderColor: "var(--hairline)" }}>
            {pairedDevices.map((dev) => (
              <div key={dev.id} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1 pr-3">
                  <div className="truncate text-sm font-medium" style={{ color: "var(--text)" }}>
                    {dev.name}
                  </div>
                  <div className="text-xs tabular-nums" style={{ color: "var(--text-secondary)" }}>
                    {dev.lastSeenAt ? `Último acesso: ${dev.lastSeenAt.slice(0, 10)}` : "Ativo"}
                  </div>
                </div>
                {onRevokeDevice ? (
                  <button
                    type="button"
                    onClick={() => handleRevoke(dev.id)}
                    disabled={revokingId === dev.id}
                    className="touch-btn shrink-0 rounded-xl px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                    style={{
                      backgroundColor: "var(--surface-elevated)",
                      border: "1px solid var(--hairline)",
                      color: "var(--danger)",
                    }}
                  >
                    {revokingId === dev.id ? "Revogando…" : "Revogar"}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 5. Aparência */}
      <section className="card-surface p-5">
        <h2 className="mb-3 text-base font-semibold" style={{ color: "var(--text)" }}>
          Aparência
        </h2>
        <div
          className="grid grid-cols-3 gap-1.5 rounded-2xl border p-1"
          style={{
            backgroundColor: "var(--surface-elevated)",
            borderColor: "var(--hairline)",
          }}
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
                  color: active ? "var(--accent-text)" : "var(--text-secondary)",
                  boxShadow: active ? "var(--shadow-pill)" : "none",
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
