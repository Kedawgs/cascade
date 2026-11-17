import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Io } from "../../scripts/io.ts";
import { newToken } from "../../scripts/new-token.ts";

// pnpm keeper:new-token: the control token for the PC (OPS_KEEPER_CONTROL_TOKEN) and its SHA-256 for the Worker
// (CONTROL_TOKEN_SHA256), the only form the Worker keeps (design §3).

function fakeIo(line: string[] = []) {
  const said: string[] = [];
  const ran: { args: string[]; value: string }[] = [];
  const io: Io = { hidden: async () => "", line: async () => line.shift() ?? "", say: (l) => said.push(l), wrangler: async (args, value) => (ran.push({ args, value }), 0) };
  return { io, said, ran };
}

describe("pnpm keeper:new-token", () => {
  it("prints the token once and its SHA-256; with --put-secret and the environment typed, pipes only the hash into wrangler", async () => {
    const f = fakeIo(["production"]);
    expect(await newToken(["--env", "production", "--put-secret"], f.io)).toBe(0);
    const token = /OPS_KEEPER_CONTROL_TOKEN\): (\S+)$/.exec(f.said[0])?.[1] as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const hash = createHash("sha256").update(token).digest("hex");
    expect(f.said).toEqual([
      `The control token for cascade-keeper-production (shown once: put it in ops/.env as OPS_KEEPER_CONTROL_TOKEN): ${token}`,
      `Its SHA-256 (the Worker's CONTROL_TOKEN_SHA256): ${hash}`,
      "CONTROL_TOKEN_SHA256 is set on cascade-keeper-production.",
    ]);
    expect(f.ran).toEqual([{ args: ["secret", "put", "CONTROL_TOKEN_SHA256", "--env", "production"], value: hash }]);
  });

  it("a different token each time; nothing put without --put-secret or the confirmation", async () => {
    const a = fakeIo();
    const b = fakeIo(["no"]);
    expect(await newToken(["--env", "test"], a.io)).toBe(0);
    expect(await newToken(["--env", "test", "--put-secret"], b.io)).toBe(1);
    expect(a.ran).toEqual([]);
    expect(b.ran).toEqual([]);
    expect(a.said[0]).not.toBe(b.said[0]);
    expect(await newToken([], fakeIo().io)).toBe(1);
  });
});
