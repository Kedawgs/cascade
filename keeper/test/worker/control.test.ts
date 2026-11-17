import { reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { encodeFunctionData, keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEEPER_CALLS_V32 } from "../../../ops/src/keeper/core/abi.ts";
import { ADDR } from "../../../ops/test/keeper-v32-world.ts";
import { fromJson, toJson } from "../../../ops/src/keeper/core/memory.ts";
import { control } from "../../src/control.ts";

import { chains, closeDue, coordinator, KEY, ME, keeperRun, testEnv } from "./harness.ts";

// The control routes (design-keeper-worker.md §3, §6): the hand run's lease, the kill switch, the deliveries switch, a
// final refusal tried again, the status. The control token, compared by its SHA-256, guards each.

const call = (path: string, o: { body?: unknown; token?: string | null; method?: string } = {}) =>
  exports.default.fetch(`https://keeper.test${path}`, {
    method: o.method ?? (o.body === undefined ? "GET" : "POST"),
    headers: { ...(o.token === null ? {} : { authorization: `Bearer ${o.token ?? testEnv.TEST_TOKEN}` }), "content-type": "application/json" },
    ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
  });
const json = async (r: Response) => fromJson<Record<string, unknown>>(await r.text());

beforeEach(async () => {
  await reset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the control routes", () => {
  it("need the control token: none or a wrong one is refused before anything is read; an unset one says so", async () => {
    chains();
    expect((await call("/v1/keeper/status", { token: null })).status).toBe(401);
    expect((await call("/v1/keeper/status", { token: "not-the-token-0123456789" })).status).toBe(401);
    expect((await call("/v1/keeper/stop", { body: { reason: "x" }, token: "x" })).status).toBe(401);
    const unset = await control(new Request("https://keeper.test/v1/keeper/status", { headers: { authorization: `Bearer ${testEnv.TEST_TOKEN}` } }), { ...testEnv, CONTROL_TOKEN_SHA256: "" });
    expect(unset.status).toBe(503);
    expect(await json(unset)).toEqual({ error: "the keeper's control token isn't set (CONTROL_TOKEN_SHA256): pnpm keeper:new-token" });
    expect((await call("/nope")).status).toBe(404);
    expect((await call("/v1/keeper/status?runs=abc")).status).toBe(200);
    expect((await call("/v1/keeper/stop", { method: "GET" })).status).toBe(405);
  });

  it("are rate limited per client before the token is checked", async () => {
    let n = 0;
    const limited = { ...testEnv, KEEPER_LIMITER: { limit: async () => ({ success: ++n <= 2 }) } };
    const req = () => new Request("https://keeper.test/v1/keeper/status", { headers: { authorization: "Bearer wrong-wrong-wrong-wrong" } });
    expect((await control(req(), limited)).status).toBe(401);
    expect((await control(req(), limited)).status).toBe(401);
    expect((await control(req(), limited)).status).toBe(429);
  });

  it("stop, start, the deliveries switch and the status", async () => {
    const c = chains((w) => closeDue(w));
    const s0 = await json(await call("/v1/keeper/status"));
    expect(s0.control).toMatchObject({ stopped: true });
    expect(s0.key).toMatchObject({ address: ME, matchesDeployment: true, vaultKeeper: ME, frontDoorKeeper: ME, codeBase: "none", codeBittensor: "none", ethWei: 10n ** 18n, taoWei: 10n ** 18n });
    expect((await call("/v1/keeper/stop", { body: {} })).status).toBe(400);
    expect(await json(await call("/v1/keeper/start", { body: { by: "founder" } }))).toMatchObject({ control: { stopped: false, by: "founder" } });
    expect((await keeperRun(testEnv, { print: () => undefined })).outcome).toBe("ran");
    expect(c.w.sends).toHaveLength(1);
    expect(await json(await call("/v1/keeper/stop", { body: { reason: "a rotation", by: "founder" } }))).toMatchObject({ control: { stopped: true, reason: "a rotation", by: "founder" } });
    expect((await keeperRun(testEnv, { print: () => undefined, now: () => Date.now() + 120_000 })).outcome).toBe("stopped");
    expect(await json(await call("/v1/keeper/deliveries", { body: { on: false, by: "founder" } }))).toMatchObject({ control: { deliveries: false, deliveriesBy: "founder" } });
    const s = await json(await call("/v1/keeper/status?runs=100"));
    const lines = (s.runs as { line: string }[]).map((r) => r.line);
    expect(lines).toContain("STOPPED by founder: a rotation");
    expect(lines).toContain("DELIVERIES OFF by founder");
    expect(lines.some((l) => l.startsWith("STARTED by founder (it was stopped: a new keeper starts stopped"))).toBe(true);
    expect(s.memory).toMatchObject({ tick: 1, final: {} });
    expect(s.deployment).toBe("v3.2-launch");
  });

  it("the hand run's lease over HTTP: acquire, renew, release; only hand holders; --break by anyone with the token", async () => {
    chains();
    const a = await json(await call("/v1/lease", { body: { action: "acquire", holder: "hand:pc:1", ttlS: 600 } }));
    expect(a).toMatchObject({ granted: true });
    const token = a.token as number;
    expect((await call("/v1/lease", { body: { action: "acquire", holder: "cron:fake", ttlS: 60 } })).status).toBe(400);
    expect(await json(await call("/v1/lease", { body: { action: "acquire", holder: "hand:pc:2" } }))).toMatchObject({ granted: false, why: "held", holder: "hand:pc:1", kind: "hand" });
    expect(await json(await call("/v1/lease", { body: { action: "renew", holder: "hand:pc:1", token, ttlS: 600 } }))).toMatchObject({ ok: true });
    expect(await json(await call("/v1/lease", { body: { action: "renew", holder: "hand:pc:1", token: token + 1 } }))).toMatchObject({ ok: false });
    expect(await json(await call("/v1/lease", { body: { action: "break", by: "founder at the PC" } }))).toMatchObject({ was: { holder: "hand:pc:1" } });
    expect(await json(await call("/v1/lease", { body: { action: "release", holder: "hand:pc:1", token } }))).toMatchObject({ ok: false });
    expect(await json(await call("/v1/lease", { body: { action: "acquire", holder: "hand:pc:2" } }))).toMatchObject({ granted: true });
  });
});

describe("the hand run's journal over the control route", () => {
  /** A close the keeper's key signed, as a hand run writes it ahead */
  async function row(nonce: number, key: `0x${string}` = KEY) {
    const req = { chain: "base" as const, nonce, label: "close batch 7 and send it to Bittensor", to: ADDR.frontDoor, abi: KEEPER_CALLS_V32, functionName: "closeBatch", args: [7n, 1n], value: 1n };
    const data = encodeFunctionData({ abi: KEEPER_CALLS_V32, functionName: "closeBatch", args: [7n, 1n] });
    const raw = await privateKeyToAccount(key).signTransaction({ type: "eip1559", chainId: 8453, nonce, to: ADDR.frontDoor, value: 1n, data, gas: 300_000n, maxFeePerGas: 2n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n });
    return { hash: keccak256(raw), text: toJson({ chain: "base", from: privateKeyToAccount(key).address, nonce, hashes: [keccak256(raw)], request: req, raw, status: "signed", at: Date.now() }) };
  }

  it("after a key rotation (R4, D-M1): a hand run's row signed by the Worker's new key is taken over the route, and the cron run adopts it, while DEPLOYMENT's keeper is still the old one", async () => {
    const fresh = generatePrivateKey();
    const NEW = privateKeyToAccount(fresh).address;
    chains(
      (w) => {
        w.door.canClose = false;
        w.vault.keeper = NEW;
        w.door.keeper = NEW;
      },
      NEW,
    );
    // the Worker's secret is the new key; testEnv's DEPLOYMENT still names ME, the plan's first keeper
    const e = { ...testEnv, KEEPER_PRIVATE_KEY: fresh };
    const post = async (path: string, body: unknown) =>
      json(await control(new Request(`https://keeper.test${path}`, { method: "POST", headers: { authorization: `Bearer ${testEnv.TEST_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) }), e));
    const a = await post("/v1/lease", { action: "acquire", holder: "hand:pc:1" });
    // the old key's row is refused now: the Worker's key is the one a hand run signs with
    expect(await post("/v1/journal", { action: "writeAhead", holder: "hand:pc:1", token: a.token, row: (await row(2)).text })).toEqual({
      error: `the row is not proven by its own signed transaction (it is from ${ME}, not the keeper ${NEW}); nothing written`,
    });
    const { hash, text } = await row(3, fresh);
    expect(await post("/v1/journal", { action: "writeAhead", holder: "hand:pc:1", token: a.token, row: text })).toMatchObject({ ok: true });
    expect(await post("/v1/journal", { action: "update", holder: "hand:pc:1", token: a.token, patch: toJson([{ hash, patch: { status: "sent" } }]) })).toMatchObject({ ok: true });
    await post("/v1/lease", { action: "break", by: "founder" });
    await post("/v1/keeper/start", { by: "founder" });
    const r = await keeperRun(e, { print: () => undefined });
    expect(r.stoppedItself).toBeUndefined();
    expect(r.lines.some((l) => l.startsWith("Settling: close batch 7") && l.includes("it is watched from now")), r.lines.join("\n")).toBe(true);
  });

  it("writes are fenced by the hand lease; the Worker's next cron run watches a row the hand run left unsettled", async () => {
    const c = chains((w) => {
      w.door.canClose = false;
    });
    const a = await json(await call("/v1/lease", { body: { action: "acquire", holder: "hand:pc:1" } }));
    const token = a.token as number;
    const { hash, text } = await row(3);
    expect(await json(await call("/v1/journal", { body: { action: "writeAhead", holder: "hand:pc:1", token: token + 1, row: text } }))).toMatchObject({ ok: false });
    expect(await json(await call("/v1/journal", { body: { action: "writeAhead", holder: "hand:pc:1", token, row: text } }))).toMatchObject({ ok: true });
    // the hand run broadcast it: "sent", written through
    expect(await json(await call("/v1/journal", { body: { action: "update", holder: "hand:pc:1", token, patch: toJson([{ hash, patch: { status: "sent" } }]) } }))).toMatchObject({ ok: true });
    const since = await json(await call("/v1/journal", { body: { action: "since", sinceMs: 0 } }));
    expect(fromJson<{ hashes: string[]; status: string }[]>(since.rows as string).map((r) => [r.hashes, r.status])).toEqual([[[hash], "sent"]]);
    expect((await call("/v1/journal", { body: { action: "writeAhead", holder: "cron:x", token, row: text } })).status).toBe(400);
    // the hand run dies without releasing; its lease is broken, and the keeper started: the cron adopts its row
    await call("/v1/lease", { body: { action: "break", by: "founder" } });
    await call("/v1/keeper/start", { body: { by: "founder" } });
    const r = await keeperRun(testEnv, { print: () => undefined });
    expect(r.lines.some((l) => l.startsWith("Settling: close batch 7") && l.includes("it is watched from now"))).toBe(true);
    expect(c.w.sends).toEqual([]);
  });

  it("an update changes only a row's status, receipt, bridge message, what came back, or the settling's mark (0 kept), each of its own type; a write-ahead brings nothing more, and its time is the object's (the re-review's N2)", async () => {
    chains();
    const a = await json(await call("/v1/lease", { body: { action: "acquire", holder: "hand:pc:1" } }));
    const lease = { holder: "hand:pc:1", token: a.token as number };
    const { hash, text } = await row(3);
    // a row written ahead with a time of the caller's own (0: its replacement due at once) and fields a write-ahead never has
    const before = Date.now();
    const ahead = { ...fromJson<Record<string, unknown>>(text), at: 0, passedAt: 5, receipt: { hash, block: 1, gasUsed: 1n, costWei: 1n } };
    expect(await json(await call("/v1/journal", { body: { action: "writeAhead", ...lease, row: toJson(ahead) } }))).toMatchObject({ ok: true });
    const stored = async () => fromJson<Record<string, unknown>[]>(await coordinator().since({ sinceMs: 0 }))[0];
    const first = await stored();
    expect(first.at as number).toBeGreaterThanOrEqual(before);
    expect([first.passedAt, first.receipt]).toEqual([undefined, undefined]);
    const update = (patch: unknown) => call("/v1/journal", { body: { action: "update", ...lease, patch: toJson([{ hash, patch }]) } });
    const refused: [unknown, RegExp][] = [
      [{ request: { ...(first.request as object), args: [7n, 0n] } }, /a patch may change only status, receipt, messageId, returned, passedAt, not request/],
      [{ raw: "0x00", hashes: [hash] }, /not raw, hashes/],
      [{ at: 0 }, /, not at\); nothing written$/],
      [{ status: "mined" }, /mined is not a journal status/],
      [{ receipt: { hash } }, /its receipt is not \{hash, block, gasUsed, costWei\}/],
      [{ messageId: "0x12" }, /its bridge message is not a 32-byte id/],
      [{ returned: -1n }, /what came back is not an amount/],
      [{ passedAt: -1 }, /its mark is not a block number/],
    ];
    for (const [patch, why] of refused) {
      const res = await update(patch);
      expect(res.status, JSON.stringify(toJson(patch))).toBe(400);
      expect(String((await json(res)).error)).toMatch(why);
    }
    expect(await stored()).toEqual(first);
    // what a hand run's settling writes: a mark, its reset to 0, then a status and receipt
    for (const passedAt of [7, 0]) {
      expect(await json(await update({ passedAt }))).toMatchObject({ ok: true });
      expect((await stored()).passedAt).toBe(passedAt);
    }
    expect(await json(await update({ status: "landed", receipt: { hash, block: 9, gasUsed: 21_000n, costWei: 21_000n } }))).toMatchObject({ ok: true });
    expect([(await stored()).status, ((await stored()).receipt as { costWei: bigint }).costWei]).toEqual(["landed", 21_000n]);
    // the object itself takes no other field, whoever patches it (a run's commit included)
    await coordinator().update({ ...lease, patch: toJson([{ hash, patch: { request: { label: "anything" }, raw: "0x00", from: ADDR.vault } }]) });
    const last = await stored();
    expect([(last.request as { label: string }).label, last.raw, last.from]).toEqual([(first.request as { label: string }).label, first.raw, first.from]);
  });
});

describe("a hand run changes only its own rows, still signed or sent (the review's W1)", () => {
  /** A close the keeper's key signed at `nonce`, as a row written ahead */
  async function close(nonce: number) {
    const req = { chain: "base" as const, nonce, label: "close batch 7 and send it to Bittensor", to: ADDR.frontDoor, abi: KEEPER_CALLS_V32, functionName: "closeBatch", args: [7n, 1n], value: 1n };
    const data = encodeFunctionData({ abi: KEEPER_CALLS_V32, functionName: "closeBatch", args: [7n, 1n] });
    const raw = await privateKeyToAccount(KEY).signTransaction({ type: "eip1559", chainId: 8453, nonce, to: ADDR.frontDoor, value: 1n, data, gas: 300_000n, maxFeePerGas: 2n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n });
    return { hash: keccak256(raw), text: toJson({ chain: "base", from: ME, nonce, hashes: [keccak256(raw)], request: req, raw, status: "signed", at: Date.now() }) };
  }
  const cancelAt = (nonce: number) => privateKeyToAccount(KEY).signTransaction({ type: "eip1559", chainId: 8453, nonce, to: ME, value: 0n, data: "0x", gas: 21_000n, maxFeePerGas: 3n * 10n ** 9n, maxPriorityFeePerGas: 2n * 10n ** 8n });
  const lease = async (holder: string) => ({ holder, token: (await json(await call("/v1/lease", { body: { action: "acquire", holder } }))).token as number });
  const stored = async () => fromJson<{ status: string; hashes: string[] }[]>(await coordinator().since({ sinceMs: 0 }))[0];

  it("a row marked never sent: no cancel is attached to it over the route, and it never becomes sent there", async () => {
    chains();
    const one = await lease("hand:pc:1");
    const { hash, text } = await close(3);
    expect(await json(await call("/v1/journal", { body: { action: "writeAhead", ...one, row: text } }))).toMatchObject({ ok: true });
    // the Worker's settle found no node knew it, twice: never sent
    await coordinator().update({ ...one, patch: toJson([{ hash, patch: { status: "never-sent" } }]) });
    expect((await stored()).status).toBe("never-sent");
    const cancel = await cancelAt(3);
    const attach = await call("/v1/journal", { body: { action: "replaced", ...one, hash, next: { hash: keccak256(cancel), raw: cancel } } });
    expect(attach.status).toBe(400);
    expect(String((await json(attach)).error)).toBe(`the replacement is refused: the row of ${hash} is never-sent, and only a row still signed or sent is replaced; nothing written`);
    const sent = await call("/v1/journal", { body: { action: "update", ...one, patch: toJson([{ hash, patch: { status: "sent" } }]) } });
    expect(sent.status).toBe(400);
    expect(String((await json(sent)).error)).toBe(`the journal update is refused (the row of ${hash} is never-sent: a hand run changes the status only of a row still signed or sent); nothing written`);
    expect(await stored()).toMatchObject({ status: "never-sent", hashes: [hash] });
  });

  it("another hand run's row, or the Worker's: never replaced or changed over the route; the run's own: replaced and settled as before", async () => {
    chains();
    const one = await lease("hand:pc:1");
    const { hash, text } = await close(3);
    await call("/v1/journal", { body: { action: "writeAhead", ...one, row: text } });
    await call("/v1/lease", { body: { action: "break", by: "founder" } });
    const two = await lease("hand:pc:2");
    const cancel = await cancelAt(3);
    const replace = await call("/v1/journal", { body: { action: "replaced", ...two, hash, next: { hash: keccak256(cancel), raw: cancel } } });
    expect(replace.status).toBe(400);
    expect(String((await json(replace)).error)).toBe(`the replacement is refused: the row of ${hash} was written by hand:pc:1, and a hand run replaces only its own; nothing written`);
    const update = await call("/v1/journal", { body: { action: "update", ...two, patch: toJson([{ hash, patch: { status: "sent" } }]) } });
    expect(update.status).toBe(400);
    expect(String((await json(update)).error)).toBe(`the journal update is refused (the row of ${hash} was written by hand:pc:1: a hand run changes only its own rows); nothing written`);
    expect((await stored()).status).toBe("signed");
    // its own row: sent, replaced by its cancel, a receipt, then its bridge message recorded after it landed
    const { hash: h2, text: t2 } = await close(4);
    expect(await json(await call("/v1/journal", { body: { action: "writeAhead", ...two, row: t2 } }))).toMatchObject({ ok: true });
    expect(await json(await call("/v1/journal", { body: { action: "update", ...two, patch: toJson([{ hash: h2, patch: { status: "sent" } }]) } }))).toMatchObject({ ok: true });
    const c4 = await cancelAt(4);
    expect(await json(await call("/v1/journal", { body: { action: "replaced", ...two, hash: h2, next: { hash: keccak256(c4), raw: c4 } } }))).toMatchObject({ ok: true });
    expect(await json(await call("/v1/journal", { body: { action: "update", ...two, patch: toJson([{ hash: h2, patch: { status: "landed", receipt: { hash: keccak256(c4), block: 9, gasUsed: 21_000n, costWei: 21_000n } } }]) } }))).toMatchObject({ ok: true });
    expect(await json(await call("/v1/journal", { body: { action: "update", ...two, patch: toJson([{ hash: h2, patch: { messageId: `0x${"ee".repeat(32)}` } }]) } }))).toMatchObject({ ok: true });
  });
});
