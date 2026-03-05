#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.e2e.yml"

DB_PORT="${INTEGRATION_DB_PORT:-55433}"
DB_NAME="continuum_e2e"
DB_USER="postgres"
DB_PASSWORD="postgres"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for integration test runs"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker daemon is not available"
  exit 1
fi

cleanup() {
  E2E_DB_PORT="$DB_PORT" docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

E2E_DB_PORT="$DB_PORT" docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
E2E_DB_PORT="$DB_PORT" docker compose -f "$COMPOSE_FILE" up -d

for i in $(seq 1 60); do
  if E2E_DB_PORT="$DB_PORT" docker compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    break
  fi
  if [[ "$i" -eq 60 ]]; then
    echo "postgres did not become ready"
    exit 1
  fi
  sleep 1
done

export NODE_ENV="test"
export INTEGRATION_DATABASE_URL="postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${DB_PORT}/${DB_NAME}"

if [[ "$#" -gt 0 ]]; then
  TEST_FILES=("$@")
else
  TEST_FILES=(
    "src/integration/offline-runtime.strict-ai.test.ts"
    "src/integration/runtime-postgres-adapter.test.ts"
  )
fi

cd "$ROOT_DIR"
node --import tsx --test --test-concurrency=1 "${TEST_FILES[@]}"
