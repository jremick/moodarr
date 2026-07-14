import { describe, expect, it, vi } from "vitest";
import { ExclusiveActionLock, isActionNavigationBlocked, runActionTask, settleRefreshTasks } from "../src/client/actionTask";

describe("client action task", () => {
  it("keeps a request creation exclusive until its result state can settle", () => {
    const lock = new ExclusiveActionLock();

    expect(lock.tryAcquire("create")).toBe(true);
    expect(isActionNavigationBlocked(lock)).toBe(true);
    expect(lock.tryAcquire("search")).toBe(false);
    expect(lock.active).toBe("create");
    expect(lock.release("search")).toBe(false);
    expect(lock.active).toBe("create");
    expect(lock.release("create")).toBe(true);
    expect(isActionNavigationBlocked(lock)).toBe(false);
    expect(lock.tryAcquire("search")).toBe(true);
  });

  it("preserves a successful mutation result when the follow-up status refresh fails", async () => {
    const result = { ok: true };
    const notices: string[] = [];

    await expect(
      runActionTask(
        async () => result,
        () => "Request created.",
        async () => {
          throw new Error("status unavailable");
        },
        (notice) => notices.push(notice)
      )
    ).resolves.toBe(result);
    expect(notices).toEqual([
      "Request created.",
      "Request created. Status refresh failed: status unavailable"
    ]);
  });

  it("preserves a successful Admin write when its combined refresh phase fails", async () => {
    const result = { ok: true, updated: "admin-user" };
    let finishAdminRefresh: (() => void) | undefined;
    const adminRefresh = new Promise<void>((resolve) => {
      finishAdminRefresh = resolve;
    });
    const refreshStatus = vi.fn(async () => {
      throw new Error("Admin readback unavailable");
    });
    const refreshAdmin = vi.fn(() => adminRefresh);
    const notices: string[] = [];

    const task = runActionTask(
      async () => result,
      () => "Admin access updated.",
      () => settleRefreshTasks([refreshStatus, refreshAdmin]),
      (notice) => notices.push(notice)
    );
    let settled = false;
    void task.finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(refreshAdmin).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    finishAdminRefresh!();

    await expect(task).resolves.toBe(result);
    expect(refreshStatus).toHaveBeenCalledOnce();
    expect(refreshAdmin).toHaveBeenCalledOnce();
    expect(notices).toEqual([
      "Admin access updated.",
      "Admin access updated. Status refresh failed: Admin readback unavailable"
    ]);
  });

  it("reports the action failure and skips refresh when the mutation itself fails", async () => {
    const refresh = vi.fn(async () => undefined);
    const notices: string[] = [];

    await expect(
      runActionTask(
        async () => {
          throw new Error("request rejected");
        },
        () => "Request created.",
        refresh,
        (notice) => notices.push(notice)
      )
    ).resolves.toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
    expect(notices).toEqual(["request rejected"]);
  });
});
