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

class XiaoAiService {
  private serverUrl: string = 'http://127.0.0.1:8080'
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
   */
  public async sendTTS(text: string, targetDids?: string[]): Promise<Record<string, boolean>> {
    const dids = targetDids && targetDids.length > 0 ? targetDids : this.selectedDids
    if (dids.length === 0) {
      throw new Error('未选择任何小爱音箱')
    }

    const response = await fetch(`${this.serverUrl}/api/tts`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ text, dids }),
    })

    const json = await response.json()
    if (json.ok) {
      return json.data
    }
    throw new Error(json.error ? String(json.error) : '发送 TTS 失败')
  }

  /**
   * 投播歌曲到小爱音箱
   */
  public async castSong(music: CastMusicParams, targetDids?: string[]): Promise<Record<string, boolean>> {
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
    if (json.ok) {
      return json.data
    }
    throw new Error(json.error ? String(json.error) : '投播歌曲失败')
  }

  /**
   * 播放控制
   */
  public async control(action: 'pause' | 'resume' | 'stop' | 'next' | 'prev' | 'volume', did?: string, value?: number): Promise<boolean> {
    const targetDid = did ?? this.selectedDids[0] ?? ''
    const response = await fetch(`${this.serverUrl}/api/control`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ action, did: targetDid, value }),
    })

    const json = await response.json()
    return !!json.ok
  }
}

export const xiaoaiService = new XiaoAiService()

