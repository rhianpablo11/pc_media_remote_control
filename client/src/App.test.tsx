import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { StateMessage } from "./types";
import { extrapolatePosition, formatTime, safeArtworkUrl } from "./utils";

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
    ],
    sessions: [
      {
        id: "chrome:11",
        source: "chrome",
        app: "YouTube",
        appId: "chrome.exe",
        title: "Lo-fi Hip Hop Radio",
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
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("loads cached state first, transitions to live state, extrapolates time, and sends commands", () => {
    const cached = makeSampleState({
      sessions: [{ ...makeSampleState().sessions[0], title: "Sessão em Cache" }],
    });
    localStorage.setItem("pcmedia_last_state_v1", JSON.stringify(cached));

    render(<App />);

    expect(screen.getByText("Conectando (cache)")).toBeInTheDocument();
    expect(screen.getByText("Sessão em Cache")).toBeInTheDocument();

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();

    act(() => {
      ws.simulateOpen();
      ws.simulateMessage(makeSampleState());
    });

    expect(screen.getByText("Conectado")).toBeInTheDocument();
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

  it("handles empty state, session switching, reconnect, pairing_required, and error banner", () => {
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

  it("supports Volume controls and More tab (YouTube search, URL open, themes)", () => {
    render(<App />);
    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.simulateOpen();
      ws.simulateMessage(makeSampleState());
    });

    // Switch to Volume tab
    fireEvent.click(screen.getByRole("button", { name: "Volume" }));
    fireEvent.click(screen.getByRole("button", { name: /Silenciar aba Lo-fi Hip Hop Radio/i }));
    fireEvent.change(screen.getByRole("slider", { name: /Volume de Spotify/i }), {
      target: { value: "0.35" },
    });

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
    fireEvent.change(screen.getByLabelText("Buscar vídeo no YouTube"), {
      target: { value: "synthwave live" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));

    fireEvent.change(screen.getByLabelText("Abrir URL em nova aba"), {
      target: { value: "https://youtube.com/watch?v=123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Abrir" }));

    fireEvent.click(screen.getByRole("radio", { name: "Escuro" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    fireEvent.click(screen.getByRole("radio", { name: "Claro" }));
    expect(document.documentElement.dataset.theme).toBe("light");

    const openMsgs = ws.sent.slice(2).map((s) => JSON.parse(s));
    expect(openMsgs[0]).toMatchObject({
      v: 1,
      type: "open",
      mode: "youtube_search",
      query: "synthwave live",
    });
    expect(openMsgs[1]).toMatchObject({
      v: 1,
      type: "open",
      mode: "url",
      url: "https://youtube.com/watch?v=123",
    });
  });
});
