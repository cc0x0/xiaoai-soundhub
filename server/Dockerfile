# Multi-stage build for XiaoAi SoundHub Server
# Stage 1: Build TypeScript & Compile Native SQLite bindings
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# 换用阿里云 Debian 国内高速镜像源并安装轻量编译工具链
RUN (sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
     sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list) && \
    apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json tsconfig.json ./
RUN npm config set registry https://registry.npmmirror.com && \
    npm install

COPY src/ ./src
COPY public/ ./public
RUN npm run build

# 清理 dev 依赖，保留生产依赖和已编译的 better-sqlite3 本地二进制
RUN npm prune --omit=dev

# Stage 2: Production Lightweight Runtime (无任何编译依赖)
FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

# 直接复用 builder 阶段已编译就绪的 node_modules 与 dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package*.json ./
COPY public/ ./public
COPY sources/ ./sources
COPY config.example.json ./config.example.json

EXPOSE 8080

CMD ["node", "dist/server.js"]




