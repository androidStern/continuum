import type {
  AssignmentDecision,
  MergeDecision,
  ThreadCandidate
} from "./types";

export interface PendingMessage {
  id: string;
  created_at: string;
  author: string;
  content: string;
}

export interface ArchivedCandidate {
  id: string;
  title: string;
  recent_excerpt: string;
}

export interface MergeCandidate {
  id: string;
  title: string;
  state: "active" | "cooling";
  last_message_at: string | null;
  recent_excerpt: string;
}

export interface ThreadingDecider {
  readonly enabled: boolean;

  decideAssignment(
    message: { author: string; content: string; created_at: string },
    candidates: ThreadCandidate[]
  ): Promise<AssignmentDecision>;

  decideRevivalLink(
    message: { author: string; content: string; created_at: string },
    candidates: ArchivedCandidate[]
  ): Promise<{ archivedThreadId: string | null; confidence: number }>;

  decideMerge(
    source: MergeCandidate,
    target: MergeCandidate
  ): Promise<MergeDecision>;
}

export type DecisionMode = "strict_ai" | "ai_with_fallback" | "heuristic_only";

interface ThreadingCoreOptions {
  mode?: DecisionMode;
  logger?: Pick<Console, "error">;
}

export interface MergePlan {
  source: MergeCandidate;
  target: MergeCandidate;
  sourceThreadId: string;
  targetThreadId: string;
  shouldMerge: boolean;
  reason: string;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "we",
  "with",
  "you"
]);

function tokenize(input: string): Set<string> {
  return new Set(
    input
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }

  return intersection / (a.size + b.size - intersection);
}

function normalizeAssignmentDecision(
  decision: AssignmentDecision,
  candidates: ThreadCandidate[],
  fallbackTitle: string
): AssignmentDecision {
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));

  if (
    decision.action === "assign" &&
    decision.threadId &&
    candidateIds.has(decision.threadId) &&
    decision.confidence >= 0.45
  ) {
    return decision;
  }

  return {
    action: "create",
    threadId: null,
    title: decision.title ?? fallbackTitle,
    confidence: decision.confidence ?? 0.5,
    reason: decision.reason || "No clear active thread match."
  };
}

export function scoreSimilarity(textA: string, textB: string): number {
  return jaccard(tokenize(textA), tokenize(textB));
}

export function buildTitle(message: string): string {
  const words = message.trim().split(/\s+/).slice(0, 8);
  const joined = words.join(" ").replace(/[^\w\s-]/g, "").trim();
  if (!joined) {
    return "Untitled discussion";
  }

  const withFirstUpper = joined.charAt(0).toUpperCase() + joined.slice(1);
  return withFirstUpper.length > 96
    ? `${withFirstUpper.slice(0, 93).trim()}...`
    : withFirstUpper;
}

export class ThreadingCore {
  private readonly mode: DecisionMode;
  private readonly logger: Pick<Console, "error">;

  constructor(
    private readonly decider: ThreadingDecider,
    options: ThreadingCoreOptions = {}
  ) {
    this.mode = options.mode ?? "ai_with_fallback";
    this.logger = options.logger ?? console;
  }

  async decideAssignment(
    pending: PendingMessage,
    candidates: ThreadCandidate[]
  ): Promise<AssignmentDecision> {
    const defaultTitle = buildTitle(pending.content);
    const messageForAI = {
      author: pending.author,
      content: pending.content,
      created_at: pending.created_at
    };

    if (candidates.length === 0) {
      return {
        action: "create",
        threadId: null,
        title: defaultTitle,
        confidence: 1,
        reason: "First thread in the system."
      };
    }

    if (this.mode === "heuristic_only") {
      return this.fallbackAssignment(pending, candidates, defaultTitle);
    }

    if (!this.decider.enabled) {
      if (this.mode === "strict_ai") {
        throw new Error(
          "Strict AI mode requires an enabled AI decider (missing API configuration)."
        );
      }
      return this.fallbackAssignment(pending, candidates, defaultTitle);
    }

    try {
      const aiDecision = await this.decider.decideAssignment(
        messageForAI,
        candidates
      );
      return normalizeAssignmentDecision(aiDecision, candidates, defaultTitle);
    } catch (error) {
      if (this.mode === "strict_ai") {
        throw new Error(
          `AI assignment failed in strict mode: ${String(error)}`
        );
      }
      this.logger.error("AI assignment failed, using heuristic", error);
      return this.fallbackAssignment(pending, candidates, defaultTitle);
    }
  }

