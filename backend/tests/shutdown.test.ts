import { describe, it, expect, vi, afterEach } from "vitest";
import { makeShutdown } from "../src/shutdown.js";

/** A server stand-in whose close() completion we drive by hand. */
function fakeServer() {
  let finish: (() => void) | undefined;
  return {
    closed: 0,
    close(cb?: () => void) {
      this.closed += 1;
      finish = cb;
    },
    complete() {
      finish?.();
    },
  };
}

describe("makeShutdown", () => {
  // NOTE: only the timer tests use fake timers. vi.waitFor polls on a timer, so pairing it with
  // fake timers in the same test hangs — keep the two techniques in separate tests.
  afterEach(() => vi.useRealTimers());

  it("stops the server, then cleans up, then exits 0", async () => {
    const order: string[] = [];
    const server = fakeServer();
    const exit = vi.fn((code: number) => void order.push(`exit:${code}`));
    const shutdown = makeShutdown({
      server,
      cleanup: async () => void order.push("cleanup"),
      exit,
      log: () => {},
    });

    shutdown("SIGTERM");
    expect(server.closed).toBe(1);
    expect(order).toEqual([]); // cleanup waits for in-flight requests to drain

    server.complete();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(order).toEqual(["cleanup", "exit:0"]);
  });

  it("ignores a second signal while already shutting down", async () => {
    const server = fakeServer();
    const cleanup = vi.fn(async () => {});
    const shutdown = makeShutdown({ server, cleanup, exit: vi.fn(), log: () => {} });

    shutdown("SIGTERM");
    shutdown("SIGINT");

    expect(server.closed).toBe(1);
    server.complete();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
  });

  it("force-exits non-zero if the server never finishes closing", () => {
    vi.useFakeTimers(); // synchronous test: safe to fake time, no vi.waitFor here
    const server = fakeServer();
    const exit = vi.fn();
    const shutdown = makeShutdown({ server, graceMs: 10_000, exit, log: () => {} });

    shutdown("SIGTERM");
    expect(exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10_000);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("defaults to a grace period inside Cloud Run's 10s SIGTERM→SIGKILL window", () => {
    // Pins the intent, not the number: at exactly 10s the force-exit and the platform's kill
    // land together and the timer is decorative. It has to fire while we are still alive.
    vi.useFakeTimers();
    const server = fakeServer();
    const exit = vi.fn();
    const shutdown = makeShutdown({ server, exit, log: () => {} });

    shutdown("SIGTERM");
    vi.advanceTimersByTime(9_000);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("still exits 0 when cleanup rejects", async () => {
    const server = fakeServer();
    const exit = vi.fn();
    const shutdown = makeShutdown({
      server,
      cleanup: async () => {
        throw new Error("pool already ended");
      },
      exit,
      log: () => {},
    });

    shutdown("SIGTERM");
    server.complete();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });
});
