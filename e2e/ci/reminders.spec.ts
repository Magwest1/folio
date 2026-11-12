import { expect, test, type APIRequestContext } from "@playwright/test";

const DEFAULTS = {
  level: "gentle",
  quietHours: { enabled: true, start: "21:00", end: "08:00" },
  morningBrief: { enabled: false, time: "08:30" },
  stillRelevantAfterDays: 14,
};

async function restoreDefaults(request: APIRequestContext) {
  await request.put("/api/reminders/settings", { data: DEFAULTS });
}

test("reminder settings save and survive a reload", async ({ page, request }) => {
  test.slow();
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("button", { name: "Reminders", exact: true }).click();
    const levels = settings.getByRole("radiogroup", { name: "Reminder level" });
    await expect(levels.getByRole("radio", { name: /Gentle/ })).toBeChecked();

    // Each change is saved on the server first, so wait for the control to settle before the next.
    await levels.getByRole("radio", { name: /Normal/ }).click({ force: true });
    await expect(levels.getByRole("radio", { name: /Normal/ })).toBeChecked();
    await settings.getByRole("checkbox", { name: "Keep quiet hours" }).click();
    await expect(settings.getByRole("checkbox", { name: "Keep quiet hours" })).not.toBeChecked();
    await settings.getByRole("checkbox", { name: "Send a morning brief" }).click();
    await expect(settings.getByRole("checkbox", { name: "Send a morning brief" })).toBeChecked();
    await settings.getByLabel("Morning brief time").fill("07:45");
    await settings.getByRole("checkbox", { name: "Waiting on others" }).click();
    await expect(settings.getByRole("checkbox", { name: "Waiting on others" })).toBeChecked();
    await expect(settings.getByText("Saved.")).toBeVisible();

    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const again = page.getByRole("dialog", { name: "Settings" });
    await again.getByRole("button", { name: "Reminders", exact: true }).click();
    await expect(again.getByRole("radio", { name: /Normal/ })).toBeChecked();
    await expect(again.getByRole("checkbox", { name: "Keep quiet hours" })).not.toBeChecked();
    await expect(again.getByRole("checkbox", { name: "Send a morning brief" })).toBeChecked();
    await expect(again.getByLabel("Morning brief time")).toHaveValue("07:45");
    await expect(again.getByRole("checkbox", { name: "Waiting on others" })).toBeChecked();
  } finally {
    await restoreDefaults(request);
    await request.delete("/api/actions/suppressions?kind=waiting-on");
  }
});

test("a snoozed item's reminder appears on Home, and Not important removes it for good", async ({ page, request }) => {
  const text = `Reminder e2e call the plumber ${Date.now().toString(36)}`;
  await request.put("/api/reminders/settings", { data: { level: "gentle", quietHours: { enabled: false } } });
  const id = (await (await request.post("/api/actions", { data: { text } })).json() as { id: string }).id;
  try {
    // A snooze that has just ended: the reminder is already due, no waiting on the clock.
    await request.post(`/api/actions/${id}/snooze`, { data: { until: new Date(Date.now() - 60_000).toISOString() } });
    // The server plans again a moment after the change; Home only asks when it opens.
    await expect.poll(async () => {
      const pending = await (await request.get("/api/reminders/pending")).json() as { reminders: { title: string }[] };
      return pending.reminders.some((reminder) => reminder.title === text);
    }).toBe(true);
    await page.goto("/");
    const toast = page.locator(".home-toast.is-reminder").filter({ hasText: text });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("Back from snooze");
    await expect(toast.getByRole("button")).toHaveText(["Done", "Snooze", "Not important"]);

    await toast.getByRole("button", { name: "Not important" }).click();
    await expect.poll(async () => (await (await request.get(`/api/actions/${id}`)).json() as { status: string }).status).toBe("let-go");

    await page.reload();
    await expect(page.getByRole("textbox", { name: "Capture" })).toBeVisible();
    await expect(page.getByText(text)).toHaveCount(0);
    await expect(page.locator(".home-toast.is-reminder")).toHaveCount(0);
    const pending = await (await request.get("/api/reminders/pending")).json() as { reminders: { title: string }[] };
    expect(pending.reminders.some((reminder) => reminder.title === text)).toBe(false);
  } finally {
    await request.post(`/api/actions/${id}/let-go`);
    await restoreDefaults(request);
  }
});

test("snoozing in plain words shows the resolved time", async ({ page, request }) => {
  const text = `Reminder e2e phrase ${Date.now().toString(36)}`;
  const id = (await (await request.post("/api/actions", { data: { text } })).json() as { id: string }).id;
  try {
    await page.goto("/");
    const card = page.locator("[data-board-card]").filter({ hasText: text });
    await card.hover();
    await card.getByRole("button", { name: "Snooze" }).click();
    const field = page.getByRole("textbox", { name: /own words/ });
    await field.fill("tomorrow after lunch");
    await field.press("Enter");
    await expect(page.locator(".home-toast").filter({ hasText: /Snoozed until \w{3} \d+, 13:00/ })).toBeVisible();
    await expect(page.getByText(text)).toHaveCount(0);
  } finally {
    await request.post(`/api/actions/${id}/let-go`);
  }
});
