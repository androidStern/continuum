#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.e2e.yml"
LOG_FILE="$ROOT_DIR/.e2e-server.log"

APP_PORT="${E2E_APP_PORT:-4173}"
DB_PORT="${E2E_DB_PORT:-55432}"
DB_NAME="continuum_e2e"
DB_USER="postgres"
DB_PASSWORD="postgres"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for e2e runs"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker daemon is not available"
  exit 1
fi

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi

  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
docker compose -f "$COMPOSE_FILE" up -d

for i in $(seq 1 60); do
  if docker compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    break
  fi
  if [[ "$i" -eq 60 ]]; then
    echo "postgres did not become ready"
    exit 1
  fi
  sleep 1
done

export NODE_ENV="test"
export PORT="$APP_PORT"
export DATABASE_URL="postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${DB_PORT}/${DB_NAME}"
export ASSIGNMENT_POLL_MS="${ASSIGNMENT_POLL_MS:-100}"
export MERGE_POLL_MS="${MERGE_POLL_MS:-500}"
export ACTIVE_TO_COOLING_MINUTES="${ACTIVE_TO_COOLING_MINUTES:-30}"
export COOLING_TO_ARCHIVED_HOURS="${COOLING_TO_ARCHIVED_HOURS:-72}"
export MAX_ACTIVE_THREAD_CANDIDATES="${MAX_ACTIVE_THREAD_CANDIDATES:-15}"
export MAX_ARCHIVED_THREAD_CANDIDATES="${MAX_ARCHIVED_THREAD_CANDIDATES:-20}"

if [[ "${E2E_ENABLE_AI:-0}" == "1" ]]; then
  if [[ -z "${OPENAI_API_KEY:-}" ]]; then
    echo "E2E_ENABLE_AI=1 requires OPENAI_API_KEY"
    exit 1
  fi
else
  export OPENAI_API_KEY=""
fi

: > "$LOG_FILE"
(
  cd "$ROOT_DIR"
  npx tsx src/server.ts >> "$LOG_FILE" 2>&1
) &
SERVER_PID=$!

for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:${APP_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  if [[ "$i" -eq 120 ]]; then
    echo "app did not become healthy"
    echo "---- server log ----"
    cat "$LOG_FILE"
    echo "--------------------"
    exit 1
  fi
  sleep 0.25
done

cd "$ROOT_DIR"
E2E_BASE_URL="http://127.0.0.1:${APP_PORT}" npx playwright test "$@"
