#!/bin/sh
# Start the service and print a public URL and a key.
#
#   ./start.sh            public URL, over a Cloudflare quick tunnel
#   ./start.sh --local    this machine only, no tunnel
#
# The first run installs what it needs. Later runs start in seconds. Running it
# twice is harmless: the second run just reprints the URL and key.
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$DIR/scripts/lib.sh"

TUNNEL=1
for arg in "$@"; do
  case "$arg" in
    --local|--no-tunnel) TUNNEL=0 ;;
    --share|--tunnel) TUNNEL=1 ;;
    *) echo "usage: start.sh [--local]" >&2; exit 2 ;;
  esac
done

if running; then
  banner "$(served_url)" "$(api_key)"
  echo "  Already running. ./stop.sh to stop it."
  exit 0
fi

mkdir -p "$STATE"
ensure_installed
ensure_key

if [ "$TUNNEL" = 1 ]; then
  if ensure_cloudflared; then
    mode="share"
  else
    echo "  starting without a tunnel"
    mode="share --no-tunnel"
  fi
else
  mode="share --no-tunnel"
fi

: >"$LOGFILE"
start_bg "exec env $(utsi_env | tr '\n' ' ') .venv/bin/utsi $mode"

printf '  starting'
url=""
i=0
while [ "$i" -lt 150 ]; do
  url=$(served_url)
  [ -n "$url" ] && break
  if ! running; then
    printf ' FAILED\n\n'
    tail -20 "$LOGFILE"
    rm -f "$PIDFILE"
    [ "$TUNNEL" = 1 ] && echo && echo "  ./start.sh --local skips the tunnel."
    exit 1
  fi
  printf '.'
  sleep 2
  i=$((i + 1))
done

if [ -z "$url" ]; then
  printf ' gave up waiting\n\n'
  tail -20 "$LOGFILE"
  exit 1
fi

printf ' ready\n'
banner "$url" "$(api_key)"

if [ -n "${UTSI_API_KEY:-}" ]; then
  echo "  (that key comes from UTSI_API_KEY in your environment, so there is no"
  echo "   .utsi/api-key file. Unset it to go back to a generated one.)"
  echo
fi

# The server checks the public URL before printing it. When that check failed,
# the cause is worth separating: a name that does not resolve at all is a DNS
# filter and will never come good on its own, while a name that resolves but
# does not answer is usually just early.
if grep -q "did not answer yet" "$LOGFILE" 2>/dev/null; then
  name=${url#*://}
  name=${name%%/*}
  if "$DIR/.venv/bin/python" -c 'import socket,sys; socket.getaddrinfo(sys.argv[1], 443)' \
      "$name" >/dev/null 2>&1; then
    echo "  Note: that URL was not answering yet. The server is up and the name"
    echo "  resolves, so give it another few seconds."
  else
    echo "  Note: $name does not resolve on this machine."
    echo
    echo "  This is almost always a DNS filter, not a broken tunnel."
    echo "  trycloudflare.com is widely blocked by ISPs and filtering resolvers."
    echo "  Check with:  dig +short $name  vs  dig @1.1.1.1 +short $name"
    echo
    echo "  If only the second answers, the quickest fix is another network."
    echo "  Mobile hotspots and guest WiFi filter this far more often than a"
    echo "  home connection. Otherwise point this machine at 1.1.1.1 (System"
    echo "  Settings > Network > DNS on macOS). Either way the tunnel itself is"
    echo "  fine: it is for reaching this service from other devices, and from"
    echo "  here http://127.0.0.1:$PORT needs no tunnel at all."
  fi
  echo
fi
echo "  ./stop.sh to stop it. The URL stops working with it."
