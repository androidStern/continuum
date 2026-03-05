import type { ArchivedCandidate, MergeCandidate, PendingMessage } from "./threading-core";
import { ThreadingCore } from "./threading-core";
import type { AssignmentDecision, ThreadCandidate } from "./types";

export interface AppliedAssignment {
  threadId: string;
  createdThreadId: string | null;
  revivalLink: { oldId: string; newId: string } | null;
}

export interface ThreadingLifecycleTransition {
  cooledThreadIds: string[];
  archivedThreadIds: string[];
}

export interface ThreadingStore {
  claimPendingMessage(): Promise<PendingMessage | null>;
  markAssignmentFailed(messageId: string, note: string): Promise<void>;

  fetchActiveThreadCandidates(): Promise<ThreadCandidate[]>;
  fetchArchivedThreadCandidates(): Promise<ArchivedCandidate[]>;
  applyAssignment(
    pending: PendingMessage,
    decision: AssignmentDecision,
    revivalSourceId: string | null
  ): Promise<AppliedAssignment>;

  fetchMergeCandidates(): Promise<MergeCandidate[]>;
  applyMerge(sourceThreadId: string, targetThreadId: string): Promise<boolean>;

  transitionLifecycle(): Promise<ThreadingLifecycleTransition>;
}

export interface ThreadingEventSink {
  onMessageUpdated(payload: {
    id: string;
    thread_id?: string;
    assignment_status: "assigned" | "failed";
    assignment_note: string | null;
  }): void;
  onThreadCreated(payload: { id: string }): void;
  onThreadUpdated(payload: { id: string }): void;
  onThreadMerged(payload: { sourceThreadId: string; targetThreadId: string }): void;
}

interface ThreadingRuntimeOptions {
  logger?: Pick<Console, "error">;
}

const NOOP_EVENTS: ThreadingEventSink = {
  onMessageUpdated: () => {},
  onThreadCreated: () => {},
  onThreadUpdated: () => {},
  onThreadMerged: () => {}
};

const ASSIGNMENT_FAILURE_NOTE = "Assignment failed. Check server logs.";

export class ThreadingRuntime {
  private readonly logger: Pick<Console, "error">;

  constructor(
    private readonly core: ThreadingCore,
    private readonly store: ThreadingStore,
    private readonly events: ThreadingEventSink = NOOP_EVENTS,
    options: ThreadingRuntimeOptions = {}
  ) {
    this.logger = options.logger ?? console;
  }

  async runAssignmentDrain(): Promise<number> {
    let processed = 0;
    while (await this.processSinglePendingMessage()) {
      processed += 1;
    }
    return processed;
  }

  async processSinglePendingMessage(): Promise<boolean> {
    const pending = await this.store.claimPendingMessage();
    if (!pending) {
      return false;
    }

    try {
      const candidates = await this.store.fetchActiveThreadCandidates();
      const decision = await this.core.decideAssignment(pending, candidates);
      let revivalSourceId: string | null = null;
      if (decision.action === "create") {
        const archived = await this.store.fetchArchivedThreadCandidates();
        revivalSourceId = await this.core.decideRevivalSource(pending, archived);
      }

      const assignment = await this.store.applyAssignment(
        pending,
        decision,
        revivalSourceId
      );
      this.events.onMessageUpdated({
        id: pending.id,
        thread_id: assignment.threadId,
        assignment_status: "assigned",
        assignment_note: decision.reason
      });

      if (assignment.createdThreadId) {
        this.events.onThreadCreated({
          id: assignment.createdThreadId
        });
      }
      this.events.onThreadUpdated({ id: assignment.threadId });

      if (assignment.revivalLink) {
        this.events.onThreadUpdated({ id: assignment.revivalLink.oldId });
        this.events.onThreadUpdated({ id: assignment.revivalLink.newId });
      }

      return true;
    } catch (error) {
      this.logger.error("processSinglePendingMessage failed", error);
      await this.store.markAssignmentFailed(pending.id, ASSIGNMENT_FAILURE_NOTE);
      this.events.onMessageUpdated({
        id: pending.id,
        assignment_status: "failed",
        assignment_note: ASSIGNMENT_FAILURE_NOTE
      });
      return true;
    }
  }

  async runMergeCycle(): Promise<boolean> {
    const candidates = await this.store.fetchMergeCandidates();
    const plan = await this.core.decideMerge(candidates);
    if (!plan || !plan.shouldMerge) {
      return false;
    }

    let sourceThreadId = plan.sourceThreadId;
    let targetThreadId = plan.targetThreadId;

    const pairById = new Map([
      [plan.source.id, plan.source],
      [plan.target.id, plan.target]
    ]);
    const sourceMeta = pairById.get(sourceThreadId);
    const targetMeta = pairById.get(targetThreadId);
    if (sourceMeta && targetMeta) {
      const sourceLast = sourceMeta.last_message_at ?? "";
      const targetLast = targetMeta.last_message_at ?? "";
      if (sourceLast > targetLast) {
        const originalTarget = targetThreadId;
        targetThreadId = sourceThreadId;
        sourceThreadId = originalTarget;
      }
    }

    if (sourceThreadId === targetThreadId) {
      return false;
    }

    const merged = await this.store.applyMerge(sourceThreadId, targetThreadId);
    if (!merged) {
      return false;
    }

    this.events.onThreadMerged({
      sourceThreadId,
      targetThreadId
    });
    this.events.onThreadUpdated({ id: sourceThreadId });
    this.events.onThreadUpdated({ id: targetThreadId });
    return true;
  }

  async runLifecycleCycle(): Promise<ThreadingLifecycleTransition> {
    const transitions = await this.store.transitionLifecycle();
    for (const id of transitions.cooledThreadIds) {
      this.events.onThreadUpdated({ id });
    }
    for (const id of transitions.archivedThreadIds) {
      this.events.onThreadUpdated({ id });
    }
    return transitions;
  }
}
