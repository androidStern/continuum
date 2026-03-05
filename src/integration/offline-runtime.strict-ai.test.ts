import assert from "node:assert/strict";
import test from "node:test";

import {
  OfflineThreadingSystem,
  type OfflineMessageInput
} from "../offline-threading";
import { FakeDecider } from "../test-utils/fake-decider";

function buildMessages(tag: string): OfflineMessageInput[] {
  return [
    {
      id: `${tag}-1`,
      file_key: "fixtures",
      line_id: 1,
      created_at: "2025-01-01T00:00:00.000Z",
      author: "alice",
      content: `${tag} cache latency spike on api gateway`
    },
    {
      id: `${tag}-2`,
      file_key: "fixtures",
      line_id: 2,
      created_at: "2025-01-01T00:01:00.000Z",
      author: "bob",
      content: `${tag} cache latency spike on api gateway again`
    }
  ];
}

test("strict_ai fails fast when merge ids are invalid", async () => {
  let threadNumber = 0;
  const decider = new FakeDecider({
    decideAssignment: () => {
      threadNumber += 1;
      return {
        action: "create",
        threadId: null,
        title: `Forced thread ${threadNumber}`,
        confidence: 0.95,
        reason: "Test setup forces separate threads."
      };
    },
    decideMerge: () => {
      return {
        shouldMerge: true,
        sourceThreadId: "invalid-source-id",
        targetThreadId: "invalid-target-id",
        confidence: 0.99,
        reason: "Intentional invalid ids for strict-mode guard coverage."
      };
    }
  });

  const system = new OfflineThreadingSystem(decider, {
    decisionMode: "strict_ai"
  });

  await assert.rejects(
    () => system.run(buildMessages("strict-merge")),
    /AI merge decision returned invalid thread ids in strict mode/i
  );
  assert.ok(decider.calls.merge >= 1, "expected merge decision to be evaluated");
});

test("ai_with_fallback continues when merge ids are invalid", async () => {
  let threadNumber = 0;
  const decider = new FakeDecider({
    decideAssignment: () => {
      threadNumber += 1;
      return {
        action: "create",
        threadId: null,
        title: `Forced thread ${threadNumber}`,
        confidence: 0.95,
        reason: "Test setup forces separate threads."
      };
    },
    decideMerge: () => {
      return {
        shouldMerge: true,
        sourceThreadId: "bad-source-id",
        targetThreadId: "bad-target-id",
        confidence: 0.99,
        reason: "Intentional invalid ids to verify fallback sanitization."
      };
    }
  });

  const system = new OfflineThreadingSystem(decider, {
    decisionMode: "ai_with_fallback"
  });

  const result = await system.run(buildMessages("fallback-merge"));
  assert.equal(result.messages.length, 2);
  assert.equal(result.assignments.length, 2);
  assert.ok(decider.calls.merge >= 1, "expected merge decision to be evaluated");

  const supersededThreads = result.threads.filter((thread) => thread.state === "superseded");
  const remainingThreads = result.threads.filter((thread) => thread.state !== "superseded");
  assert.equal(
    supersededThreads.length,
    1,
    "fallback should preserve merge by sanitizing invalid ids"
  );
  assert.equal(remainingThreads.length, 1);
  for (const message of result.messages) {
    assert.equal(message.thread_id, remainingThreads[0].id);
  }
});
