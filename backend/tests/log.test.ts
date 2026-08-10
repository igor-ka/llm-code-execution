import { describe, it, expect, vi, afterEach } from "vitest";
import { makeLogger, configureLogger } from "../src/log.js";

describe("makeLogger (json)", () => {
  it("emits one JSON line with Cloud Logging's severity/message fields", () => {
    const lines: string[] = [];
    const log = makeLogger("json", (line) => lines.push(line));

    log.info("backend listening", { port: 8080 });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      severity: "INFO",
      message: "backend listening",
      port: 8080,
    });
  });

  it("maps error() to ERROR severity and serializes an Error's message and stack", () => {
    const lines: string[] = [];
    const log = makeLogger("json", (line) => lines.push(line));

    log.error("history persist failed", { err: new Error("connection refused") });

    const entry = JSON.parse(lines[0]);
    expect(entry.severity).toBe("ERROR");
    expect(entry.message).toBe("history persist failed");
    expect(entry.err.message).toBe("connection refused");
    expect(typeof entry.err.stack).toBe("string");
  });

  it("survives a circular field value WITHOUT losing severity or message", () => {
    // The whole point of the logger is filterable lines. Dropping severity/message to report a
    // bad field would make the fail-open quota alarm unfindable at exactly the wrong moment.
    const lines: string[] = [];
    const log = makeLogger("json", (line) => lines.push(line));
    const circular: Record<string, unknown> = { keep: "me" };
    circular.self = circular;

    expect(() => log.warn("odd", { circular })).not.toThrow();
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.severity).toBe("WARNING");
    expect(entry.message).toBe("odd");
    expect(entry.circular.keep).toBe("me"); // the rest of the field survives
    expect(entry.circular.self).toBe("[Circular]");
  });

  it("does not let a caller field named severity or message hijack the real ones", () => {
    // `log.error("x", { message: err.message })` is an entirely natural call. If the field won,
    // the ERROR line would vanish from every `severity>=ERROR` filter — the alarm goes silent
    // while appearing to have been logged.
    const lines: string[] = [];
    const log = makeLogger("json", (line) => lines.push(line));

    log.error("real message", { message: "field wins", severity: "DEBUG" });

    const entry = JSON.parse(lines[0]);
    expect(entry.severity).toBe("ERROR");
    expect(entry.message).toBe("real message");
  });

  it("reports only genuine cycles, not a shared reference used twice", () => {
    // A path-scoped ancestor set, not a global one: two siblings pointing at the same object are
    // a DAG, not a cycle, and calling it "[Circular]" throws away real diagnostic data.
    const lines: string[] = [];
    const log = makeLogger("json", (line) => lines.push(line));
    const shared = { id: 1 };

    log.info("dag", { a: shared, b: shared, list: [shared, shared] });

    const entry = JSON.parse(lines[0]);
    expect(entry.a).toEqual({ id: 1 });
    expect(entry.b).toEqual({ id: 1 });
    expect(entry.list).toEqual([{ id: 1 }, { id: 1 }]);
  });

  it("unwraps AggregateError.errors, where node-redis hides the real connection failure", () => {
    // A failed node-redis connect is an AggregateError whose own message is "All promises were
    // rejected". Without this, the fail-open alarm fires and says nothing about why.
    const lines: string[] = [];
    const log = makeLogger("json", (line) => lines.push(line));
    const err = new AggregateError(
      [new Error("connect ECONNREFUSED 127.0.0.1:6379")],
      "All promises were rejected",
    );

    log.error("redis client error", { err });

    const entry = JSON.parse(lines[0]);
    expect(entry.err.message).toBe("All promises were rejected");
    expect(entry.err.errors[0].message).toBe("connect ECONNREFUSED 127.0.0.1:6379");
  });

  it("unwraps a cause chain", () => {
    const lines: string[] = [];
    const log = makeLogger("json", (line) => lines.push(line));

    log.error("wrapped", { err: new Error("outer", { cause: new Error("root cause") }) });

    const entry = JSON.parse(lines[0]);
    expect(entry.err.cause.message).toBe("root cause");
  });

  it("never throws when a field's getter throws, and still emits severity/message", () => {
    // Reading caller properties happens in normalize(), which must sit inside the same guard as
    // serialization: an exception escaping here would turn error reporting into a second error.
    const lines: string[] = [];
    const log = makeLogger("json", (line) => lines.push(line));
    const hostile = {
      get boom() {
        throw new Error("getter exploded");
      },
    };

    expect(() => log.error("still logged", hostile)).not.toThrow();

    const entry = JSON.parse(lines[0]);
    expect(entry.severity).toBe("ERROR");
    expect(entry.message).toBe("still logged");
    expect(entry.unserializableFields).toBe(true);
  });

  it("keeps a Date readable instead of flattening it to {}", () => {
    const lines: string[] = [];
    const log = makeLogger("json", (line) => lines.push(line));

    log.info("stamped", { at: new Date("2026-08-10T00:00:00.000Z") });

    expect(JSON.parse(lines[0]).at).toBe("2026-08-10T00:00:00.000Z");
  });
});

describe("makeLogger (text)", () => {
  it("emits a human-readable line with the fields appended", () => {
    const lines: string[] = [];
    const log = makeLogger("text", (line) => lines.push(line));

    log.info("backend listening", { port: 8080 });

    expect(lines[0]).toBe('INFO  backend listening {"port":8080}');
  });

  it("omits the field suffix when there are no fields", () => {
    const lines: string[] = [];
    const log = makeLogger("text", (line) => lines.push(line));

    log.info("backend listening");

    expect(lines[0]).toBe("INFO  backend listening");
  });
});

describe("default logger", () => {
  afterEach(() => {
    configureLogger("text"); // leave the module in its default state for other suites
    vi.restoreAllMocks();
  });

  it("writes to stdout", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { log } = await import("../src/log.js");
    log.info("hello");
    expect(spy).toHaveBeenCalled();
  });

  it("honours configureLogger, so the composition root decides the format", async () => {
    // The format is resolved per call, not frozen at module load — otherwise LOG_FORMAT from the
    // repo-root .env would depend on whether something imported config.ts (which loads dotenv)
    // first, which is import-order luck rather than configuration.
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { log } = await import("../src/log.js");

    configureLogger("json");
    log.info("structured", { k: 1 });

    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0]))).toEqual({
      severity: "INFO",
      message: "structured",
      k: 1,
    });
  });
});
