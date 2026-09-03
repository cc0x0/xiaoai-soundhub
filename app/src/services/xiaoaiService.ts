import { getData, saveData } from '@/plugins/storage'
import { storageDataPrefix } from '@/config/constant'

const SOUNDHUB_SERVER_URL_KEY = storageDataPrefix.soundhubServerUrl
const SOUNDHUB_TOKEN_KEY = storageDataPrefix.soundhubToken
const SOUNDHUB_SELECTED_DIDS_KEY = storageDataPrefix.soundhubSelectedDids

/**
 * Keys an earlier build wrote without the `@` prefix and without registering
 * them in storageDataPrefix. Read as a fallback so an existing install does not
 * lose its server address, token and speaker selection on upgrade.
 */
const LEGACY_KEYS = {
  serverUrl: 'soundhub_server_url',
  token: 'soundhub_token',
  selectedDids: 'soundhub_selected_dids',
} as const

export interface XiaoAiDevice {
  did: string
  name: string
  alias: string
  model: string
  online?: boolean
  source: string
}

export interface CastMusicParams {
  id: string
  name: string
  singer: string
  albumName?: string
  interval?: string
  duration?: number
  img?: string
  source: string
  raw?: any
}

/** One speaker as the cloud knows it, including its management flags. */
export interface XiaoAiSpeaker {
  did: string
  name: string
  model: string
  hardware: string
  is_gateway: number
  is_ignored: number
  is_listener_enabled: number
}

/** The tenant's server-side preferences, mirrored into the app. */
export interface XiaoAiUserSettings {
  search_platform: string
  preferred_quality: string
  default_chime: string
  enable_tts_chime: number
  fallback_policy: 'strict' | 'cross_source'
}

/** Prelude tone played before a TTS announcement. */
export type ChimeType = 'dingdong' | 'gentle' | 'marimba' | 'none'

export interface CastOutcome {
  /** True when a same-recording copy from another platform was substituted. */
  crossSource: boolean
  msg: string
}

/**
 * A cast that failed for a reason the user can act on.
 * `reason` mirrors the server's ResolveFailureReason so the UI can offer the
 * matching fix (bind an account, configure a source credential) instead of a
 * dead-end toast.
 */
export class CastFailedError extends Error {
  public readonly reason: string
  constructor(message: string, reason: string) {
    super(message)
    this.name = 'CastFailedError'
    this.reason = reason
  }
}

/**
 * The stored token was rejected. Thrown so callers can reopen the auth prompt
 * rather than showing a toast the user cannot act on — an expired session looks
 * identical to a network failure otherwise.
 */
export class AuthExpiredError extends Error {
  constructor(message = '登录会话已过期，请重新登录') {
    super(message)
    this.name = 'AuthExpiredError'
  }
}

/** Must match the placeholder shown in the XiaoAi settings panel. */
export const DEFAULT_SERVER_URL = 'http://117.72.79.238:8989'

class XiaoAiService {
  private serverUrl: string = DEFAULT_SERVER_URL
  private token: string = ''
  private cachedDevices: XiaoAiDevice[] = []
  private selectedDids: string[] = []
  private username: string = ''

  constructor() {
    void this.init()
  }

  public async init(): Promise<void> {
    try {
      // Prefer the registered key, then migrate whatever the legacy bare key
      // holds so the value survives and later reads find it in the new place.
      const url = await getData<string>(SOUNDHUB_SERVER_URL_KEY) ??
        await getData<string>(LEGACY_KEYS.serverUrl)
      if (url && !url.includes('127.0.0.1')) {
        this.serverUrl = url
      } else {
        this.serverUrl = DEFAULT_SERVER_URL
        await saveData(SOUNDHUB_SERVER_URL_KEY, this.serverUrl)
      }

      const token = await getData<string>(SOUNDHUB_TOKEN_KEY) ??
        await getData<string>(LEGACY_KEYS.token)
      this.token = token || 'self_hosted_token'
      if (!token) {
        await saveData(SOUNDHUB_TOKEN_KEY, this.token)
      }

      this.username = await getData<string>('@soundhub_username') ?? ''

      const dids = await getData<string[]>(SOUNDHUB_SELECTED_DIDS_KEY) ??
        await getData<string[]>(LEGACY_KEYS.selectedDids)
      if (dids && Array.isArray(dids)) {
        this.selectedDids = dids
        await saveData(SOUNDHUB_SELECTED_DIDS_KEY, dids)
      }
    } catch {
      // ignore
    }
  }

  public getUsername(): string {
    return this.username
  }

  public async setUsername(u: string): Promise<void> {
    this.username = u
    await saveData('@soundhub_username', u)
  }

  public getServerUrl(): string {
    return this.serverUrl
  }

