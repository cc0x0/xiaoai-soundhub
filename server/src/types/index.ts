/**
 * XiaoAi SoundHub - 类型定义
 */

export interface DeviceInfo {
  did: string;
  deviceId?: string;
  hardware?: string;
  name: string;
  alias: string;
  model: string;
  mac: string;
  online?: boolean;
  source: 'MiNA' | 'MIoT';
}

export type TTSMode = 'auto' | 'command' | 'default';

export interface SpeakerConfig {
  userId: string;
  passToken?: string;
  password?: string;
  did?: string;
  defaultDid?: string;
  speakers?: Array<{
    did: string;
    name: string;
    model: string;
    enabled: boolean;
  }>;
  ttsMode?: TTSMode;
  verboseLog?: boolean;
  ttsFallbackCommand?: [number, number];
  ttsFallbackCommands?: Record<string, [number, number]>;
}

export interface AppConfig {
  server: {
    port: number;
    host: string;
    token?: string;
    publicBaseUrl: string;
  };
  speaker: SpeakerConfig;
  listener: {
    enabled: boolean;
    pollIntervalMs: number;
    keywords: string[];
    controlKeywords: {
      stop: string[];
      pause: string[];
      resume: string[];
      next: string[];
      prev: string[];
    };
  };
  sourceEngine: {
    activeSource: string;
    sourcesDir: string;
    defaultQuality: string;
    proxyStream: boolean;
  };
}

/**
 * The same recording as located on another platform, kept as a resolution hint.
 * Slim on purpose: only the fields a resolver needs, so carrying these through
 * the API payload stays cheap.
 */
export interface MusicAlternate {
  source: string;
  id: string;
  name: string;
  singer: string;
  duration?: number;
}

export interface MusicItem {
  id: string;
  name: string;
  singer: string;
  albumName?: string;
  interval?: string;
  duration?: number;
  img?: string;
  source: string;
  raw?: Record<string, unknown>;
  /** Direct audio stream URL if already resolved by client (e.g. App pre-listening) */
  streamUrl?: string;
  url?: string;
  /**
   * Copies of this exact recording found on other platforms during an
   * aggregated search. Lets resolution fall back without searching again —
   * which matters because QQ/酷狗/咪咕 gate their direct links behind VIP.
   */
  alternates?: MusicAlternate[];
}

export interface SearchResult {
  list: MusicItem[];
  total: number;
  page: number;
  limit: number;
  source: string;
}

/** Why a resolution attempt produced no url, so callers can say something useful. */
export type ResolveFailureReason =
  | 'no_source'
  | 'needs_credentials'
  | 'not_available'
  | 'blocked_by_policy';

export interface MusicUrlResult {
  url: string;
  headers?: Record<string, string>;
  quality: string;
  /** Platform the url actually came from, set when it differs from the request. */
  resolvedSource?: string;
  /** True when the url came from another platform's copy of the recording. */
  crossSource?: boolean;
  /** Present only when `url` is empty. */
  reason?: ResolveFailureReason;
  /** Chinese, user-facing explanation matching `reason`. */
  message?: string;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  msg?: string;
}

export interface PlayQueueItem {
  music: MusicItem;
  streamUrl: string;
  targetDid: string;
  startTime: number;
  duration: number;
}

