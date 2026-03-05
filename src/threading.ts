import { Pool } from "pg";

import { AIDecider } from "./ai";
import { config } from "./config";
import { PostgresThreadingStore } from "./postgres-threading-store";
import { RealtimeHub } from "./realtime";
import { ThreadingCore } from "./threading-core";
import { ThreadingRuntime, type ThreadingEventSink } from "./threading-engine";

class RealtimeThreadingEvents implements ThreadingEventSink {
  constructor(private readonly realtimeHub: RealtimeHub) {}

  onMessageUpdated(payload: {
    id: string;
    thread_id?: string;
    assignment_status: "assigned" | "failed";
    assignment_note: string | null;
  }): void {
    this.realtimeHub.broadcast("message.updated", payload);
  }

  onThreadCreated(payload: { id: string }): void {
    this.realtimeHub.broadcast("thread.created", payload);
  }

  onThreadUpdated(payload: { id: string }): void {
    this.realtimeHub.broadcast("thread.updated", payload);
  }

  onThreadMerged(payload: { sourceThreadId: string; targetThreadId: string }): void {
    this.realtimeHub.broadcast("thread.merged", payload);
  }
}

export class ThreadingEngine {
  private readonly runtime: ThreadingRuntime;

  private assignmentLoopBusy = false;
  private lifecycleLoopBusy = false;
  private mergeLoopBusy = false;

  constructor(pool: Pool, realtimeHub: RealtimeHub) {
    const ai = new AIDecider();
    const core = new ThreadingCore(ai, {
      mode: "ai_with_fallback"
    });
    const store = new PostgresThreadingStore(pool);
    const events = new RealtimeThreadingEvents(realtimeHub);
    this.runtime = new ThreadingRuntime(core, store, events);
  }

  start(): void {
    setInterval(() => void this.assignmentTick(), config.ASSIGNMENT_POLL_MS);
    setInterval(() => void this.lifecycleTick(), 10_000);
    setInterval(() => void this.mergeTick(), config.MERGE_POLL_MS);
    void this.assignmentTick();
    void this.lifecycleTick();
    void this.mergeTick();
  }

  private async assignmentTick(): Promise<void> {
    if (this.assignmentLoopBusy) {
      return;
    }

    this.assignmentLoopBusy = true;
    try {
      await this.runtime.runAssignmentDrain();
    } catch (error) {
      console.error("assignmentTick failed", error);
    } finally {
      this.assignmentLoopBusy = false;
    }
  }

  private async lifecycleTick(): Promise<void> {
    if (this.lifecycleLoopBusy) {
      return;
    }

    this.lifecycleLoopBusy = true;
    try {
      await this.runtime.runLifecycleCycle();
    } catch (error) {
      console.error("lifecycleTick failed", error);
    } finally {
      this.lifecycleLoopBusy = false;
    }
  }

  private async mergeTick(): Promise<void> {
    if (this.mergeLoopBusy) {
      return;
    }

    this.mergeLoopBusy = true;
    try {
      await this.runtime.runMergeCycle();
    } catch (error) {
      console.error("mergeTick failed", error);
    } finally {
      this.mergeLoopBusy = false;
    }
  }
}
