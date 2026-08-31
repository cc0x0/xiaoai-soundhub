# Multi-stage build for XiaoAi SoundHub Server
# Stage 1: Build TypeScript & Download prebuilt SQLite bindings
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm config set registry https://registry.npmmirror.com && \
    npm install

COPY src/ ./src
COPY public/ ./public
RUN npm run build

# 清理 dev 依赖，保留生产依赖和预编译好的 better-sqlite3
RUN npm prune --omit=dev

# Stage 2: Production Lightweight Runtime
FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

# 直接复用 builder 阶段已就绪的 node_modules 与 dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package*.json ./
COPY public/ ./public
COPY sources/ ./sources
COPY config.example.json ./config.example.json

EXPOSE 8080

CMD ["node", "dist/server.js"]



