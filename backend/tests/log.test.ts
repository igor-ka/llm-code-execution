import { describe, it, expect, vi } from "vitest";
import { makeLogger } from "../src/log.js";

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
  it("writes to stdout", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { log } = await import("../src/log.js");
    log.info("hello");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
