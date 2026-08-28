# XiaoAi SoundHub Android App (小爱声枢移动端)

基于 `lx-music-mobile` 扩展开发的小爱全网音乐播放与多音箱 TTS 广播 Android 客户端。

---

## ✨ 核心特性

1. **顶级全网音乐体验**：
   - 完整继承原版 LX Music 的全网搜歌、热歌榜单、歌词滚动、封面展示、多音质选择与本地下载。
   - 天然完美兼容你现有的稳定自定义音源脚本。
2. **小爱音箱投播 (XiaoAi Cast)**：
   - 在歌曲列表或播放控制条点击「🔊 投播小爱」，自由勾选客厅、卧室等多台音箱，实现一键投播或全屋同步播放。
3. **多音箱文本语音 (TTS) 广播**：
   - 输入任意文本，勾选目标音箱，一键全屋广播播报。

---

## 🛠️ 本地编译与运行

### 环境要求
- Node.js >= 18
- Java JDK 17
- Android SDK (API 33+)

### 1. 本地安装依赖并运行
```bash
npm install
npm run dev
```

### 2. 本地直接打包 APK (Release)
```bash
cd android
./gradlew assembleRelease
# 构建产物位于: android/app/build/outputs/apk/release/
```

---

## 🚀 GitHub Actions 自动编译与发版 (CI/CD)

本仓库已配置好完整的 `.github/workflows/release.yml` 自动化构建工作流：

1. 在 GitHub 仓库设置中添加 Secrets（**Settings $\to$ Secrets and variables $\to$ Actions**）：
   - `KEYSTORE_STORE_FILE_BASE64`：你的 Android 签名证书文件的 base64 编码（`base64 -w0 your.keystore`）
   - `KEYSTORE_STORE_FILE`：keystore 文件名（如 `my-upload-key.keystore`）
   - `KEYSTORE_KEY_ALIAS`：key alias 名称
   - `KEYSTORE_PASSWORD`：keystore 密码
   - `KEYSTORE_KEY_PASSWORD`：key 密码
2. 推送代码或在 GitHub **Actions** 页面手动点击 **Run workflow**，系统将全自动构建并输出多架构 APK 到 GitHub Releases。

---

## ⚙️ 云端服务连接配置

在 App 内配置你的云端 SoundHub 服务地址：
- 默认连接地址：`http://你的云服务器公网IP:8080`
- 可在 App 设置中随时更新服务器地址与鉴权 Token。
