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

[[ -r "$ROOT_ENV" ]] || fail "cannot read $ROOT_ENV"
token="$(sed -n 's/^SENTRY_MCP_AUTH_TOKEN=//p' "$ROOT_ENV" | tail -n 1)"
token="${token%\"}"
token="${token#\"}"
token="${token%\'}"
token="${token#\'}"
[[ -n "$token" ]] || fail "SENTRY_MCP_AUTH_TOKEN is not set in $ROOT_ENV"

# The package receives a token for every project, so the caller's checkout must
# not choose where it comes from: drop inherited npm settings (a `bun run` or
# `npm run` exports them) and run from matrix, away from a checkout's .npmrc.
while IFS= read -r name; do
  unset "$name"
done < <(compgen -e | grep -i '^npm_config_' || true)
export npm_config_registry="https://registry.npmjs.org/"
cd "$MATRIX_ROOT"

# 0.42.0 reads SENTRY_ACCESS_TOKEN (newer releases prefer SENTRY_AUTH_TOKEN), so
# drop an inherited repository token, often an org:ci upload token.
unset SENTRY_TOKEN SENTRY_AUTH_TOKEN
export SENTRY_ACCESS_TOKEN="$token"
exec npx -y "$SERVER_PACKAGE" "$@"