  public async setServerUrl(url: string): Promise<void> {
    this.serverUrl = url.replace(/\/$/, '')
    await saveData(SOUNDHUB_SERVER_URL_KEY, this.serverUrl)
  }

  public getToken(): string {
    return this.token
  }

  public async setToken(token: string): Promise<void> {
    this.token = token
    await saveData(SOUNDHUB_TOKEN_KEY, this.token)
  }

  public getSelectedDids(): string[] {
    return this.selectedDids
  }

  public async setSelectedDids(dids: string[]): Promise<void> {
    this.selectedDids = dids
    await saveData(SOUNDHUB_SELECTED_DIDS_KEY, dids)
  }

  /** True when a token is on hand or in self-hosted mode. */
  public hasToken(): boolean {
    return !!(this.serverUrl)
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`
    }
    return headers
  }

  // ====== 鉴权 (惰性登录：只在需要云端能力时才要求) ======

  /**
   * Log in and keep the token. `register` creates the account first, for the
   * "I don't have one yet" path in the same modal — one less trip to a browser.
   */
  public async login(username: string, password: string, register = false): Promise<string> {
    const endpoint = register ? '/api/auth/register' : '/api/auth/login'
    const response = await fetch(`${this.serverUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })

    const json = await response.json()
    if (!json.ok || !json.data?.token) {
      throw new Error(json.error ? String(json.error) : (register ? '注册失败' : '登录失败'))
    }

