/**
 * `.env` carries nine values that have to agree with STACK_SLOT, and every way of getting it
 * wrong is silent: the worst are a worktree on slot 1 whose DATABASE_URL still says 5432, which
 * writes its chat history into slot 0's Postgres and reports success, and one left on slot 0's
 * SANDBOX_IMAGE, which executes another worktree's sandbox image. These tests pin the warnings
 * that make both visible — and, just as importantly, pin the cases that must stay quiet.
 */
import { describe, it, expect } from "vitest";
import { stackSlotWarnings } from "../src/config.js";

/** A fully consistent slot 1, as scripts/worktree-new.sh will generate it. */
const slot1 = {
  STACK_SLOT: "1",
  BACKEND_PORT: "8010",
  FRONTEND_PORT: "5183",
  PG_PORT: "5442",
  REDIS_PORT: "6389",
  FRONTEND_ORIGIN: "http://localhost:5183",
  DATABASE_URL: "postgres://app:app@localhost:5442/app",
  REDIS_URL: "redis://localhost:6389",
  SANDBOX_IMAGE: "llm-sandbox:slot1",
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
        BACKEND_PORT: "8000",
        FRONTEND_PORT: "5173",
        PG_PORT: "5432",
        REDIS_PORT: "6379",
        FRONTEND_ORIGIN: "http://localhost:5173",
        DATABASE_URL: "postgres://app:app@localhost:5432/app",
        REDIS_URL: "redis://localhost:6379",
        SANDBOX_IMAGE: "llm-sandbox:slot0",
      }),
    ).toEqual([]);
  });

  it("says nothing for a consistent slot 1", () => {
    expect(stackSlotWarnings(slot1)).toEqual([]);
  });

  // The regression that matters most: Compose pins the container listener to PORT=8000 at every
  // slot and publishes it on BACKEND_PORT. Checking PORT would fire on every `docker compose up`
  // of a non-zero slot, and a check that cries wolf on the normal path trains you to ignore it.
  it("stays quiet in a slot-1 Compose container, where PORT is pinned to 8000", () => {
    expect(
      stackSlotWarnings({
        ...slot1,
        PORT: "8000",
        DATABASE_URL: "postgres://app:app@postgres:5432/app",
        REDIS_URL: "redis://redis:6379",
      }),
    ).toEqual([]);
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

  it("catches a published port left on another slot", () => {
    const warnings = stackSlotWarnings({ ...slot1, PG_PORT: "5432" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("PG_PORT points at port 5432");
  });

  it("catches every mismatched value at once, not just the first", () => {
    const warnings = stackSlotWarnings({
      STACK_SLOT: "2",
      BACKEND_PORT: "8000",
      FRONTEND_PORT: "5173",
      PG_PORT: "5432",
      REDIS_PORT: "6379",
      FRONTEND_ORIGIN: "http://localhost:5173",
      DATABASE_URL: "postgres://app:app@localhost:5432/app",
      REDIS_URL: "redis://localhost:6379",
      SANDBOX_IMAGE: "llm-sandbox:slot0",
    });
    expect(warnings).toHaveLength(8);
  });

  describe("SANDBOX_IMAGE — the tag that defeats sandbox isolation when it is wrong", () => {
    it("catches another slot's tag", () => {
      const warnings = stackSlotWarnings({ ...slot1, SANDBOX_IMAGE: "llm-sandbox:slot0" });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("would execute another slot's sandbox image");
    });

    it("catches an untagged image on a non-zero slot", () => {
      const warnings = stackSlotWarnings({ ...slot1, SANDBOX_IMAGE: "llm-sandbox:latest" });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("shared with every other worktree");
    });

    // Slot 0 IS the shared daemon-wide default, so an untagged image there is the status quo,
    // not a mistake — every pre-slot checkout in existence looks like this.
    it("accepts an untagged image on slot 0", () => {
      expect(stackSlotWarnings({ STACK_SLOT: "0", SANDBOX_IMAGE: "llm-sandbox:latest" })).toEqual(
        [],
      );
    });
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
