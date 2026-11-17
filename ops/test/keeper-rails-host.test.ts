import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOLD_FILE, handRails, holdFileText, monitorFromEnv } from "../src/keeper/rails-host.ts";

// The PC's half of the rails (design-keeper-worker.md §6): a hand run reads ops/hold.json each round and the monitor at
// OPS_HOLD_URL, and may carry --ignore-monitor-outage --until (outages only, at most 24 h). The Worker (Task 50b) reads
// the monitor through its service binding and never carries an override.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const NOW_MS = 1_800_000_000_000;

describe("ops/hold.json", () => {
  it("is ops/hold.json; absent reads as no file, present as its text, read again each time", () => {
    expect(HOLD_FILE.pathname.endsWith("/ops/hold.json")).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "hold-"));
    dirs.push(dir);
    const path = join(dir, "hold.json");
    expect(holdFileText(path)).toBeUndefined();
    writeFileSync(path, '{"hold": true}');
    expect(holdFileText(path)).toBe('{"hold": true}');
    writeFileSync(path, '{"hold": false}');
    expect(holdFileText(path)).toBe('{"hold": false}');
  });
});

describe("OPS_HOLD_URL", () => {
  it("the monitor's base URL (or its /v1/status); unset is no monitor, which the v3.2 keeper takes as an outage", () => {
    expect(monitorFromEnv({})).toBeNull();
    expect(monitorFromEnv({ OPS_HOLD_URL: " " })).toBeNull();
    expect(monitorFromEnv({ OPS_HOLD_URL: "https://monitor.example.com" })?.where).toBe("monitor.example.com");
    expect(() => monitorFromEnv({ OPS_HOLD_URL: "monitor.example.com" })).toThrow(/OPS_HOLD_URL is not an https URL/);
  });
});

describe("a hand run's rails", () => {
  it("the monitor, the file read each round, the deliveries switch, and --ignore-monitor-outage --until when given (checked: at most 24 h ahead)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hold-"));
    dirs.push(dir);
    const path = join(dir, "hold.json");
    const r = handRails({ OPS_HOLD_URL: "https://monitor.example.com" }, { nowMs: NOW_MS, deliveriesOn: true, holdPath: path });
    expect(r.monitor?.where).toBe("monitor.example.com");
    expect(r.override).toBeUndefined();
    expect(r.deliveriesOn).toBe(true);
    expect(r.holdFile?.()).toBeUndefined();
    writeFileSync(path, '{"hold": true}');
    expect(r.holdFile?.()).toBe('{"hold": true}');
    const until = new Date(NOW_MS + 3_600_000).toISOString();
    expect(handRails({}, { nowMs: NOW_MS, deliveriesOn: false, ignoreMonitorOutageUntil: until }).override).toEqual({ until: NOW_MS + 3_600_000 });
    expect(() => handRails({}, { nowMs: NOW_MS, deliveriesOn: false, ignoreMonitorOutageUntil: new Date(NOW_MS + 25 * 3_600_000).toISOString() })).toThrow(/more than 24 hours ahead/);
  });
});
