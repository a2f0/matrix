#!/usr/bin/env bash
# Start the Sentry MCP server (stdio) with the workspace's personal Sentry token.
# The token comes from matrix-secrets/root/root.env and never appears in
# harness configuration or process arguments.
set -euo pipefail

MATRIX_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SECRETS_DIR="${MATRIX_SECRETS_DIR:-$MATRIX_ROOT/../matrix-secrets}"
ROOT_ENV="$SECRETS_DIR/root/root.env"
# Bump deliberately: the server runs with a broadly scoped token.
SERVER_PACKAGE="@sentry/mcp-server@0.42.0"
# System tool directories only. The caller's PATH is never used: a checkout's
# node_modules/.bin, version-manager shims or symlinked tool folders could put
# their own npx or node in front of the token.
TRUSTED_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
# Inherited variables that survive; everything else (NODE_OPTIONS, npm_config_*,
# SENTRY_*, BUN_*, ...) is dropped, so the calling checkout cannot inject code
# or configuration into the process that holds the token.
KEEP_ENV=" LANG LC_ALL LC_CTYPE TERM TMPDIR USER LOGNAME "

fail() {
  echo "sentry-mcp: $1" >&2
  exit 1
}

user="$(id -un)"
[[ "$user" =~ ^[A-Za-z0-9._-]+$ ]] || fail "unexpected user name"
# The account's home from the user database, not an inherited HOME that could
# point npm's cache (and its cached package) into a checkout.
eval "home=~$user"
[[ "$home" == /* && -d "$home" ]] || fail "cannot resolve the home directory of $user"

[[ -r "$ROOT_ENV" ]] || fail "cannot read $ROOT_ENV"
token="$(sed -n 's/^SENTRY_MCP_AUTH_TOKEN=//p' "$ROOT_ENV" | tail -n 1)"
token="${token%\"}"
token="${token#\"}"
token="${token%\'}"
token="${token#\'}"
[[ -n "$token" ]] || fail "SENTRY_MCP_AUTH_TOKEN is not set in $ROOT_ENV"

while IFS= read -r name; do
  [[ "$KEEP_ENV" == *" $name "* ]] || unset "$name" 2>/dev/null || true
done < <(compgen -e)
export HOME="$home" PATH="$TRUSTED_PATH"
# npm reads this file instead of ~/.npmrc; it pins every registry, including the
# @sentry scope. No global config, and matrix (the working directory) has none.
export npm_config_userconfig="$MATRIX_ROOT/scripts/sentry/npmrc"
export npm_config_globalconfig=/dev/null
cd "$MATRIX_ROOT"
npx_bin="$(command -v npx)" || fail "npx not found in $TRUSTED_PATH"

# 0.42.0 reads SENTRY_ACCESS_TOKEN (newer releases prefer SENTRY_AUTH_TOKEN).
export SENTRY_ACCESS_TOKEN="$token"
exec "$npx_bin" -y "$SERVER_PACKAGE" "$@"
