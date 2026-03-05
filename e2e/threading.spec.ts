import { expect, test } from "@playwright/test";

async function sendMessage(page: import("@playwright/test").Page, author: string, content: string) {
  await page.getByLabel("Name").fill(author);
  await page.getByLabel("Message").fill(content);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("#composer-status")).toContainText("Sent");
}

async function readTaggedMessages(
  page: import("@playwright/test").Page,
  tag: string
): Promise<
  Array<{
    id: string;
    content: string;
    assignment_status: string;
    thread_id: string | null;
  }>
> {
  const response = await page.request.get("/api/messages?limit=200");
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  return (payload.messages as Array<{
    id: string;
    content: string;
    assignment_status: string;
    thread_id: string | null;
  }>).filter((message) => message.content.includes(tag));
}

test("live messages are organized into the expected threads", async ({ page }) => {
  const tag = `e2e-${Date.now()}`;
  const firstTopic = `${tag} printer jammed near kitchen hall`;
  const secondTopic = `${tag} printer still jammed near kitchen hall`;
  const thirdTopic = `${tag} sushi lunch plan for friday noon`;

  await page.goto("/");

  await sendMessage(page, "alice", firstTopic);
  await sendMessage(page, "bob", secondTopic);
  await sendMessage(page, "charlie", thirdTopic);

  await expect
    .poll(async () => {
      const tagged = await readTaggedMessages(page, tag);
      return tagged.filter((message) => message.assignment_status === "assigned").length;
    })
    .toBe(3);

  const tagged = await readTaggedMessages(page, tag);
  const firstMessage = tagged.find((message) => message.content === firstTopic);
  const secondMessage = tagged.find((message) => message.content === secondTopic);
  const thirdMessage = tagged.find((message) => message.content === thirdTopic);

  expect(firstMessage).toBeDefined();
  expect(secondMessage).toBeDefined();
  expect(thirdMessage).toBeDefined();
  expect(firstMessage?.thread_id).toBeTruthy();
  expect(secondMessage?.thread_id).toBeTruthy();
  expect(thirdMessage?.thread_id).toBeTruthy();
  expect(firstMessage?.thread_id).toBe(secondMessage?.thread_id);
  expect(firstMessage?.thread_id).not.toBe(thirdMessage?.thread_id);

  const printerThreadId = firstMessage?.thread_id as string;
  const lunchThreadId = thirdMessage?.thread_id as string;

  await expect
    .poll(async () => {
      const response = await page.request.get("/api/threads");
      expect(response.ok()).toBeTruthy();
      const payload = await response.json();
      const rows = payload.threads as Array<{ id: string; message_count: number }>;
      const printer = rows.find((row) => row.id === printerThreadId);
      const lunch = rows.find((row) => row.id === lunchThreadId);
      return {
        printerMessages: printer?.message_count ?? 0,
        lunchMessages: lunch?.message_count ?? 0
      };
    })
    .toEqual({ printerMessages: 2, lunchMessages: 1 });

  await page.locator(`.thread-link[data-thread-id="${printerThreadId}"]`).first().click();
  await expect(page.locator("#thread-detail")).toContainText(firstTopic);
  await expect(page.locator("#thread-detail")).toContainText(secondTopic);
  await expect(page.locator("#thread-detail")).not.toContainText(thirdTopic);

  await page.locator(`.thread-link[data-thread-id="${lunchThreadId}"]`).first().click();
  await expect(page.locator("#thread-detail")).toContainText(thirdTopic);
  await expect(page.locator("#thread-detail")).not.toContainText(firstTopic);
});
