## App 端改造现状（`app/`）

最后更新：2026-09-01 · 依据：逐文件读取 + 与上游 `lx-music-mobile` 逐文件哈希比对 + 对照 `server/src` 真实路由 + 映射层端到端实测

`app/` 是 lx-music-mobile 的 fork，已有一套小爱功能实现（4 个新文件 + 6 处上游文件改动）。本轮修通了投播主链路，本文记录已完成项、遗留项与实施要点。

---

## 一、已有的改造代码

### 新增文件

| 文件 | 作用 |
|---|---|
| `src/services/xiaoaiService.ts` | 云端 API 客户端单例 |
| `src/services/soundhubMapper.ts` | **本轮新增** · lx MusicInfo → 服务端 CastMusicParams 映射层 |
| `src/components/XiaoAiCastModal.tsx` | 投播设备选择弹窗 |
| `src/components/XiaoAiTTSModal.tsx` | TTS 播报弹窗（含 5 条预设语） |
| `src/screens/Home/Views/Setting/settings/XiaoAi/index.tsx` | 设置页「小爱声枢」面板 |

### 改动的上游文件

| 文件 | 改动 |
|---|---|
| `src/screens/Home/Vertical/Header.tsx` | 顶栏加「📢 播报」「🔊 投播」（`LeftHeader` 与 `RightHeader` 各一处） |
| `src/screens/Home/Vertical/DrawerNav.tsx` | 侧边抽屉「小爱音箱专属功能」区块 |
| `src/components/player/PlayerBar/components/ControlBtn.tsx` | 播放条加 🔊 投播按钮 |
| `src/components/OnlineList/ListMenu.tsx` | **本轮** · 长按菜单加「投播到小爱音箱」 |
| `src/components/OnlineList/index.tsx` | **本轮** · 挂载投播弹窗并接线 |
| `src/screens/Home/Views/Setting/Main.tsx` + `Vertical/Main.tsx` | 注册 `xiaoai` 设置分屏 |
| `src/config/constant.ts` | **本轮** · `storageDataPrefix` 登记 3 个小爱 storage key |
| `src/lang/{zh-cn,zh-tw,en-us}.json` | `setting_xiaoai` + **本轮** `xiaoai_cast_to` |

### 服务端

**无需改动。** app 所需接口均已就绪并验证过：`/api/devices`（`server.ts:117`）、`/api/search`、`/api/play`、`/api/control`、`/api/tts`、`/api/status`、`/api/sources`、`/api/auth/login`。

---

## 二、本轮修复的缺陷

### 投播完全不可用（主因）

`XiaoAiCastModal` 要求 `currentMusic` prop，缺失时 `handleCast()` 首行即返回：

```tsx
if (!currentMusic) { showToast('当前没有选中可投播的歌曲'); return }
```

而**四个调用点全都没传**：`Vertical/Header.tsx` 两处、`ControlBtn.tsx`、`XiaoAi/index.tsx`。按钮可见、设备可选、点击必失败。

**修法**：Modal 改为接收 lx 原生 `MusicInfo`，并回落到当前播放曲目。这让 Header 与播放器按钮**无需改代码即变可用**，语义也更顺——播放器上投播 = 投播正在播的歌。

### 曲目 id 映射（最高风险项）

lx 与服务端识别曲目的方式不同，错配的表现是「投播成功但不出声」：

<div style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0">
<div style="flex:1;min-width:240px;padding:11px 13px;background:#f6f8fa;border-left:3px solid #c04a4a;border-radius:3px">
<div style="font-weight:600;margin-bottom:5px">lx 的 MusicInfo.id 是复合键</div>
<div style="font-size:12.5px;line-height:1.7"><code>${source}_${songmid}</code><br>酷狗例外：<code>${songmid}_${hash}</code><br><b>它不是平台 id</b></div>
</div>
<div style="flex:1;min-width:240px;padding:11px 13px;background:#f6f8fa;border-left:3px solid #4ba86a;border-radius:3px">
<div style="font-weight:600;margin-bottom:5px">真正的平台 id 藏在 meta</div>
<div style="font-size:12.5px;line-height:1.7">wy / tx / kw → <code>meta.songId</code><br>kg → <code>meta.hash</code>（32位hex）<br>mg → <code>meta.copyrightId</code></div>
</div>
</div>

