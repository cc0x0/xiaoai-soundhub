# Multi-stage build for XiaoAi SoundHub Server
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm install

COPY src/ ./src
COPY public/ ./public
RUN npm run build

# Production runtime stage
FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY public/ ./public
COPY sources/ ./sources
COPY config.example.json ./config.example.json

EXPOSE 8080

CMD ["node", "dist/server.js"]

