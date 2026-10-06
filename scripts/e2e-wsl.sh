#!/usr/bin/env bash
# 在 WSL 内运行 dss 的单测 + e2e 套件 — 本地使用, 不进 CI(Windows runner 无 WSL)
#
# 前置: WSL 默认发行版内有 node(>=18) 与 sudo; service 用的 systemd 场景需 wsl.conf 启用 systemd
# 行为: 把仓库快照复制到 ~/dss-e2e(不污染 /mnt/c 挂载), 装依赖后依次跑 npm test / npm run test:e2e
set -e

SRC="$(cd "$(dirname "$0")/.." && pwd)"
export DSS_SRC_WIN="$(wslpath -w "$SRC")"
export WSLENV="${WSLENV:+$WSLENV:}DSS_SRC_WIN/w"

wsl.exe -e sh -c '
  set -e
  rm -rf "$HOME/dss-e2e"
  mkdir -p "$HOME/dss-e2e"
  cp -r "$DSS_SRC_WIN/index.js" "$DSS_SRC_WIN/package.json" "$DSS_SRC_WIN/src" "$DSS_SRC_WIN/config" "$HOME/dss-e2e/"
  cd "$HOME/dss-e2e"
  npm install --omit=dev --no-audit --no-fund
  npm test
  npm run test:e2e
'

echo "WSL test run complete (工作目录: ~/dss-e2e)"
