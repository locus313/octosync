import { describe, expect, it } from "vitest";
import { DebugLog } from "../src/debug-log";
import { DEFAULT_SETTINGS } from "../src/types";

describe("DebugLog", () => {
  it("does not write entries when logging is disabled", () => {
    const log = new DebugLog({ ...DEFAULT_SETTINGS, debugLogging: false }, async () => {});

    log.write("sync.start");

    expect(log.getEntries()).toEqual([]);
  });

  it("writes, formats, and redacts sensitive keys recursively", async () => {
    let saved: unknown;
    const log = new DebugLog({ ...DEFAULT_SETTINGS, debugLogging: true }, async (entries) => {
      saved = entries;
    });

    log.write("github.request", {
      token: "secret",
      nested: {
        authorization: "Bearer secret",
        ok: true,
      },
      list: [{ password: "secret" }],
    });

    const entry = log.getEntries()[0];
    expect(entry.message).toBe("github.request");
    expect(entry.data).toEqual({
      token: "[redacted]",
      nested: {
        authorization: "[redacted]",
        ok: true,
      },
      list: [{ password: "[redacted]" }],
    });
    expect(log.format()).toContain("github.request");
    expect(saved).toEqual(log.getEntries());
  });

  it("loads only valid entries and caps the rolling log", () => {
    const log = new DebugLog({ ...DEFAULT_SETTINGS, debugLogging: true }, async () => {});
    const entries = Array.from({ length: 305 }, (_, index) => ({
      timestamp: `2026-05-15T00:00:${String(index).padStart(2, "0")}Z`,
      message: `entry-${index}`,
    }));

    log.load([{ nope: true }, ...entries]);

    expect(log.getEntries()).toHaveLength(300);
    expect(log.getEntries()[0].message).toBe("entry-5");
  });

  it("clears entries and persists the empty log", async () => {
    let saved: unknown;
    const log = new DebugLog({ ...DEFAULT_SETTINGS, debugLogging: true }, async (entries) => {
      saved = entries;
    });
    log.write("sync.start");

    await log.clear();

    expect(log.getEntries()).toEqual([]);
    expect(saved).toEqual([]);
  });
});