    const uname = String(json.data.username ?? json.data.user?.username ?? username)
    await this.setToken(String(json.data.token))
    await this.setUsername(uname)
    return uname
  }

  /** Verify the stored token against the server; false means re-login needed. */
  public async verifyToken(): Promise<boolean> {
    if (!this.token) return false
    try {
      const response = await fetch(`${this.serverUrl}/api/auth/me`, {
        method: 'GET',
        headers: this.getHeaders(),
      })
      const json = await response.json()
      return json.ok === true
    } catch {
      return false
    }
  }

  public async logout(): Promise<void> {
    await this.setToken('')
    await this.setUsername('')
    this.cachedDevices = []
  }

  /**
   * Drop a token the server has rejected, so the next `hasToken()` check
   * correctly reports "not bound" and the UI offers the login prompt.
   */
  private async handleUnauthorized(): Promise<never> {
    await this.setToken('')
    this.cachedDevices = []
    throw new AuthExpiredError()
  }

  /**
   * 拉取云端小爱音箱列表
   */
  public async getDevices(forceRefresh = false): Promise<XiaoAiDevice[]> {
    if (!forceRefresh && this.cachedDevices.length > 0) {
      return this.cachedDevices
    }

    try {
      const response = await fetch(`${this.serverUrl}/api/devices`, {
        method: 'GET',
        headers: this.getHeaders(),
      })

      if (response.status === 401) await this.handleUnauthorized()

      const json = await response.json()
      if (json.ok && Array.isArray(json.data)) {
        this.cachedDevices = json.data
        return this.cachedDevices
      }
      throw new Error(json.error ? String(json.error) : '获取设备失败')
    } catch (err: unknown) {
      console.warn('[XiaoAiService] 拉取设备列表失败:', (err as Error).message)
      throw err
    }
  }

  /**
   * 发送多音箱文本语音 (TTS) 广播
   *
   * The server answers `{ok, msg, results}` — note `results`, not `data`.
   */
  public async sendTTS(
    text: string,
    targetDids?: string[],
    chime?: string,
  ): Promise<Record<string, boolean>> {
    const dids = targetDids && targetDids.length > 0 ? targetDids : this.selectedDids
    if (dids.length === 0) {
      throw new Error('未选择任何小爱音箱')
    }

    const response = await fetch(`${this.serverUrl}/api/tts`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(chime ? { text, dids, chime } : { text, dids }),
    })

    if (response.status === 401) await this.handleUnauthorized()
    const json = await response.json()
    if (json.ok) {
      return (json.results ?? {}) as Record<string, boolean>
    }
    throw new Error(json.error ? String(json.error) : '发送 TTS 失败')
  }

  /**
   * 投播歌曲到小爱音箱
   *
   * Reports whether the stream ended up coming from another platform's copy of
   * the recording, so the UI can say so rather than letting the user wonder why
   * the version sounds different from the source they picked.
   */
  public async castSong(music: CastMusicParams, targetDids?: string[]): Promise<CastOutcome> {
    const dids = targetDids && targetDids.length > 0 ? targetDids : this.selectedDids
    if (dids.length === 0) {
      throw new Error('请先选择要投播的小爱音箱')
    }

    const response = await fetch(`${this.serverUrl}/api/play`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ music, dids }),
    })

    if (response.status === 401) await this.handleUnauthorized()
    const json = await response.json()
    if (!json.ok) {
      const message = json.error ? String(json.error) : '投播歌曲失败'
      throw new CastFailedError(message, String(json.reason ?? 'unknown'))
    }

    return {
      crossSource: json.data?.crossSource === true,
      msg: String(json.msg ?? '已投播'),
    }
  }

  /**
   * 播放控制
   *
   * The volume value must be sent as `volume`: the server reads that key and
   * silently ignores anything else, so a mismatch fails without an error.
   */
  public async control(
    action: 'pause' | 'resume' | 'stop' | 'next' | 'prev' | 'volume',
    dids?: string[],
    volume?: number,
  ): Promise<boolean> {
    const targetDids = dids && dids.length > 0 ? dids : this.selectedDids
    if (targetDids.length === 0) {
      throw new Error('请先选择要控制的小爱音箱')
    }

    const body: Record<string, unknown> = { action, dids: targetDids }
    if (action === 'volume') {
      if (volume === undefined) throw new Error('未指定音量值')
      body.volume = volume
    }

    const response = await fetch(`${this.serverUrl}/api/control`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    })

    if (response.status === 401) await this.handleUnauthorized()
    const json = await response.json()
    if (!json.ok) {
      throw new Error(json.error ? String(json.error) : '控制指令下发失败')
    }
    return true
  }

  /** Current playback state per device, keyed by did. */
  public async getStatus(): Promise<Record<string, {
    music: { name: string, singer: string, source: string }
    startTime: number
    duration: number
  }>> {
    const response = await fetch(`${this.serverUrl}/api/status`, {
      method: 'GET',
      headers: this.getHeaders(),
    })
    const json = await response.json()
    if (json.ok) return json.data?.states ?? {}
    throw new Error(json.error ? String(json.error) : '获取播放状态失败')
  }

  // ====== 设备管理 (主网关 / 屏蔽 / 语音监听) ======

  /**
   * Speakers with their management flags, which `/api/devices` does not carry.
   * Requires a token — the flags are per-tenant state.
   */
  public async getSpeakers(): Promise<XiaoAiSpeaker[]> {
    const response = await fetch(`${this.serverUrl}/api/user/speakers`, {
      method: 'GET',
      headers: this.getHeaders(),
    })
    if (response.status === 401) await this.handleUnauthorized()
    const json = await response.json()
    if (json.ok && Array.isArray(json.data)) return json.data as XiaoAiSpeaker[]
    throw new Error(json.error ? String(json.error) : '获取音箱管理信息失败')
  }

  /** Designate the speaker whose voice commands drive playback. */
  public async setGateway(did: string): Promise<string> {
    return await this.postUserAction('/api/user/speakers/gateway', { did }, '设置主网关失败')
  }

  public async setSpeakerIgnored(did: string, isIgnored: boolean): Promise<string> {
    return await this.postUserAction('/api/user/speakers/ignore', { did, isIgnored }, '切换屏蔽状态失败')
  }

  public async setSpeakerListener(did: string, isEnabled: boolean): Promise<string> {
    return await this.postUserAction('/api/user/speakers/listener', { did, isEnabled }, '切换语音监听失败')
  }

  private async postUserAction(
    path: string,
    body: Record<string, unknown>,
    failMessage: string,
  ): Promise<string> {
    const response = await fetch(`${this.serverUrl}${path}`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    })
    if (response.status === 401) await this.handleUnauthorized()
    const json = await response.json()
    if (!json.ok) throw new Error(json.error ? String(json.error) : failMessage)
    return String(json.msg ?? '已生效')
  }

  // ====== 偏好设置双向同步 ======

  /** Pull the tenant's server-side preferences. */
  public async getSettings(): Promise<XiaoAiUserSettings> {
    const response = await fetch(`${this.serverUrl}/api/user/settings`, {
      method: 'GET',
      headers: this.getHeaders(),
    })
    if (response.status === 401) await this.handleUnauthorized()
    const json = await response.json()
    if (!json.ok || !json.data) {
      throw new Error(json.error ? String(json.error) : '获取云端偏好失败')
    }
    const d = json.data
    return {
      search_platform: String(d.search_platform ?? 'all'),
      preferred_quality: String(d.preferred_quality ?? '320k'),
      default_chime: String(d.default_chime ?? 'dingdong'),
      enable_tts_chime: Number(d.enable_tts_chime ?? 1),
      fallback_policy: d.fallback_policy === 'strict' ? 'strict' : 'cross_source',
    }
  }

  /** Push a partial preference change; unset keys keep their stored value. */
  public async updateSettings(patch: Partial<XiaoAiUserSettings>): Promise<string> {
    return await this.postUserAction('/api/user/settings', patch, '保存云端偏好失败')
  }
}

export const xiaoaiService = new XiaoAiService()

