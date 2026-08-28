# XiaoAi SoundHub Server (小爱声枢云端服务)

云端小爱控制中枢，负责小爱音箱云端控制、实体对话语音抢断、LX Music 自定义音源执行与流媒体防盗链中继。

---

## 一、 快速开始 (Docker 部署)

### 1. 配置环境变量或 `config.json`
复制 `config.example.json` 为 `config.json`：
```bash
cp config.example.json config.json
```
在 `config.json` 或 `docker-compose.yml` 中填入你的：
- `userId`：小米账号数字 ID（在小米账号个人中心查看）
- `passToken`：小米登录凭证（获取方法参考 [migpt-next/issues/4](https://github.com/idootop/migpt-next/issues/4)）
- `publicBaseUrl`：小爱音箱拉取中继流的地址，例如 `http://你的云服务器公网IP:8080`

### 2. 放入你的稳定 LX 自定义音源脚本
将你在 `lx-music-mobile` 中使用的稳定自定义音源脚本命名为 `my-custom-source.js`（或自定义名称并在配置中指定），放入 `sources/` 目录。

### 3. 一键启动 Docker 容器
```bash
docker compose up -d --build
```
启动成功后，浏览器打开 `http://你的云服务器IP:8080` 即可进入 Web 管理控制台！

---

## 二、 本地开发与调试

```bash
# 1. 安装依赖
npm install

# 2. 类型检查 (TypeScript)
npm run typecheck

# 3. 代码规范检查 (ESLint)
npm run lint

# 4. 开发模式运行
npm run dev

# 5. 编译构建
npm run build
```

---

## 三、 RESTful API 接口速查

| 接口 | 方法 | 说明 |
| :--- | :--- | :--- |
| `/api/devices` | `GET` | 获取当前小米账号下所有小爱音箱列表 |
| `/api/tts` | `POST` | 多音箱并发文本语音播报 `{ "text": "...", "dids": [...] }` |
| `/api/search` | `GET` | 通过云端 LX 音源全网搜歌 `?keyword=周杰伦` |
| `/api/url` | `GET` | 解析歌曲播放直链 `?songId=xxx&quality=320k` |
| `/api/play` | `POST` | 投播歌曲到指定音箱 `{ "music": {...}, "dids": [...] }` |
| `/api/control` | `POST` | 播放控制 `{ "action": "pause/resume/next/prev/volume", "did": "..." }` |
| `/proxy/stream`| `GET` | 音频流中继代理 (支持 HTTP Range 分片拉流) |
| `/api/status` | `GET` | 运行状态监控 |

