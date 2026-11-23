export type MediaStatus =
  | "PLAYING"
  | "PAUSED"
  | "STOPPED"
  | "CHANGING"
  | "OPENED"
  | "CLOSED"
  | "UNKNOWN";

export type MediaAction =
  | "play"
  | "pause"
  | "toggle"
  | "next"
  | "previous"
  | "seek"
  | "seek_relative"
  | "skip_ad"
  | "play_video"
  | "toggle_fullscreen"
  | "fullscreen";

export interface ControlsPayload {
  play: boolean;
  pause: boolean;
  toggle: boolean;
  next: boolean;
  previous: boolean;
  seek: boolean;
  skipAd: boolean;
  fullscreen?: boolean;
}

export interface MediaSession {
  id: string;
  source: string;
  app: string;
  appId: string;
  title: string;
  artist: string;
  album: string;
  artworkUrl: string | null;
  status: MediaStatus;
  position: number;
  duration: number;
  controls: ControlsPayload;
  volume: number | null;
  muted: boolean | null;
  isSystemActive: boolean;
  isFullscreen?: boolean;
}

export interface MasterVolume {
  level: number;
  muted: boolean;
  deviceName: string;
}

export interface AudioSession {
  id: string;
  source: string;
  app: string;
  processName: string;
  pid: number;
  active: boolean;
  volume: number;
  muted: boolean;
}

export interface StateMessage {
  v: 1;
  type: "state";
  sessions: MediaSession[];
  activeSessionId: string | null;
  masterVolume: MasterVolume;
  audioSessions: AudioSession[];
  extensionConnected: boolean;
  remoteInputEnabled?: boolean;
  tailscaleEnabled?: boolean;
  screenMirrorAvailable?: boolean;
}

export interface ErrorMessage {
  v: 1;
  type: "error";
  code: string;
  message: string;
  requestId?: string | null;
}

export interface AckMessage {
  v: 1;
  type: "ack";
  requestId?: string | null;
  ok: boolean;
  clientSentAt?: number | null;
  execMs: number;
  target?: string | null;
  reason?: string | null;
}

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "pairing_required";

export type ThemeMode = "auto" | "light" | "dark";
export type ActiveTab = "now_playing" | "volume" | "search" | "remote" | "more";

export type MouseButton = "left" | "right" | "middle";
export type ModifierKey = "ctrl" | "alt" | "shift" | "win";
export type SystemAction =
  | "lock_screen"
  | "open_devices"
  | "open_display"
  | "open_sound"
  | "open_network";
export type InputAction =
  | "mouse_move"
  | "mouse_move_abs"
  | "mouse_click"
  | "mouse_down"
  | "mouse_up"
  | "mouse_scroll"
  | "key_text"
  | "key_press"
  | "system_action";

export interface InputMessagePayload {
  action: InputAction;
  dx?: number;
  dy?: number;
  x?: number;
  y?: number;
  monitor?: number;
  button?: MouseButton;
  double?: boolean;
  text?: string;
  key?: string;
  modifiers?: ModifierKey[];
  systemAction?: SystemAction;
}

export interface ScreenMonitorInfo {
  id: number;
  name: string;
  left: number;
  top: number;
  width: number;
  height: number;
  primary: boolean;
}

export interface ScreenMetaMessage {
  v: 1;
  type: "screen_meta";
  monitors: ScreenMonitorInfo[];
  activeMonitor: number;
  fps: number;
  quality: number;
  maxWidth: number;
  paused?: boolean;
}

export type ScreenQualityPreset = "eco" | "normal" | "fluid";

export interface SearchResultItem {
  id: string;
  title: string;
  channel: string;
  duration: string;
  views?: string;
  thumbnail: string;
  isLive: boolean;
  isShorts?: boolean;
}

export interface SearchResultsMessage {
  v: 1;
  type: "search_results";
  requestId?: string | null;
  ok: boolean;
  query: string;
  results: SearchResultItem[];
  fallbackUrl?: string | null;
  error?: string | null;
  reason?: string | null;
}

export interface SearchMessage {
  v: 1;
  type: "search";
  query: string;
  requestId?: string;
  clientSentAt?: number;
}

export interface PairedDevicePublic {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface DiagnosticInfo {
  wsUrl: string;
  clientOrigin: string;
  clientHost: string;
  isLoopback: boolean;
  hasToken: boolean;
  tokenPrefix: string;
  connectionStatus: ConnectionStatus;
  lastCloseCode: number | null;
  lastCloseReason: string | null;
  lastCloseTimestamp: string | null;
  lastError: string | null;
  reconnectAttempts: number;
  // Latency & telemetry instrumentation:
  lastRttMs?: number | null;
  lastHostExecMs?: number | null;
  lastNetworkMs?: number | null;
  lastAction?: string | null;
  avgRttMs?: number | null;
  avgHostExecMs?: number | null;
  bottleneckSummary?: string | null;
}
