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

fail() {
  echo "sentry-mcp: $1" >&2
  exit 1
}

# The package receives a token for every project, so the caller's checkout must
# not choose what runs. Before reading the token: drop PATH entries a checkout
# controls (relative, node_modules, or inside the calling directory), drop
# inherited npm settings (`bun run` and `npm run` export them), replace user and
# global npm config with scripts/sentry/npmrc, and run from matrix, away from a
# checkout's .npmrc.
caller_logical="$PWD"
caller_physical="$(pwd -P)"
inside_caller() {
  local entry="$1" root
  for root in "$caller_logical" "$caller_physical"; do
    [[ "$root" == "/" ]] && continue
    [[ "$entry" == "$root" || "$entry" == "$root"/* ]] && return 0
  done
  return 1
}
safe_path=""
IFS=: read -r -a path_entries <<< "${PATH:-}"
for entry in "${path_entries[@]}"; do
  [[ "$entry" == /* ]] || continue
  [[ "/$entry/" == */node_modules/* ]] && continue
  inside_caller "$entry" && continue
  safe_path="${safe_path:+$safe_path:}$entry"
done
export PATH="$safe_path"

while IFS= read -r name; do
  unset "$name"
done < <(compgen -e | grep -i '^npm_config_' || true)
export npm_config_userconfig="$MATRIX_ROOT/scripts/sentry/npmrc"
export npm_config_globalconfig=/dev/null
export npm_config_registry="https://registry.npmjs.org/"
cd "$MATRIX_ROOT"
npx_bin="$(command -v npx)" || fail "npx is not on a trusted PATH entry"

[[ -r "$ROOT_ENV" ]] || fail "cannot read $ROOT_ENV"
token="$(sed -n 's/^SENTRY_MCP_AUTH_TOKEN=//p' "$ROOT_ENV" | tail -n 1)"
token="${token%\"}"
token="${token#\"}"
token="${token%\'}"
token="${token#\'}"
[[ -n "$token" ]] || fail "SENTRY_MCP_AUTH_TOKEN is not set in $ROOT_ENV"

# 0.42.0 reads SENTRY_ACCESS_TOKEN (newer releases prefer SENTRY_AUTH_TOKEN), so
# drop an inherited repository token, often an org:ci upload token.
unset SENTRY_TOKEN SENTRY_AUTH_TOKEN
export SENTRY_ACCESS_TOKEN="$token"
exec "$npx_bin" -y "$SERVER_PACKAGE" "$@"
