import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { StateMessage } from "./types";
import {
  cleanMediaTitle,
  extrapolatePosition,
  formatTime,
  safeArtworkUrl,
} from "./utils";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  simulateMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }

  simulateClose(code = 1006): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }
}

function makeSampleState(overrides?: Partial<StateMessage>): StateMessage {
  return {
    v: 1,
    type: "state",
    activeSessionId: "chrome:11",
    extensionConnected: true,
    masterVolume: {
      level: 0.45,
      muted: false,
      deviceName: "Alto-falantes Realtek",
    },
    audioSessions: [
      {
        id: "windows-audio:Spotify.exe",
        source: "windows",
        app: "Spotify",
        processName: "Spotify.exe",
        pid: 101,
        active: true,
        volume: 0.75,
        muted: false,
      },
      {
        id: "windows-audio:SystemSounds",
        source: "windows",
        app: "Sons do Sistema",
        processName: "SystemSounds",
        pid: 0,
        active: true,
        volume: 0.5,
        muted: false,
      },
      {
        id: "windows-audio:windowsterminal.exe",
        source: "windows",
        app: "Windows Terminal",
        processName: "windowsterminal.exe",
        pid: 300,
        active: true,
        volume: 0.5,
        muted: false,
      },
      {
        id: "windows-audio:chrome.exe",
        source: "windows",
        app: "Google Chrome",
        processName: "chrome.exe",
        pid: 400,
        active: true,
        volume: 0.9,
        muted: false,
      },
      {
        id: "windows-audio:vlc.exe",
        source: "windows",
        app: "VLC media player",
        processName: "vlc.exe",
        pid: 500,
        active: false,
        volume: 0.5,
        muted: false,
      },
    ],
    sessions: [
      {
        id: "chrome:11",
        source: "chrome",
        app: "YouTube",
        appId: "chrome.exe",
        title: "(2509) Lo-fi Hip Hop Radio",
        artist: "Lofi Girl",
        album: "",
        artworkUrl: "https://i.ytimg.com/vi/abc123/hqdefault.jpg",
        status: "PLAYING",
        position: 30,
        duration: 120,
        controls: {
          play: true,
          pause: true,
          toggle: true,
          next: true,
          previous: false,
          seek: true,
          skipAd: true,
        },
        volume: 0.8,
        muted: false,
        isSystemActive: true,
      },
      {
        id: "windows:Spotify.exe:0",
        source: "windows",
        app: "Spotify",
        appId: "Spotify.exe",
        title: "Faixa Salva",
        artist: "Banda Teste",
        album: "Álbum Teste",
        artworkUrl: null,
        status: "PAUSED",
        position: 10,
        duration: 200,
        controls: {
          play: true,
          pause: false,
          toggle: true,
          next: true,
          previous: true,
          seek: true,
          skipAd: false,
        },
        volume: null,
        muted: null,
        isSystemActive: false,
      },
    ],
    ...overrides,
  };
}

