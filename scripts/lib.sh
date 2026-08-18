#!/bin/sh
# Shared internals for ../start.sh, ../stop.sh and ../update.sh.
# POSIX only, so this works under bash, dash and busybox ash alike.
#
# The caller sets DIR to the checkout root before sourcing this.

set -eu

# Git Bash and Cygwin get far enough to be confusing. The sandbox is the reason:
# each plugin runs in a subprocess with address-space and CPU limits, in its own
# process group so the whole group can be killed on timeout. Windows has neither
# `resource` nor process groups, so the isolation would silently not be there.
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*)
    echo "Windows needs WSL for this." >&2
    echo >&2
    echo "  Each plugin runs in a subprocess with resource limits and its own" >&2
    echo "  process group. Windows provides neither, so the sandbox that makes" >&2
    echo "  running other people's code acceptable would not be there." >&2
    echo >&2
    echo "  wsl --install        (once, in PowerShell as administrator)" >&2
    echo "  wsl                  then clone and run these commands inside it" >&2
    exit 1
    ;;
esac

STATE="${UTSI_STATE_DIR:-$DIR/.utsi}"
PIDFILE="$STATE/utsi.pid"
LOGFILE="$STATE/utsi.log"
BIN="$STATE/bin"

PORT="${UTSI_PORT:-7860}"
MIN_PYTHON=11        # 3.11

# Run something slow with a heartbeat: quiet on success, loud on failure.
# A terminal that has said nothing for two minutes is indistinguishable from
# one that has crashed.
step() {
  label="$1"
  shift
  printf '  %-34s' "$label"
  log="$STATE/step.log"
  mkdir -p "$STATE"
  "$@" >"$log" 2>&1 </dev/null &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    printf '.'
    sleep 2
  done
  if wait "$pid"; then
    printf ' done\n'
    rm -f "$log"
  else
    printf ' FAILED\n\n'
    tail -20 "$log"
    exit 1
  fi
}

python_bin() {
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c '
import sys
sys.exit(0 if sys.version_info[:2] >= (3, '"$MIN_PYTHON"') else 1)' 2>/dev/null; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# First run does the install; later runs skip straight past it.
ensure_installed() {
  [ -x "$DIR/.venv/bin/utsi" ] && return 0

  if ! python=$(python_bin); then
    echo "Python 3.$MIN_PYTHON or newer is required, and was not found." >&2
    echo "  macOS:  brew install python3" >&2
    echo "  Debian: sudo apt install python3 python3-venv" >&2
    exit 1
  fi
  echo "  first run, setting up (a few minutes, once)"
  step "virtualenv" "$python" -m venv "$DIR/.venv"
  # Not the `speedups` extra: this workload is subprocess-bound, so uvloop and
  # httptools buy nothing and fail to build on some platforms.
  step "python packages" "$DIR/.venv/bin/pip" install --quiet --no-cache-dir \
    -e "$DIR[plugin-runtime]"
}

# cloudflared is fetched on demand rather than installed up front, and lands in
# the state dir rather than /usr/local/bin so it never needs root.
ensure_cloudflared() {
  command -v cloudflared >/dev/null 2>&1 && return 0
  [ -x "$BIN/cloudflared" ] && return 0

  base=https://github.com/cloudflare/cloudflared/releases/latest/download
  mkdir -p "$BIN"
  case "$(uname -s)-$(uname -m)" in
    Linux-aarch64|Linux-arm64) asset=cloudflared-linux-arm64 ;;
    Linux-x86_64|Linux-amd64) asset=cloudflared-linux-amd64 ;;
    Linux-armv7l|Linux-armv8l) asset=cloudflared-linux-arm ;;
    Darwin-arm64) asset=cloudflared-darwin-arm64.tgz ;;
    Darwin-x86_64) asset=cloudflared-darwin-amd64.tgz ;;
    *) echo "  no cloudflared build for $(uname -s)/$(uname -m)"; return 1 ;;
  esac

  case "$asset" in
    *.tgz)
      # macOS ships a tarball holding a single `cloudflared` binary.
      step "cloudflared (~35 MB, once)" \
        sh -c "curl -fsSL '$base/$asset' | tar xzf - -C '$BIN'"
      ;;
    *)
      step "cloudflared (~35 MB, once)" \
        sh -c "curl -fsSL -o '$BIN/cloudflared' '$base/$asset'"
      ;;
  esac
  chmod +x "$BIN/cloudflared"
}

# Everything already exported wins; these are only defaults.
utsi_env() {
  cat <<EOF
UTSI_API_KEY='$(api_key)'
UTSI_HOST='${UTSI_HOST:-127.0.0.1}'
UTSI_PORT='$PORT'
UTSI_CACHE_TTL_S='${UTSI_CACHE_TTL_S:-900}'
EOF
}

start_bg() {
  nohup /bin/sh -c "cd '$DIR' && PATH='$BIN':\$PATH && $1" \
    >"$LOGFILE" 2>&1 </dev/null &
  echo $! >"$PIDFILE"
}

running() {
  [ -f "$PIDFILE" ] || return 1
  pid=$(cat "$PIDFILE" 2>/dev/null) || return 1
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

# Minted once and kept, because a key that changes on every restart is a key
# that has to be re-pasted into a client on every restart.
ensure_key() {
  if [ -n "${UTSI_API_KEY:-}" ] || [ -s "$STATE/api-key" ]; then
    return 0
  fi
  mkdir -p "$STATE"
  key=$(head -c 256 /dev/urandom 2>/dev/null | base64 2>/dev/null \
        | tr -dc 'A-Za-z0-9' | cut -c1-43) || key=""
  if [ ${#key} -lt 32 ]; then
    key=$(tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | dd bs=1 count=43 2>/dev/null)
  fi
  [ ${#key} -ge 32 ] || { echo "could not generate an API key" >&2; return 1; }
  (umask 077; printf '%s\n' "$key" >"$STATE/api-key")
}

api_key() {
  if [ -n "${UTSI_API_KEY:-}" ]; then
    printf '%s' "$UTSI_API_KEY"
  else
    cat "$STATE/api-key" 2>/dev/null || true
  fi
}

# The URL the server settled on, taken from its own start-up banner rather than
# guessed. Behind a tunnel it is not knowable any other way.
served_url() {
  sed -n 's/.*URL  \(http[^ ]*\).*/\1/p' "$LOGFILE" 2>/dev/null | tail -n 1
}

banner() {
  printf '\n'
  printf '  \033[1mURL\033[0m  %s\n' "$1"
  printf '  \033[1mKey\033[0m  %s\n' "${2:-(none, running unauthenticated)}"
  printf '\n'
}
