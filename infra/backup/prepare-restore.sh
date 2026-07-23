#!/bin/sh
set -eu

umask 077

: "${BACKUP_DIR:?BACKUP_DIR is required}"
: "${RESTORE_DATA_DIR:?RESTORE_DATA_DIR is required}"
: "${WAL_ARCHIVE_DIR:?WAL_ARCHIVE_DIR is required}"

for path in "$BACKUP_DIR" "$RESTORE_DATA_DIR" "$WAL_ARCHIVE_DIR"; do
  case "$path" in
    /*) ;;
    *)
      echo "[RESTORE_INVALID] All paths must be absolute" >&2
      exit 2
      ;;
  esac
  case "$path" in
    *[!A-Za-z0-9_./-]*)
      echo "[RESTORE_INVALID] Paths may contain only letters, numbers, dot, slash, underscore, and dash" >&2
      exit 2
      ;;
  esac
done

if [ ! -f "$BACKUP_DIR/backup_manifest" ]; then
  echo "[RESTORE_INVALID] PostgreSQL backup manifest is missing" >&2
  exit 2
fi

if [ ! -d "$WAL_ARCHIVE_DIR" ]; then
  echo "[RESTORE_INVALID] WAL archive directory does not exist" >&2
  exit 2
fi

mkdir -p "$RESTORE_DATA_DIR"
if [ -n "$(find "$RESTORE_DATA_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  echo "[RESTORE_NOT_EMPTY] Refusing to overwrite $RESTORE_DATA_DIR" >&2
  exit 2
fi

pg_verifybackup "$BACKUP_DIR"
cp -a "$BACKUP_DIR/." "$RESTORE_DATA_DIR/"
chmod 700 "$RESTORE_DATA_DIR"

printf "\nrestore_command = 'cp %s/%%f %%p'\n" "$WAL_ARCHIVE_DIR" >> "$RESTORE_DATA_DIR/postgresql.auto.conf"
printf "recovery_target_timeline = 'latest'\n" >> "$RESTORE_DATA_DIR/postgresql.auto.conf"

if [ -n "${RECOVERY_TARGET_TIME:-}" ]; then
  case "$RECOVERY_TARGET_TIME" in
    *[!0-9T:Z+.,-]*)
      echo "[RESTORE_INVALID] RECOVERY_TARGET_TIME is invalid" >&2
      exit 2
      ;;
  esac
  printf "recovery_target_time = '%s'\n" "$RECOVERY_TARGET_TIME" >> "$RESTORE_DATA_DIR/postgresql.auto.conf"
  printf "recovery_target_action = 'promote'\n" >> "$RESTORE_DATA_DIR/postgresql.auto.conf"
fi

touch "$RESTORE_DATA_DIR/recovery.signal"

printf 'RESTORE_DATA_DIR=%s\n' "$RESTORE_DATA_DIR"
printf 'RESTORE_PREPARED=true\n'
