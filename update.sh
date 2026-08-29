#!/bin/sh
# Pull the latest version and reinstall. Restarts the service if it was
# running, the same way it was running, and keeps the API key.
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$DIR/scripts/lib.sh"

was_running=0
was_shared=0
if running; then
  was_running=1
  case "$(served_url)" in *trycloudflare.com*) was_shared=1 ;; esac
  "$DIR/stop.sh"
fi

# `git pull` first, so the install below sees the new dependency list.
step "pulling" git -C "$DIR" pull --ff-only --quiet
step "python packages" "$DIR/.venv/bin/pip" install --quiet --no-cache-dir \
  -e "$DIR[plugin-runtime]"

if [ "$was_running" = 1 ]; then
  if [ "$was_shared" = 1 ]; then
    exec "$DIR/start.sh"
  fi
  exec "$DIR/start.sh" --local
fi
echo "  ./start.sh when you want it back."
