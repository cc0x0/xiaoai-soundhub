# XiaoAi SoundHub (小爱声枢) 实施任务清单与质量保障指南

本文档记录 XiaoAi SoundHub 项目的分阶段实施计划、各模块详细开发任务以及阶段性的代码校验（TypeScript / ESLint）与原项目功能比对标准。

---

## 一、 质量保障与门禁标准 (Quality Gates)

为了确保新工程在演进过程中**不破坏原有稳定功能**，且**代码质量健壮无隐患**，每个阶段的实施均需满足以下门禁要求：

### 1. 静态代码与类型检查门禁
- **TypeScript 校验**：在 `server/` 和 `app/` 根目录执行 `npx tsc --noEmit`，必须达到 **0 Errors**（零类型报错）。
- **ESLint 代码规范校验**：执行 `npx eslint .`，必须达到 **0 Errors**。
- **模块依赖隔离**：后端不引入臃肿依赖，轻量快速；前端组件高内聚低耦合。

### 2. 阶段性功能比对与回归基准
- **音乐播放与音源比对（对比 `lx-music-mobile`）**：
  - 校验榜单获取、单曲搜索、音源解析是否与本地 `lx-music-mobile` 的行为与结果 100% 一致。
  - 确保原有本地下载、列表管理、歌词滚动等基础能力不受任何干扰。
- **小爱交互与防抢断比对（对比 `xiaomusic` & `xiaoi`）**：
  - 校验 `conversation` 轮询间隔与时间戳过滤逻辑，杜绝重复触发。
  - 校验 `force_stop` 抢断逻辑与 `[siid, aiid]` 机型映射表覆盖度。
  - 校验 Stream Proxy 在断点续传（HTTP 206 / Range 请求）场景下的音箱缓冲稳定性。

---

## 二、 阶段实施任务清单 (TODO List)

### 📌 Phase 1: 项目脚手架与基础结构搭建
- [x] 创建独立工程目录 `xiaoai-soundhub`
- [x] 输出完整架构设计与技术全景文档 (`ARCHITECTURE.md`)
- [x] 输出分阶段实施清单与质量保障指南 (`TODO.md`)
- [x] 初始化 `server/` 基础工程结构（`package.json`, `tsconfig.json`, `eslint.config.mjs`）
- [x] 初始化 `app/` 移动端工程结构（基于 `lx-music-mobile` 建立独立扩展目录）

---

### 📌 Phase 2: 云端 Docker 服务端核心研发 (`server/`)

#### 1. 小爱音箱网关与多设备控制模块 (`src/speaker/`)
- [x] 封装小米账号认证逻辑（支持 `userId` + `passToken` / `password`，以及缓存机制）
- [x] 封装设备发现接口 `listDevices()`，支持获取所有音箱名称、DID、硬件型号与在线状态
- [x] 封装单音箱与多音箱并发 TTS 广播接口（支持机型指令表 `[5,1]`, `[7,3]` 等自动映射及 `Promise.allSettled` 并行）
- [x] 封装音频直链下发接口 `playAudio(url, did)` 及音量调节 `setVolume(vol, did)`

#### 2. LX Music 自定义音源沙箱引擎 (`src/source_engine/`)
- [x] 搭建基于 Node.js `vm` 的沙箱执行环境，模拟 `lx.request`、`crypto`、`Buffer` 等 API
- [x] 支持动态加载指定的 LX 自定义音源 `.js` 脚本
- [x] 封装 `search(keyword, page)` 搜索歌曲接口
- [x] 封装 `getMusicUrl(songInfo, quality)` 取链接口（支持 128k / 320k / flac）

#### 3. 防盗链音频中继代理 (`src/proxy/`)
- [x] 实现流式中继路由 `GET /proxy/stream`
- [x] 支持自动附加 LX 音源所需的 `Referer`、`User-Agent` 等特殊 Headers
- [x] 实现 HTTP `Range` 分片传输（支持音频拖动、快速缓冲、断点续传）

#### 4. 实体音箱语音对话监听与拦截 (`src/listener/`)
- [x] 实现长轮询 MiNA 会话获取器 `get_latest_ask`
- [x] 实现语音口令正则提取器（匹配“播放XXX”、“播放歌曲XXX”、“暂停”、“下一首”）
- [x] 实现秒级抢先拦截机制：捕获到播放口令立即触发 `player_pause` 掐断官方 VIP 拦截提示
- [x] 串联完整流程：语音捕获 $\to$ 掐断 $\to$ LX 搜歌 $\to$ 取链 $\to$ 代理流推送 $\to$ 小爱播放

#### 5. Web 控制端与 RESTful API (`src/server.ts` & `public/`)
- [x] 编写标准化 RESTful API 路由（设备查询、TTS 播报、歌曲搜索、投播控制）
- [x] 编写轻量简洁的 Web 管理页面（包含音箱列表、多选 TTS 发送框、在线搜歌播放器）
- [x] 编写 `Dockerfile` 与 `docker-compose.yml`

#### 🔍 阶段校验门禁 (Phase 2 Gates):
- [x] 运行 `cd server && npx tsc --noEmit` 确保无类型错误（通过，0 errors）
- [x] 运行 `cd server && npx eslint src` 确保代码规范通过（通过，0 problems）
- [x] 运行 `cd server && npm run build` 生成构建产物（通过，dist 构建成功）

---

### 📌 Phase 3: Android App 客户端扩展与集成 (`app/`)

#### 1. 小爱云端通信服务层 (`src/services/`)
- [x] 封装与云端 Server 交互的 API 客户端（获取设备列表、发送投播指令、发送 TTS 广播）
- [x] 支持本地持久化存储云端 Server 地址、Token 以及选中的默认音箱

#### 2. 小爱设备投播与多音箱控制组件 (`src/components/`)
- [x] 实现小爱投播弹窗组件 `XiaoAiCastModal.tsx`（显示各音箱状态，支持单选/全选/一键投播）
- [x] 实现点击歌曲直接将音频直链与元数据下发到选中小爱音箱播放

#### 3. 多音箱文本语音 (TTS) 广播独立组件
- [x] 实现 TTS 广播弹窗组件 `XiaoAiTTSModal.tsx`（支持预设常用语、多设备复选框、一键全屋广播）

#### 4. CI/CD 自动构建工作流
- [x] 整合 `.github/workflows/release.yml`，支持推送代码后自动构建 Android Release APK 并发版

---

### 📌 Phase 4: 全链路联调测试与交付指南

- [x] 编写云端服务部署与运维说明 (`server/README.md`)
- [x] 编写移动端构建与使用说明 (`app/README.md`)
- [ ] **场景 1 验证**：在云端配置小米账号后，通过 Web / App 发送文本，多台小爱音箱同步语音播报
- [ ] **场景 2 验证**：在 Web / App 搜索歌曲，点击投播至指定小爱音箱
- [ ] **场景 3 验证**：对实体小爱音箱说“小爱同学，播放周杰伦”，验证秒级掐断与通过 LX 音源自动开播
