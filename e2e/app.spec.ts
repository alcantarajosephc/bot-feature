import { test, expect, type Page } from "@playwright/test";

const ROLES = ["ceo", "pm", "designer", "cto", "security", "dev", "qa", "docs"];

async function submitTicket(page: Page, title: string) {
  await page.goto("/");
  await expect(page.getByTestId("conn")).toHaveText(/live/);
  await page.getByLabel("Ticket title").fill(title);
  await page.getByLabel("Ticket description").fill("Users want greet(name). Empty names greet the world.");
  await page.getByRole("button", { name: "Send to the team" }).click();
  await expect(page.getByTestId("pr-node").getByTestId("ticket-status")).toHaveText(/PR ready/, { timeout: 45_000 });
}

test.describe.configure({ mode: "serial" });

test("canvas shows the whole team, the ticket input and the PR output", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("conn")).toHaveText(/live/);
  for (const r of ROLES) await expect(page.getByTestId(`role-node-${r}`)).toBeVisible();
  await expect(page.getByTestId("ticket-form")).toBeVisible();
  await expect(page.getByTestId("pr-node")).toBeVisible();
  await expect(page.getByTestId("status-rows").locator("tbody tr")).toHaveCount(8);
});

test("a ticket flows through every role to a dry-run PR, with a live team log", async ({ page }) => {
  await submitTicket(page, "Add a greet function");
  const log = page.getByTestId("team-log");
  await expect(log).toContainText("handed off to Product Manager");
  await expect(log).toContainText("Automated test gate passed");
  await expect(log).toContainText("Dry run: PR text prepared");

  await page.getByTestId("view-pr").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Team decisions");
  for (const h of ["CEO (Marlow)", "Product Manager (Priya)", "Designer (Juno)", "CTO (Theo)", "Security (Vera)", "Developer (Kai)", "QA (Ines)", "Docs (Otto)"]) {
    await expect(dialog).toContainText(h);
  }
  await expect(dialog).toContainText("Hello, Ada!");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("a ticket can come from a GitHub issue link, and the PR closes the issue", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("conn")).toHaveText(/live/);
  await page.getByRole("tab", { name: "GitHub issue" }).click();

  // a bad reference explains itself
  await page.getByLabel("GitHub issue").fill("acme/widgets#404");
  await page.getByRole("button", { name: "Load" }).click();
  await expect(page.getByTestId("ticket-form")).toContainText("Could not load acme/widgets#404");
  await expect(page.getByRole("button", { name: "Send to the team" })).toBeDisabled();

  await page.getByLabel("GitHub issue").fill("https://github.com/acme/widgets/issues/5");
  await page.getByLabel("GitHub issue").press("Enter");
  const preview = page.getByTestId("issue-preview");
  await expect(preview).toContainText("acme/widgets#5");
  await expect(preview).toContainText("Add a greet function");

  await page.getByRole("button", { name: "Send to the team" }).click();
  const pr = page.getByTestId("pr-node");
  await expect(pr).toContainText("from acme/widgets#5");
  await expect(pr.getByTestId("ticket-status")).toHaveText(/PR ready/, { timeout: 45_000 });
  await page.getByTestId("view-pr").click();
  await expect(page.getByRole("dialog")).toContainText("Closes acme/widgets#5");
  await page.keyboard.press("Escape");

  // the manual option is still there
  await page.getByRole("tab", { name: "Write" }).click();
  await expect(page.getByLabel("Ticket title")).toBeVisible();
});

test("clicking a role on the canvas shows its output for the current ticket", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("role-node-qa").click();
  const panel = page.getByTestId("role-panel");
  await expect(panel).toContainText("Ines");
  await expect(panel.getByTestId("role-run").first()).toContainText("All criteria pass.");
  await expect(panel).toContainText("AC-1");
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toBeHidden();
});

test("office view: characters are clickable and open their panel", async ({ page }) => {
  await page.goto("/office");
  const canvas = page.getByTestId("office-canvas");
  await expect(canvas).toBeVisible();
  await page.waitForFunction(() => (window as unknown as { __office?: { characterBoxes(): unknown[] } }).__office?.characterBoxes().length === 8);
  const box = await page.evaluate(() => {
    const b = (window as unknown as { __office: { characterBoxes(): { id: string; x: number; y: number; w: number; h: number }[] } }).__office
      .characterBoxes()
      .find((h) => h.id === "cto")!;
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  });
  // characters wander, so click where the CTO is right now (freeze by clicking immediately)
  await canvas.click({ position: box });
  const panel = page.getByTestId("role-panel");
  await expect(panel).toContainText("Theo");
  await expect(panel).toContainText("CTO");
  await panel.getByRole("button", { name: "Close" }).click();

  await page.getByTestId("office-chip-security").click();
  await expect(panel).toContainText("Vera");
  await expect(panel.getByTestId("role-run")).toHaveCount(2); // plan review + diff review
});

