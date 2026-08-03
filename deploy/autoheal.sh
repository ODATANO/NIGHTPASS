#!/usr/bin/env bash
# Auto-heal for a NIGHTPASS container, run from host cron every 5 minutes.
#
#   bash autoheal.sh nightpass          # main site (zkpassport.eu)
#   bash autoheal.sh nightpass-demo     # Try-it demo (demo.zkpassport.eu)
#
# Why this exists: Docker's restart policy does not act on failed healthchecks,
# and a wedged container can even survive `docker restart` (2026-08-02 outage:
# "tried to kill container, but did not receive an exit event" left the demo
# container Exited for 5 hours). This script force-recreates the container
# whenever it is not running or its healthcheck reports unhealthy.
#
# Kill switch: `touch /root/nightpass/deploy/.<service>-off` stops the auto-heal
# for that service (remove the file to re-enable). Without this guard, an
# intentional `docker compose stop` would be resurrected within 5 minutes.
#
# Logs only when it acts, so the cron log stays quiet in normal operation.
set -uo pipefail
cd /root/nightpass/deploy || exit 1

SERVICE="${1:-nightpass-demo}"
NAME="deploy-${SERVICE}-1"
# The demo container only exists under the compose profile of the same name.
PROFILE_ARGS=()
[ "$SERVICE" = "nightpass-demo" ] && PROFILE_ARGS=(--profile demo)

[ -e ".${SERVICE}-off" ] && exit 0
# Back-compat with the demo-only kill switch documented before this rewrite.
[ "$SERVICE" = "nightpass-demo" ] && [ -e .demo-off ] && exit 0

# Serialize against the nightly restart script and against a previous run of
# this script that is still recreating a container.
exec 9>"/var/lock/nightpass-${SERVICE}.lock"
flock -n 9 || exit 0

state=$(docker inspect -f '{{.State.Status}}' "$NAME" 2>/dev/null || echo missing)
health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$NAME" 2>/dev/null || echo none)

# Fine states: running+healthy, running+starting (boot grace period),
# running+none (image without healthcheck).
if [ "$state" = "running" ] && [ "$health" != "unhealthy" ]; then
  exit 0
fi

echo "=== $(date -Is) autoheal[$SERVICE]: state=$state health=$health, forcing recreate ==="
docker rm -f "$NAME" 2>/dev/null
if /usr/bin/docker compose "${PROFILE_ARGS[@]}" up -d "$SERVICE"; then
  echo "=== $(date -Is) autoheal[$SERVICE]: up -d ok ==="
else
  echo "=== $(date -Is) autoheal[$SERVICE]: up -d FAILED (exit $?) ==="
fi