服务端适配器会校验格式（kg 要 32 位 hex，wy/kw 要纯数字），所以必须逐源拆解。`soundhubMapper.ts` 承担此职责，并顺带处理三件事：拆包 `LX.Download.ListItem`（下载任务激活时播放器暴露的是它，真曲目在 `metadata.musicInfo`——这个是 TS 类型检查抓出来的）、把 `interval` 字符串解析为秒、对本地文件与未知音源**前置拒绝并给出原因**（同时禁用按钮），而非请求后失败。

**端到端实测**（五平台真实 id，对着运行中的服务端）：

```
✅ kw  id=521282545                        → 酷我原生取链成功
✅ tx  id=001e2FJz3QXaf0                   → 无直链，精确同曲兜底至酷我
✅ kg  id=18b89d66950b7856eabb131bb6273f6e → 无直链，精确同曲兜底至酷我
✅ mg  id=69058500687                      → 无直链，精确同曲兜底至酷我
✅ wy  id=3400509270                       → 网易云原生取链成功
⛔ local                                    → 正确拒绝
```

tx/kg/mg 的直链需 VIP，由服务端的「精确同曲跨源兜底」接管，全部落到酷我正版流。

### 服务端契约不一致

| 问题 | 修法 |
|---|---|
| `/api/control` 音量字段发 `value`，服务端读 `volume`（`server.ts:344`），**静默失效** | 改为 `volume`，并改发 `dids` 数组以支持多音箱 |
| `/api/tts` 返回 `{ok,msg,results}`，代码读 `json.data` | 读 `results` |
| `/api/play` 无 payload，代码读 `json.data`，且返回类型谎报 per-device 结果 | 返回 `Promise<void>` |
| 默认端口 `8080`（service）与 `8989`（设置页 UI）自相矛盾 | 统一 `DEFAULT_SERVER_URL = 8989` |

补充：新增 `getStatus()` 与 `sendTTS` 的 `chime` 参数，服务端本已支持。

### 两处规范偏离

**样式绕过 `createStyle`**——这不只是视觉问题。`createStyle`（`utils/tools.ts:521`）会把尺寸过 `scaleSizeW/H`、把 `fontSize`/`lineHeight` 过 `setSpText`，而 `setSpText`（`utils/pixelRatio.ts:53`）乘以 `global.lx.fontSize`，即**用户的字体大小设置**。两个 Modal 用 RN 原生 `StyleSheet.create`，等于无视用户字体设置与设备 DPI 缩放——App 其余部分都会响应。已改为 `createStyle`。

**storage key 未登记**——`xiaoaiService.ts` 用裸键 `soundhub_server_url` 等，既无 `@` 前缀也未登记在 `storageDataPrefix`（`config/constant.ts:40`）。已登记为 `@soundhub_server_url` 等，并保留读旧裸键的回退（照 `getPlayInfo` 的既有迁移写法），避免抹掉已有用户的服务地址、token 与音箱选择。

---

## 三、TODO.md 2.1–2.4 对照

图例：✅ 完成 · 🟡 部分 · ❌ 未开始

### 2.1 基础改造

| # | 项目 | 状态 | 说明 |
|---|---|---|---|
| 1 | 应用名与包名 | ❌ | 仍是 `cn.toside.music.mobile` /「洛雪音乐助手」。需改 `app.json`、`package.json`、`android/app/build.gradle`（namespace + applicationId）、`strings.xml`，以及 `android/app/src/main/java/` 包目录 |
| 2 | 图标与启动页 | ❌ | 5 组 mipmap 与上游逐字节相同 |
| 3 | 云端 API 客户端 | 🟡 | 契约已修正、已补 `getStatus()`；仍缺登录与 401 处理、缺 `/api/search` 与 `/api/sources` 封装 |
| 4 | 账号体系 | ❌ | 无登录页。**已定方向：惰性登录，仅投播时要求** |

> 原 TODO 的「移除我的列表云同步」**建议不做**——那是 lx 自带的同步服务，与 SoundHub 账号互不干涉，删它属于减法，违背「双轨并存、加法为主」。

