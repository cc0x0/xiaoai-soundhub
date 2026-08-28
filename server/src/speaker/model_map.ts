/**
 * 小爱音箱各机型 MiOT TTS 指令映射表 (siid, aiid)
 * 参考 xiaoi & xiaomusic 机型规格定义
 */

export const DEFAULT_TTS_COMMANDS: Readonly<Record<string, [number, number]>> = Object.freeze({
  oh2p: [7, 3],   // XIAOMI 智能音箱 Pro
  oh2: [5, 3],    // XIAOMI 智能音箱
  lx06: [5, 1],   // 小爱音箱 Pro
  s12: [5, 1],    // 小米AI音箱 (第一代)
  l15a: [7, 3],   // 小米AI音箱 (第二代)
  lx5a: [5, 1],   // 小爱音箱万能遥控版
  lx05: [5, 1],   // 小爱音箱 Play
  x10a: [7, 3],   // 小爱触屏音箱 10
  l17a: [7, 3],   // Xiaomi Sound Pro
  l16a: [5, 3],   // Xiaomi Sound
  l06a: [5, 1],   // 小爱音箱
  lx01: [5, 1],   // 小爱音箱 mini
  l05b: [5, 3],   // 小爱音箱 Play (2019)
  l05c: [5, 3],   // 小爱音箱 Play 增强版
  l09a: [3, 1],   // 小米音箱 Art
  lx04: [5, 1],   // 小爱触屏音箱
  asx4b: [5, 3],  // 小爱触屏音箱
  x4b: [5, 3],
  x6a: [7, 3],    // Redmi 触屏音箱 6
  x08c: [7, 3],   // Redmi 触屏音箱 8
  x08e: [7, 3],   // 小爱触屏音箱 8
  x8f: [7, 3],
});

export function resolveTTSCommand(
  model: string,
  customCommands?: Record<string, [number, number]>,
  defaultCommand: [number, number] = [5, 1]
): [number, number] {
  if (!model) return defaultCommand;
  const cleanModel = model.toLowerCase().replace(/^(xiaomi\.(wifispeaker\.)?)/, '').trim();

  // 1. 用户自定义映射
  if (customCommands && customCommands[cleanModel]) {
    return customCommands[cleanModel];
  }

  // 2. 内置映射
  if (DEFAULT_TTS_COMMANDS[cleanModel]) {
    return DEFAULT_TTS_COMMANDS[cleanModel];
  }

  // 3. 模糊匹配后缀
  for (const [key, cmd] of Object.entries(DEFAULT_TTS_COMMANDS)) {
    if (cleanModel.includes(key) || key.includes(cleanModel)) {
      return cmd;
    }
  }

  return defaultCommand;
}

