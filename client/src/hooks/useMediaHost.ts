import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AckMessage,
  ConnectionStatus,
  DiagnosticInfo,
  ErrorMessage,
  MediaAction,
  PairedDevicePublic,
  SearchMessage,
  SearchResultsMessage,
  StateMessage,
} from "../types";
import {
  buildWebSocketUrl,
  clearAuthToken,
  clearPairingCodeFromUrl,
  computeReconnectDelayMs,
  fetchPairedDevicesApi,
  getPairingCodeFromUrl,
  isLoopbackHost,
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
  searchYouTube: (query: string) => Promise<SearchResultsMessage>;
  playVideo: (
    videoId: string,
    opts?: { mode?: "current_tab" | "new_tab"; fullscreen?: boolean; sessionId?: string },
  ) => boolean;
  reconnectNow: () => void;
  pairWithPin: (pin: string) => Promise<{ ok: boolean; error?: string }>;
  pairedDevices: PairedDevicePublic[];
  refreshPairedDevices: () => Promise<void>;
  revokeDevice: (deviceId: string) => Promise<boolean>;
  diagnostic: DiagnosticInfo;
  clearTokenAndRepair: () => void;
}

const PAIRING_CLOSE_CODES = new Set([4001, 4401]);

export function useMediaHost(): UseMediaHostResult {
  const initialCache = loadCachedState();
  const [state, setState] = useState<StateMessage | null>(initialCache);
  const [isCachedState, setIsCachedState] = useState<boolean>(initialCache !== null);
  const [receivedAtMs, setReceivedAtMs] = useState<number>(() => Date.now());
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(() => {
    if (!isLoopbackHost() && !loadAuthToken() && !getPairingCodeFromUrl()) {
      return "pairing_required";
    }
    return "connecting";
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pairedDevices, setPairedDevices] = useState<PairedDevicePublic[]>([]);

  const [diagnostic, setDiagnostic] = useState<DiagnosticInfo>(() => {
    const token = loadAuthToken();
    return {
      wsUrl: buildWebSocketUrl(),
      clientOrigin: typeof window !== "undefined" ? window.location.origin : "",
      clientHost: typeof window !== "undefined" ? window.location.host : "",
      isLoopback: isLoopbackHost(),
      hasToken: Boolean(token),
      tokenPrefix: "",
      connectionStatus:
        !isLoopbackHost() && !token && !getPairingCodeFromUrl()
          ? "pairing_required"
          : "connecting",
      lastCloseCode: null,
      lastCloseReason: null,
      lastCloseTimestamp: null,
      lastError: null,
      reconnectAttempts: 0,
      lastRttMs: null,
      lastHostExecMs: null,
      lastNetworkMs: null,
      lastAction: null,
      avgRttMs: null,
      avgHostExecMs: null,
      bottleneckSummary: null,
    };
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const errorTimerRef = useRef<number | null>(null);
  const attemptRef = useRef<number>(0);
  const disposedRef = useRef<boolean>(false);
  const reqSeqRef = useRef<number>(0);
  const pendingSearchRef = useRef<Map<string, (res: SearchResultsMessage) => void>>(new Map());
  const pairingInProgressRef = useRef<boolean>(false);
  const pairingRequiredRef = useRef<boolean>(!isLoopbackHost() && !loadAuthToken() && !getPairingCodeFromUrl());

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

  const clearTokenAndRepair = useCallback(() => {
    clearAuthToken();
    pairingRequiredRef.current = true;
    pairingInProgressRef.current = false;
    setConnectionStatus("pairing_required");
    setDiagnostic((prev) => ({
      ...prev,
      hasToken: false,
      tokenPrefix: "",
      connectionStatus: "pairing_required",
    }));
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (disposedRef.current || pairingInProgressRef.current) return;
    clearReconnectTimer();

    // If on LAN without an auth token, do not open WebSocket — show pairing screen immediately
    if (!isLoopbackHost() && !loadAuthToken()) {
      pairingRequiredRef.current = true;
      setConnectionStatus("pairing_required");
      setDiagnostic((prev) => ({
        ...prev,
        connectionStatus: "pairing_required",
        hasToken: false,
        tokenPrefix: "",
      }));
      return;
    }

    const existing = wsRef.current;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return;
    }

    setConnectionStatus((prev) => (prev === "reconnecting" ? "reconnecting" : "connecting"));
    setDiagnostic((prev) => ({
      ...prev,
      connectionStatus: prev.connectionStatus === "reconnecting" ? "reconnecting" : "connecting",
    }));

    let socket: WebSocket;
    const wsUrl = buildWebSocketUrl();
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      const delay = computeReconnectDelayMs(attemptRef.current++);
      setConnectionStatus("reconnecting");
      setDiagnostic((prev) => ({
        ...prev,
        connectionStatus: "reconnecting",
        reconnectAttempts: attemptRef.current,
      }));
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
      pairingRequiredRef.current = false;
      setConnectionStatus("connected");

      const token = loadAuthToken();
      setDiagnostic((prev) => ({
        ...prev,
        connectionStatus: "connected",
        hasToken: Boolean(token),
        tokenPrefix: "",
        reconnectAttempts: 0,
      }));

      // Send auth frame immediately if a token exists
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
        const parsed = JSON.parse(String(event.data)) as
          | StateMessage
          | ErrorMessage
          | AckMessage
          | { type: string };
        if (parsed.type === "state") {
          const stateMsg = parsed as StateMessage;
          setState(stateMsg);
          setIsCachedState(false);
          setReceivedAtMs(Date.now());
          saveCachedState(stateMsg);
          return;
        }
        if (parsed.type === "search_results") {
          const resMsg = parsed as SearchResultsMessage;
          const reqId = resMsg.requestId;
          if (reqId && pendingSearchRef.current.has(reqId)) {
            const resolver = pendingSearchRef.current.get(reqId);
            pendingSearchRef.current.delete(reqId);
            if (resolver) resolver(resMsg);
          }
          return;
        }
        if (parsed.type === "ack") {
          const ackMsg = parsed as AckMessage;
          const now = Date.now();
          const rtt = ackMsg.clientSentAt ? now - ackMsg.clientSentAt : null;
          const hostExec = ackMsg.execMs;
          const net = rtt !== null ? Math.max(0, rtt - hostExec) : null;

          setDiagnostic((prev) => {
            const nextAvgRtt =
              rtt !== null
                ? prev.avgRttMs
                  ? Math.round(prev.avgRttMs * 0.7 + rtt * 0.3)
                  : rtt
                : prev.avgRttMs;
            const nextAvgHost = prev.avgHostExecMs
              ? Math.round(prev.avgHostExecMs * 0.7 + hostExec * 0.3)
              : hostExec;

            let summary = "Wi-Fi local rápido (<100ms)";
            if (nextAvgRtt && nextAvgRtt > 150) {
              summary =
                nextAvgHost > (net ?? 0)
                  ? `Gargalo: Drivers/COM (${nextAvgHost}ms)`
                  : `Gargalo: Rede Wi-Fi (${net ?? 0}ms)`;
            }

            return {
              ...prev,
              lastRttMs: rtt,
              lastHostExecMs: hostExec,
              lastNetworkMs: net,
              lastAction: ackMsg.target || undefined,
              avgRttMs: nextAvgRtt,
              avgHostExecMs: nextAvgHost,
              bottleneckSummary: summary,
            };
          });

          if (!ackMsg.ok) {
            showError(
              ackMsg.reason
                ? `Não foi possível concluir o comando (${ackMsg.reason}).`
                : "Não foi possível concluir o comando.",
            );
          }
          return;
        }
        if (parsed.type === "error") {
          const errMsg = parsed as ErrorMessage;
          setDiagnostic((prev) => ({
            ...prev,
            lastError: errMsg.message || errMsg.code,
          }));
          if (errMsg.code === "pairing_required") {
            clearAuthToken();
            pairingRequiredRef.current = true;
            setConnectionStatus("pairing_required");
            setDiagnostic((prev) => ({
              ...prev,
              hasToken: false,
              tokenPrefix: "",
              connectionStatus: "pairing_required",
            }));
          }
          showError(errMsg.message || "Não foi possível concluir o comando.");
        }
      } catch {
        // Ignore malformed non-JSON frames
      }
    };

    socket.onclose = (event) => {
      for (const resolver of pendingSearchRef.current.values()) {
        resolver({
          v: 1,
          type: "search_results",
          ok: false,
          query: "",
          results: [],
          reason: "disconnected",
          error: "Conexão perdida com o computador.",
        });
      }
      pendingSearchRef.current.clear();

      if (wsRef.current === socket) {
        wsRef.current = null;
      }
      if (disposedRef.current) return;

      setDiagnostic((prev) => ({
        ...prev,
        lastCloseCode: event.code,
        lastCloseReason: event.reason || null,
        lastCloseTimestamp: new Date().toLocaleTimeString(),
        reconnectAttempts: attemptRef.current + 1,
      }));

      if (
        PAIRING_CLOSE_CODES.has(event.code) ||
        pairingRequiredRef.current ||
        (!isLoopbackHost() && !loadAuthToken())
      ) {
        clearAuthToken();
        pairingRequiredRef.current = true;
        setConnectionStatus("pairing_required");
        setDiagnostic((prev) => ({
          ...prev,
          hasToken: false,
          tokenPrefix: "",
          connectionStatus: "pairing_required",
        }));
        return;
      }

      if (event.code === 1006) {
        // Fast reconnect for abnormal closures (screen wake / Wi-Fi transient drop)
        setConnectionStatus("reconnecting");
        attemptRef.current = 0;
        const fastDelay = 400; // reconnect in under 1 second
        setDiagnostic((prev) => ({
          ...prev,
          connectionStatus: "reconnecting",
          reconnectAttempts: 1,
        }));
        reconnectTimerRef.current = window.setTimeout(connect, fastDelay);
        return;
      }

      setConnectionStatus("reconnecting");
      const delay = computeReconnectDelayMs(attemptRef.current++);
      setDiagnostic((prev) => ({
        ...prev,
        connectionStatus: "reconnecting",
        reconnectAttempts: attemptRef.current,
      }));
      reconnectTimerRef.current = window.setTimeout(connect, delay);
    };
  }, [clearReconnectTimer, showError]);

  const reconnectNow = useCallback(() => {
    pairingInProgressRef.current = false;
    attemptRef.current = 0;
    clearReconnectTimer();
    const existing = wsRef.current;
    if (existing && existing.readyState !== WebSocket.CLOSED) {
      existing.close();
      wsRef.current = null;
    }
    if (!isLoopbackHost() && !loadAuthToken()) {
      pairingRequiredRef.current = true;
      setConnectionStatus("pairing_required");
      setDiagnostic((prev) => ({
        ...prev,
        hasToken: false,
        tokenPrefix: "",
        connectionStatus: "pairing_required",
      }));
      return;
    }
    pairingRequiredRef.current = false;
    setConnectionStatus("connecting");
    setDiagnostic((prev) => ({
      ...prev,
      connectionStatus: "connecting",
    }));
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
        // Desbloquear flag de pareamento ANTES de disparar reconexão
        pairingInProgressRef.current = false;
        pairingRequiredRef.current = false;
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
          pairingInProgressRef.current = false;
          if (res.ok) {
            pairingRequiredRef.current = false;
            connect();
          } else {
            showError(res.error || "Código de pareamento inválido ou expirado.");
            pairingRequiredRef.current = true;
            setConnectionStatus("pairing_required");
          }
        })
        .finally(() => {
          pairingInProgressRef.current = false;
        });
    } else {
      if (!isLoopbackHost() && !loadAuthToken()) {
        pairingRequiredRef.current = true;
        setConnectionStatus("pairing_required");
      } else {
        connect();
      }
    }

    const handleResume = () => {
      if (document.visibilityState === "visible") {
        attemptRef.current = 0;
        clearReconnectTimer();
        const sock = wsRef.current;
        if (!sock || sock.readyState === WebSocket.CLOSED || sock.readyState === WebSocket.CLOSING) {
          connect();
        } else if (sock.readyState === WebSocket.OPEN) {
          try {
            sock.send(JSON.stringify({ v: 1, type: "ping" }));
          } catch {
            sock.close();
            connect();
          }
        }
      }
    };

    const handleOnline = () => {
      const sock = wsRef.current;
      if (!sock || sock.readyState === WebSocket.CLOSED || sock.readyState === WebSocket.CLOSING) {
        attemptRef.current = 0;
        clearReconnectTimer();
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
      const clientSentAt = Date.now();
      socket.send(
        JSON.stringify({
          v: 1,
          requestId: `pwa-${reqSeqRef.current}`,
          clientSentAt,
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

  const searchYouTube = useCallback(
    (query: string): Promise<SearchResultsMessage> => {
      const socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return Promise.resolve({
          v: 1,
          type: "search_results",
          ok: false,
          query,
          results: [],
          reason: "no_connection",
          error: "Sem conexão com o notebook.",
        });
      }

      reqSeqRef.current += 1;
      const reqId = `search-${reqSeqRef.current}`;
      const payload: SearchMessage = {
        v: 1,
        type: "search",
        query,
        requestId: reqId,
        clientSentAt: Date.now(),
      };

      return new Promise<SearchResultsMessage>((resolve) => {
        const timeoutTimer = window.setTimeout(() => {
          if (pendingSearchRef.current.has(reqId)) {
            pendingSearchRef.current.delete(reqId);
            resolve({
              v: 1,
              type: "search_results",
              ok: false,
              query,
              results: [],
              reason: "timeout",
              error: "Tempo limite esgotado ao buscar no YouTube.",
            });
          }
        }, 9000);

        pendingSearchRef.current.set(reqId, (result) => {
          window.clearTimeout(timeoutTimer);
          resolve(result);
        });

        socket.send(JSON.stringify(payload));
      });
    },
    [],
  );

  const playVideo = useCallback(
    (
      videoId: string,
      opts?: { mode?: "current_tab" | "new_tab"; fullscreen?: boolean; sessionId?: string },
    ): boolean => {
      triggerHaptic(12);
      return sendPayload({
        type: "command",
        action: "play_video",
        videoId,
        mode: opts?.mode ?? "current_tab",
        fullscreen: opts?.fullscreen,
        sessionId: opts?.sessionId,
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
    searchYouTube,
    playVideo,
    reconnectNow,
    pairWithPin,
    pairedDevices,
    refreshPairedDevices,
    revokeDevice,
    diagnostic,
    clearTokenAndRepair,
  };
}
