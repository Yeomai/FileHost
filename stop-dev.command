#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT=3000
PID_FILE="$ROOT/logs/dev.pid"

cd "$ROOT"

PIDS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -z "$PIDS" ]]; then
  rm -f "$PID_FILE"
  echo "PicHost 未运行。"
  exit 0
fi

for pid in $PIDS; do
  command_line="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
  if [[ "$command_line" != *"$ROOT"* && "$cwd" != "$ROOT" ]]; then
    echo "端口 $PORT 属于其他程序，已取消停止。"
    exit 1
  fi
  kill "$pid" 2>/dev/null || true
done

for _ in {1..20}; do
  if ! lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  for pid in $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
    kill -9 "$pid" 2>/dev/null || true
  done
fi

if [[ -f "$PID_FILE" ]]; then
  kill "$(cat "$PID_FILE")" 2>/dev/null || true
  rm -f "$PID_FILE"
fi

echo "PicHost 已停止。"