### 2.2 投播能力

| # | 项目 | 状态 | 说明 |
|---|---|---|---|
| 5 | 「设备」Tab | ❌ | 设备选择目前在 Modal 内。需改 `config/constant.ts:101` 的 `NAV_MENUS`（现 6 项）+ 新建 `Views/Devices/` |
| 6 | 音箱多选 + 持久化 | ✅ | |
| 7 | 搜索列表投播入口 | ✅ | 走长按菜单，一次覆盖搜索/排行榜/歌单**所有**在线列表 |
| 8 | 播放器投播按钮 | ✅ | 靠回落逻辑修通 |
| 9 | 投播状态回显 | 🟡 | `getStatus()` 已封装，UI 未接 |
| 10 | 远程控制 | 🟡 | `control()` 已修正，无 UI 调用 |

### 2.3 语音播报

| # | 项目 | 状态 | 说明 |
|---|---|---|---|
| 11 | 播报页面 | 🟡 | 是 Modal，非独立 Tab 页 |
| 12 | 常用语预设 | ✅ | 5 条 |
| 13 | 前导提示音选择 | 🟡 | service 已支持 `chime` 参数，UI 无选择器 |
| 14 | 多音箱同时播报 | ✅ | |

### 2.4 音源与设置

| # | 项目 | 状态 | 说明 |
|---|---|---|---|
| 15 | App 内切换搜索音源 | ❌ | lx **自带**音源切换 UI（`kw/kg/tx/wy/mg` + `all`，见 `DEFAULT_SETTING.search`）。缺的是与云端 `/api/sources`、`search_platform` 对齐 |
| 16 | 音源选择上报云端 | ❌ | 未接 `/api/user/settings` |
| 17 | 自定义语音口令 | ❌ | 服务端有 `custom_prefixes` / `custom_stop_keywords` |
| 18 | 音质偏好 | ❌ | 服务端有 `preferred_quality` |

**统计：✅ 6 · 🟡 5 · ❌ 9**

---

## 四、后续实施要点

这些是调研中确认的项目惯例，按它们写才不会与上游冲突：

**状态管理**无 Redux/MobX，是自研的「可变全局对象 + 事件总线」，每个 store 三件套 `state.ts` / `action.ts` / `hook.ts`。新事件必须先在 `src/event/stateEvent.ts` 的 `StateEvent` 类里加方法，否则 TS 不认。

**新增持久化设置项**要改三处：`src/types/app_setting.d.ts`（类型）、`src/config/defaultSetting.ts`（默认值）、使用处。key 命名 `'模块.驼峰名'`。

**存储**用 `src/plugins/storage.ts`（`saveData` / `getData` / `removeData`），它有超 500000 字符自动分片，别直裸用 AsyncStorage。key 一律登记进 `storageDataPrefix`。

**样式**一律用 `createStyle`，不用 `StyleSheet.create`。

**待办的规范债**：小爱相关文案大量硬编码中文，未走 i18n；Toast 用 `ToastAndroid` + `Alert` 而非项目统一组件。建议等新页面（设备 Tab、播报页）落地后一次性统一整理，比现在零散改动更省事。

---

## 五、建议的下一步顺序

1. **惰性登录** — 点投播时若无 token 才弹登录，登录后继续原动作。`/api/auth/login` 已就绪。
2. **「设备」独立 Tab** — 从 Modal 里把设备管理提出来，接投播状态回显与远程控制。
3. **音源/音质/口令与云端双向同步** — 打通 `/api/user/settings` 与 `/api/sources`。
4. **打包发布**（TODO 2.5）— 需要真机环境，见下。

---

## 六、构建环境限制

这台开发机**没有 Android SDK / emulator**。可以改代码、跑 `tsc` 与 `eslint`，**无法产出 APK 或跑真机**。

因此本轮的验证边界是：映射层与服务端契约是**对着运行中的真实服务端实测**的；UI 交互、字体缩放实际表现、Modal 真机布局仅有类型与代码层面的保证。真机行为需要你验，若本地有 Android Studio，`cd app && npm run pack:android` 可出 release 包。

另注：改包名后 RN 通常需要清缓存重建（`npm run clear:full`）。
