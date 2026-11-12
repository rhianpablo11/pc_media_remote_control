import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConnectionStatus,
  ErrorMessage,
  MediaAction,
  PairedDevicePublic,
  StateMessage,
} from "../types";
import {
  buildWebSocketUrl,
  clearAuthToken,
  clearPairingCodeFromUrl,
  computeReconnectDelayMs,
  fetchPairedDevicesApi,
  getPairingCodeFromUrl,
  loadAuthToken,
  loadCachedState,
  pairDeviceApi,
  revokeDeviceApi,
  saveCachedState,
  triggerHaptic,
} from "../utils";

export interface UseMediaHostResult {
  state: StateMessage | null;
  isCachedState: boolean;
  receivedAtMs: number;
  connectionStatus: ConnectionStatus;
  errorMessage: string | null;
  dismissError: () => void;
  sendCommand: (sessionId: string, action: MediaAction, value?: number) => boolean;
  sendVolume: (target: string, opts: { value?: number; muted?: boolean }) => boolean;
  selectSession: (sessionId: string) => boolean;
  sendOpen: (mode: "youtube_search" | "url", payload: { query?: string; url?: string }) => boolean;
  reconnectNow: () => void;
  pairWithPin: (pin: string) => Promise<{ ok: boolean; error?: string }>;
  pairedDevices: PairedDevicePublic[];
  refreshPairedDevices: () => Promise<void>;
  revokeDevice: (deviceId: string) => Promise<boolean>;
}

const PAIRING_CLOSE_CODES = new Set([4001, 4401]);

