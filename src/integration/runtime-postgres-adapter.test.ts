import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { PostgresThreadingStore } from "../postgres-threading-store";
import { ThreadingCore } from "../threading-core";
import { ThreadingRuntime } from "../threading-engine";
import { FakeDecider } from "../test-utils/fake-decider";

const connectionString =
  process.env.INTEGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "Set INTEGRATION_DATABASE_URL (or DATABASE_URL) before running integration tests."
  );
}

const pool = new Pool({ connectionString });

async function runSchemaMigration(): Promise<void> {
  const schemaPath = path.resolve(process.cwd(), "db/schema.sql");
  const sql = await fs.readFile(schemaPath, "utf8");
  await pool.query(sql);
}

async function resetDb(): Promise<void> {
  await pool.query("TRUNCATE TABLE messages, threads RESTART IDENTITY CASCADE");
}

test.before(async () => {
  await runSchemaMigration();
});

test.beforeEach(async () => {
  await resetDb();
});

test.after(async () => {
  await pool.end();
});

test("runtime assignment revives archived threads through postgres adapter", async () => {
  const archivedThreadId = randomUUID();
  const archivedTime = "2024-01-01T00:00:00.000Z";

  await pool.query(
    `
    INSERT INTO threads (
      id, title, state, created_at, updated_at, last_message_at, archived_at
    )
    VALUES ($1, $2, 'archived', $3, $3, $3, $3)
    `,
    [archivedThreadId, "Printer jam in kitchen hall", archivedTime]
  );

  await pool.query(
    `
    INSERT INTO messages (
      id, created_at, author, content, thread_id, assignment_status, assignment_note
    )
    VALUES ($1, $2, $3, $4, $5, 'assigned', 'seed data')
    `,
    [
      randomUUID(),
      archivedTime,
      "alice",
      "printer jam in kitchen hall keeps repeating",
      archivedThreadId
    ]
  );

  const pendingMessageId = randomUUID();
  const pendingTime = "2024-01-02T00:00:00.000Z";
  await pool.query(
    `
    INSERT INTO messages (
      id, created_at, author, content, assignment_status
    )
    VALUES ($1, $2, $3, $4, 'pending')
    `,
    [
      pendingMessageId,
      pendingTime,
      "bob",
      "printer jam in kitchen hall has started again"
    ]
  );

  const decider = new FakeDecider({
    decideAssignment: () => ({
      action: "create",
      threadId: null,
      title: "Printer jam in kitchen hall (revival)",
      confidence: 0.99,
      reason: "Start a new active thread for this recurrence."
    }),
    decideRevivalLink: (_message, candidates) => {
      assert.ok(
        candidates.some((candidate) => candidate.id === archivedThreadId),
        "expected archived candidate to include the original thread"
      );
      return {
        archivedThreadId,
        confidence: 0.95
      };
    }
  });

  const runtime = new ThreadingRuntime(
    new ThreadingCore(decider, { mode: "strict_ai" }),
    new PostgresThreadingStore(pool)
  );

  const processed = await runtime.runAssignmentDrain();
  assert.equal(processed, 1);

  const messageResult = await pool.query<{
    thread_id: string | null;
    assignment_status: string;
    assignment_note: string | null;
  }>(
    `
    SELECT thread_id, assignment_status, assignment_note
    FROM messages
    WHERE id = $1
    `,
    [pendingMessageId]
  );

  assert.equal(messageResult.rowCount, 1);
  const assignedMessage = messageResult.rows[0];
  assert.equal(assignedMessage.assignment_status, "assigned");
  assert.ok(assignedMessage.thread_id, "pending message should have a thread id");
  assert.notEqual(assignedMessage.thread_id, archivedThreadId);
  assert.ok(
    (assignedMessage.assignment_note ?? "").length > 0,
    "assignment note should be recorded"
  );

  const newThreadId = assignedMessage.thread_id as string;

  const newThreadResult = await pool.query<{
    state: string;
    revives_thread_id: string | null;
  }>(
    `
    SELECT state, revives_thread_id
    FROM threads
    WHERE id = $1
    `,
    [newThreadId]
  );

  assert.equal(newThreadResult.rowCount, 1);
  assert.equal(newThreadResult.rows[0].state, "active");
  assert.equal(newThreadResult.rows[0].revives_thread_id, archivedThreadId);

  const oldThreadResult = await pool.query<{
    state: string;
    continued_in_thread_id: string | null;
  }>(
    `
    SELECT state, continued_in_thread_id
    FROM threads
    WHERE id = $1
    `,
    [archivedThreadId]
  );

  assert.equal(oldThreadResult.rowCount, 1);
  assert.equal(oldThreadResult.rows[0].state, "superseded");
  assert.equal(oldThreadResult.rows[0].continued_in_thread_id, newThreadId);
});

test("runtime merge cycle applies adapter merge with stable source/target ordering", async () => {
  const olderThreadId = randomUUID();
  const newerThreadId = randomUUID();

  const olderLast = "2024-06-01T10:00:00.000Z";
  const newerLast = "2024-06-01T10:05:00.000Z";

  await pool.query(
    `
    INSERT INTO threads (id, title, state, created_at, updated_at, last_message_at)
    VALUES
      ($1, $3, 'active', $5, $5, $5),
      ($2, $4, 'active', $6, $6, $6)
    `,
    [
      olderThreadId,
      newerThreadId,
      "Billing dashboard outage",
      "Billing dashboard outage",
      olderLast,
      newerLast
    ]
  );

  const olderMessageId = randomUUID();
  const newerMessageId = randomUUID();

  await pool.query(
    `
    INSERT INTO messages (
      id, created_at, author, content, thread_id, assignment_status, assignment_note
    )
    VALUES
      ($1, $3, 'alice', 'billing dashboard outage affecting invoices', $5, 'assigned', 'seed'),
      ($2, $4, 'bob', 'billing dashboard outage still affecting invoices', $6, 'assigned', 'seed')
    `,
    [
      olderMessageId,
      newerMessageId,
      olderLast,
      newerLast,
      olderThreadId,
      newerThreadId
    ]
  );

  const decider = new FakeDecider({
    decideMerge: () => ({
      shouldMerge: true,
      sourceThreadId: newerThreadId,
      targetThreadId: olderThreadId,
      confidence: 0.99,
      reason: "Duplicate conversation detected"
    })
  });

  const runtime = new ThreadingRuntime(
    new ThreadingCore(decider, { mode: "strict_ai" }),
    new PostgresThreadingStore(pool)
  );

  const merged = await runtime.runMergeCycle();
  assert.equal(merged, true);

  const oldThread = await pool.query<{
    state: string;
    merged_into_thread_id: string | null;
  }>(
    `
    SELECT state, merged_into_thread_id
    FROM threads
    WHERE id = $1
    `,
    [olderThreadId]
  );
  assert.equal(oldThread.rowCount, 1);
  assert.equal(oldThread.rows[0].state, "superseded");
  assert.equal(oldThread.rows[0].merged_into_thread_id, newerThreadId);

  const olderMessage = await pool.query<{ thread_id: string | null }>(
    `
    SELECT thread_id
    FROM messages
    WHERE id = $1
    `,
    [olderMessageId]
  );

  assert.equal(olderMessage.rowCount, 1);
  assert.equal(olderMessage.rows[0].thread_id, newerThreadId);

  const remainingOnOldThread = await pool.query<{ count: string }>(
    `
    SELECT COUNT(*)::text AS count
    FROM messages
    WHERE thread_id = $1
    `,
    [olderThreadId]
  );
  assert.equal(Number(remainingOnOldThread.rows[0].count), 0);
});
