## App 端改造现状核查（`app/`）

调查时间：2026-09-01 · 调查方式：逐文件读取 + 与上游 `lx-music-mobile` 逐文件哈希比对 + 对照 `server/src` 真实路由

> **先更正我此前的两处错误结论**，避免误导后续判断：
>
> 1. 我最初说「`app/` 是零改造的纯净上游拷贝」——**错**。原因是比对脚本只遍历两侧共有文件名，只存在于 app 的新文件被整体跳过了。实际已有 4 个新文件 + 5 处上游文件改动。
> 2. 我随后说「`/api/devices` 不存在」——**也错**。它存在于 `server/src/server.ts:117`，返回 `{ok, data}`，与 app 的调用完全对得上。当时我只 grep 了 `routes/user.ts` 就下了结论。

---

## 一、已经改了什么（真实存在的代码）

### 新增文件（4 个）

| 文件 | 作用 | 状态 |
|---|---|---|
| `src/services/xiaoaiService.ts` | 云端 API 客户端单例，177 行 | 骨架完整，有 3 处接口错误 |
| `src/components/XiaoAiCastModal.tsx` | 投播设备选择弹窗，304 行 | UI 完整，**因缺 prop 必然失败** |
| `src/components/XiaoAiTTSModal.tsx` | TTS 播报弹窗（含 5 条预设语），285 行 | UI 完整，可用 |
| `src/screens/Home/Views/Setting/settings/XiaoAi/index.tsx` | 设置页「小爱声枢」面板，203 行 | 可用 |

### 改动的上游文件（5 处）

| 文件 | 改动内容 |
|---|---|
| `src/screens/Home/Vertical/Header.tsx` | 顶栏加「📢 播报」「🔊 投播」两个按钮（**两个组件里各加一次，共 2 处**） |
| `src/components/player/PlayerBar/components/ControlBtn.tsx` | 播放条加 `XiaoAiCastBtn`（🔊） |
| `src/screens/Home/Views/Setting/Main.tsx` | 注册 `xiaoai` 设置分屏（`SETTING_SCREENS` 首位 + switch 分支） |
| `src/screens/Home/Views/Setting/Vertical/Main.tsx` | 同上（竖屏版） |
| `src/lang/zh-cn.json` / `en-us.json` / `zh-tw.json` | 各加 1 条：`"setting_xiaoai": "小爱声枢"` |

### 服务端侧

**无需改动。** 所有 app 要用的接口都已存在且我上一轮验证过：
`/api/devices`、`/api/search`、`/api/play`、`/api/control`、`/api/tts`、`/api/status`、`/api/sources`、`/api/auth/login`。

---

## 二、为什么"没看到功能"（5 个真实故障）

### 🔴 故障 1：投播按钮点了必然报错（这是主因）

`XiaoAiCastModal` 要求 `currentMusic` prop，缺失时 `handleCast()` 第一句就返回：

```tsx
// XiaoAiCastModal.tsx:84
if (!currentMusic) {
  showToast('当前没有选中可投播的歌曲')
  return
}
```

**而四个调用点全都没传这个 prop**：

| 调用点 | 代码 |
|---|---|
| `Vertical/Header.tsx:67` | `<XiaoAiCastModal visible={castVisible} onClose={...} />` |
| `Vertical/Header.tsx:116` | 同上（第二个 Header 组件） |
| `ControlBtn.tsx:59` | `<XiaoAiCastModal visible={visible} onClose={...} />` |
| `XiaoAi/index.tsx:142` | `<XiaoAiCastModal visible={castModalVisible} onClose={...} />` |

结论：**投播功能 100% 不可用**。能选设备、能勾选、能点按钮，但点下去只会弹「当前没有选中可投播的歌曲」。

### 🔴 故障 2：音量控制字段名对不上

app 发 `value`，服务端读 `volume`：

```ts
// app xiaoaiService.ts:168
body: JSON.stringify({ action, did: targetDid, value })

// server server.ts:344
case 'volume':
  if (volume !== undefined) { ... }   // ← value 永远读不到
```

结论：音量调节静默失效，不报错但没反应。

### 🟡 故障 3：TTS / 投播的返回值读错字段

| 接口 | 服务端实际返回 | app 读取 |
|---|---|---|
| `/api/tts` (`server.ts:239`) | `{ok, msg, results}` | `json.data` → `undefined` |
| `/api/play` (`server.ts:274`) | `{ok, msg}`（无 data） | `json.data` → `undefined` |

影响较轻：因为只判断 `json.ok` 就走成功分支，返回值本身没被用到。但函数签名声明的 `Promise<Record<string, boolean>>` 是假的，将来若依赖返回值会踩坑。

### 🟡 故障 4：默认端口不一致

- `xiaoaiService.ts:29`：`http://127.0.0.1:8080`
- `XiaoAi/index.tsx:21`：`http://127.0.0.1:8989`

首次安装时设置页显示 8989，但服务实际用 8080，直到用户手动保存一次才一致。

### 🟡 故障 5：没有登录流程，要求手填 JWT

设置页让用户粘贴 Token，提示语是「未开启鉴权可留空」。但服务端 `/api/user/*` 全部挂了 `authMiddleware`，普通用户拿不到 token。

