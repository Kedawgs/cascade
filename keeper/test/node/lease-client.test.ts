import { describe, expect, it } from "vitest";
import { classifyFailure } from "../../../ops/src/keeper/core/failures.ts";
import { fromJson, toJson } from "../../../ops/src/keeper/core/memory.ts";
import type { JournalRow } from "../../../ops/src/keeper/core/journal.ts";
import { make, routes, TOKEN, URL_ } from "./fake-routes.ts";
import { historyProblem, KeeperControl, keeperCommand, LeaseLost, NoLease, parseKeeperCommand, statusLines, takeHandFlags, takeWithoutLease, withoutLeaseWarning } from "../../../ops/src/keeper/lease-client.ts";

// The PC's side of the lease (ops/src/keeper/lease-client.ts; design-keeper-worker.md §3): a hand run takes the
// Worker's lease over HTTPS, waits up to 3 minutes while a cron run holds it, renews it every 2 minutes and before every
// send, and releases it on exit; `pnpm ops keeper …` drives the kill switch and the status. Here against a fake of the
// control routes; test/node/bundle.test.ts runs it against the bundled Worker.

describe("the hand run's lease", () => {
  it("takes the lease, renews it before a send, releases it; a lease lost since stops the next send (a stop, never a retry)", async () => {
    const r = routes();
    const lines: string[] = [];
    const lease = await make(r, lines).acquire("v3.2-launch");
    expect(lease.token).toBe(1);
    expect(lines).toEqual(["The keeper's lease is this hand run's (token 1): the Worker's cron waits until it is released"]);
    await lease.renew();
    // broken from elsewhere: the next renew fails, and so does every later one
    r.st.holder = null;
    r.st.token++;
    const e = await lease.renew().catch((x: Error) => x);
    expect(e).toBeInstanceOf(LeaseLost);
    expect((e as Error).message).toBe("LEASE LOST: the lease is no longer this run's; this hand run sends nothing more");
    expect(classifyFailure(e).stop).toBe(true);
    await expect(lease.renew()).rejects.toBeInstanceOf(LeaseLost);
    await lease.release();
  });

  it("waits up to 3 minutes while a cron run holds the lease, then takes it", async () => {
    const r = routes();
    r.st.holder = "cron:abc";
    r.st.kind = "cron";
    r.st.until = r.st.now + 50_000;
    const lines: string[] = [];
    const lease = await make(r, lines).acquire("v3.2-launch");
    expect(lines[0]).toBe(`The Worker's run (cron:abc) holds the keeper's lease until ${new Date(1_050_000).toISOString()}: waiting for it, at most 3 minutes`);
    expect(lease.token).toBe(1);
    await lease.release();
    expect(r.st.holder).toBeNull();
  });

  it("refuses at once when another hand run holds it, and after 3 minutes of cron runs", async () => {
    const r = routes();
    r.st.holder = "hand:other:9";
    r.st.kind = "hand";
    r.st.until = r.st.now + 600_000;
    await expect(make(r, []).acquire("v3.2-launch")).rejects.toThrow(
      `another hand run (hand:other:9) holds the keeper's lease until ${new Date(1_600_000).toISOString()}: never run two keepers at once; if none is running, free it with pnpm ops keeper lease --break; nothing sent`,
    );
    const busy = routes();
    busy.st.holder = "cron:x";
    busy.st.kind = "cron";
    busy.st.until = busy.st.now + 36_000_000;
    await expect(make(busy, []).acquire("v3.2-launch")).rejects.toThrow("the Worker's run still holds the keeper's lease after 3 minutes: try again, or stop the Worker first (pnpm ops keeper stop --reason \"…\"); nothing sent");
  });

  it("refuses a Worker that runs another deployment, and an unreachable one (naming --without-lease)", async () => {
    await expect(make(routes({ deployment: "v3.2-test" }), []).acquire("v3.2-launch")).rejects.toThrow("the keeper at OPS_KEEPER_URL runs v3.2-test, not v3.2-launch: set OPS_KEEPER_URL to this deployment's keeper; nothing sent");
    const down = routes();
    down.st.down = true;
    const e = await make(down, []).acquire("v3.2-launch").catch((x: Error) => x);
    expect(e).toBeInstanceOf(NoLease);
    expect((e as Error).message).toBe('the keeper\'s control route can\'t be reached (fetch failed): nothing sent. If Cloudflare is down, a one-shot command may go ahead with --without-lease "<reason>"');
  });

  it("renews by itself every 2 minutes while the run is long", async () => {
    const r = routes();
    let tick: () => Promise<void> = async () => undefined;
    const lease = await make(r, [], { every: (f) => ((tick = f), () => undefined) }).acquire("v3.2-launch");
    r.st.now += 120_000;
    await tick();
    expect(r.st.calls.filter((c) => c.body.action === "renew")).toHaveLength(1);
    expect(r.st.until).toBe(r.st.now + 600_000);
    await lease.release();
  });
});

