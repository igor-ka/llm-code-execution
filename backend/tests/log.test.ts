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

  // pg's DatabaseError extends Error and hangs its diagnostics off the instance as OWN
  // ENUMERABLE properties. Normalizing an Error to just {message, stack, name} is right for a
  // plain Error — those three are non-enumerable and would not survive JSON.stringify — but it
  // discards every field that says what actually broke. This bites hardest on the boot path:
  // migrate() runs before listen(), so a bad migration reaches the operator through
  // index.ts's "fatal: backend failed to start" on a crash-looping container, and
  // `column "foo" does not exist` without position or SQLSTATE is most of a debugging session.
  it("keeps a pg DatabaseError's own diagnostics — code, detail, position", () => {
    const lines: string[] = [];
    const log = makeLogger("json", (line) => lines.push(line));

    // Shaped like pg's DatabaseError: an Error subclass whose diagnostics are own enumerable
    // properties. Constructed by hand so the test does not depend on pg's internals.
    class DatabaseError extends Error {
      severity = "ERROR";
      code = "23505";
      detail = "Key (owner_sub, id)=(auth0|abc, s1) already exists.";
      position = "13";
      table = "sessions";
      constraint = "sessions_pkey";
      // pg leaves the fields that do not apply undefined; they must not break serialization.
      where = undefined;
      routine = "errorMissingColumn";
    }
    log.error("fatal: backend failed to start", {
      err: new DatabaseError('column "foo" does not exist'),
    });

    const entry = JSON.parse(lines[0]);
    expect(entry.err.code).toBe("23505"); // the SQLSTATE — the only stable thing to alert on
    expect(entry.err.position).toBe("13"); // the byte offset into the failing SQL
    expect(entry.err.constraint).toBe("sessions_pkey");
    expect(entry.err.table).toBe("sessions");
    expect(entry.err.routine).toBe("errorMissingColumn");
    // The explicit unwrapping still wins: message/stack/name are overlaid on top of the own
    // properties, not replaced by them.
    expect(entry.err.message).toBe('column "foo" does not exist');
    expect(typeof entry.err.stack).toBe("string");
    expect(entry.err.name).toBe("Error");
  });

  // Postgres' DETAIL on a constraint violation is `Failing row contains (...)` — the whole row.
  // On `runs` that is the user's prompt, the generated code and its output; server.ts logs
  // exactly those insert failures. Lifting it would put user content in the log stream and undo
  // the isolation the history store enforces, so it is redacted while the diagnosis is kept.
  it("never logs the pg fields that carry row content", () => {
    const lines: string[] = [];
    const log = makeLogger("json", (line) => lines.push(line));

    class DatabaseError extends Error {
      code = "23514";
      constraint = "runs_kind_check";
      table = "runs";
      detail = "Failing row contains (r1, s1, auth0|abc, what is my SSN? 123-45-6789, ...).";
      where = "PL/pgSQL function insert_run(text) line 3 at SQL statement";
      internalQuery = "INSERT INTO runs (prompt) VALUES ('secret')";
    }
    log.error("history persist failed (continuing)", { err: new DatabaseError("boom") });

    const line = lines[0];
    expect(line).not.toContain("123-45-6789");
    expect(line).not.toContain("Failing row contains");
    expect(line).not.toContain("INSERT INTO runs");
    const entry = JSON.parse(line);
    expect(entry.err.detail).toBeUndefined();
    expect(entry.err.where).toBeUndefined();
    expect(entry.err.internalQuery).toBeUndefined();
    // The diagnosis still survives — that is the whole point of the change.
    expect(entry.err.code).toBe("23514");
    expect(entry.err.constraint).toBe("runs_kind_check");
    expect(entry.err.table).toBe("runs");
  });

  // safeValue walks Object.entries, and a plain Error has none — so an Error-valued property
  // would serialize as `{}`: a line that looks like it captured the failure while holding
  // nothing. node-redis hangs originalError/socketError off its errors exactly this way, which
  // is the case log.ts's own header comment exists to prevent.
  it("unwraps an Error held in an own property instead of emitting {}", () => {
    const lines: string[] = [];
    const log = makeLogger("json", (line) => lines.push(line));

    class ReconnectStrategyError extends Error {
      originalError = new Error("ECONNREFUSED 127.0.0.1:6379");
    }
    log.error("redis client error", { err: new ReconnectStrategyError("reconnect failed") });

    const entry = JSON.parse(lines[0]);
    expect(entry.err.originalError.message).toBe("ECONNREFUSED 127.0.0.1:6379");
    expect(typeof entry.err.originalError.stack).toBe("string");
  });

  // Only an ARRAY `errors` is the AggregateError shape handled below. A validation library's
  // `errors: {field: reason}` is ordinary data, and dropping it would lose the whole payload.
  it("keeps a non-array errors payload", () => {
    const lines: string[] = [];
    const log = makeLogger("json", (line) => lines.push(line));

    const err = new Error("validation failed");
    (err as unknown as Record<string, unknown>).errors = { email: "required" };
    log.error("bad request", { err });

    expect(JSON.parse(lines[0]).err.errors).toEqual({ email: "required" });
  });

  it("loses only the offending field when an own getter throws, not the whole line", () => {
    const lines: string[] = [];
    const log = makeLogger("json", (line) => lines.push(line));

    const err = new Error("boom");
    Object.defineProperty(err, "poison", {
      enumerable: true,
      get() {
        throw new Error("getter exploded");
      },
    });
    (err as unknown as Record<string, unknown>).code = "42703";
    log.error("fatal: server error", { err, port: 8080 });

    const entry = JSON.parse(lines[0]);
    expect(entry.port).toBe(8080); // sibling fields survive
    expect(entry.err.code).toBe("42703");
    expect(entry.err.message).toBe("boom");
    expect(entry.unserializableFields).toBeUndefined();
  });

  // `new Error(m, {cause})` makes cause NON-enumerable, but `err.cause = other` makes it an own
  // ENUMERABLE property — so lifting own properties would hand the whole chain to safeValue,
  // which walks deeply with cycle protection but no depth limit. MAX_CAUSE_DEPTH would be applied
  // only afterwards, too late to stop the walk.
  it("caps an assigned (enumerable) cause chain instead of walking it in full", () => {
    const lines: string[] = [];
    const log = makeLogger("json", (line) => lines.push(line));

    let deep: Error = new Error("leaf");
    for (let i = 0; i < 5000; i++) {
      const wrapper = new Error(`level-${i}`);
      wrapper.cause = deep;
      deep = wrapper;
    }
    log.error("deep", { err: deep });

    // It emitted a line at all — no stack overflow inside the logger — and stopped at the cap
    // rather than serializing 5000 levels.
    expect(lines).toHaveLength(1);
    let node = JSON.parse(lines[0]).err;
    let depth = 0;
    while (node?.cause !== undefined) {
      node = node.cause;
      depth++;
    }
    expect(depth).toBeLessThanOrEqual(5);
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
