#!/bin/bash
# ==========================================
# XiaoAi SoundHub 一键极速更新脚本
# ==========================================
set -e

echo "=============================================="
echo "🚀 正在一键更新 XiaoAi SoundHub 服务..."
echo "=============================================="

# 1. 检查是否存在 .env 文件，若不存在则从 .env.example 引导创建
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "⚠️ 已自动生成 .env 文件，请先在 .env 中填入你的小米账号与IP配置！"
  fi
fi

# 2. 如果是 git 仓库，自动拉取最新代码
if [ -d .git ] || [ -d ../.git ]; then
  echo "📥 正在拉取 GitHub 最新代码..."
  git pull || true
fi

# 3. 极速重构并启动容器 (自动加载 .env，保留全部配置)
echo "🔨 正在重启 Docker 容器..."
docker compose up -d --build

echo "=============================================="
echo "✅ SoundHub 服务已成功更新并启动！"
echo "=============================================="
docker compose logs -f --tail=30
