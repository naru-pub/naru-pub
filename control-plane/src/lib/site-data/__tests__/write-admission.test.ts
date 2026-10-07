/** @jest-environment node */
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { WriteAdmission } from "../write-admission";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const gate = (maxActive = 2, overrides = {}) =>
  new WriteAdmission({
    maxActive,
    maxQueued: 8,
    maxQueuedPerSite: 4,
    queueTimeoutMs: 1000,
    ...overrides,
  });
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
afterEach(() => {
  jest.useRealTimers();
});

describe("write admission", () => {
  test("serializes one site while other sites use global capacity", async () => {
    const admission = gate();
    const first = deferred();
    const second = deferred();
    const order: string[] = [];
    const a = admission.run("a", undefined, async () => {
      order.push("a1");
      await first.promise;
    });
    const a2 = admission.run("a", undefined, async () => {
      order.push("a2");
    });
    const b = admission.run("b", undefined, async () => {
      order.push("b");
      await second.promise;
    });
    await flush();
    expect(order).toEqual(["a1", "b"]);
    expect(admission.state).toEqual({ active: 2, queued: 1, activeSites: 2 });
    first.resolve();
    await a;
    await a2;
    expect(order).toEqual(["a1", "b", "a2"]);
    second.resolve();
    await b;
    expect(admission.state).toEqual({ active: 0, queued: 0, activeSites: 0 });
  });
  test("global limit skips a blocked site's queued requests", async () => {
    const admission = gate();
    const aHold = deferred();
    const bHold = deferred();
    const cHold = deferred();
    const started: string[] = [];
    const a = admission.run("a", undefined, () => aHold.promise);
    const b = admission.run("b", undefined, () => bHold.promise);
    const a2 = admission.run("a", undefined, async () => {
      started.push("a2");
    });
    const c = admission.run("c", undefined, async () => {
      started.push("c");
      await cHold.promise;
    });
    await flush();
    expect(admission.state.active).toBe(2);
    bHold.resolve();
    await b;
    await flush();
    expect(started).toEqual(["c"]);
    aHold.resolve();
    await a;
    await a2;
    cHold.resolve();
    await c;
    expect(admission.state.queued).toBe(0);
  });
  test("preserves FIFO for the same site's queued operations", async () => {
    const admission = gate();
    const hold = deferred();
    const order: number[] = [];
    const first = admission.run("a", undefined, () => hold.promise);
    const requests = [1, 2, 3].map((n) =>
      admission.run("a", undefined, async () => {
        order.push(n);
      }),
    );
    hold.resolve();
    await Promise.all([first, ...requests]);
    expect(order).toEqual([1, 2, 3]);
  });
  test("sheds global and per-site overflow without running rejected operations", async () => {
    const admission = gate(1, { maxQueued: 2, maxQueuedPerSite: 1 });
    const hold = deferred();
    const rejected = jest.fn(async () => undefined);
    const first = admission.run("a", undefined, () => hold.promise);
    const a2 = admission.run("a", undefined, async () => undefined);
    await expect(admission.run("a", undefined, rejected)).rejects.toMatchObject(
      { status: 503, code: "UNAVAILABLE" },
    );
    const b = admission.run("b", undefined, async () => undefined);
    await expect(admission.run("c", undefined, rejected)).rejects.toMatchObject(
      { status: 503, code: "UNAVAILABLE" },
    );
    expect(rejected).not.toHaveBeenCalled();
    hold.resolve();
    await Promise.all([first, a2, b]);
    expect(admission.state).toEqual({ active: 0, queued: 0, activeSites: 0 });
  });
  test("expired requests free queue capacity and never execute", async () => {
    jest.useFakeTimers();
    const admission = gate(1, { maxQueued: 1 });
    const hold = deferred();
    const rejected = jest.fn(async () => undefined);
    const first = admission.run("a", undefined, () => hold.promise);
    const waiting = admission.run("b", undefined, rejected);
    const assertion = expect(waiting).rejects.toMatchObject({
      status: 503,
      code: "UNAVAILABLE",
    });
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(admission.state.queued).toBe(0);
    const next = admission.run("c", undefined, async () => undefined);
    hold.resolve();
    await Promise.all([first, next]);
    expect(rejected).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
  test("does not admit expired work before an overdue timer callback runs", async () => {
    jest.useFakeTimers();
    const time = jest.spyOn(performance, "now").mockReturnValue(0);
    const admission = gate(1);
    const hold = deferred();
    const rejected = jest.fn(async () => undefined);
    try {
      const first = admission.run("a", undefined, () => hold.promise);
      const waiting = admission.run("b", undefined, rejected);
      const assertion = expect(waiting).rejects.toMatchObject({
        status: 503,
        code: "UNAVAILABLE",
      });
      time.mockReturnValue(1000);
      hold.resolve();
      await first;
      await assertion;
      expect(rejected).not.toHaveBeenCalled();
      expect(admission.state).toEqual({ active: 0, queued: 0, activeSites: 0 });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      hold.resolve();
      time.mockRestore();
    }
  });
  test("aborting a queued request removes it immediately", async () => {
    const admission = gate(1, { maxQueued: 1 });
    const hold = deferred();
    const controller = new AbortController();
    const rejected = jest.fn(async () => undefined);
    const first = admission.run("a", undefined, () => hold.promise);
    const waiting = admission.run("b", controller.signal, rejected);
    const assertion = expect(waiting).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await assertion;
    const next = admission.run("b", undefined, async () => undefined);
    hold.resolve();
    await Promise.all([first, next]);
    expect(rejected).not.toHaveBeenCalled();
    expect(admission.state.queued).toBe(0);
  });
  test("handles abort before execution and releases a newly acquired slot", async () => {
    const admission = gate();
    const controller = new AbortController();
    const rejected = jest.fn(async () => undefined);
    const pending = admission.run("a", controller.signal, rejected);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      admission.run("a", controller.signal, rejected),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(rejected).not.toHaveBeenCalled();
    expect(admission.state.active).toBe(0);
  });
  test("an executing operation settles before releasing its slot after abort", async () => {
    const admission = gate();
    const controller = new AbortController();
    const hold = deferred();
    let executed = false;
    const first = admission.run("a", controller.signal, async () => {
      executed = true;
      await hold.promise;
      return "committed";
    });
    await flush();
    expect(executed).toBe(true);
    controller.abort();
    expect(admission.state.active).toBe(1);
    hold.resolve();
    await expect(first).resolves.toBe("committed");
    expect(admission.state.active).toBe(0);
  });
  test("synchronous throws and asynchronous failures release admission", async () => {
    const admission = gate(1);
    await expect(
      admission.run("a", undefined, () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    await expect(
      admission.run("a", undefined, async () => {
        throw new Error("async");
      }),
    ).rejects.toThrow("async");
    await expect(admission.run("a", undefined, async () => "ok")).resolves.toBe(
      "ok",
    );
    expect(admission.state).toEqual({ active: 0, queued: 0, activeSites: 0 });
  });
});
