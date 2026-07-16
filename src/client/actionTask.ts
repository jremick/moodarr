export async function runActionTask<T>(
  action: () => Promise<T>,
  successMessage: (result: T) => string,
  refresh: () => Promise<unknown>,
  setNotice: (message: string) => void
) {
  try {
    const result = await action();
    const message = successMessage(result);
    setNotice(message);
    try {
      await refresh();
    } catch (error) {
      setNotice(`${message ? `${message} ` : ""}Status refresh failed: ${errorMessage(error)}`);
    }
    return result;
  } catch (error) {
    setNotice(errorMessage(error));
    return undefined;
  }
}

export async function settleRefreshTasks(tasks: Array<() => Promise<unknown>>) {
  const outcomes = await Promise.allSettled(tasks.map((task) => Promise.resolve().then(task)));
  const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  if (failure) throw failure.reason;
}

export class ExclusiveActionLock {
  private activeName = "";

  get active() {
    return this.activeName;
  }

  tryAcquire(name: string) {
    if (this.activeName) return false;
    this.activeName = name;
    return true;
  }

  release(name: string) {
    if (this.activeName !== name) return false;
    this.activeName = "";
    return true;
  }
}

export function isActionNavigationBlocked(lock: Pick<ExclusiveActionLock, "active">) {
  return Boolean(lock.active);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
