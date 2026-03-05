import { expect, test } from "@playwright/test";

async function sendMessage(page: import("@playwright/test").Page, author: string, content: string) {
  await page.getByLabel("Name").fill(author);
  await page.getByLabel("Message").fill(content);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("#composer-status")).toContainText("Sent");
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
      const items = page.locator("#messages li").filter({ hasText: tag });
      const count = await items.count();
      if (count < 3) {
        return { count, assigned: 0 };
      }
      let assigned = 0;
      for (let i = 0; i < count; i += 1) {
        const text = (await items.nth(i).textContent()) ?? "";
        if (text.includes("status: assigned")) {
          assigned += 1;
        }
      }
      return { count, assigned };
    })
    .toEqual({ count: 3, assigned: 3 });

  const printerThread = page.locator("#threads li").filter({
    hasText: `${tag} printer`
  });
  const lunchThread = page.locator("#threads li").filter({
    hasText: `${tag} sushi`
  });

  await expect(printerThread).toHaveCount(1);
  await expect(lunchThread).toHaveCount(1);
  await expect(printerThread).toContainText("2 messages");
  await expect(lunchThread).toContainText("1 messages");

  await printerThread.locator(".thread-link").click();
  await expect(page.locator("#thread-detail")).toContainText(firstTopic);
  await expect(page.locator("#thread-detail")).toContainText(secondTopic);
  await expect(page.locator("#thread-detail")).not.toContainText(thirdTopic);

  await lunchThread.locator(".thread-link").click();
  await expect(page.locator("#thread-detail")).toContainText(thirdTopic);
  await expect(page.locator("#thread-detail")).not.toContainText(firstTopic);
});
