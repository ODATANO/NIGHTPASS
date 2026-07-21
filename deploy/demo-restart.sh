#!/usr/bin/env bash
# Periodic restart of the Try-it demo container to pre-empt stale sponsor
# sessions (indexer websockets drop over long uptime -> "Sponsor session not
# found, inactive" on every anchor). Boot re-prewarms the 3 sponsors to chain
# tip and mints fresh sessions. Main site (nightpass, caddy) is untouched.
set -uo pipefail
cd /root/nightpass/deploy || exit 1

INFO_URL="https://demo.zkpassport.eu/api/v1/demo/demoInfo()"

# Return 0 (busy) if a visitor run is currently running or waiting.
demo_busy() {
  local body
  body=$(curl -s --max-time 15 "$INFO_URL") || return 1
  # busy when runningCount>0 or waitingCount>0 or queueDepth>0
  echo "$body" | grep -qE '"(runningCount|waitingCount|queueDepth)":[1-9]'
}

# Before restarting, give an in-flight visitor run time to finish.
# Wait up to 3 x 10 min, then restart regardless (a run is ~2.6 min; the
# restart marks any lingering run failed and the visitor UI auto-restarts).
for wait_i in 1 2 3; do
  if demo_busy; then
    echo "=== $(date -Is) demo busy, waiting 10 min (attempt ${wait_i}/3) ==="
    sleep 600
  else
    break
  fi
done

echo "=== $(date -Is) demo restart (cron) ==="
/usr/bin/docker compose --profile demo restart nightpass-demo

# Wait for sponsor prewarm to catch up, then log the result.
for i in $(seq 1 40); do
  if docker logs deploy-nightpass-demo-1 --since 4m 2>&1 | grep -q "prewarm.*CAUGHT UP"; then
    break
  fi
  sleep 5
done
n=$(docker logs deploy-nightpass-demo-1 --since 4m 2>&1 | grep -c "prewarm.*CAUGHT UP")
echo "=== $(date -Is) prewarm CAUGHT UP lines: ${n} (expect 3) ==="