describe("the hand run's journal is the Worker's (the spend cap counts both)", () => {
  const row = (hash: string, at: number): JournalRow =>
    ({ chain: "base", from: "0x00000000000000000000000000000000000000A1", nonce: 4, hashes: [hash as never], request: { chain: "base", nonce: 4, label: "close batch 9 and send it to Bittensor", to: "0x00000000000000000000000000000000000000B2", abi: [], functionName: "closeBatch", args: [9n, 10n ** 18n], value: 3n * 10n ** 15n }, raw: "0x02", status: "signed", at }) as JournalRow;

  it("writes ahead, replaces and moves rows on through the lease; reads the last day back, the Worker's rows too", async () => {
    const r = routes();
    r.st.journal.push(row("0xc0", 900_000));
    const ctl = make(r, []);
    const lease = await ctl.acquire("v3.2-launch");
    expect(lease.deliveries).toBe(true);
    const j = lease.journal;
    await j.writeAhead(row("0xaa", 1_000_000));
    await j.update("0xaa", { status: "sent" });
    await j.replaced("0xaa", { hash: "0xab", raw: "0x03" });
    expect((await j.pending()).map((x) => x.hashes)).toEqual([["0xc0"], ["0xaa", "0xab"]]);
    await j.update("0xab", { status: "landed", receipt: { hash: "0xab", block: 5, gasUsed: 21_000n, costWei: 21_000n } });
    expect((await j.pending()).map((x) => x.hashes)).toEqual([["0xc0"]]);
    expect(r.st.journal.map((x) => [x.hashes, x.status])).toEqual([
      [["0xc0"], "signed"],
      [["0xaa", "0xab"], "landed"],
    ]);
    expect((await j.since(950_000)).map((x) => x.hashes[0])).toEqual(["0xaa"]);
    expect((await j.since(0)).map((x) => x.hashes[0])).toEqual(["0xc0", "0xaa"]);
    // pending: the Worker's unsettled rows too (the spend cap counts them, settlePending settles them)
    expect((await j.pending()).map((x) => x.hashes[0])).toEqual(["0xc0"]);
    expect(r.st.journal[1].request.args).toEqual([9n, 10n ** 18n]);
    await lease.release();
  });

  it("leaves the Worker's rows to the Worker: a row it didn't write is settled for its own spend cap only, never written, so the Worker's next run still adopts it and reports it (the re-review's N6)", async () => {
    const r = routes();
    // a row a cut-off Worker run left "sent", with no watch
    r.st.journal.push({ ...row("0xc0", 900_000), status: "sent" });
    const lease = await make(r, []).acquire("v3.2-launch");
    const j = lease.journal;
    const writes = () => r.st.calls.filter((c) => c.path === "/v1/journal" && c.body.action === "update").length;
    // the hand run's settling finds its receipt, then marks another of its hashes: kept in this run, never sent to the Worker
    await j.update("0xc0", { status: "landed", receipt: { hash: "0xc0", block: 5, gasUsed: 21_000n, costWei: 42_000n } });
    expect(writes()).toBe(0);
    expect(r.st.journal[0].status).toBe("sent");
    expect((await j.pending()).map((x) => x.hashes[0])).toEqual([]);
    expect((await j.since(0)).map((x) => [x.hashes[0], x.status, x.receipt?.costWei])).toEqual([["0xc0", "landed", 42_000n]]);
    // its own rows are written through, as before
    await j.writeAhead(row("0xaa", 1_000_000));
    await j.update("0xaa", { status: "sent" });
    expect(writes()).toBe(1);
    expect(r.st.journal[1].status).toBe("sent");
    await lease.release();
  });

  it("a write-ahead the Worker refuses (the lease lost) is never broadcast: it throws LeaseLost", async () => {
    const r = routes();
    const lease = await make(r, []).acquire("v3.2-launch");
    r.st.holder = "hand:someone-else";
    const e = await lease.journal.writeAhead(row("0xdd", 1_000_000)).catch((x: Error) => x);
    expect(e).toBeInstanceOf(LeaseLost);
    expect((e as Error).message).toBe("close batch 9 and send it to Bittensor not sent: the lease is no longer this run's");
  });
});

