import { expect, test } from "@playwright/test";

type E2EThreadRow = {
  id: string;
  title: string;
  state: string;
  revives_thread_id: string | null;
  continued_in_thread_id: string | null;
};

async function sendMessage(
  page: import("@playwright/test").Page,
  author: string,
  content: string
) {
  await page.getByLabel("Name").fill(author);
  await page.getByLabel("Message").fill(content);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("#composer-status")).toContainText("Sent");
}

async function waitForAssignedMessages(
  page: import("@playwright/test").Page,
  tag: string,
  expected: number
) {
  await expect
    .poll(async () => {
      const rows = page.locator("#messages li").filter({ hasText: tag });
      const count = await rows.count();
      if (count < expected) {
        return -1;
      }

      let assigned = 0;
      for (let i = 0; i < count; i += 1) {
        const text = (await rows.nth(i).textContent()) ?? "";
        if (text.includes("status: assigned")) {
          assigned += 1;
        }
      }

      return assigned;
    })
    .toBe(expected);
}

async function loadTaggedThreads(
  page: import("@playwright/test").Page,
  tag: string
): Promise<E2EThreadRow[]> {
  const response = await page.request.get("/api/threads");
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as { threads: E2EThreadRow[] };
  const normalizedTag = tag.toLowerCase();
  return payload.threads.filter((thread) =>
    thread.title.toLowerCase().includes(normalizedTag)
  );
}

test("archived threads can be revived and discovered in archived search", async ({
  page
}) => {
  const tag = `revive-${Date.now()}`;
  const firstTopic = `${tag} basement hvac compressor fault near lobby`;
  const revivalTopic = `${tag} basement hvac compressor fault resurfaced today`;

  await page.goto("/");

  await sendMessage(page, "alice", firstTopic);
  await waitForAssignedMessages(page, tag, 1);

  await expect
    .poll(
      async () => {
        const threads = page.locator("#threads li").filter({ hasText: tag });
        const count = await threads.count();
        let archived = 0;

        for (let i = 0; i < count; i += 1) {
          const text = ((await threads.nth(i).textContent()) ?? "").toLowerCase();
          if (text.includes("archived")) {
            archived += 1;
          }
        }

        return { count, archived };
      },
      { timeout: 45_000 }
    )
    .toEqual({ count: 1, archived: 1 });

  await sendMessage(page, "bob", revivalTopic);
  await waitForAssignedMessages(page, tag, 2);

  let revivedThreadId = "";
  let supersededThreadId = "";
  await expect
    .poll(
      async () => {
        const threads = await loadTaggedThreads(page, tag);
        if (threads.length !== 2) {
          return false;
        }

        const superseded = threads.find((thread) => thread.state === "superseded");
        if (!superseded) {
          return false;
        }

        const revived = threads.find(
          (thread) =>
            thread.id !== superseded.id &&
            thread.revives_thread_id === superseded.id &&
            superseded.continued_in_thread_id === thread.id
        );
        if (!revived) {
          return false;
        }

        supersededThreadId = superseded.id;
        revivedThreadId = revived.id;
        return true;
      },
      { timeout: 45_000 }
    )
    .toBe(true);

  await page
    .locator(`#threads .thread-link[data-thread-id="${revivedThreadId}"]`)
    .first()
    .click();
  await expect(page.locator("#thread-detail")).toContainText("revives");
  await expect(page.locator("#thread-detail")).toContainText(revivalTopic);

  await page
    .locator(`#thread-detail .thread-link[data-thread-id="${supersededThreadId}"]`)
    .first()
    .click();
  await expect(page.locator("#thread-detail")).toContainText("superseded");
  await expect(page.locator("#thread-detail")).toContainText(firstTopic);

  await page.getByPlaceholder("search archived threads").fill(`${tag} compressor`);
  await page.getByRole("button", { name: "Search" }).click();

  const supersededSearchLink = page.locator(
    `#search-results .thread-link[data-thread-id="${supersededThreadId}"]`
  );
  await expect(supersededSearchLink).toHaveCount(1);
  const supersededSearchItem = supersededSearchLink.locator("xpath=ancestor::li[1]");
  await expect(supersededSearchItem).toContainText("superseded");
});
