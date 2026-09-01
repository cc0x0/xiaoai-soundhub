import { getData, saveData } from '@/plugins/storage'

const SOUNDHUB_SERVER_URL_KEY = 'soundhub_server_url'
const SOUNDHUB_TOKEN_KEY = 'soundhub_token'
const SOUNDHUB_SELECTED_DIDS_KEY = 'soundhub_selected_dids'

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

/** Must match the placeholder shown in the XiaoAi settings panel. */
export const DEFAULT_SERVER_URL = 'http://127.0.0.1:8989'

class XiaoAiService {
  private serverUrl: string = DEFAULT_SERVER_URL
  private token: string = ''
  private cachedDevices: XiaoAiDevice[] = []
  private selectedDids: string[] = []

  constructor() {
    void this.init()
  }

  public async init(): Promise<void> {
    try {
      const url = await getData<string>(SOUNDHUB_SERVER_URL_KEY)
      if (url) this.serverUrl = url

      const token = await getData<string>(SOUNDHUB_TOKEN_KEY)
      if (token) this.token = token

      const dids = await getData<string[]>(SOUNDHUB_SELECTED_DIDS_KEY)
      if (dids && Array.isArray(dids)) this.selectedDids = dids
    } catch {
      // ignore
    }
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

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`
    }
    return headers
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

    const json = await response.json()
    if (json.ok) {
      return (json.results ?? {}) as Record<string, boolean>
    }
    throw new Error(json.error ? String(json.error) : '发送 TTS 失败')
  }

  /**
   * 投播歌曲到小爱音箱
   *
   * The server answers `{ok, msg}` with no payload, so this resolves to void
   * rather than pretending to return per-device results.
   */
  public async castSong(music: CastMusicParams, targetDids?: string[]): Promise<void> {
    const dids = targetDids && targetDids.length > 0 ? targetDids : this.selectedDids
    if (dids.length === 0) {
      throw new Error('请先选择要投播的小爱音箱')
    }

    const response = await fetch(`${this.serverUrl}/api/play`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ music, dids }),
    })

    const json = await response.json()
    if (!json.ok) {
      throw new Error(json.error ? String(json.error) : '投播歌曲失败')
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
}

export const xiaoaiService = new XiaoAiService()

