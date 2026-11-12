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
  | "skip_ad";

export interface ControlsPayload {
  play: boolean;
  pause: boolean;
  toggle: boolean;
  next: boolean;
  previous: boolean;
  seek: boolean;
  skipAd: boolean;
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
}

export interface ErrorMessage {
  v: 1;
  type: "error";
  code: string;
  message: string;
  requestId?: string | null;
}

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "pairing_required";

export type ThemeMode = "auto" | "light" | "dark";
export type ActiveTab = "now_playing" | "volume" | "more";
