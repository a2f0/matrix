#!/usr/bin/env bash
# Archive the whole matrix-secrets folder, encrypted with GPG unless --no-password.
set -euo pipefail
umask 077

MATRIX_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SECRETS_DIR="${MATRIX_SECRETS_DIR:-$MATRIX_ROOT/../matrix-secrets}"
OUTPUT_DIR="$HOME/matrix-secrets-backups"
PASSWORD=""
NO_PASSWORD=false
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE_EXTENSION=".zip"

usage() {
  echo "Usage: backupSecrets.sh [output_dir] [--password <password>] [--no-password]"
}

fail() {
  echo "backupSecrets: $1" >&2
  exit 1
}

output_dir_set=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --password)
      if [[ $# -lt 2 ]]; then
        usage >&2
        fail "missing value for --password"
      fi
      PASSWORD="$2"
      [[ -n "$PASSWORD" ]] || fail "--password cannot be empty"
      shift 2
      ;;
    --password=*)
      PASSWORD="${1#*=}"
      [[ -n "$PASSWORD" ]] || fail "--password cannot be empty"
      shift
      ;;
    --no-password)
      NO_PASSWORD=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      usage >&2
      fail "unknown option: $1"
      ;;
    *)
      if [[ "$output_dir_set" -eq 1 ]]; then
        usage >&2
        fail "too many positional arguments"
      fi
      OUTPUT_DIR="${1/#~/$HOME}"
      output_dir_set=1
      shift
      ;;
  esac
done

if [[ -n "$PASSWORD" && "$NO_PASSWORD" == true ]]; then
  fail "--password and --no-password cannot be combined"
fi
if [[ -z "$PASSWORD" && "$NO_PASSWORD" != true && ! -t 0 ]]; then
  fail "non-interactive backups require --password or explicit --no-password"
fi
command -v zip >/dev/null 2>&1 || fail "'zip' command not found."
if [[ "$NO_PASSWORD" != true ]]; then
  command -v gpg >/dev/null 2>&1 || fail "'gpg' command not found."
  ARCHIVE_EXTENSION="${ARCHIVE_EXTENSION}.gpg"
fi

[[ -d "$SECRETS_DIR" ]] || fail "secrets directory not found: $SECRETS_DIR"
SECRETS_ABS="$(cd "$SECRETS_DIR" && pwd -P)"
[[ "$SECRETS_ABS" != "/" ]] || fail "secrets directory cannot be the root directory"
SECRETS_PARENT="$(dirname "$SECRETS_ABS")"
SECRETS_NAME="$(basename "$SECRETS_ABS")"

# Canonicalize the output path before creating it, so a refused path leaves
# nothing behind: existing components resolve through symlinks, and `.` and
# `..` apply in order, including after components that do not exist yet.
resolve_path() {
  local current component
  local -a components
  if [[ "$1" == /* ]]; then current="/"; else current="$(pwd -P)"; fi
  IFS=/ read -r -a components <<<"$1"
  for component in "${components[@]}"; do
    case "$component" in
      "" | .) continue ;;
      ..) current="$(dirname "$current")" ;;
      *) current="${current%/}/$component" ;;
    esac
    if [[ -d "$current" ]]; then current="$(cd "$current" && pwd -P)"; fi
  done
  printf '%s\n' "$current"
}

OUTPUT_ABS="$(resolve_path "$OUTPUT_DIR")"
if [[ "$OUTPUT_ABS" == "$SECRETS_ABS" || "$OUTPUT_ABS" == "$SECRETS_ABS/"* ]]; then
  fail "output directory cannot be inside the secrets directory: $OUTPUT_ABS"
fi
mkdir -p "$OUTPUT_ABS"

# A private directory reserves a unique suffix for concurrent backups. Keep
# the in-progress archive there and hard-link it into place only on success;
# ln refuses to replace an existing destination.
RESERVATION_DIR="$(mktemp -d "$OUTPUT_ABS/.matrix-secrets-backup-${TIMESTAMP}.XXXXXX")"
TEMP_ARCHIVE="$RESERVATION_DIR/archive$ARCHIVE_EXTENSION"
trap 'rm -f "$TEMP_ARCHIVE"; rmdir "$RESERVATION_DIR"' EXIT
ARCHIVE_PATH="$OUTPUT_ABS/matrix-secrets-backup-${TIMESTAMP}-${RESERVATION_DIR##*.}$ARCHIVE_EXTENSION"

# Zip from the parent so archive paths start with the folder name. Symlinks
# are followed. Encrypted mode streams directly into GPG so the plaintext
# archive is never written to disk.
if [[ "$NO_PASSWORD" == true ]]; then
  (cd "$SECRETS_PARENT" && zip -r "$TEMP_ARCHIVE" "$SECRETS_NAME" -x '*.DS_Store' >/dev/null)
elif [[ -n "$PASSWORD" ]]; then
  echo "backupSecrets: WARNING: --password exposes the passphrase in the backup command's process list." >&2
  (cd "$SECRETS_PARENT" && zip -r - "$SECRETS_NAME" -x '*.DS_Store' 2>/dev/null) |
    gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 \
      --symmetric --cipher-algo AES256 --force-aead --output "$TEMP_ARCHIVE" \
      3<<<"$PASSWORD"
else
  (cd "$SECRETS_PARENT" && zip -r - "$SECRETS_NAME" -x '*.DS_Store' 2>/dev/null) |
    gpg --symmetric --cipher-algo AES256 --force-aead --output "$TEMP_ARCHIVE"
fi
ln "$TEMP_ARCHIVE" "$ARCHIVE_PATH"

echo "Created backup: $ARCHIVE_PATH"
echo "Backed up: $SECRETS_ABS"
