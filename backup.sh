#!/usr/bin/env bash
# Nightly database backup, kept for 14 days. Installed by deploy.sh as /etc/cron.d/harbor (root, 03:40).
# Provider keys in the dump are encrypted; MASTER_KEY lives in /etc/harbor/app.env, not in the dump.
set -euo pipefail
DEST=/var/backups/harbor
KEEP_DAYS=14
cd /opt/harbor
umask 077
mkdir -p "$DEST"
docker compose exec -T db pg_dump -U harbor -Fc harbor > "$DEST/.db.tmp"
mv "$DEST/.db.tmp" "$DEST/db-$(date +%F).dump"
find "$DEST" -name 'db-*.dump' -mtime +"$KEEP_DAYS" -delete
