import { ToolContentReadError } from "./tool-content-store.js";

/** Cancels local waiting only. A late native response must never mutate a cancelled viewer. */
export function waitForToolRead<T>(work: Promise<T>, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => finish(() => reject(new ToolContentReadError("cancelled")));
    const timer = setTimeout(abort, timeoutMs); timer.unref();
    const finish = (done: () => void): void => { clearTimeout(timer); signal?.removeEventListener("abort", abort); done(); };
    signal?.addEventListener("abort", abort, { once: true });
    work.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal?.aborted) abort();
  });
}
