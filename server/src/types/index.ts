/**
 * XiaoAi SoundHub - 类型定义
 */

export interface DeviceInfo {
  did: string;
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
}

export interface SearchResult {
  list: MusicItem[];
  total: number;
  page: number;
  limit: number;
  source: string;
}

export interface MusicUrlResult {
  url: string;
  headers?: Record<string, string>;
  quality: string;
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

