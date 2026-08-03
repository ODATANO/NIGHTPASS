#!/usr/bin/env bash
# Nightly PostgreSQL backup for both NIGHTPASS databases, run from host cron.
#
#   bash backup-db.sh [target-dir]      # default /root/nightpass-backups
#
# Writes one custom-format dump per database (pg_dump -Fc, restorable with
# pg_restore, compressed) and prunes dumps older than RETAIN_DAYS.
#
# IMPORTANT, and deliberately not automated here: these dumps live on the SAME
# disk as the databases, so they survive an accidental DELETE but NOT a host
# loss. Ship them off-box (rclone/borg/scp to another machine) for that; the
# `OFFSITE_CMD` hook below runs after a successful dump when it is set.
#
# What a dump does NOT contain: deploy/.env secrets, the wallet mnemonics and
# the ENCRYPTION_KEY. Without the matching ENCRYPTION_KEY every payloadCipher
# in a restored dump stays unreadable, so keep an encrypted copy of the
# secrets separately (see deploy/README.md, "Key material").
set -uo pipefail
cd /root/nightpass/deploy || exit 1

TARGET="${1:-/root/nightpass-backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$TARGET" || exit 1

dump_one() {
  local service="$1" db="$2" user="$3"
  local out="$TARGET/${db}-${STAMP}.dump"
  if ! docker compose --profile demo exec -T "$service" pg_dump -Fc -U "$user" -d "$db" > "$out" 2>/tmp/pgdump.err; then
    echo "=== $(date -Is) backup FAILED for $db: $(tail -1 /tmp/pgdump.err) ==="
    rm -f "$out"
    return 1
  fi
  # A dump that is suspiciously small usually means the command "succeeded"
  # against an empty or wrong database; catch it here rather than on restore.
  local size
  size=$(stat -c %s "$out")
  if [ "$size" -lt 10000 ]; then
    echo "=== $(date -Is) backup SUSPICIOUS for $db: only ${size} bytes, keeping it but check ==="
  fi
  echo "$(date -Is) $db -> $out (${size} bytes)"
}

rc=0
dump_one postgres nightpass nightpass || rc=1
dump_one postgres-demo nightpass_demo nightpass_demo || rc=1

# Retention: keep the last RETAIN_DAYS days of dumps.
find "$TARGET" -name '*.dump' -mtime "+${RETAIN_DAYS}" -delete 2>/dev/null

# Optional off-box copy, e.g. OFFSITE_CMD='rclone copy /root/nightpass-backups remote:nightpass'
if [ -n "${OFFSITE_CMD:-}" ] && [ "$rc" -eq 0 ]; then
  if eval "$OFFSITE_CMD"; then echo "$(date -Is) offsite copy ok"; else echo "$(date -Is) offsite copy FAILED"; rc=1; fi
fi

exit "$rc"
