# Multi-stage build for XiaoAi SoundHub Server
# Stage 1: Build TypeScript with Node 22 Native SQLite
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm config set registry https://registry.npmmirror.com && \
    npm install

COPY src/ ./src
ENV NODE_OPTIONS="--max-old-space-size=512"
RUN npm run build

# 清理 dev 依赖，保留生产依赖
RUN npm prune --omit=dev

# Stage 2: Production Lightweight Runtime (纯原生 Node 22，零外部 C++ 插件)
FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package*.json ./
COPY public/ ./public
COPY sources/ ./sources
COPY config.example.json ./config.example.json

EXPOSE 8080

CMD ["node", "dist/server.js"]





