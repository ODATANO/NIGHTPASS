#!/usr/bin/env bash
# Auto-heal for the Try-it demo container, run from host cron every 5 minutes.
#
# Why this exists: Docker's restart policy does not act on failed healthchecks,
# and a wedged container can even survive `docker restart` (2026-08-02 outage:
# "tried to kill container, but did not receive an exit event" left the
# container Exited for 5 hours). This script force-recreates the container
# whenever it is not running or its healthcheck reports unhealthy.
#
# Kill switch: `touch /root/nightpass/deploy/.demo-off` stops the auto-heal
# (remove the file to re-enable). Without this guard, an intentional
# `docker compose stop nightpass-demo` would be resurrected within 5 minutes.
#
# Logs only when it acts, so the cron log stays quiet in normal operation.
set -uo pipefail
cd /root/nightpass/deploy || exit 1

NAME=deploy-nightpass-demo-1

[ -e .demo-off ] && exit 0

state=$(docker inspect -f '{{.State.Status}}' "$NAME" 2>/dev/null || echo missing)
health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$NAME" 2>/dev/null || echo none)

# Fine states: running+healthy, running+starting (boot grace period),
# running+none (image without healthcheck).
if [ "$state" = "running" ] && [ "$health" != "unhealthy" ]; then
  exit 0
fi

echo "=== $(date -Is) autoheal: state=$state health=$health, forcing recreate ==="
docker rm -f "$NAME" 2>/dev/null
/usr/bin/docker compose --profile demo up -d nightpass-demo
echo "=== $(date -Is) autoheal: up -d done ==="