不过 `/api/devices`、`/api/play`、`/api/tts`、`/api/control` 这四个都做了**匿名降级**（无 token 时回落到 `admin_root_001` 或 `fallbackClient`），所以单用户自部署场景下留空反而能用 —— 这也解释了为什么它看起来"半通"。

---

## 三、TODO.md 2.1–2.4 逐项对照

图例：✅ 已完成 · 🟡 部分完成 · ❌ 未开始

### 2.1 基础改造

| # | 项目 | 状态 | 说明 |
|---|---|---|---|
| 1 | 应用名与包名 | ❌ | 仍是 `cn.toside.music.mobile` / "洛雪音乐助手"。需改 `app.json`、`package.json`、`android/app/build.gradle`（namespace + applicationId）、`strings.xml`、以及 `android/app/src/main/java/` 包目录 |
| 2 | 图标与启动页 | ❌ | 5 组 mipmap 与上游逐字节相同 |
| 3 | 云端 API 客户端 | 🟡 | `xiaoaiService.ts` 已有骨架；缺登录、缺 401 处理、缺 `/api/search` 与 `/api/status` 封装 |
| 4 | 账号体系 | ❌ | 无登录页。**按你的决定：登录改为惰性，仅投播时要求** |

> 原 TODO 的「移除我的列表云同步」建议**不做** —— 那是 lx 自带的同步服务，与 SoundHub 账号互不干涉，删它属于减法，违背"双轨并存、加法为主"。

### 2.2 投播能力

| # | 项目 | 状态 | 说明 |
|---|---|---|---|
| 5 | 「设备」Tab | ❌ | 现有设备选择藏在 Modal 里。需改 `src/config/constant.ts:101` 的 `NAV_MENUS`（现 6 项：search/songlist/top/love/download/setting）+ 新建 `Views/Devices/` |
| 6 | 音箱多选 + 持久化 | ✅ | `setSelectedDids()` 存 storage，已可用 |
| 7 | 搜索列表投播按钮 | ❌ | `Views/Search/MusicList.tsx` 每行无投播入口 —— **这是最该有的入口，却完全没做** |
| 8 | 播放器投播按钮 | 🟡 | 按钮在 `ControlBtn.tsx`，但因故障 1 不可用 |
| 9 | 投播状态回显 | ❌ | 未接 `/api/status` |
| 10 | 远程控制 | 🟡 | `control()` 已写，但音量字段错（故障 2），且无 UI 调用 |

### 2.3 语音播报

| # | 项目 | 状态 | 说明 |
|---|---|---|---|
| 11 | 播报页面 | 🟡 | 是 Modal 而非独立 Tab 页 |
| 12 | 常用语预设 | ✅ | `PRESETS` 5 条 |
| 13 | 前导提示音选择 | ❌ | 服务端支持 `chime`（dingdong/gentle/marimba/none），app 未传，走默认值 |
| 14 | 多音箱同时播报 | ✅ | 已支持 |

### 2.4 音源与设置

| # | 项目 | 状态 | 说明 |
|---|---|---|---|
| 15 | App 内切换搜索音源 | ❌ | lx **自带**音源切换 UI（`kw/kg/tx/wy/mg` + `all` 聚合，见 `DEFAULT_SETTING.search.source`）。缺的是与云端 `/api/sources`、`search_platform` 对齐 |
| 16 | 音源选择上报云端 | ❌ | 未接 `/api/user/settings` |
| 17 | 自定义语音口令 | ❌ | 服务端有 `custom_prefixes` / `custom_stop_keywords` |
| 18 | 音质偏好 | ❌ | 服务端有 `preferred_quality` |

**统计：✅ 3 项 · 🟡 5 项 · ❌ 10 项**

---

## 四、建议的动手顺序

**第一步（半天内可见效果）：修通现有的**

1. 修故障 1 —— 四个调用点传入 `currentMusic`。播放器那个从 `usePlayerMusicInfo()` 取，Header 那两个改为「投播当前播放曲目」或直接移除（因为 Header 不知道要投什么）。
2. 修故障 2 —— `value` → `volume`。
3. 统一端口，修正返回值字段与函数签名。

改完这三步，**投播立刻能真正工作**。这是投入产出比最高的一步。

**第二步（核心补强）**

4. 搜索列表每行加投播按钮（TODO #7）—— 用户最自然的入口。
5. 惰性登录：点投播时若无 token 才弹登录框，登录成功后继续投播；`/api/auth/login` 已就绪。
6. 「设备」独立 Tab（TODO #5）。

**第三步（打通设置）**

7. 音源/音质/口令与云端 `/api/user/settings` 双向同步。
8. TTS 提示音选择。
9. 投播状态回显 + 远程控制 UI。

---

## 五、两个待确认事项

**1. Header 的两个按钮要不要保留？**
Header 不持有"当前选中的歌曲"上下文，投播按钮放这里语义上说不通。我倾向：Header 只留「📢 播报」（TTS 不需要歌曲上下文），投播入口移到搜索列表行内 + 播放器。需要你确认。

**2. 构建环境**
这台机器上没有 Android SDK / emulator，我**能改代码、能跑 `tsc` 与 `eslint`，但装不出 APK、跑不了真机**。所有真机行为需要你验。要不要我先探测一下环境到底缺什么？
