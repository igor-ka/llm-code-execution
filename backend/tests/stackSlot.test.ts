/**
 * `.env` carries nine values that have to agree with STACK_SLOT, and every way of getting it
 * wrong is silent: the worst is a worktree on slot 1 whose DATABASE_URL still says 5432, which
 * writes its chat history into slot 0's Postgres and reports success. These tests pin the
 * warning that makes that visible.
 */
import { describe, it, expect } from "vitest";
import { stackSlotWarnings } from "../src/config.js";

const slot1 = {
  STACK_SLOT: "1",
  PORT: "8010",
  FRONTEND_ORIGIN: "http://localhost:5183",
  DATABASE_URL: "postgres://app:app@localhost:5442/app",
  REDIS_URL: "redis://localhost:6389",
};

describe("stackSlotWarnings", () => {
  it("says nothing when STACK_SLOT is absent — the pre-slot setup is not an error", () => {
    expect(stackSlotWarnings({})).toEqual([]);
    expect(stackSlotWarnings({ DATABASE_URL: "postgres://app:app@localhost:5432/app" })).toEqual(
      [],
    );
  });

  it("says nothing for a consistent slot 0", () => {
    expect(
      stackSlotWarnings({
        STACK_SLOT: "0",
        PORT: "8000",
        FRONTEND_ORIGIN: "http://localhost:5173",
        DATABASE_URL: "postgres://app:app@localhost:5432/app",
        REDIS_URL: "redis://localhost:6379",
      }),
    ).toEqual([]);
  });

  it("says nothing for a consistent slot 1", () => {
    expect(stackSlotWarnings(slot1)).toEqual([]);
  });

  it("catches the datastore left on another slot", () => {
    const warnings = stackSlotWarnings({
      ...slot1,
      DATABASE_URL: "postgres://app:app@localhost:5432/app",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("DATABASE_URL points at port 5432");
    expect(warnings[0]).toContain("STACK_SLOT=1 owns 5442");
  });

  it("catches every mismatched service at once, not just the first", () => {
    const warnings = stackSlotWarnings({
      STACK_SLOT: "2",
      PORT: "8000",
      FRONTEND_ORIGIN: "http://localhost:5173",
      DATABASE_URL: "postgres://app:app@localhost:5432/app",
      REDIS_URL: "redis://localhost:6379",
    });
    expect(warnings).toHaveLength(4);
  });

  // Compose rewrites these to service names on its own network, where the host-port scheme does
  // not apply. Warning there would fire on every single `docker compose up` and train the reader
  // to ignore the message.
  it("ignores compose-network hosts", () => {
    expect(
      stackSlotWarnings({
        ...slot1,
        DATABASE_URL: "postgres://app:app@postgres:5432/app",
        REDIS_URL: "redis://redis:6379",
      }),
    ).toEqual([]);
  });

  it("ignores values it cannot parse rather than inventing a complaint", () => {
    expect(stackSlotWarnings({ ...slot1, DATABASE_URL: "not a url" })).toEqual([]);
    // No explicit port: nothing to compare against.
    expect(stackSlotWarnings({ ...slot1, REDIS_URL: "redis://localhost" })).toEqual([]);
  });

  it("reports a STACK_SLOT that is not a slot number", () => {
    const warnings = stackSlotWarnings({ ...slot1, STACK_SLOT: "one" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not a slot number");
  });
});
