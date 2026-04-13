#!/bin/zsh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

npm run license-tool

echo
echo "按回车键关闭窗口..."
read
