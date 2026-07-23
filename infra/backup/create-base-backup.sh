#!/bin/sh
set -eu

umask 077

: "${BACKUP_ROOT:?BACKUP_ROOT is required}"

BACKUP_ID=${BACKUP_ID:-$(date -u +%Y%m%dT%H%M%SZ)}

case "$BACKUP_ROOT" in
  /*) ;;
  *)
    echo "[BACKUP_INVALID] BACKUP_ROOT must be an absolute path" >&2
    exit 2
    ;;
esac

case "$BACKUP_ID" in
  *[!A-Za-z0-9._-]* | '')
    echo "[BACKUP_INVALID] BACKUP_ID contains unsupported characters" >&2
    exit 2
    ;;
esac

backup_path="$BACKUP_ROOT/$BACKUP_ID"
if [ -e "$backup_path" ]; then
  echo "[BACKUP_EXISTS] Refusing to overwrite $backup_path" >&2
  exit 2
fi

mkdir -p "$backup_path"
started_at=$(date +%s)

pg_basebackup \
  --checkpoint=fast \
  --format=plain \
  --manifest-checksums=SHA256 \
  --pgdata="$backup_path" \
  --progress \
  --wal-method=stream

pg_verifybackup "$backup_path"

completed_at=$(date +%s)
duration_seconds=$((completed_at - started_at))

printf 'BACKUP_PATH=%s\n' "$backup_path"
printf 'BACKUP_DURATION_SECONDS=%s\n' "$duration_seconds"
printf 'BACKUP_VERIFIED=true\n'
