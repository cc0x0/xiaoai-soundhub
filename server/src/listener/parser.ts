/**
 * 语音指令解析器
 * 从实体小爱音箱识别到的文本中提取操作意图与搜歌关键词
 */

export interface ParsedVoiceCommand {
  type: 'play' | 'stop' | 'pause' | 'resume' | 'next' | 'prev' | 'volume' | 'unknown';
  keyword?: string;
  volume?: number;
  isAllSpeakers?: boolean;
  rawText: string;
}

export class VoiceParser {
  private playPrefixes = [
    '点歌', '搜歌', '放歌', '听歌', '听一首', '来一曲', '唱一曲',
    '播放歌曲', '播放', '我想听', '放一首', '唱一首', '放首', '来首', '来一首',
  ];
  private stopKeywords = [
    '停止播放', '停止', '别唱了', '闭嘴', '关机', '不要放了', '别放了',
    '退下', '退下吧', '别播了', '不听了', '别放歌了', '关闭播放', '关掉音乐',
    '停', '别吵了', '休息吧', '别吵', '不播了', '不要播了', '关掉', '退出',
  ];
  private pauseKeywords = [
    '暂停播放', '暂停', '先停一下', '稍等一下', '暂停一下', '停一下', '等一下', '先别放了',
  ];
  private resumeKeywords = ['继续播放', '恢复播放', '继续'];
  private nextKeywords = ['下一首', '切歌', '换一首', '下一曲', '换歌', '切下一首'];
  private prevKeywords = ['上一首', '上一曲', '切上一首'];

  constructor(customStopKeywords: string[] = [], customPlayPrefixes: string[] = []) {
    if (customStopKeywords && customStopKeywords.length > 0) {
      this.stopKeywords = Array.from(new Set([...this.stopKeywords, ...customStopKeywords.filter(Boolean)]));
    }
    if (customPlayPrefixes && customPlayPrefixes.length > 0) {
      this.playPrefixes = Array.from(new Set([...this.playPrefixes, ...customPlayPrefixes.filter(Boolean)]));
    }
  }

  public parse(text: string): ParsedVoiceCommand {
    let raw = (text || '').trim();
    if (!raw) {
      return { type: 'unknown', rawText: raw };
    }

    // 检测是否触发全屋广播/全部播放
    const isAllSpeakers = /全屋|所有音箱|全部音箱|到处都|每间房|全家/.test(raw);
    // 清洗掉“全屋”修饰前缀与修饰介词，便于后续指令识别
    const cleanedRaw = raw
      .replace(/全屋|所有音箱|全部音箱|到处都|每间房|全家/g, '')
      .replace(/^[在让向给]/, '')
      .trim();

    // 1. 停止
    if (this.stopKeywords.some((k) => raw === k || raw.startsWith(k) || raw.endsWith(k) || cleanedRaw === k)) {
      return { type: 'stop', isAllSpeakers, rawText: raw };
    }

    // 2. 暂停
    if (this.pauseKeywords.some((k) => raw === k || raw.startsWith(k) || raw.endsWith(k) || cleanedRaw === k)) {
      return { type: 'pause', isAllSpeakers, rawText: raw };
    }

    // 3. 继续
    if (this.resumeKeywords.some((k) => raw === k || cleanedRaw === k)) {
      return { type: 'resume', isAllSpeakers, rawText: raw };
    }

    // 4. 下一首
    if (this.nextKeywords.some((k) => raw.includes(k) || cleanedRaw.includes(k))) {
      return { type: 'next', isAllSpeakers, rawText: raw };
    }

    // 5. 上一首
    if (this.prevKeywords.some((k) => raw.includes(k) || cleanedRaw.includes(k))) {
      return { type: 'prev', isAllSpeakers, rawText: raw };
    }

    // 6. 音量控制
    const volMatch = raw.match(/音量.*?(?:调到|设为|调成|为)?\s*(\d{1,3})/);
    if (volMatch && volMatch[1]) {
      const vol = parseInt(volMatch[1], 10);
      if (vol >= 0 && vol <= 100) {
        return { type: 'volume', volume: vol, isAllSpeakers, rawText: raw };
      }
    }

    // 7. 播放与搜歌口令匹配
    for (const prefix of this.playPrefixes) {
      const matched = raw.startsWith(prefix) ? raw : cleanedRaw.startsWith(prefix) ? cleanedRaw : null;
      if (matched) {
        let keyword = matched.slice(prefix.length).trim();
        // 清理常见的修饰词与语气词
        keyword = keyword.replace(/^在?(全屋|所有音箱|全部音箱)/, '').trim();
        keyword = keyword.replace(/的(歌|歌曲|音乐)$/, '').trim();
        // 将“周杰伦的晴天”智能清洗为“周杰伦 晴天”，精准定位原唱
        keyword = keyword.replace(/(?<=[^\s])的(?=[^\s])/g, ' ').replace(/\s+/g, ' ').trim();
        if (keyword) {
          return { type: 'play', keyword, isAllSpeakers, rawText: raw };
        }
      }
    }

    return { type: 'unknown', isAllSpeakers, rawText: raw };
  }
}

