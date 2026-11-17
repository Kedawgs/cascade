import { reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromJson } from "../../../ops/src/keeper/core/memory.ts";

import { keeperKey } from "../../src/signer.ts";
import { chains, closeDue, coordinator, KEY, ME, started, keeperRun, testEnv } from "./harness.ts";

// The signer (design-keeper-worker.md §2): viem's local account from the secret. A key whose address isn't keeper() on
// both contracts sends nothing, whatever DEPLOYMENT's keeper (R4, D-M1: the plan's first, which a rotation leaves as it
// is); and no log line, error, stored row or response ever holds the key (setup.ts also checks every line every test file
// prints).

const bare = KEY.slice(2).toLowerCase();
const holdsKey = (text: string) => text.toLowerCase().includes(bare);

beforeEach(async () => {
  await reset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the keeper's key", () => {
  it("signs as the secret's address", () => {
    expect(keeperKey(KEY).address).toBe(ME);
    expect(keeperKey(`  ${KEY}\n`).address).toBe(ME);
  });

  it("a missing or malformed secret: nothing runs, and the message never quotes what was set", async () => {
    chains();
    const bad = `0x${"zz".repeat(32)}`;
    for (const [secret, why] of [
      [undefined, "KEEPER_PRIVATE_KEY is not set (pnpm keeper:new-key --put-secret sets it); nothing signed or sent"],
      [bad, "KEEPER_PRIVATE_KEY is not a private key (0x and 64 hex digits); nothing signed or sent"],
      [KEY.slice(2), "KEEPER_PRIVATE_KEY is not a private key (0x and 64 hex digits); nothing signed or sent"],
      [`0x${"00".repeat(32)}`, "KEEPER_PRIVATE_KEY is not a usable secp256k1 key; nothing signed or sent"],
    ] as const) {
      const r = await keeperRun({ ...testEnv, KEEPER_PRIVATE_KEY: secret as never }, { print: () => undefined });
      expect(r.outcome).toBe("not-configured");
      expect(r.lines).toEqual([`NOT RUNNING: ${why}`]);
      expect(r.lines.join("")).not.toContain("zzzz");
    }
    // the bare key (no 0x) is refused, and not echoed either
    expect(holdsKey(JSON.stringify(await keeperRun({ ...testEnv, KEEPER_PRIVATE_KEY: KEY.slice(2) }, { print: () => undefined })))).toBe(false);
  });

  it("a key keeper() doesn't name on the contracts sends nothing, and stops the keeper (saved)", async () => {
    const c = chains((w) => closeDue(w));
    await started();
    const other = generatePrivateKey();
    const r = await keeperRun({ ...testEnv, KEEPER_PRIVATE_KEY: other }, { print: () => undefined });
    expect(c.w.sends).toEqual([]);
    expect(r.stoppedItself).toMatch(new RegExp(`the vault's keeper\\(\\) is ${ME}, not the keeper's key ${privateKeyToAccount(other).address}`));
    expect(fromJson<{ control: { stopped: boolean } }>(await coordinator().status()).control.stopped).toBe(true);
  });

  it("after a key rotation (runbook 2.6, 7.4): a new secret that keeper() names on both contracts runs, with DEPLOYMENT's keeper still the old one (R4, D-M1)", async () => {
    const fresh = generatePrivateKey();
    const NEW = privateKeyToAccount(fresh).address;
    // the chains take the new key's transactions, and keeper() names it on both contracts
    const c = chains((w) => {
      closeDue(w);
      w.vault.keeper = NEW;
      w.door.keeper = NEW;
    }, NEW);
    await started();
    // testEnv's DEPLOYMENT names ME, the plan's first keeper: never a gate
    const r = await keeperRun({ ...testEnv, KEEPER_PRIVATE_KEY: fresh }, { print: () => undefined });
    expect(r.stoppedItself).toBeUndefined();
    expect(c.w.sends.map((s) => s.fn)).toEqual(["closeBatch"]);
  });

  it("a key whose address isn't keeper() on the front door sends nothing", async () => {
    const c = chains((w) => {
      closeDue(w);
      w.door.keeper = "0x000000000000000000000000000000000000dEaD";
    });
    await started();
    const r = await keeperRun(testEnv, { print: () => undefined });
    expect(c.w.sends).toEqual([]);
    expect(r.stoppedItself).toMatch(/the front door's keeper\(\) is 0x000000000000000000000000000000000000dEaD, not the keeper's key/);
  });

  it("a key with code on either chain (an EIP-7702 delegation) sends nothing, and stops the keeper", async () => {
    const c = chains((w) => {
      closeDue(w);
      w.codes[ME.toLowerCase()] = `0xef0100${"ab".repeat(20)}`;
    });
    await started();
    const r = await keeperRun(testEnv, { print: () => undefined });
    expect(c.w.sends).toEqual([]);
    expect(r.stoppedItself).toContain(`the keeper wallet ${ME} has code (an EIP-7702 delegation or a contract): an EIP-7702 delegation to 0x`);
  });

  it("no log line, error, stored row or response holds the key, through sends, a revert, a timeout and a node that echoes it", async () => {
    const printed: string[] = [];
    const c = chains((w) => {
      closeDue(w);
      w.vault.balance = 10n * 10n ** 18n;
    });
    await started();
    const runs = [];
    let t = Date.now();
    // a close that lands, a stake that reverts on chain, then a node whose errors carry the key in them
    c.w.fate = (x) => {
      if (x.fn === "closeBatch") {
        c.w.door.deposits = [];
        c.w.door.totalDeposits = 0n;
        c.w.door.id = 8n;
      }
      return x.fn === "stakeIdle" ? "revert" : "mine";
    };
    runs.push(await keeperRun(testEnv, { print: (l) => printed.push(l), now: () => t }));
    t += 61_000;
    runs.push(await keeperRun(testEnv, { print: (l) => printed.push(l), now: () => t }));
    t += 300_000;
    await started();
    c.hold.wait = async (f) => {
      if (f.method === "eth_blockNumber") throw new Error(`node error near ${KEY} (and ${bare.toUpperCase()})`);
    };
    runs.push(await keeperRun(testEnv, { print: (l) => printed.push(l), now: () => t }));
    c.hold.wait = async () => undefined;
    expect(c.w.sends.map((x) => x.fn)).toContain("stakeIdle");
    expect(runs[0].stoppedItself).toMatch(/reverted on chain/);
    const res = await exports.default.fetch("https://keeper.test/v1/keeper/status?runs=500", { headers: { authorization: `Bearer ${testEnv.TEST_TOKEN}` } });
    const body = await res.text();
    const stored = [await coordinator().status({ runs: 500 }), await coordinator().since({ sinceMs: 0 })];
    const everything = [...printed, ...runs.flatMap((r) => r.lines), body, ...stored, JSON.stringify(runs, (_k, v) => (typeof v === "bigint" ? String(v) : v))];
    expect(everything.filter(holdsKey)).toEqual([]);
    // and the redaction is what cut it out of the echoed error
    expect(printed.some((l) => l.includes("[the keeper's key]"))).toBe(true);
  });
});