describe("utils", () => {
  it("normalizes media titles by stripping browser notification counts", () => {
    expect(cleanMediaTitle("(2509) Never Gonna Give You Up")).toBe("Never Gonna Give You Up");
    expect(cleanMediaTitle("(1) YouTube Video")).toBe("YouTube Video");
    expect(cleanMediaTitle("(99+) Lofi Hip Hop")).toBe("Lofi Hip Hop");
    expect(cleanMediaTitle("Normal Track Title")).toBe("Normal Track Title");
    expect(cleanMediaTitle("")).toBe("");
  });

  it("extrapolates playing position and clamps to duration", () => {
    expect(
      extrapolatePosition({
        position: 30,
        duration: 120,
        status: "PLAYING",
        receivedAtMs: 1000,
        nowMs: 5500,
      }),
    ).toBeCloseTo(34.5);

    expect(
      extrapolatePosition({
        position: 118,
        duration: 120,
        status: "PLAYING",
        receivedAtMs: 1000,
        nowMs: 10000,
      }),
    ).toBe(120);

    expect(
      extrapolatePosition({
        position: 30,
        duration: 120,
        status: "PAUSED",
        receivedAtMs: 1000,
        nowMs: 9000,
      }),
    ).toBe(30);
  });

  it("formats time and validates safe artwork URLs", () => {
    expect(formatTime(65)).toBe("01:05");
    expect(formatTime(3661)).toBe("1:01:01");
    expect(safeArtworkUrl("https://i.ytimg.com/vi/1/hqdefault.jpg")).toBe(
      "https://i.ytimg.com/vi/1/hqdefault.jpg",
    );
    expect(safeArtworkUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("App PWA", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (window as unknown as { location?: unknown }).location;
    (window as unknown as { location: unknown }).location = originalLocation;
  });

  it("loads cached state first, transitions to live state, normalizes title, and sends commands", () => {
    const cached = makeSampleState({
      sessions: [{ ...makeSampleState().sessions[0], title: "(12) Sessão em Cache" }],
    });
    localStorage.setItem("pcmedia_last_state_v1", JSON.stringify(cached));

    render(<App />);

    expect(screen.getByText("Conectando (cache)")).toBeInTheDocument();
    // Notification count "(12) " was cleaned
    expect(screen.getByText("Sessão em Cache")).toBeInTheDocument();

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();

    act(() => {
      ws.simulateOpen();
      ws.simulateMessage(makeSampleState());
    });

    expect(screen.getByText("Conectado")).toBeInTheDocument();
    // Notification count "(2509) " was cleaned from title
    expect(screen.getByText("Lo-fi Hip Hop Radio")).toBeInTheDocument();
    expect(screen.getByText("00:30")).toBeInTheDocument();

    // Local extrapolation advances time without extra server message
    act(() => {
      vi.advanceTimersByTime(2200);
    });
    expect(screen.getByText("00:32")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Pausar" }));
    fireEvent.click(screen.getByRole("button", { name: "Voltar 10 segundos" }));
    fireEvent.click(screen.getByRole("button", { name: "Avançar 10 segundos" }));
    fireEvent.click(screen.getByRole("button", { name: "Pular anúncio" }));

    const sent = ws.sent.map((raw) => JSON.parse(raw));
    expect(sent[0]).toMatchObject({ v: 1, type: "command", sessionId: "chrome:11", action: "pause" });
    expect(sent[1]).toMatchObject({
      v: 1,
      type: "command",
      sessionId: "chrome:11",
      action: "seek_relative",
      value: -10,
    });
    expect(sent[2]).toMatchObject({
      v: 1,
      type: "command",
      sessionId: "chrome:11",
      action: "seek_relative",
      value: 10,
    });
    expect(sent[3]).toMatchObject({
      v: 1,
      type: "command",
      sessionId: "chrome:11",
      action: "skip_ad",
    });
  });

  it("handles empty state, session switching with state indicators, reconnect, and pairing_required", () => {
    render(<App />);
    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.simulateOpen();
      ws.simulateMessage(makeSampleState({ sessions: [], activeSessionId: null }));
    });
    expect(screen.getByText("Nenhuma mídia tocando")).toBeInTheDocument();

    act(() => {
      ws.simulateMessage(makeSampleState());
    });

    fireEvent.click(screen.getByRole("button", { name: "Selecionar sessão de mídia" }));
    expect(screen.getByRole("dialog", { name: "Sessões de mídia disponíveis" })).toBeInTheDocument();

    // Equalizer for playing and "Pausado" for paused session
    expect(screen.getByTitle("Tocando agora")).toBeInTheDocument();
    expect(screen.getByText("Pausado")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Faixa Salva"));

    const selectMsg = JSON.parse(ws.sent.at(-1)!);
    expect(selectMsg).toMatchObject({ v: 1, type: "select", sessionId: "windows:Spotify.exe:0" });

    act(() => {
      ws.simulateMessage({
        v: 1,
        type: "error",
        code: "command_failed",
        message: "Erro simulado no comando",
      });
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Erro simulado no comando");
    fireEvent.click(screen.getByRole("button", { name: "Fechar aviso de erro" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    act(() => {
      ws.simulateClose(1006);
    });
    expect(screen.getByText("Reconectando...")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1100);
    });
    const ws2 = MockWebSocket.instances[1];
    expect(ws2).toBeDefined();

    act(() => {
      ws2.simulateOpen();
      ws2.simulateClose(4001);
    });
    expect(screen.getByText("Dispositivo não pareado")).toBeInTheDocument();
  });

  it("filters inactive and system apps in Volume view and supports More tab", () => {
    render(<App />);
    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.simulateOpen();
      ws.simulateMessage(makeSampleState());
    });

    // Switch to Volume tab
    fireEvent.click(screen.getByRole("button", { name: "Volume" }));

    // Chrome tab volume is present
    fireEvent.click(screen.getByRole("button", { name: /Silenciar aba Lo-fi Hip Hop Radio/i }));

    // Active non-system app (Spotify) is present
    expect(screen.getByText("Spotify")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("slider", { name: /Volume de Spotify/i }), {
      target: { value: "0.35" },
    });

    // Inactive app (VLC), system sounds, terminal, and duplicate Chrome are filtered out
    expect(screen.queryByText("Sons do Sistema")).not.toBeInTheDocument();
    expect(screen.queryByText("Windows Terminal")).not.toBeInTheDocument();
    expect(screen.queryByText("VLC media player")).not.toBeInTheDocument();
    // "Google Chrome" is NOT rendered as an app because Chrome tabs are present
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toContain("Abas do Chrome");
    expect(headings).toContain("Aplicativos (Windows)");

    const volMsgs = ws.sent.map((s) => JSON.parse(s));
    expect(volMsgs[0]).toMatchObject({ v: 1, type: "volume", target: "chrome:11", muted: true });
    expect(volMsgs[1]).toMatchObject({
      v: 1,
      type: "volume",
      target: "windows-audio:Spotify.exe",
      value: 0.35,
    });

    // Switch to Mais tab
    fireEvent.click(screen.getByRole("button", { name: "Mais" }));

    fireEvent.change(screen.getByPlaceholderText("Colar link"), {
      target: { value: "https://youtube.com/watch?v=123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Abrir" }));

    // Single connection status card
    expect(screen.getByText("Conectado (Host + Extensão)")).toBeInTheDocument();

    // Theme switcher at the end
    fireEvent.click(screen.getByRole("radio", { name: "Escuro" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    fireEvent.click(screen.getByRole("radio", { name: "Claro" }));
    expect(document.documentElement.dataset.theme).toBe("light");

    const openMsgs = ws.sent.slice(2).map((s) => JSON.parse(s));
    expect(openMsgs[0]).toMatchObject({
      v: 1,
      type: "open",
      mode: "url",
      url: "https://youtube.com/watch?v=123",
    });
  });

  it("sends auth frame if token is stored in localStorage", () => {
    localStorage.setItem("pcmedia_auth_token_v1", "test-auth-token-xyz");
    render(<App />);
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.simulateOpen();
    });
    expect(ws.sent.length).toBeGreaterThanOrEqual(1);
    const firstMsg = JSON.parse(ws.sent[0]);
    expect(firstMsg).toEqual({
      v: 1,
      type: "auth",
      token: "test-auth-token-xyz",
    });
  });

  it("handles pairing with 6-digit PIN when pairing is required", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        token: "tok-new-123",
        deviceId: "dev_abc",
        deviceName: "Celular Teste",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.simulateOpen();
      ws.simulateClose(4001);
    });

    expect(screen.getByText("Dispositivo não pareado")).toBeInTheDocument();

    const pinInput = screen.getByLabelText("PIN de 6 dígitos");
    fireEvent.change(pinInput, { target: { value: "123456" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Parear com PIN" }));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/pair",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(localStorage.getItem("pcmedia_auth_token_v1")).toBe("tok-new-123");

    // After pairing, WebSocket should immediately connect and send auth frame
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    const newWs = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    act(() => {
      newWs.simulateOpen();
    });
    expect(newWs.sent.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(newWs.sent[0])).toEqual({
      v: 1,
      type: "auth",
      token: "tok-new-123",
    });
  });

  it("shows pairing screen immediately on LAN when no token is stored", () => {
    delete (window as unknown as { location?: unknown }).location;
    (window as unknown as { location: unknown }).location = new URL("http://192.168.15.4:8765/");

    render(<App />);

    // Should immediately show PairingPlaceholder on LAN without token
    expect(screen.getByText("Dispositivo não pareado")).toBeInTheDocument();
    // No WebSocket should be opened
    expect(MockWebSocket.instances.length).toBe(0);
  });

  it("displays connection diagnostic panel in More view with live socket info", () => {
    localStorage.setItem("pcmedia_auth_token_v1", "tok_mobile_demo_123");
    render(<App />);
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.simulateOpen();
    });

    fireEvent.click(screen.getByRole("button", { name: "Mais" }));

    expect(screen.getByText("Diagnóstico de Conexão")).toBeInTheDocument();
    expect(screen.getByText("URL WebSocket")).toBeInTheDocument();
    expect(screen.getByText(/ws:\/\//)).toBeInTheDocument();
    expect(screen.getByText("Salvo")).toBeInTheDocument();
  });

  it("reconnects and re-authenticates in under 1s after close code 1006", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem("pcmedia_auth_token_v1", "tok_fast_reconnect");
      render(<App />);
      const ws = MockWebSocket.instances[0];
      act(() => {
        ws.simulateOpen();
      });

      // Simulate abnormal closure (code 1006 - e.g. screen lock or WiFi blip)
      act(() => {
        ws.simulateClose(1006);
      });

      // Advance timer by 450ms (< 1s)
      act(() => {
        vi.advanceTimersByTime(450);
      });

      expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
      const reconnectedWs = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      act(() => {
        reconnectedWs.simulateOpen();
      });

      expect(reconnectedWs.sent).toContain(
        JSON.stringify({ v: 1, type: "auth", token: "tok_fast_reconnect" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects immediately when document becomes visible again (visibilitychange)", () => {
    localStorage.setItem("pcmedia_auth_token_v1", "tok_visibility_test");
    render(<App />);
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.simulateOpen();
      ws.readyState = WebSocket.CLOSED;
    });

    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    const reconnectedWs = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    act(() => {
      reconnectedWs.simulateOpen();
    });

    expect(reconnectedWs.sent).toContain(
      JSON.stringify({ v: 1, type: "auth", token: "tok_visibility_test" }),
    );
  });

  it("processes AckMessage and updates latency telemetry and error toast", () => {
    render(<App />);
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.simulateOpen();
      ws.simulateMessage({
        v: 1,
        type: "ack",
        requestId: "pwa-1",
        ok: true,
        clientSentAt: Date.now() - 42,
        execMs: 8.5,
        target: "chrome:101",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Mais" }));
    expect(screen.getByText("RTT (Ida + Volta):")).toBeInTheDocument();
    expect(screen.getByText("Execução no Host:")).toBeInTheDocument();
    expect(screen.getByText(/8\.5 ms/)).toBeInTheDocument();
  });

  it("supports Buscar tab: search query, results, play_video, history chips, fallback, and fullscreen toggle", async () => {
    render(<App />);
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.simulateOpen();
      ws.simulateMessage(makeSampleState());
    });

    // Verify fullscreen toggle button on NowPlayingView
    const fullscreenBtn = screen.getByRole("button", { name: "Tela cheia" });
    expect(fullscreenBtn).toBeInTheDocument();
    fireEvent.click(fullscreenBtn);
    const cmdMsgs = ws.sent.map((s) => JSON.parse(s));
    expect(cmdMsgs[0]).toMatchObject({
      v: 1,
      type: "command",
      sessionId: "chrome:11",
      action: "toggle_fullscreen",
    });

    // Switch to Buscar tab
    const searchNavBtn = screen.getByRole("button", { name: "Buscar" });
    fireEvent.click(searchNavBtn);

    // Initial empty state
    expect(screen.getByText("Buscar e Tocar Vídeos")).toBeInTheDocument();

    const searchInput = screen.getByPlaceholderText("Buscar vídeos no YouTube...");
    fireEvent.change(searchInput, { target: { value: "lofi hip hop" } });

    // Submit search
    const submitBtn = screen.getByRole("button", { name: "Pesquisar vídeos" });
    fireEvent.click(submitBtn);

    // Verify search message sent to host
    const searchSent = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === "search");
    expect(searchSent).toBeDefined();
    expect(searchSent).toMatchObject({
      v: 1,
      type: "search",
      query: "lofi hip hop",
    });

    // Simulate search_results message from host
    await act(async () => {
      ws.simulateMessage({
        v: 1,
        type: "search_results",
        requestId: searchSent.requestId,
        ok: true,
        query: "lofi hip hop",
        results: [
          {
            id: "jfKfPfyJRdk",
            title: "lofi hip hop radio - beats to relax/study to",
            channel: "Lofi Girl",
            duration: "",
            views: "1.2M visualizações",
            thumbnail: "https://i.ytimg.com/vi/jfKfPfyJRdk/hqdefault.jpg",
            isLive: true,
          },
          {
            id: "5qap5aO4i9A",
            title: "Lofi Hip Hop Chill Mix",
            channel: "ChilledCow",
            duration: "24:15",
            views: "850K visualizações",
            thumbnail: "https://i.ytimg.com/vi/5qap5aO4i9A/hqdefault.jpg",
            isLive: false,
          },
        ],
      });
      await Promise.resolve();
    });

    // Assert results are rendered
    expect(screen.getByText("lofi hip hop radio - beats to relax/study to")).toBeInTheDocument();
    expect(screen.getByText("AO VIVO")).toBeInTheDocument();
    expect(screen.getByText("Lofi Hip Hop Chill Mix")).toBeInTheDocument();
    expect(screen.getByText("24:15")).toBeInTheDocument();

    // Click "Tocar agora" on first video
    const playNowButtons = screen.getAllByRole("button", { name: /Tocar agora/i });
    fireEvent.click(playNowButtons[0]);

    const playMsgs = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.action === "play_video");
    expect(playMsgs[0]).toMatchObject({
      v: 1,
      type: "command",
      action: "play_video",
      videoId: "jfKfPfyJRdk",
      mode: "current_tab",
      fullscreen: true,
    });

    // Click "Nova aba" on second video
    const newTabButtons = screen.getAllByRole("button", { name: "Nova aba" });
    fireEvent.click(newTabButtons[1]);

    const playMsgs2 = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.action === "play_video");
    expect(playMsgs2[1]).toMatchObject({
      v: 1,
      type: "command",
      action: "play_video",
      videoId: "5qap5aO4i9A",
      mode: "new_tab",
      fullscreen: true,
    });

    // Test error state with fallback button
    fireEvent.change(searchInput, { target: { value: "error query" } });
    fireEvent.click(screen.getByRole("button", { name: "Pesquisar vídeos" }));
    const errorSearchMsg = ws.sent.map((s) => JSON.parse(s)).find((m) => m.query === "error query");

    await act(async () => {
      ws.simulateMessage({
        v: 1,
        type: "search_results",
        requestId: errorSearchMsg.requestId,
        ok: false,
        query: "error query",
        results: [],
        error: "Extensão Chrome offline.",
      });
      await Promise.resolve();
    });

    expect(screen.getByText("Falha na busca")).toBeInTheDocument();
    expect(screen.getByText("Extensão Chrome offline.")).toBeInTheDocument();
    const fallbackBtn = screen.getByRole("button", { name: "Abrir busca no notebook" });
    fireEvent.click(fallbackBtn);

    const openSearchSent = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === "open" && m.mode === "youtube_search");
    expect(openSearchSent).toBeDefined();
    expect(openSearchSent).toMatchObject({
      v: 1,
      type: "open",
      mode: "youtube_search",
      query: "error query",
    });
  });

  it("supports Controle tab: locked state by default, security switch in MoreView, touchpad gestures and mouse buttons", () => {
    localStorage.clear();
    render(<App />);
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.simulateOpen();
      ws.simulateMessage(makeSampleState({ remoteInputEnabled: false }));
    });

    // Switch to Controle tab while locked
    fireEvent.click(screen.getByRole("button", { name: "Controle" }));
    expect(screen.getByText("Mouse e teclado desativados")).toBeInTheDocument();

    // Go to settings via CTA -> toggles switch in Mais tab
    fireEvent.click(screen.getByRole("button", { name: "Ir para Configurações" }));
    const toggleSwitch = screen.getByRole("switch", { name: "Ativar mouse e teclado remoto" });
    expect(toggleSwitch).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Desativado")).toBeInTheDocument();

    fireEvent.click(toggleSwitch);
    const settingsMsg = JSON.parse(ws.sent.at(-1)!);
    expect(settingsMsg).toMatchObject({
      v: 1,
      type: "settings",
      remoteInputEnabled: true,
    });

    // Host confirms enabled -> switch back to Controle tab
    act(() => {
      ws.simulateMessage(makeSampleState({ remoteInputEnabled: true }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Controle" }));

    const pad = screen.getByRole("application", { name: "Área do touchpad" });
    expect(pad).toBeInTheDocument();

    // 1-finger move (1.5x sensitivity: 10px -> 15px, no requestId)
    fireEvent.touchStart(pad, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchMove(pad, { touches: [{ clientX: 110, clientY: 104 }] });
    act(() => {
      vi.advanceTimersByTime(20);
    });
    fireEvent.touchEnd(pad, { touches: [] });

    const moveMsg = ws.sent.map((s) => JSON.parse(s)).find((m) => m.action === "mouse_move");
    expect(moveMsg).toMatchObject({ v: 1, type: "input", action: "mouse_move", dx: 15, dy: 6 });
    expect(moveMsg.requestId).toBeUndefined();

    // 1-finger quick tap -> left click
    fireEvent.touchStart(pad, { touches: [{ clientX: 50, clientY: 50 }] });
    fireEvent.touchEnd(pad, { touches: [] });
    expect(JSON.parse(ws.sent.at(-1)!)).toMatchObject({
      type: "input",
      action: "mouse_click",
      button: "left",
      double: false,
    });

    // 2-finger quick tap -> right click
    fireEvent.touchStart(pad, {
      touches: [
        { clientX: 40, clientY: 40 },
        { clientX: 80, clientY: 40 },
      ],
    });
    fireEvent.touchEnd(pad, { touches: [] });
    expect(JSON.parse(ws.sent.at(-1)!)).toMatchObject({
      type: "input",
      action: "mouse_click",
      button: "right",
    });

    // Vertical scroll strip drag -> mouse_scroll
    const scrollStrip = screen.getByRole("scrollbar", { name: "Barra de rolagem vertical" });
    fireEvent.touchStart(scrollStrip, { touches: [{ clientX: 300, clientY: 100 }] });
    fireEvent.touchMove(scrollStrip, { touches: [{ clientX: 300, clientY: 80 }] });
    act(() => {
      vi.advanceTimersByTime(20);
    });
    fireEvent.touchEnd(scrollStrip, { touches: [] });

    const scrollMsg = ws.sent.map((s) => JSON.parse(s)).find((m) => m.action === "mouse_scroll");
    expect(scrollMsg).toMatchObject({ v: 1, type: "input", action: "mouse_scroll", dy: -100 });
    expect(scrollMsg.requestId).toBeUndefined();

    // Arrastar lock & release buttons
    fireEvent.click(screen.getByRole("button", { name: "Arrastar" }));
    expect(JSON.parse(ws.sent.at(-1)!)).toMatchObject({
      type: "input",
      action: "mouse_down",
      button: "left",
    });
    fireEvent.click(screen.getByRole("button", { name: "Soltar" }));
    expect(JSON.parse(ws.sent.at(-1)!)).toMatchObject({
      type: "input",
      action: "mouse_up",
      button: "left",
    });
  });

  it("supports Controle tab remote keyboard in batch mode (with accents) and real-time mode + quick shortcuts", () => {
    localStorage.clear();
    render(<App />);
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.simulateOpen();
      ws.simulateMessage(makeSampleState({ remoteInputEnabled: true }));
    });

    fireEvent.click(screen.getByRole("button", { name: "Controle" }));

    const textInput = screen.getByLabelText("Digitar texto para o PC");
    fireEvent.change(textInput, { target: { value: "Olá ação!" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));

    expect(JSON.parse(ws.sent.at(-1)!)).toMatchObject({
      v: 1,
      type: "input",
      action: "key_text",
      text: "Olá ação!",
    });

    // Switch to Tempo real mode
    fireEvent.click(screen.getByRole("radio", { name: "Tempo real" }));
    const liveInput = screen.getByLabelText("Digitar texto para o PC");
    fireEvent.change(liveInput, { target: { value: "a" } });
    expect(JSON.parse(ws.sent.at(-1)!)).toMatchObject({
      v: 1,
      type: "input",
      action: "key_text",
      text: "a",
    });

    // Special shortcuts Alt+Tab and Copiar
    fireEvent.click(screen.getByRole("button", { name: "Alt+Tab" }));
    expect(JSON.parse(ws.sent.at(-1)!)).toMatchObject({
      type: "input",
      action: "key_press",
      key: "tab",
      modifiers: ["alt"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Copiar" }));
    expect(JSON.parse(ws.sent.at(-1)!)).toMatchObject({
      type: "input",
      action: "key_press",
      key: "c",
      modifiers: ["ctrl"],
    });
  });
});
