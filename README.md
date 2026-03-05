# Continuum

Real-time conversation with memory.

Continuum keeps a single global chat stream, then continuously organizes it
into persistent threads in the background.

## MVP implemented

- Single global live firehose (`messages` table + live UI)
- Async thread assignment worker (messages appear immediately as unassigned)
- AI-based assignment to active/cooling threads via OpenAI
- Automatic thread creation when no active match exists
- Lifecycle transitions:
  - `active -> cooling` after 30 minutes idle
  - `cooling -> archived` after 72 hours idle
- Archived topic revival behavior:
  - New topic creates a new thread
  - Old archived thread is marked `superseded`
  - Old thread stores `continued_in_thread_id`
  - New thread stores `revives_thread_id`
- Duplicate merge behavior:
  - Only active/cooling threads are merge candidates
  - Source thread becomes `superseded` with `merged_into_thread_id`
- Archived/superseded thread search using PostgreSQL full-text search
- Barebones UI:
  - Global message feed
  - Thread list
  - Thread detail with link relationships
  - Archived search
- WebSocket updates for message/thread state changes

## Stack

- Node.js + TypeScript
- Express (API + static UI)
- WebSocket (`ws`)
- PostgreSQL (`pg`, plain SQL)
- OpenAI API (`gpt-4.1-mini` default)

## Prerequisites

- Node.js 20+
- npm
- PostgreSQL running locally

## Environment

Set env vars in `.env` (optional defaults shown):

```bash
PORT=3000
DATABASE_URL=postgres://localhost/continuum
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
ACTIVE_TO_COOLING_MINUTES=30
COOLING_TO_ARCHIVED_HOURS=72
ASSIGNMENT_POLL_MS=1500
MERGE_POLL_MS=45000
MAX_ACTIVE_THREAD_CANDIDATES=15
MAX_ARCHIVED_THREAD_CANDIDATES=20
```

If `OPENAI_API_KEY` is unset, the worker falls back to heuristic matching.

## Run

```bash
npm install
npm run db:migrate
npm run dev
```

Open <http://localhost:3000>.

## Build

```bash
npm run check
npm run build
npm start
```

## Offline Benchmark Replay

The threading algorithm has a shared core that now runs in both:

- the live app worker (Postgres-backed), and
- an offline replay engine (in-memory) for benchmark runs.

Run IRC replay to generate a `predictions.graph.txt` file:

```bash
npm run benchmark:irc -- \
  --dataset-dir /path/to/dev \
  --output /path/to/predictions.graph.txt \
  --start-index 1000 \
  --decision-mode strict_ai
```

`strict_ai` means AI calls are required and no heuristic fallback is used.

## API surface

- `GET /health`
- `GET /api/messages?limit=200`
- `POST /api/messages`
- `GET /api/threads?states=active,cooling,archived,superseded`
- `GET /api/threads/:id`
- `GET /api/search?q=<query>`

## Notes

- The service runs assignment, lifecycle, and merge loops in-process.
- This is intentionally a raw UI with a functional backend.
- For local npm issues on this machine, commands can be run with:
  `pkgx +node@20 npm <command>`.
