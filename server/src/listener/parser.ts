/**
 * 语音指令解析器
 * 从实体小爱音箱识别到的文本中提取操作意图与搜歌关键词
 */

export interface ParsedVoiceCommand {
  type: 'play' | 'stop' | 'pause' | 'resume' | 'next' | 'prev' | 'volume' | 'unknown';
  keyword?: string;
  volume?: number;
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
    const raw = (text || '').trim();
    if (!raw) {
      return { type: 'unknown', rawText: raw };
    }

    // 1. 停止
    if (this.stopKeywords.some((k) => raw === k || raw.startsWith(k) || raw.endsWith(k))) {
      return { type: 'stop', rawText: raw };
    }

    // 2. 暂停
    if (this.pauseKeywords.some((k) => raw === k || raw.startsWith(k) || raw.endsWith(k))) {
      return { type: 'pause', rawText: raw };
    }

    // 3. 继续
    if (this.resumeKeywords.some((k) => raw === k)) {
      return { type: 'resume', rawText: raw };
    }

    // 4. 下一首
    if (this.nextKeywords.some((k) => raw.includes(k))) {
      return { type: 'next', rawText: raw };
    }

    // 5. 上一首
    if (this.prevKeywords.some((k) => raw.includes(k))) {
      return { type: 'prev', rawText: raw };
    }

    // 6. 音量控制
    const volMatch = raw.match(/音量.*?(?:调到|设为|调成|为)?\s*(\d{1,3})/);
    if (volMatch && volMatch[1]) {
      const vol = parseInt(volMatch[1], 10);
      if (vol >= 0 && vol <= 100) {
        return { type: 'volume', volume: vol, rawText: raw };
      }
    }

    // 7. 播放与搜歌口令匹配
    for (const prefix of this.playPrefixes) {
      if (raw.startsWith(prefix)) {
        let keyword = raw.slice(prefix.length).trim();
        // 清理常见的后缀语气词，如“的歌”、“的歌曲”
        keyword = keyword.replace(/的(歌|歌曲|音乐)$/, '').trim();
        // 将“周杰伦的晴天”智能清洗为“周杰伦 晴天”，精准定位原唱
        keyword = keyword.replace(/(?<=[^\s])的(?=[^\s])/g, ' ').replace(/\s+/g, ' ').trim();
        if (keyword) {
          return { type: 'play', keyword, rawText: raw };
        }
      }
    }

    return { type: 'unknown', rawText: raw };
  }
}

