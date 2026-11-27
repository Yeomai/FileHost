#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT=3000
LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/dev.log"
PID_FILE="$LOG_DIR/dev.pid"

cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node.js 22 或更高版本。"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "未找到 npm，请检查 Node.js 安装。"
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "正在安装项目依赖..."
  npm ci
fi

if [[ ! -f .env && -f .env.example ]]; then
  cp .env.example .env
fi

mkdir -p "$LOG_DIR"

if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT 已被占用，请先运行 stop-dev.command 或检查其他程序。"
  exit 1
fi

echo "正在启动 PicHost..."
nohup npm run dev >"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"

for _ in {1..60}; do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
    echo "PicHost 已启动：http://127.0.0.1:$PORT/"
    open "http://127.0.0.1:$PORT/"
    exit 0
  fi
  if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "PicHost 启动失败，最后日志："
    tail -n 40 "$LOG_FILE" 2>/dev/null || true
    rm -f "$PID_FILE"
    exit 1
  fi
  sleep 1
done

echo "PicHost 启动超时，请查看日志：$LOG_FILE"
exit 1