  async decideRevivalSource(
    pending: PendingMessage,
    candidates: ArchivedCandidate[]
  ): Promise<string | null> {
    if (candidates.length === 0) {
      return null;
    }

    const messageForAI = {
      author: pending.author,
      content: pending.content,
      created_at: pending.created_at
    };

    if (this.mode === "heuristic_only") {
      return this.fallbackRevivalSource(pending, candidates);
    }

    if (!this.decider.enabled) {
      if (this.mode === "strict_ai") {
        throw new Error(
          "Strict AI mode requires an enabled AI decider (missing API configuration)."
        );
      }
      return this.fallbackRevivalSource(pending, candidates);
    }

    try {
      const aiDecision = await this.decider.decideRevivalLink(
        messageForAI,
        candidates
      );
      if (
        aiDecision.archivedThreadId &&
        aiDecision.confidence >= 0.62 &&
        candidates.some((row) => row.id === aiDecision.archivedThreadId)
      ) {
        return aiDecision.archivedThreadId;
      }

      if (this.mode === "strict_ai") {
        return null;
      }
    } catch (error) {
      if (this.mode === "strict_ai") {
        throw new Error(`AI revival decision failed in strict mode: ${String(error)}`);
      }
      this.logger.error("AI revival link decision failed, using heuristic", error);
    }

    return this.fallbackRevivalSource(pending, candidates);
  }

  async decideMerge(candidates: MergeCandidate[]): Promise<MergePlan | null> {
    const pair = this.findMergePair(candidates);
    if (!pair) {
      return null;
    }

    let shouldMerge = pair.score >= 0.78;
    let sourceThreadId = pair.source.id;
    let targetThreadId = pair.target.id;
    let reason = "Heuristic merge score";

    if (this.mode !== "heuristic_only") {
      if (!this.decider.enabled) {
        if (this.mode === "strict_ai") {
          throw new Error(
            "Strict AI mode requires an enabled AI decider (missing API configuration)."
          );
        }
      } else {
        try {
          const decision = await this.decider.decideMerge(pair.source, pair.target);
          shouldMerge = decision.shouldMerge && decision.confidence >= 0.6;
          sourceThreadId = decision.sourceThreadId;
          targetThreadId = decision.targetThreadId;
          reason = decision.reason;
        } catch (error) {
          if (this.mode === "strict_ai") {
            throw new Error(`AI merge decision failed in strict mode: ${String(error)}`);
          }
          this.logger.error("AI merge decision failed, using heuristic", error);
        }
      }
    }

    const validIds = new Set([pair.source.id, pair.target.id]);
    const hasInvalidMergeIds =
      !validIds.has(sourceThreadId) || !validIds.has(targetThreadId);
    if (hasInvalidMergeIds) {
      if (this.mode === "strict_ai") {
        throw new Error(
          `AI merge decision returned invalid thread ids in strict mode (source=${sourceThreadId}, target=${targetThreadId}, expected one of ${pair.source.id} or ${pair.target.id}).`
        );
      }
      sourceThreadId = pair.source.id;
      targetThreadId = pair.target.id;
    }
    if (sourceThreadId === targetThreadId) {
      if (this.mode === "strict_ai") {
        throw new Error(
          `AI merge decision returned identical source and target ids in strict mode (${sourceThreadId}).`
        );
      }
      shouldMerge = false;
    }

    return {
      source: pair.source,
      target: pair.target,
      sourceThreadId,
      targetThreadId,
      shouldMerge,
      reason
    };
  }

  private fallbackAssignment(
    pending: PendingMessage,
    candidates: ThreadCandidate[],
    defaultTitle: string
  ): AssignmentDecision {
    const messageText = `${pending.content}`;
    let best: { id: string; score: number } | null = null;

    for (const candidate of candidates) {
      const score = scoreSimilarity(
        messageText,
        `${candidate.title} ${candidate.recent_excerpt}`
      );
      if (!best || score > best.score) {
        best = { id: candidate.id, score };
      }
    }

    if (best && best.score >= 0.26) {
      return {
        action: "assign",
        threadId: best.id,
        title: null,
        confidence: Math.min(1, best.score + 0.25),
        reason: "Heuristic token overlap matched an existing thread."
      };
    }

    return {
      action: "create",
      threadId: null,
      title: defaultTitle,
      confidence: 0.62,
      reason: "No strong overlap with existing active threads."
    };
  }

  private fallbackRevivalSource(
    pending: PendingMessage,
    candidates: ArchivedCandidate[]
  ): string | null {
    let best: { id: string; score: number } | null = null;

    for (const candidate of candidates) {
      const score = scoreSimilarity(
        pending.content,
        `${candidate.title} ${candidate.recent_excerpt}`
      );
      if (!best || score > best.score) {
        best = { id: candidate.id, score };
      }
    }

    if (best && best.score >= 0.31) {
      return best.id;
    }

    return null;
  }

  private findMergePair(candidates: MergeCandidate[]): {
    source: MergeCandidate;
    target: MergeCandidate;
    score: number;
  } | null {
    let best: { source: MergeCandidate; target: MergeCandidate; score: number } | null =
      null;

    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        const first = candidates[i];
        const second = candidates[j];
        const score = scoreSimilarity(
          `${first.title} ${first.recent_excerpt}`,
          `${second.title} ${second.recent_excerpt}`
        );
        if (!best || score > best.score) {
          best = { source: first, target: second, score };
        }
      }
    }

    if (!best || best.score < 0.58) {
      return null;
    }

    return best;
  }
}
