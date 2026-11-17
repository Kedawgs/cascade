import { env } from "cloudflare:workers";
import { afterAll, expect } from "vitest";

// Runs before each worker test file: every line any test makes the Worker (or anything else) print is kept, and after
// the file none may hold the keeper's key, in any case, with or without 0x (design §2: no log line ever contains it).

const key = String((env as unknown as { KEEPER_PRIVATE_KEY: string }).KEEPER_PRIVATE_KEY).slice(2).toLowerCase();
export const printed: string[] = [];
(globalThis as unknown as { __printed: string[] }).__printed = printed;
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    printed.push(args.map((a) => (typeof a === "string" ? a : a instanceof Error ? `${a.message}\n${a.stack}` : JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))).join(" "));
    if (level === "error" || level === "warn") original(...args);
  };
}

afterAll(() => {
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  const leaked = printed.filter((l) => l.toLowerCase().includes(key));
  expect(leaked, "a printed line holds the keeper's key").toEqual([]);
});
