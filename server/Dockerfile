# Multi-stage build for XiaoAi SoundHub Server
# Stage 1: Build TypeScript & Native SQLite bindings
FROM node:20-alpine AS builder

WORKDIR /app

# 换用阿里云国内高速源与 npmmirror 镜像源，大幅加速国内构建
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories && \
    apk add --no-cache python3 make g++

COPY package*.json tsconfig.json ./
RUN npm config set registry https://registry.npmmirror.com && \
    npm install

COPY src/ ./src
COPY public/ ./public
RUN npm run build

# 清理 dev 依赖，保留生产依赖和编译好的 better-sqlite3 本地二进制库
RUN npm prune --omit=dev

# Stage 2: Production Lightweight Runtime
FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# 直接复用 builder 阶段已编译好的 node_modules 与 dist，免去重复下载与编译
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package*.json ./
COPY public/ ./public
COPY sources/ ./sources
COPY config.example.json ./config.example.json

EXPOSE 8080

CMD ["node", "dist/server.js"]


