import { describe, expect, it, vi } from "vitest";

import { createCloseFlow } from "../../electron/close-flow.js";

function setup(overrides: Partial<{
  requestFlush: () => Promise<boolean>;
  confirmCloseAnyway: () => Promise<boolean>;
  isRendererAvailable: () => boolean;
}> = {}) {
  const requestFlush = vi.fn(overrides.requestFlush ?? (() => Promise.resolve(true)));
  const confirmCloseAnyway = vi.fn(overrides.confirmCloseAnyway ?? (() => Promise.resolve(false)));
  const flow = createCloseFlow({
    requestFlush,
    confirmCloseAnyway,
    isRendererAvailable: overrides.isRendererAvailable ?? (() => true),
  });
  return { flow, requestFlush, confirmCloseAnyway };
}

describe("createCloseFlow", () => {
  it("approves the close without prompting when the flush succeeds", async () => {
    const { flow, confirmCloseAnyway } = setup();
    await expect(flow.requestClose()).resolves.toBe("approved");
    expect(confirmCloseAnyway).not.toHaveBeenCalled();
  });

  it("keeps the window open when the flush fails and the user cancels", async () => {
    const { flow, confirmCloseAnyway } = setup({ requestFlush: () => Promise.resolve(false) });
    await expect(flow.requestClose()).resolves.toBe("cancelled");
    expect(confirmCloseAnyway).toHaveBeenCalledTimes(1);
  });

  it("closes anyway when the user confirms after a failed or rejected flush", async () => {
    const failed = setup({
      requestFlush: () => Promise.resolve(false),
      confirmCloseAnyway: () => Promise.resolve(true),
    });
    await expect(failed.flow.requestClose()).resolves.toBe("approved");

    const rejected = setup({
      requestFlush: () => Promise.reject(new Error("ipc")),
      confirmCloseAnyway: () => Promise.resolve(true),
    });
    await expect(rejected.flow.requestClose()).resolves.toBe("approved");
  });

  it("never blocks a crashed or destroyed renderer", async () => {
    const { flow, requestFlush, confirmCloseAnyway } = setup({ isRendererAvailable: () => false });
    await expect(flow.requestClose()).resolves.toBe("approved");
    expect(requestFlush).not.toHaveBeenCalled();
    expect(confirmCloseAnyway).not.toHaveBeenCalled();
  });

  it("approves without prompting when the renderer dies during the flush", async () => {
    let available = true;
    const { flow, confirmCloseAnyway } = setup({
      requestFlush: () => {
        available = false;
        return Promise.resolve(false);
      },
      isRendererAvailable: () => available,
    });
    await expect(flow.requestClose()).resolves.toBe("approved");
    expect(confirmCloseAnyway).not.toHaveBeenCalled();
  });

  it("shares one request between concurrent callers and allows a later one", async () => {
    const { flow, requestFlush } = setup();
    const first = flow.requestClose();
    expect(flow.isPending()).toBe(true);
    const second = flow.requestClose();
    await Promise.all([first, second]);
    expect(requestFlush).toHaveBeenCalledTimes(1);
    expect(flow.isPending()).toBe(false);
    await flow.requestClose();
    expect(requestFlush).toHaveBeenCalledTimes(2);
  });
});