export function useMediaHost(): UseMediaHostResult {
  const initialCache = loadCachedState();
  const [state, setState] = useState<StateMessage | null>(initialCache);
  const [isCachedState, setIsCachedState] = useState<boolean>(initialCache !== null);
  const [receivedAtMs, setReceivedAtMs] = useState<number>(() => Date.now());
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pairedDevices, setPairedDevices] = useState<PairedDevicePublic[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const errorTimerRef = useRef<number | null>(null);
  const attemptRef = useRef<number>(0);
  const disposedRef = useRef<boolean>(false);
  const reqSeqRef = useRef<number>(0);
  const pairingInProgressRef = useRef<boolean>(false);

  const showError = useCallback((msg: string) => {
    setErrorMessage(msg);
    if (errorTimerRef.current !== null) {
      window.clearTimeout(errorTimerRef.current);
    }
    errorTimerRef.current = window.setTimeout(() => {
      setErrorMessage(null);
      errorTimerRef.current = null;
    }, 4500);
  }, []);

  const dismissError = useCallback(() => {
    if (errorTimerRef.current !== null) {
      window.clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    setErrorMessage(null);
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const refreshPairedDevices = useCallback(async () => {
    const token = loadAuthToken();
    const list = await fetchPairedDevicesApi(token);
    setPairedDevices(list);
  }, []);

  const revokeDevice = useCallback(
    async (deviceId: string): Promise<boolean> => {
      const token = loadAuthToken();
      const ok = await revokeDeviceApi(deviceId, token);
      if (ok) {
        await refreshPairedDevices();
      }
      return ok;
    },
    [refreshPairedDevices],
  );

  const connect = useCallback(() => {
    if (disposedRef.current || pairingInProgressRef.current) return;
    clearReconnectTimer();

    const existing = wsRef.current;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return;
    }

    setConnectionStatus((prev) => (prev === "reconnecting" ? "reconnecting" : "connecting"));

    let socket: WebSocket;
    try {
      socket = new WebSocket(buildWebSocketUrl());
    } catch {
      const delay = computeReconnectDelayMs(attemptRef.current++);
      setConnectionStatus("reconnecting");
      reconnectTimerRef.current = window.setTimeout(connect, delay);
      return;
    }

    wsRef.current = socket;

    socket.onopen = () => {
      if (disposedRef.current) {
        socket.close();
        return;
      }
      attemptRef.current = 0;
      setConnectionStatus("connected");

      // Send auth frame immediately if a token exists
      const token = loadAuthToken();
      if (token) {
        try {
          socket.send(JSON.stringify({ v: 1, type: "auth", token }));
        } catch {
          // Socket might have closed
        }
      }
    };

    socket.onmessage = (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as StateMessage | ErrorMessage | { type: string };
        if (parsed.type === "state") {
          const stateMsg = parsed as StateMessage;
          setState(stateMsg);
          setIsCachedState(false);
          setReceivedAtMs(Date.now());
          saveCachedState(stateMsg);
          return;
        }
        if (parsed.type === "error") {
          const errMsg = parsed as ErrorMessage;
          if (errMsg.code === "pairing_required") {
            clearAuthToken();
            setConnectionStatus("pairing_required");
          }
          showError(errMsg.message || "Não foi possível concluir o comando.");
        }
      } catch {
        // Ignore malformed non-JSON frames
      }
    };

    socket.onclose = (event) => {
      if (wsRef.current === socket) {
        wsRef.current = null;
      }
      if (disposedRef.current) return;

      if (PAIRING_CLOSE_CODES.has(event.code)) {
        clearAuthToken();
        setConnectionStatus("pairing_required");
        return;
      }

      setConnectionStatus("reconnecting");
      const delay = computeReconnectDelayMs(attemptRef.current++);
      reconnectTimerRef.current = window.setTimeout(connect, delay);
    };
  }, [clearReconnectTimer, showError]);

  const reconnectNow = useCallback(() => {
    attemptRef.current = 0;
    clearReconnectTimer();
    const existing = wsRef.current;
    if (existing && existing.readyState !== WebSocket.CLOSED) {
      existing.close();
      wsRef.current = null;
    }
    setConnectionStatus("connecting");
    connect();
  }, [clearReconnectTimer, connect]);

  const pairWithPin = useCallback(
    async (pin: string): Promise<{ ok: boolean; error?: string }> => {
      pairingInProgressRef.current = true;
      try {
        const res = await pairDeviceApi(pin);
        if (!res.ok) {
          showError(res.error || "Falha ao parear com o PIN informado.");
          return { ok: false, error: res.error };
        }
        setConnectionStatus("connecting");
        reconnectNow();
        return { ok: true };
      } finally {
        pairingInProgressRef.current = false;
      }
    },
    [reconnectNow, showError],
  );

  useEffect(() => {
    disposedRef.current = false;

    // Check URL for ?pair=<code> from QR code
    const initialPairCode = getPairingCodeFromUrl();
    if (initialPairCode) {
      pairingInProgressRef.current = true;
      clearPairingCodeFromUrl();
      pairDeviceApi(initialPairCode)
        .then((res) => {
          if (res.ok) {
            connect();
          } else {
            showError(res.error || "Código de pareamento inválido ou expirado.");
            setConnectionStatus("pairing_required");
          }
        })
        .finally(() => {
          pairingInProgressRef.current = false;
        });
    } else {
      connect();
    }

    const handleResume = () => {
      if (document.visibilityState === "visible") {
        const sock = wsRef.current;
        if (!sock || sock.readyState === WebSocket.CLOSED) {
          attemptRef.current = 0;
          connect();
        }
      }
    };

    const handleOnline = () => {
      const sock = wsRef.current;
      if (!sock || sock.readyState === WebSocket.CLOSED) {
        attemptRef.current = 0;
        connect();
      }
    };

    document.addEventListener("visibilitychange", handleResume);
    window.addEventListener("online", handleOnline);

    return () => {
      disposedRef.current = true;
      document.removeEventListener("visibilitychange", handleResume);
      window.removeEventListener("online", handleOnline);
      clearReconnectTimer();
      if (errorTimerRef.current !== null) {
        window.clearTimeout(errorTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [clearReconnectTimer, connect, showError]);

  const sendPayload = useCallback(
    (payload: Record<string, unknown>): boolean => {
      const socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        showError("Sem conexão com o PC. Tentando reconectar...");
        return false;
      }
      reqSeqRef.current += 1;
      socket.send(
        JSON.stringify({
          v: 1,
          requestId: `pwa-${reqSeqRef.current}`,
          ...payload,
        }),
      );
      return true;
    },
    [showError],
  );

  const sendCommand = useCallback(
    (sessionId: string, action: MediaAction, value?: number): boolean => {
      triggerHaptic(10);
      const body: Record<string, unknown> = {
        type: "command",
        sessionId,
        action,
      };
      if (value !== undefined) {
        body.value = value;
      }
      return sendPayload(body);
    },
    [sendPayload],
  );

  const sendVolume = useCallback(
    (target: string, opts: { value?: number; muted?: boolean }): boolean => {
      const body: Record<string, unknown> = {
        type: "volume",
        target,
      };
      if (opts.value !== undefined) body.value = opts.value;
      if (opts.muted !== undefined) body.muted = opts.muted;
      return sendPayload(body);
    },
    [sendPayload],
  );

  const selectSession = useCallback(
    (sessionId: string): boolean => {
      triggerHaptic(8);
      return sendPayload({
        type: "select",
        sessionId,
      });
    },
    [sendPayload],
  );

  const sendOpen = useCallback(
    (mode: "youtube_search" | "url", payload: { query?: string; url?: string }): boolean => {
      triggerHaptic(10);
      return sendPayload({
        type: "open",
        mode,
        ...payload,
      });
    },
    [sendPayload],
  );

  return {
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
    reconnectNow,
    pairWithPin,
    pairedDevices,
    refreshPairedDevices,
    revokeDevice,
  };
}
