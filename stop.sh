#!/bin/sh
# Stop the service. The public URL stops working the moment this returns.
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$DIR/scripts/lib.sh"

if ! running; then
  rm -f "$PIDFILE"
  echo "  Not running."
  exit 0
fi

pid=$(cat "$PIDFILE")
kill "$pid" 2>/dev/null || true

printf '  stopping'
i=0
while [ "$i" -lt 15 ] && kill -0 "$pid" 2>/dev/null; do
  printf '.'
  sleep 1
  i=$((i + 1))
done
if kill -0 "$pid" 2>/dev/null; then
  kill -9 "$pid" 2>/dev/null || true
fi

# Belt and braces if the shell that owned it died first. The pattern is
# qualified by this checkout's path, so it can only match our own server.
if command -v pkill >/dev/null 2>&1; then
  pkill -f "$DIR/.venv/bin/utsi" 2>/dev/null || true
fi

rm -f "$PIDFILE"
printf ' stopped\n'
