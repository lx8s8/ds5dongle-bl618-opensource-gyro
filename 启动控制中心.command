#!/bin/bash
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  echo '需要 Python 3，或使用 Release 中无需 Python 的 macOS 应用。'
  read -r -p '按回车关闭'
  exit 1
fi
exec python3 desktop/launcher.py
