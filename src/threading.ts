import { Pool } from "pg";

import { AIDecider } from "./ai";
import { config } from "./config";
import { RealtimeHub } from "./realtime";
import {
  buildTitle,
  ThreadingCore,
  type ArchivedCandidate,
  type MergeCandidate,
  type PendingMessage
} from "./threading-core";
import type { AssignmentDecision, ThreadCandidate } from "./types";

export class ThreadingEngine {
  private readonly ai = new AIDecider();
  private readonly core = new ThreadingCore(this.ai, {
    mode: "ai_with_fallback"
  });
  private assignmentLoopBusy = false;
  private lifecycleLoopBusy = false;
  private mergeLoopBusy = false;

  constructor(
    private readonly pool: Pool,
    private readonly realtimeHub: RealtimeHub
  ) {}

  start(): void {
    setInterval(() => void this.assignmentTick(), config.ASSIGNMENT_POLL_MS);
    setInterval(() => void this.lifecycleTick(), 10_000);
    setInterval(() => void this.mergeTick(), config.MERGE_POLL_MS);
    void this.assignmentTick();
    void this.lifecycleTick();
    void this.mergeTick();
  }

  private async assignmentTick(): Promise<void> {
    if (this.assignmentLoopBusy) return;
    this.assignmentLoopBusy = true;
    try {
      while (await this.processSinglePendingMessage()) {
        // Drain the queue to keep assignment latency low.
      }
    } finally {
      this.assignmentLoopBusy = false;
    }
  }

  private async lifecycleTick(): Promise<void> {
    if (this.lifecycleLoopBusy) return;
    this.lifecycleLoopBusy = true;
    try {
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

      for (const row of cooled.rows) {
        this.realtimeHub.broadcast("thread.updated", { id: row.id });
      }
      for (const row of archived.rows) {
        this.realtimeHub.broadcast("thread.updated", { id: row.id });
      }
    } catch (error) {
      console.error("lifecycleTick failed", error);
    } finally {
      this.lifecycleLoopBusy = false;
    }
  }

  private async mergeTick(): Promise<void> {
    if (this.mergeLoopBusy) return;
    this.mergeLoopBusy = true;
    try {
      const candidates = await this.fetchMergeCandidates();
      const plan = await this.core.decideMerge(candidates);
      if (!plan || !plan.shouldMerge) {
        return;
      }

      let sourceThreadId = plan.sourceThreadId;
      let targetThreadId = plan.targetThreadId;

      const sourceLast = plan.source.last_message_at ?? "";
      const targetLast = plan.target.last_message_at ?? "";
      if (sourceLast > targetLast) {
        const originalTarget = targetThreadId;
        targetThreadId = sourceThreadId;
        sourceThreadId = originalTarget;
      }

      if (sourceThreadId === targetThreadId) {
        return;
      }

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
          return;
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

        this.realtimeHub.broadcast("thread.merged", {
          sourceThreadId,
          targetThreadId
        });
        this.realtimeHub.broadcast("thread.updated", { id: sourceThreadId });
        this.realtimeHub.broadcast("thread.updated", { id: targetThreadId });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("mergeTick failed", error);
    } finally {
      this.mergeLoopBusy = false;
    }
  }

  private async processSinglePendingMessage(): Promise<boolean> {
    const pending = await this.claimPendingMessage();
    if (!pending) {
      return false;
    }

    try {
      const candidates = await this.fetchActiveThreadCandidates();
      const decision = await this.core.decideAssignment(pending, candidates);

      const revivalSourceId =
        decision.action === "create" ? await this.findRevivalSource(pending) : null;
      const assignment = await this.applyAssignment(
        pending,
        decision,
        revivalSourceId
      );
      this.realtimeHub.broadcast("message.updated", {
        id: pending.id,
        thread_id: assignment.threadId,
        assignment_status: "assigned",
        assignment_note: decision.reason
      });

      if (assignment.createdThreadId) {
        this.realtimeHub.broadcast("thread.created", {
          id: assignment.createdThreadId
        });
      }
      this.realtimeHub.broadcast("thread.updated", { id: assignment.threadId });

      if (assignment.revivalLink) {
        this.realtimeHub.broadcast("thread.updated", { id: assignment.revivalLink.oldId });
        this.realtimeHub.broadcast("thread.updated", { id: assignment.revivalLink.newId });
      }

      return true;
    } catch (error) {
      console.error("processSinglePendingMessage failed", error);
      await this.pool.query(
        `
        UPDATE messages
        SET assignment_status = 'failed',
            assignment_note = $2
        WHERE id = $1
        `,
        [pending.id, "Assignment failed. Check server logs."]
      );
      this.realtimeHub.broadcast("message.updated", {
        id: pending.id,
        assignment_status: "failed",
        assignment_note: "Assignment failed. Check server logs."
      });
      return true;
    }
  }

  private async claimPendingMessage(): Promise<PendingMessage | null> {
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

  private async fetchActiveThreadCandidates(): Promise<ThreadCandidate[]> {
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

  private async fetchArchivedThreadCandidates(): Promise<ArchivedCandidate[]> {
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

  private async findRevivalSource(
    pending: PendingMessage
  ): Promise<string | null> {
    const archived = await this.fetchArchivedThreadCandidates();
    return this.core.decideRevivalSource(pending, archived);
  }

  private async applyAssignment(
    pending: PendingMessage,
    decision: AssignmentDecision,
    revivalSourceId: string | null
  ): Promise<{
    threadId: string;
    createdThreadId: string | null;
    revivalLink: { oldId: string; newId: string } | null;
  }> {
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

  private async fetchMergeCandidates(): Promise<MergeCandidate[]> {
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
}
