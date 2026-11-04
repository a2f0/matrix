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

# 0.42.0 reads SENTRY_ACCESS_TOKEN (newer releases prefer SENTRY_AUTH_TOKEN), so
# drop an inherited repository token, often an org:ci upload token.
unset SENTRY_TOKEN SENTRY_AUTH_TOKEN
export SENTRY_ACCESS_TOKEN="$token"
exec npx -y "$SERVER_PACKAGE" "$@"
