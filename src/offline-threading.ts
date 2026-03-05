import { ThreadingCore } from "./threading-core";
import type {
  ArchivedCandidate,
  DecisionMode,
  MergeCandidate,
  PendingMessage,
  ThreadingDecider
} from "./threading-core";
import {
  ThreadingRuntime,
  type AppliedAssignment,
  type ThreadingLifecycleTransition,
  type ThreadingStore
} from "./threading-engine";
import type { AssignmentDecision, ThreadCandidate, ThreadState } from "./types";

export interface OfflineMessageInput {
  id?: string;
  file_key: string;
  line_id: number;
  created_at: string;
  author: string;
  content: string;
}

interface OfflineMessageRecord extends OfflineMessageInput {
  id: string;
  thread_id: string | null;
  assignment_note: string | null;
}

interface OfflineThreadRecord {
  id: string;
  title: string;
  state: ThreadState;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  archived_at: string | null;
  superseded_at: string | null;
  revives_thread_id: string | null;
  continued_in_thread_id: string | null;
  merged_into_thread_id: string | null;
  message_ids: string[];
}

export interface OfflineAssignment {
  message_id: string;
  file_key: string;
  line_id: number;
  thread_id: string;
  created_thread_id: string | null;
  decision: AssignmentDecision;
  revival_source_id: string | null;
}

export interface OfflineThreadingResult {
  messages: OfflineMessageRecord[];
  threads: OfflineThreadRecord[];
  assignments: OfflineAssignment[];
}

export interface OfflineThreadingOptions {
  decisionMode?: DecisionMode;
  activeToCoolingMinutes?: number;
  coolingToArchivedHours?: number;
  maxActiveThreadCandidates?: number;
  maxArchivedThreadCandidates?: number;
  mergeCandidateLimit?: number;
}

interface OfflinePendingMessage extends PendingMessage {
  file_key: string;
  line_id: number;
}

function parseEpochMs(input: string): number {
  const value = Date.parse(input);
  if (Number.isFinite(value)) {
    return value;
  }
  throw new Error(`Invalid timestamp: ${input}`);
}

function compareByRecencyDesc(aIso: string | null, bIso: string | null): number {
  const a = aIso ? parseEpochMs(aIso) : 0;
  const b = bIso ? parseEpochMs(bIso) : 0;
  return b - a;
}

