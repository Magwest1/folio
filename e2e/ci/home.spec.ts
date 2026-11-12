import { expect, test } from "@playwright/test";

const modifier = process.platform === "darwin" ? "Meta" : "Control";

test("Home takes typing with zero clicks and Cmd/Ctrl+Enter starts the normal filing flow", async ({ page, request }) => {
  const token = Date.now().toString(36);
  const text = `Home capture ${token} about the garden fence`;
  await page.goto("/");
  const capture = page.getByRole("textbox", { name: "Capture" });
  await expect(capture).toBeVisible();
  await expect(capture).toBeFocused();

  // No click anywhere: typing goes straight into the field, and Enter is a new line.
  await page.keyboard.type(`${text}`);
  await page.keyboard.press("Enter");
  await page.keyboard.type("second line");
  await expect(capture).toHaveValue(`${text}\nsecond line`);

  // Escape only leaves the field; the text stays and survives a reload.
  await page.keyboard.press("Escape");
  await expect(capture).not.toBeFocused();
  await expect(capture).toHaveValue(`${text}\nsecond line`);
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Capture" })).toHaveValue(`${text}\nsecond line`);

  const filing = page.waitForRequest((candidate) =>
    candidate.method() === "POST" && new URL(candidate.url()).pathname === "/api/notes");
  await page.getByRole("textbox", { name: "Capture" }).focus();
  await page.keyboard.press(`${modifier}+Enter`);
  await filing;

  // The same confirmation as filing any draft.
  const confirmation = page.getByRole("dialog", { name: "Filing confirmation" });
  await expect(confirmation).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(confirmation).toHaveCount(0);

  // Cleanup the note this test filed.
  const notes = await (await request.get("/api/notes")).json() as { id: string; title: string }[];
  for (const note of notes.filter((candidate) => candidate.title.includes(token) || candidate.id.includes(token)))
    await request.delete(`/api/note?id=${encodeURIComponent(note.id)}`);
});

test("Cmd/Ctrl+T still goes straight to a new draft, and Cmd/Ctrl+Shift+H returns to Home", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Capture" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Todo List", exact: true })).toBeVisible();
  await page.keyboard.press(`${modifier}+t`);
  const draft = page.getByRole("textbox", { name: "Write a new note" });
  await expect(draft).toBeVisible();
  await expect(draft).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Capture" })).toHaveCount(0);

  await page.keyboard.press(`${modifier}+Shift+H`);
  await expect(page.getByRole("textbox", { name: "Capture" })).toBeFocused();
  await page.getByRole("button", { name: "Close Home", exact: true }).click();
  await expect(draft).toBeVisible();
});

test("Not important removes an action permanently", async ({ page, request }) => {
  const token = Date.now().toString(36);
  const text = `Home e2e chase the plumber ${token}`;
  const created = await request.post("/api/actions", { data: { text } });
  expect(created.status()).toBe(201);
  const { id } = await created.json() as { id: string };

  await page.goto("/");
  const card = page.getByRole("listitem").filter({ hasText: text });
  await expect(card).toBeVisible();
  // The card's actions appear on hover or focus.
  await card.hover();
  await card.getByRole("button", { name: "Not important" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("won't come back");

  await expect.poll(async () => (await (await request.get(`/api/actions/${id}`)).json() as { status: string }).status).toBe("let-go");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Capture" })).toBeVisible();
  await expect(page.getByText(text)).toHaveCount(0);
  const open = await (await request.get("/api/actions")).json() as { id: string }[];
  expect(open.map((action) => action.id)).not.toContain(id);
});

test("a card moves to another column by drag and by keyboard", async ({ page, request }) => {
  const token = Date.now().toString(36);
  const dragText = `Home e2e drag me ${token}`;
  const keyText = `Home e2e key me ${token}`;
  const today = new Date();
  const dateOf = (offset: number) => {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  };
  const created = await Promise.all([dragText, keyText].map((text) =>
    request.post("/api/actions", { data: { text, due: { date: dateOf(2), time: "10:00" } } })));
  const [dragged, keyed] = await Promise.all(created.map(async (response) => {
    expect(response.status()).toBe(201);
    return (await response.json() as { id: string }).id;
  }));
  const dueOf = async (id: string) => (await (await request.get(`/api/actions/${id}`)).json() as { due: unknown }).due;

  try {
    await page.goto("/");
    // Columns adapt to what is due, so drop on Today, which is always a single day.
    const card = page.getByRole("listitem").filter({ hasText: dragText });
    await expect(card).toBeVisible();
    const target = page.locator("[data-column='today']");
    await card.dragTo(target);
    await expect(target.getByText(dragText)).toBeVisible();
    await expect.poll(() => dueOf(dragged)).toEqual({ date: dateOf(0), time: "10:00" });

    // Keyboard: Shift+Left moves a card to the column before its own, and the move is announced.
    const keyCard = page.getByRole("listitem").filter({ hasText: keyText });
    await keyCard.focus();
    await page.keyboard.press("Shift+ArrowLeft");
    await expect(page.getByRole("status")).toContainText("Moved to");
    await expect.poll(() => dueOf(keyed)).not.toEqual({ date: dateOf(2), time: "10:00" });
    await expect(page.getByRole("listitem").filter({ hasText: keyText })).toBeVisible();
  } finally {
    await Promise.all([dragged, keyed].map((id) => request.post(`/api/actions/${id}/let-go`)));
  }
});
