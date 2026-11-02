#!/usr/bin/env bash
set -eu

# launch-editor passes custom launchers: file, line, column.
# Toolbox's `idea` script locates the Windows executable but does not convert files.
if ! command -v idea >/dev/null 2>&1; then
  echo 'IDEA launcher not found: enable the idea shell script in JetBrains Toolbox.' >&2
  exit 1
fi

editor_file=$(wslpath -aw "$1")
if [ -n "${2:-}" ]; then
  exec idea --line "$2" --column "${3:-1}" "$editor_file"
else
  exec idea "$editor_file"
fi