function toISO(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

class OfflineThreadingStore implements ThreadingStore {
  private readonly activeToCoolingMs: number;
  private readonly coolingToArchivedMs: number;
  private readonly maxActiveThreadCandidates: number;
  private readonly maxArchivedThreadCandidates: number;
  private readonly mergeCandidateLimit: number;

  private nextThreadId = 1;
  private readonly queue: OfflinePendingMessage[] = [];
  private readonly pendingById = new Map<string, OfflinePendingMessage>();
  private readonly messages: OfflineMessageRecord[] = [];
  private readonly messageById = new Map<string, OfflineMessageRecord>();
  private readonly threads = new Map<string, OfflineThreadRecord>();
  private readonly assignments: OfflineAssignment[] = [];
  private readonly failures: Array<{ messageId: string; note: string }> = [];

  constructor(options: OfflineThreadingOptions = {}) {
    this.activeToCoolingMs = (options.activeToCoolingMinutes ?? 30) * 60 * 1000;
    this.coolingToArchivedMs = (options.coolingToArchivedHours ?? 72) * 60 * 60 * 1000;
    this.maxActiveThreadCandidates = options.maxActiveThreadCandidates ?? 15;
    this.maxArchivedThreadCandidates = options.maxArchivedThreadCandidates ?? 20;
    this.mergeCandidateLimit = options.mergeCandidateLimit ?? 16;
  }

  load(messages: OfflineMessageInput[]): void {
    this.nextThreadId = 1;
    this.queue.length = 0;
    this.pendingById.clear();
    this.messages.length = 0;
    this.messageById.clear();
    this.threads.clear();
    this.assignments.length = 0;
    this.failures.length = 0;

    const normalized = [...messages]
      .map((message, index) => this.normalizeMessage(message, index))
      .sort((a, b) => {
        const dt = parseEpochMs(a.created_at) - parseEpochMs(b.created_at);
        if (dt !== 0) {
          return dt;
        }
        const fileCmp = a.file_key.localeCompare(b.file_key);
        if (fileCmp !== 0) {
          return fileCmp;
        }
        return a.line_id - b.line_id;
      });

    this.queue.push(...normalized);
    for (const message of normalized) {
      this.pendingById.set(message.id, message);
    }
  }

  result(): OfflineThreadingResult {
    return {
      messages: [...this.messages],
      threads: [...this.threads.values()],
      assignments: [...this.assignments]
    };
  }

  failureCount(): number {
    return this.failures.length;
  }

  firstFailureNote(): string | null {
    return this.failures[0]?.note ?? null;
  }

  async claimPendingMessage(): Promise<PendingMessage | null> {
    const next = this.queue.shift();
    if (!next) {
      return null;
    }
    return next;
  }

  async markAssignmentFailed(messageId: string, note: string): Promise<void> {
    this.failures.push({ messageId, note });
  }

  async fetchActiveThreadCandidates(): Promise<ThreadCandidate[]> {
    const rows = [...this.threads.values()]
      .filter((thread) => thread.state === "active" || thread.state === "cooling")
      .sort((a, b) =>
        compareByRecencyDesc(
          a.last_message_at ?? a.updated_at,
          b.last_message_at ?? b.updated_at
        )
      )
      .slice(0, this.maxActiveThreadCandidates);

    return rows.map((thread) => ({
      id: thread.id,
      title: thread.title,
      state: thread.state === "active" ? "active" : "cooling",
      last_message_at: thread.last_message_at,
      recent_excerpt: this.renderRecentExcerpt(thread, 6)
    }));
  }

  async fetchArchivedThreadCandidates(): Promise<ArchivedCandidate[]> {
    const rows = [...this.threads.values()]
      .filter((thread) => thread.state === "archived")
      .sort((a, b) =>
        compareByRecencyDesc(
          a.last_message_at ?? a.updated_at,
          b.last_message_at ?? b.updated_at
        )
      )
      .slice(0, this.maxArchivedThreadCandidates);

    return rows.map((thread) => ({
      id: thread.id,
      title: thread.title,
      recent_excerpt: this.renderRecentExcerpt(thread, 8)
    }));
  }

  async applyAssignment(
    pending: PendingMessage,
    decision: AssignmentDecision,
    revivalSourceId: string | null
  ): Promise<AppliedAssignment> {
    let threadId: string | null = decision.threadId;
    let createdThreadId: string | null = null;
    let revivalLink: { oldId: string; newId: string } | null = null;

    if (decision.action === "create" || !threadId || !this.threads.has(threadId)) {
      const newThreadId = this.makeThreadId();
      const newThread: OfflineThreadRecord = {
        id: newThreadId,
        title: decision.title ?? "Untitled discussion",
        state: "active",
        created_at: pending.created_at,
        updated_at: pending.created_at,
        last_message_at: pending.created_at,
        archived_at: null,
        superseded_at: null,
        revives_thread_id: null,
        continued_in_thread_id: null,
        merged_into_thread_id: null,
        message_ids: []
      };

      this.threads.set(newThreadId, newThread);
      threadId = newThreadId;
      createdThreadId = newThreadId;

      if (revivalSourceId) {
        const archived = this.threads.get(revivalSourceId);
        if (archived && archived.state === "archived") {
          archived.state = "superseded";
          archived.superseded_at = pending.created_at;
          archived.continued_in_thread_id = newThreadId;
          archived.updated_at = pending.created_at;
          newThread.revives_thread_id = revivalSourceId;
          revivalLink = { oldId: revivalSourceId, newId: newThreadId };
        }
      }
    }

    if (!threadId) {
      throw new Error("Assignment did not produce a thread id");
    }

    const assignedThread = this.threads.get(threadId);
    if (!assignedThread) {
      throw new Error(`Assigned thread does not exist: ${threadId}`);
    }

    const pendingMeta = this.pendingById.get(pending.id);
    if (!pendingMeta) {
      throw new Error(`Missing pending metadata for message ${pending.id}`);
    }

    const messageRecord: OfflineMessageRecord = {
      id: pending.id,
      file_key: pendingMeta.file_key,
      line_id: pendingMeta.line_id,
      created_at: pending.created_at,
      author: pending.author,
      content: pending.content,
      thread_id: threadId,
      assignment_note: decision.reason
    };
    this.messages.push(messageRecord);
    this.messageById.set(messageRecord.id, messageRecord);

    assignedThread.message_ids.push(messageRecord.id);
    assignedThread.state = assignedThread.state === "cooling" ? "active" : assignedThread.state;
    assignedThread.updated_at = pending.created_at;

    const currentLast = assignedThread.last_message_at
      ? parseEpochMs(assignedThread.last_message_at)
      : parseEpochMs(pending.created_at);
    const incoming = parseEpochMs(pending.created_at);
    assignedThread.last_message_at = toISO(Math.max(currentLast, incoming));

    this.assignments.push({
      message_id: pending.id,
      file_key: pendingMeta.file_key,
      line_id: pendingMeta.line_id,
      thread_id: threadId,
      created_thread_id: createdThreadId,
      decision,
      revival_source_id: revivalSourceId
    });

    return {
      threadId,
      createdThreadId,
      revivalLink
    };
  }

  async fetchMergeCandidates(): Promise<MergeCandidate[]> {
    return [...this.threads.values()]
      .filter((thread) => thread.state === "active" || thread.state === "cooling")
      .sort((a, b) =>
        compareByRecencyDesc(
          a.last_message_at ?? a.updated_at,
          b.last_message_at ?? b.updated_at
        )
      )
      .slice(0, this.mergeCandidateLimit)
      .map((thread) => ({
        id: thread.id,
        title: thread.title,
        state: thread.state === "active" ? "active" : "cooling",
        last_message_at: thread.last_message_at,
        recent_excerpt: this.renderRecentExcerpt(thread, 5)
      }));
  }

  async applyMerge(sourceThreadId: string, targetThreadId: string): Promise<boolean> {
    if (sourceThreadId === targetThreadId) {
      return false;
    }

    const source = this.threads.get(sourceThreadId);
    const target = this.threads.get(targetThreadId);
    if (!source || !target) {
      return false;
    }
    if (!(source.state === "active" || source.state === "cooling")) {
      return false;
    }
    if (!(target.state === "active" || target.state === "cooling")) {
      return false;
    }

    const nowIso = toISO(
      Math.max(
        parseEpochMs(source.last_message_at ?? source.updated_at),
        parseEpochMs(target.last_message_at ?? target.updated_at)
      )
    );

    source.state = "superseded";
    source.merged_into_thread_id = target.id;
    source.superseded_at = nowIso;
    source.updated_at = nowIso;

    for (const message of this.messages) {
      if (message.thread_id === source.id) {
        message.thread_id = target.id;
      }
    }

    target.message_ids = [...target.message_ids, ...source.message_ids];
    target.state = "active";
    target.updated_at = nowIso;

    const targetMessageTimes = target.message_ids
      .map((id) => this.messageById.get(id)?.created_at)
      .filter((value): value is string => Boolean(value))
      .map((iso) => parseEpochMs(iso));

    if (targetMessageTimes.length > 0) {
      target.last_message_at = toISO(Math.max(...targetMessageTimes));
    }

    return true;
  }

  async transitionLifecycle(): Promise<ThreadingLifecycleTransition> {
    const nextPending = this.queue[0];
    if (!nextPending) {
      return {
        cooledThreadIds: [],
        archivedThreadIds: []
      };
    }

    return this.applyLifecycleTransitions(nextPending.created_at);
  }

  private normalizeMessage(
    message: OfflineMessageInput,
    index: number
  ): OfflinePendingMessage {
    if (!Number.isInteger(message.line_id) || message.line_id < 0) {
      throw new Error(`line_id must be a non-negative integer: ${message.line_id}`);
    }

    const id = message.id?.trim() || `${message.file_key}:${message.line_id}:${index}`;
    return {
      id,
      file_key: message.file_key,
      line_id: message.line_id,
      created_at: message.created_at,
      author: message.author,
      content: message.content
    };
  }

  private applyLifecycleTransitions(nowIso: string): ThreadingLifecycleTransition {
    const nowMs = parseEpochMs(nowIso);
    const cooledThreadIds: string[] = [];
    const archivedThreadIds: string[] = [];

    for (const thread of this.threads.values()) {
      if (!thread.last_message_at) {
        continue;
      }
      const lastMs = parseEpochMs(thread.last_message_at);

      if (thread.state === "active" && nowMs - lastMs >= this.activeToCoolingMs) {
        thread.state = "cooling";
        thread.updated_at = nowIso;
        cooledThreadIds.push(thread.id);
      }

      if (thread.state === "cooling" && nowMs - lastMs >= this.coolingToArchivedMs) {
        thread.state = "archived";
        thread.archived_at = thread.archived_at ?? nowIso;
        thread.updated_at = nowIso;
        archivedThreadIds.push(thread.id);
      }
    }

    return {
      cooledThreadIds,
      archivedThreadIds
    };
  }

  private renderRecentExcerpt(thread: OfflineThreadRecord, limit: number): string {
    const items = [...thread.message_ids]
      .map((id) => this.messageById.get(id))
      .filter((message): message is OfflineMessageRecord => Boolean(message))
      .sort((a, b) => parseEpochMs(b.created_at) - parseEpochMs(a.created_at))
      .slice(0, limit)
      .map((message) => message.content);

    return items.join("\n");
  }

  private makeThreadId(): string {
    const value = this.nextThreadId;
    this.nextThreadId += 1;
    return `thread-${value.toString().padStart(6, "0")}`;
  }
}

export class OfflineThreadingSystem {
  private readonly runtime: ThreadingRuntime;
  private readonly store: OfflineThreadingStore;

  constructor(decider: ThreadingDecider, options: OfflineThreadingOptions = {}) {
    const core = new ThreadingCore(decider, {
      mode: options.decisionMode ?? "strict_ai"
    });
    this.store = new OfflineThreadingStore(options);
    this.runtime = new ThreadingRuntime(core, this.store);
  }

  async run(messages: OfflineMessageInput[]): Promise<OfflineThreadingResult> {
    this.store.load(messages);

    while (true) {
      await this.runtime.runLifecycleCycle();
      const processed = await this.runtime.processSinglePendingMessage();
      if (!processed) {
        break;
      }
      await this.runtime.runMergeCycle();
    }

    if (this.store.failureCount() > 0) {
      throw new Error(
        this.store.firstFailureNote() ??
          "Offline threading run encountered assignment failures"
      );
    }

    return this.store.result();
  }
}
