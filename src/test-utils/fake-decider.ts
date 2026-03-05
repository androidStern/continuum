import {
  buildTitle,
  type ArchivedCandidate,
  type MergeCandidate,
  type ThreadingDecider
} from "../threading-core";
import type { AssignmentDecision, MergeDecision, ThreadCandidate } from "../types";

type AssignmentInput = {
  author: string;
  content: string;
  created_at: string;
};

type RevivalDecision = {
  archivedThreadId: string | null;
  confidence: number;
};

type AssignmentResponder = (
  message: AssignmentInput,
  candidates: ThreadCandidate[]
) => AssignmentDecision | Promise<AssignmentDecision>;

type RevivalResponder = (
  message: AssignmentInput,
  candidates: ArchivedCandidate[]
) => RevivalDecision | Promise<RevivalDecision>;

type MergeResponder = (
  source: MergeCandidate,
  target: MergeCandidate
) => MergeDecision | Promise<MergeDecision>;

export interface FakeDeciderOptions {
  enabled?: boolean;
  decideAssignment?: AssignmentResponder;
  decideRevivalLink?: RevivalResponder;
  decideMerge?: MergeResponder;
}

export class FakeDecider implements ThreadingDecider {
  readonly enabled: boolean;
  readonly calls = {
    assignment: 0,
    revival: 0,
    merge: 0
  };

  constructor(private readonly options: FakeDeciderOptions = {}) {
    this.enabled = options.enabled ?? true;
  }

  async decideAssignment(
    message: AssignmentInput,
    candidates: ThreadCandidate[]
  ): Promise<AssignmentDecision> {
    this.calls.assignment += 1;

    if (this.options.decideAssignment) {
      return this.options.decideAssignment(message, candidates);
    }

    if (candidates.length > 0) {
      return {
        action: "assign",
        threadId: candidates[0].id,
        title: null,
        confidence: 1,
        reason: "Fake decider default: assign to the newest candidate."
      };
    }

    return {
      action: "create",
      threadId: null,
      title: buildTitle(message.content),
      confidence: 1,
      reason: "Fake decider default: create when no candidates exist."
    };
  }

  async decideRevivalLink(
    message: AssignmentInput,
    candidates: ArchivedCandidate[]
  ): Promise<RevivalDecision> {
    this.calls.revival += 1;

    if (this.options.decideRevivalLink) {
      return this.options.decideRevivalLink(message, candidates);
    }

    return {
      archivedThreadId: null,
      confidence: 0
    };
  }

  async decideMerge(
    source: MergeCandidate,
    target: MergeCandidate
  ): Promise<MergeDecision> {
    this.calls.merge += 1;

    if (this.options.decideMerge) {
      return this.options.decideMerge(source, target);
    }

    return {
      shouldMerge: false,
      sourceThreadId: source.id,
      targetThreadId: target.id,
      confidence: 0,
      reason: "Fake decider default: do not merge."
    };
  }
}
