import { Pool } from "pg";

import { config } from "./config";
import { buildTitle, type ArchivedCandidate, type MergeCandidate, type PendingMessage } from "./threading-core";
import type { AppliedAssignment, ThreadingLifecycleTransition, ThreadingStore } from "./threading-engine";
import type { AssignmentDecision, ThreadCandidate } from "./types";

export class PostgresThreadingStore implements ThreadingStore {
  constructor(private readonly pool: Pool) {}

  async claimPendingMessage(): Promise<PendingMessage | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const picked = await client.query<PendingMessage>(
        `
        SELECT id, created_at, author, content
        FROM messages
        WHERE assignment_status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
        `
      );

      if (picked.rowCount === 0) {
        await client.query("COMMIT");
        return null;
      }

      const pending = picked.rows[0];
      await client.query(
        `
        UPDATE messages
        SET assignment_status = 'in_progress'
        WHERE id = $1
        `,
        [pending.id]
      );
      await client.query("COMMIT");
      return pending;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markAssignmentFailed(messageId: string, note: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE messages
      SET assignment_status = 'failed',
          assignment_note = $2
      WHERE id = $1
      `,
      [messageId, note]
    );
  }

  async fetchActiveThreadCandidates(): Promise<ThreadCandidate[]> {
    const rows = await this.pool.query<ThreadCandidate>(
      `
      SELECT
        t.id,
        t.title,
        t.state,
        t.last_message_at,
        COALESCE(
          STRING_AGG(m.content, E'\\n' ORDER BY m.created_at DESC),
          ''
        ) AS recent_excerpt
      FROM threads t
      LEFT JOIN LATERAL (
        SELECT content, created_at
        FROM messages
        WHERE thread_id = t.id
        ORDER BY created_at DESC
        LIMIT 6
      ) m ON TRUE
      WHERE t.state IN ('active', 'cooling')
      GROUP BY t.id
      ORDER BY COALESCE(t.last_message_at, t.updated_at) DESC
      LIMIT $1
      `,
      [config.MAX_ACTIVE_THREAD_CANDIDATES]
    );

    return rows.rows;
  }

  async fetchArchivedThreadCandidates(): Promise<ArchivedCandidate[]> {
    const rows = await this.pool.query<ArchivedCandidate>(
      `
      SELECT
        t.id,
        t.title,
        COALESCE(
          STRING_AGG(m.content, E'\\n' ORDER BY m.created_at DESC),
          ''
        ) AS recent_excerpt
      FROM threads t
      LEFT JOIN LATERAL (
        SELECT content, created_at
        FROM messages
        WHERE thread_id = t.id
        ORDER BY created_at DESC
        LIMIT 8
      ) m ON TRUE
      WHERE t.state = 'archived'
      GROUP BY t.id
      ORDER BY COALESCE(t.last_message_at, t.updated_at) DESC
      LIMIT $1
      `,
      [config.MAX_ARCHIVED_THREAD_CANDIDATES]
    );

    return rows.rows;
  }

  async applyAssignment(
    pending: PendingMessage,
    decision: AssignmentDecision,
    revivalSourceId: string | null
  ): Promise<AppliedAssignment> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let threadId: string | null = decision.threadId;
      let createdThreadId: string | null = null;
      let revivalLink: { oldId: string; newId: string } | null = null;

      if (decision.action === "create" || !threadId) {
        const created = await client.query<{ id: string }>(
          `
          INSERT INTO threads (
            title,
            state,
            last_message_at,
            updated_at
          )
          VALUES ($1, 'active', $2, NOW())
          RETURNING id
          `,
          [decision.title ?? buildTitle(pending.content), pending.created_at]
        );
        threadId = created.rows[0].id;
        createdThreadId = threadId;

        if (revivalSourceId) {
          const superseded = await client.query<{ id: string }>(
            `
            UPDATE threads
            SET state = 'superseded',
                superseded_at = NOW(),
                continued_in_thread_id = $2,
                updated_at = NOW()
            WHERE id = $1
              AND state = 'archived'
            RETURNING id
            `,
            [revivalSourceId, threadId]
          );

          if ((superseded.rowCount ?? 0) > 0) {
            await client.query(
              `
              UPDATE threads
              SET revives_thread_id = $2,
                  updated_at = NOW()
              WHERE id = $1
              `,
              [threadId, revivalSourceId]
            );
            revivalLink = { oldId: revivalSourceId, newId: threadId };
          }
        }
      }

      if (!threadId) {
        throw new Error("Assignment did not produce a thread id");
      }

      await client.query(
        `
        UPDATE messages
        SET thread_id = $2,
            assignment_status = 'assigned',
            assignment_note = $3
        WHERE id = $1
        `,
        [pending.id, threadId, decision.reason]
      );

      await client.query(
        `
        UPDATE threads
        SET state = CASE WHEN state = 'cooling' THEN 'active' ELSE state END,
            updated_at = NOW(),
            last_message_at = GREATEST(
              COALESCE(last_message_at, $2::timestamptz),
              $2::timestamptz
            )
        WHERE id = $1
        `,
        [threadId, pending.created_at]
      );

      await client.query("COMMIT");

      return {
        threadId,
        createdThreadId,
        revivalLink
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async fetchMergeCandidates(): Promise<MergeCandidate[]> {
    const rows = await this.pool.query<MergeCandidate>(
      `
      SELECT
        t.id,
        t.title,
        t.state,
        t.last_message_at,
        COALESCE(
          STRING_AGG(m.content, E'\\n' ORDER BY m.created_at DESC),
          ''
        ) AS recent_excerpt
      FROM threads t
      LEFT JOIN LATERAL (
        SELECT content, created_at
        FROM messages
        WHERE thread_id = t.id
        ORDER BY created_at DESC
        LIMIT 5
      ) m ON TRUE
      WHERE t.state IN ('active', 'cooling')
      GROUP BY t.id
      ORDER BY COALESCE(t.last_message_at, t.updated_at) DESC
      LIMIT 16
      `
    );
    return rows.rows;
  }

  async applyMerge(sourceThreadId: string, targetThreadId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const updatedSource = await client.query<{ id: string }>(
        `
        UPDATE threads
        SET state = 'superseded',
            merged_into_thread_id = $2,
            superseded_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
          AND state IN ('active', 'cooling')
        RETURNING id
        `,
        [sourceThreadId, targetThreadId]
      );

      if (updatedSource.rowCount === 0) {
        await client.query("ROLLBACK");
        return false;
      }

      await client.query(
        `
        UPDATE messages
        SET thread_id = $2
        WHERE thread_id = $1
        `,
        [sourceThreadId, targetThreadId]
      );

      await client.query(
        `
        UPDATE threads
        SET state = 'active',
            last_message_at = (
              SELECT MAX(created_at) FROM messages WHERE thread_id = $1
            ),
            updated_at = NOW()
        WHERE id = $1
        `,
        [targetThreadId]
      );

      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async transitionLifecycle(): Promise<ThreadingLifecycleTransition> {
    const cooled = await this.pool.query<{ id: string }>(
      `
      UPDATE threads
      SET state = 'cooling',
          updated_at = NOW()
      WHERE state = 'active'
        AND last_message_at IS NOT NULL
        AND last_message_at < NOW() - make_interval(mins => $1::INT)
      RETURNING id
      `,
      [config.ACTIVE_TO_COOLING_MINUTES]
    );

    const archived = await this.pool.query<{ id: string }>(
      `
      UPDATE threads
      SET state = 'archived',
          archived_at = COALESCE(archived_at, NOW()),
          updated_at = NOW()
      WHERE state = 'cooling'
        AND last_message_at IS NOT NULL
        AND last_message_at < NOW() - make_interval(hours => $1::INT)
      RETURNING id
      `,
      [config.COOLING_TO_ARCHIVED_HOURS]
    );

    return {
      cooledThreadIds: cooled.rows.map((row) => row.id),
      archivedThreadIds: archived.rows.map((row) => row.id)
    };
  }
}