describe("the hand run's history probe", () => {
  it("refuses a Bittensor RPC without the vault's logs at its creation block (a pruned node)", async () => {
    const rpc = (logs: unknown[]) => ({ request: async (_c: string, m: string) => (m === "eth_getLogs" ? logs : null) }) as never;
    const vault = "0x00000000000000000000000000000000000000B2";
    expect(await historyProblem(rpc([{}]), vault, 6_000_000)).toBeUndefined();
    expect(await historyProblem(rpc([]), vault, 6_000_000)).toBe(
      "this Bittensor RPC has no logs at block 6000000, where the vault was created: it doesn't keep history (a pruned node); use an archive node (archive.chain.opentensor.ai); nothing sent",
    );
  });
});

describe("--without-lease", () => {
  it("is taken off the arguments with its reason; one-shot commands only; a reason is needed", () => {
    expect(takeWithoutLease(["close", "--live", "--without-lease", "Cloudflare is down"])).toEqual({ argv: ["close", "--live"], withoutLease: "Cloudflare is down" });
    expect(takeWithoutLease(["close", "--live"])).toEqual({ argv: ["close", "--live"] });
    expect(() => takeWithoutLease(["run", "--live", "--without-lease", "x"])).toThrow("--without-lease is for one-shot commands (close, stake, payouts, reexec, claim, adopt, add-hotkey, remove-hotkey, park), never run");
    expect(() => takeWithoutLease(["close", "--without-lease"])).toThrow('--without-lease needs a reason: --without-lease "Cloudflare is down"');
    expect(() => takeWithoutLease(["close", "--without-lease", "--live"])).toThrow('--without-lease needs a reason: --without-lease "Cloudflare is down"');
  });

  it("--ignore-monitor-outage --until goes with it as a hand run's flag", () => {
    expect(takeHandFlags(["run", "--live", "--ignore-monitor-outage", "--until", "2027-01-18T14:05Z"])).toEqual({ argv: ["run", "--live"], ignoreMonitorOutageUntil: "2027-01-18T14:05Z" });
    expect(takeHandFlags(["close", "--without-lease", "down", "--ignore-monitor-outage", "--until", "2027-01-18T14:05Z"])).toEqual({ argv: ["close"], withoutLease: "down", ignoreMonitorOutageUntil: "2027-01-18T14:05Z" });
    expect(() => takeHandFlags(["run", "--ignore-monitor-outage"])).toThrow("--ignore-monitor-outage needs --until <a UTC time at most 24 hours ahead, e.g. 2027-01-18T14:05Z>");
    expect(() => takeHandFlags(["run", "--until", "2027-01-18T14:05Z"])).toThrow("--until goes with --ignore-monitor-outage");
  });

  it("says so loudly", () => {
    expect(withoutLeaseWarning("Cloudflare is down")).toEqual([
      "WITHOUT THE LEASE: Cloudflare is down.",
      "WITHOUT THE LEASE: the Worker may act at the same time. Only the nonce keeps two transactions from both landing (one key, one nonce a chain). Stop the Worker first if you can: pnpm ops keeper stop --reason \"…\"",
      "WITHOUT THE LEASE: the 24 h spend cap counts only this command's sends, not the Worker's.",
    ]);
  });
});