test("history lists tickets and shows every role's output, cost and PR text", async ({ page }) => {
  await page.goto("/history");
  const rows = page.getByTestId("history-row");
  await expect(rows.first()).toContainText("Add a greet function");
  await expect(rows.first()).toContainText("PR ready");
  await rows.first().click();
  const detail = page.getByTestId("ticket-detail");
  await expect(detail).toContainText("tokens");
  await expect(page.getByTestId("detail-run")).toHaveCount(9);
  await page.getByRole("tab", { name: "PR description" }).click();
  await expect(page.getByTestId("pr-body")).toContainText("Automated test gate");
});

test("settings: save per-role models and keep API keys out of the browser", async ({ page }) => {
  const responses: string[] = [];
  page.on("response", async (r) => {
    if (r.url().includes("/api/")) responses.push(await r.text().catch(() => ""));
  });
  await page.goto("/settings");
  await expect(page.getByTestId("repo-checks")).toContainText("Git repository found");
  await page.getByLabel("Model for CEO").fill("claude-sonnet-5-5");
  await page.getByTestId("save-settings").click();
  await expect(page.getByText("Settings saved.")).toBeVisible();

  await page.getByLabel("Anthropic API key").fill("sk-ant-e2e-secret-123");
  await page.getByRole("button", { name: "Store key" }).click();
  await expect(page.getByTestId("secret-status")).toHaveText(/stored/);

  await page.reload();
  await expect(page.getByLabel("Model for CEO")).toHaveValue("claude-sonnet-5-5");
  await expect(page.getByTestId("secret-status")).toHaveText(/stored/);
  await expect(page.getByLabel("Anthropic API key")).toHaveValue("");
  expect(responses.join("\n")).not.toContain("sk-ant-e2e-secret-123");

  await page.goto("/");
  await page.getByTestId("role-node-ceo").click();
  await expect(page.getByTestId("role-panel")).toContainText("claude-sonnet-5-5");
});

test("ticket actions sit in the toolbar of both Canvas and Office: cancel, then retry", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("conn")).toHaveText(/live/);
  await page.getByLabel("Ticket title").fill("Add a greet function (retry test)");
  await page.getByRole("button", { name: "Send to the team" }).click();
  const toolbar = page.getByTestId("toolbar");
  await toolbar.getByRole("button", { name: "Cancel" }).click();
  await expect(toolbar.getByTestId("ticket-status")).toHaveText("Cancelled");

  await page.getByRole("link", { name: "Office" }).click();
  const officeBar = page.getByTestId("toolbar");
  await expect(officeBar.getByTestId("ticket-status")).toHaveText("Cancelled");
  await officeBar.getByRole("button", { name: "Retry" }).click();
  await expect(officeBar.getByTestId("ticket-status")).toHaveText(/PR ready/, { timeout: 45_000 });
  await expect(officeBar.getByRole("button", { name: "Retry" })).toBeHidden();
});

test("a follow-up change request reruns Dev onward on the same ticket and shows as a revision", async ({ page }) => {
  await page.goto("/");
  const toolbar = page.getByTestId("toolbar");
  await expect(toolbar.getByTestId("ticket-status")).toHaveText(/PR ready/);
  await toolbar.getByRole("button", { name: "Follow up" }).click();

  const dialog = page.getByRole("dialog");
  // a dry-run ticket has no PR on GitHub, so there are no review comments to address
  await expect(dialog.getByRole("radio", { name: "Address review comments" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Send follow-up" })).toBeDisabled();
  await dialog.getByLabel("Follow-up details").fill("Also trim spaces around names.");
  await dialog.getByRole("button", { name: "Send follow-up" }).click();
  await expect(dialog).toBeHidden();

  await expect(toolbar.getByTestId("ticket-status")).toHaveText(/Running|Queued/);
  await expect(toolbar.getByTestId("ticket-status")).toHaveText(/PR ready/, { timeout: 45_000 });

  await page.getByRole("link", { name: "History" }).click();
  await page.getByTestId("history-row").first().click();
  const revisions = page.getByTestId("revisions");
  await expect(revisions).toContainText("Revision 1");
  await expect(revisions).toContainText("Also trim spaces around names.");
  await expect(revisions).toContainText("done");
  await expect(page.getByTestId("detail-run").filter({ hasText: "revision 1" })).toHaveCount(4);
  await page.getByRole("tab", { name: "PR description" }).click();
  await expect(page.getByTestId("pr-body")).toContainText("Revision 1: Change request");
});