describe("pnpm ops keeper", () => {
  it("parses its commands", () => {
    expect(parseKeeperCommand(["status"])).toEqual({ sub: "status", runs: 20 });
    expect(parseKeeperCommand(["status", "--runs", "100"])).toEqual({ sub: "status", runs: 100 });
    expect(parseKeeperCommand(["stop", "--reason", "rotating the key"])).toEqual({ sub: "stop", reason: "rotating the key" });
    expect(parseKeeperCommand(["start"])).toEqual({ sub: "start" });
    expect(parseKeeperCommand(["lease", "--break"])).toEqual({ sub: "lease-break" });
    expect(parseKeeperCommand(["deliveries", "off"])).toEqual({ sub: "deliveries", on: false });
    expect(parseKeeperCommand(["retry", "payouts:0xab"])).toEqual({ sub: "retry", key: "payouts:0xab" });
    for (const bad of [[], ["stop"], ["lease"], ["deliveries", "maybe"], ["retry"], ["nap"], ["status", "--runs", "x"]]) expect(() => parseKeeperCommand(bad), bad.join(" ")).toThrow(/^pnpm ops keeper /);
  });

  it("stop, start and --break go through the control routes and say what they did", async () => {
    const r = routes();
    const lines: string[] = [];
    const env = { OPS_KEEPER_URL: URL_, OPS_KEEPER_CONTROL_TOKEN: TOKEN };
    expect(await keeperCommand(["stop", "--reason", "rotating the key"], env, (l) => lines.push(l), { fetch: r.f, by: "founder@pc" })).toBe(0);
    expect(r.st.calls.at(-1)).toEqual({ path: "/v1/keeper/stop", body: { reason: "rotating the key", by: "founder@pc" } });
    expect(await keeperCommand(["start"], env, (l) => lines.push(l), { fetch: r.f, by: "founder@pc" })).toBe(0);
    r.st.holder = "hand:stuck";
    r.st.kind = "hand";
    expect(await keeperCommand(["lease", "--break"], env, (l) => lines.push(l), { fetch: r.f, by: "founder@pc" })).toBe(0);
    expect(lines).toEqual([
      "v3.2-launch: STOPPED (rotating the key). The next cron run doesn't start; a send in flight finishes.",
      "v3.2-launch: started. The next cron run, within a minute, goes ahead.",
      "v3.2-launch: the lease is free (it was hand:stuck's, hand, token 0). Its old holder can no longer renew or write.",
    ]);
    expect(await keeperCommand(["start"], {}, (l) => lines.push(l), { fetch: r.f })).toBe(1);
    expect(lines.at(-1)).toBe("Set OPS_KEEPER_URL (the keeper's own hostname) and OPS_KEEPER_CONTROL_TOKEN (pnpm keeper:new-token) in ops/.env; nothing done");
  });

  it("status prints the switch, the lease, the memory with its final refusals, the unsettled sends, the key and the last runs", async () => {
    const r = routes();
    const s = fromJson<Record<string, unknown>>(await (await r.f(`${URL_}/v1/keeper/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).text());
    expect(statusLines(s)).toEqual([
      "Keeper v3.2-launch: STOPPED (a new keeper starts stopped), by founder at 1970-01-01T00:15:40.000Z",
      "Deliveries: on",
      "Lease: free (token 0)",
      `Memory: round 12, next round due ${new Date(1_030_000).toISOString()}, 0 failed rounds in a row; saved ${new Date(980_000).toISOString()}`,
      "FINAL (not tried again until pnpm ops keeper retry <key>): payouts:0xab: REPORT: payout batch 0xab…: NotScheduled",
      `Unsettled: Base nonce 4 sent: close batch 9 and send it to Bittensor (0xaa), since ${new Date(960_000).toISOString()}`,
      "Key: 0x00000000000000000000000000000000000000A1, keeper() on both contracts: yes; keeper() on the vault: 0x00000000000000000000000000000000000000A1, on the front door: 0x00000000000000000000000000000000000000A1; the plan's first keeper: this key; code on Base: none, on Bittensor: none; 0.005 ETH, 0.1 TAO",
      "Last runs:",
      `  ${new Date(940_000).toISOString()}  Round 12 (lease token 7): Done: closing the batch`,
    ]);
  });
});
