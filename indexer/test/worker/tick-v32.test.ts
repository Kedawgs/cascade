import { env } from "cloudflare:workers";
import { encodeFunctionData, type Hex, keccak256 } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { ADAPTER_V32, BIT_ADAPTER_V32, FRONT_DOOR_V32, SCHEDULABLE, VAULT, VAULT_V32 } from "../../src/abi.ts";
import { batchKey, encodeBatchMessage } from "../../src/crosscheck/replay.ts";
import { parkKeyOf } from "../../src/parks.ts";
import { RULES } from "../../src/rules/ids.ts";
import { STAKE_MISSING } from "./bridge-fixtures.ts";
import { ITEMS_KEY, MAX_LIVE_ITEMS, parseItems, parseRefused, REFUSED_KEY, type TrackedItem } from "../../src/scheduler.ts";
import { setMeta } from "../../src/store.ts";
import { expand, peerIdOf } from "../../src/snapshot.ts";
import deploymentV32 from "../fixtures/deployment-v3.2.json";
import { wipe } from "./d1-count.ts";
import { OWNER, RAIL_SETUP } from "./fake-deployment.ts";
import { rawLog, tx } from "./fixtures.ts";
import { h, rows, tickWorld } from "./tick-world.ts";

// A v3.2 deployment end to end: the tick scans with v3.2's events and reads through the lenses.

const db = env.DB;
beforeEach(async () => {
  await wipe(db);
});

const SAFE = "0x5afe5afe5afe5afe5afe5afe5afe5afe5afe0001" as Hex;
const A = "0x00000000000000000000000000000000000000a5" as Hex;

describe("a v3.2 deployment's tick", () => {
  it("stores its logs decoded with v3.2's events (the libraries' at the vault's address too), and a v3.1-shaped log as unknown", async () => {
    const w = tickWorld({ over: { DEPLOYMENT: JSON.stringify(deploymentV32) } });
    const d = w.cfg.deployment;
    expect(d.version).toBe("v3.2");
    const at = (n: number) => ({ block: 6_900_100n, logIndex: n, txHash: h(`v3.2 tx ${n}`) });
    w.addLogs("bittensor", [
      rawLog({ address: d.vault, abi: VAULT_V32, eventName: "StakeAdopted", args: { rao: 5n }, ...at(0) }),
      rawLog({ address: d.vault, abi: VAULT_V32, eventName: "PayoutBatchCancelled", args: { key: h("k"), reminted: 1n, bouncesCarried: 1 }, ...at(1) }),
      rawLog({ address: d.vault, abi: VAULT_V32, eventName: "ShortfallAbsorbed", args: { amount: 7n }, ...at(2) }),
      rawLog({ address: d.bitAdapter, abi: BIT_ADAPTER_V32, eventName: "ParkedDropped", args: { key: h("p") }, ...at(3) }),
      // v3-launch's six-field PayoutChunkSent: another topic, not one of this deployment's events
      rawLog({ address: d.vault, abi: VAULT, eventName: "PayoutChunkSent", args: { key: h("k"), chunk: 0, taken: 1, gross: 1n, net: 0n, fee: 0n }, ...at(4) }),
    ]);
    w.addLogs("base", [rawLog({ address: d.frontDoor, abi: FRONT_DOOR_V32, eventName: "PotSwept", args: { amount: 9n }, block: 37_000_300n, logIndex: 0, txHash: h("sweep") })]);
    expect((await w.tick()).outcome).toBe("done");
    const stored = await rows<{ contract: string; event: string }>("SELECT contract, event FROM logs ORDER BY chain, block, log_index");
    expect(stored).toEqual([
      { contract: "frontDoor", event: "PotSwept" },
      { contract: "vault", event: "StakeAdopted" },
      { contract: "vault", event: "PayoutBatchCancelled" },
      { contract: "vault", event: "ShortfallAbsorbed" },
      { contract: "bitAdapter", event: "ParkedDropped" },
      { contract: "vault", event: "unknown" },
    ]);
  });

  it("keeps the warning rules it couldn't judge for the digest (meta unjudged_warnings): root.pair_stamped until Task 62, written when the list changes", async () => {
    const w = tickWorld({ over: { DEPLOYMENT: JSON.stringify(deploymentV32) } });
    const listed = async () => ((await rows<{ v: string }>("SELECT v FROM meta WHERE k = 'unjudged_warnings'"))[0]?.v ?? "").split(",").filter(Boolean);
    expect((await w.tick()).outcome).toBe("done");
    const first = await listed();
    expect(first).toContain("root.pair_stamped");
    for (const r of first) expect(RULES[r as keyof typeof RULES]?.tier, r).toBe("warning");
    w.advance();
    await w.tick();
    expect(await listed()).toContain("root.pair_stamped");
  });

  it("reads through the lenses, then the owner's threshold and signers once a reading has named the owner", async () => {
    const w = tickWorld({
      over: { DEPLOYMENT: JSON.stringify(deploymentV32) },
      setup: (s) => {
        s.base.owner = SAFE;
        s.bit.owner = SAFE;
        s.base.safeOwners[SAFE] = { threshold: 2n, owners: [A, OWNER] };
        s.bit.safeOwners[SAFE] = { threshold: 2n, owners: [A, OWNER] };
      },
    });
    w.specs.base.code = { [SAFE]: "0x6080604052" };
    w.specs.bittensor.code = { [SAFE]: "0x6080604052" };
    await w.tick();
    const first = expand((await rows<{ json: string }>("SELECT json FROM readings ORDER BY at"))[0].json);
    expect(first.bittensor?.state).toMatchObject({ rootStakeRao: 49n * 10n ** 9n, bookedStake: 48n * 10n ** 9n, stakeMissing: false, exits: { open: true } });
    expect(first.base?.state).toMatchObject({ exits: { open: true }, potCarried: 7n * 10n ** 13n });
    // the first reading names the owner; the next asks it for its threshold and signers
    expect(first.base?.state).not.toHaveProperty("ownerSafe");
    w.advance();
    await w.tick();
    const next = expand((await rows<{ json: string }>("SELECT json FROM readings ORDER BY at DESC"))[0].json);
    expect(next.base?.state.ownerSafe).toEqual({ address: SAFE, threshold: 2n, signers: [A, OWNER] });
    expect(next.bittensor?.state.ownerSafe).toEqual({ address: SAFE, threshold: 2n, signers: [A, OWNER] });
  });

  it("reads scheduled(id) of each new Scheduled and of every item the admin rules keep, through the lenses, and emails the Scheduled at once", async () => {
    const G = "0x00000000000000000000000000000000000000b2" as Hex;
    const w = tickWorld({ over: { DEPLOYMENT: JSON.stringify(deploymentV32), ALERT_MODE: "send", ALERT_TO: "owner@example.com" } });
    const d = w.cfg.deployment;
    const readyAt = 1_800_000_000 + 8 * 86_400;
    const data = encodeFunctionData({ abi: SCHEDULABLE.vault, functionName: "setGuardian", args: [G] });
    const id = keccak256(data);
    w.state.bit.scheduled[id] = { scheduledAt: 1_799_999_000n, readyAt: BigInt(readyAt), class: 2, kind: 1, selector: data.slice(0, 10) as Hex, readyBlock: 6_960_000n };
    w.addLogs("bittensor", [
      rawLog({ address: d.vault, abi: VAULT_V32, eventName: "Scheduled", args: { id, kind: 1, selector: data.slice(0, 10), readyAt: BigInt(readyAt), data }, block: 6_900_100n, logIndex: 0, txHash: h("schedule") }),
    ]);
    expect((await w.tick()).outcome).toBe("done");
    const first = expand((await rows<{ json: string }>("SELECT json FROM readings ORDER BY at"))[0].json);
    expect(first.bittensor?.state.scheduled).toEqual({ [id]: { scheduledAt: 1_799_999_000, readyAt, class: 2, kind: 1, selector: data.slice(0, 10), readyBlock: 6_960_000n } });
    const mail = w.sent.find((m) => m.subject.includes("An owner change was scheduled on the vault: setGuardian"));
    expect(mail?.subject.startsWith("[CASCADE CRITICAL]")).toBe(true);
    expect(mail?.text).toContain("ready from block: 6960000");
    expect(mail?.text).toContain(`argument newGuardian: ${G}`);
    const meta = await rows<{ v: string }>(`SELECT v FROM meta WHERE k = '${ITEMS_KEY}'`);
    expect(parseItems(meta[0]?.v).map((x) => x.id)).toEqual([id]);
    // the next tick reads it again from the record, with no new log
    w.advance();
    await w.tick();
    const next = expand((await rows<{ json: string }>("SELECT json FROM readings ORDER BY at DESC"))[0].json);
    expect(Object.keys(next.bittensor?.state.scheduled ?? {})).toEqual([id]);
    expect(next.base?.state.scheduled).toEqual({});
  });

  it("with the record full, a flood of Scheduled still emails each one, the record_full critical and every other rule's email, and the tick commits", async () => {
    const w = tickWorld({ over: { DEPLOYMENT: JSON.stringify(deploymentV32), ALERT_MODE: "send", ALERT_TO: "owner@example.com" } });
    const d = w.cfg.deployment;
    const full: TrackedItem[] = Array.from({ length: MAX_LIVE_ITEMS }, (_, k) => ({
      chain: "base",
      role: "frontDoor",
      id: tx(700_000 + k),
      kind: 0,
      selector: "0x12345678",
      readyAt: 1_800_000_000 + 2 * 86_400,
      data: "0x12345678",
      uid: tx(800_000 + k),
      block: "1",
      tx: tx(900_000 + k),
    }));
    await setMeta(db, ITEMS_KEY, JSON.stringify(full)).run();
    const flood = Array.from({ length: 12 }, (_, k) => {
      const data = encodeFunctionData({ abi: SCHEDULABLE.vault, functionName: "setPayoutDelay", args: [BigInt(3600 + k)] });
      return rawLog({ address: d.vault, abi: VAULT_V32, eventName: "Scheduled", args: { id: keccak256(data), kind: 0, selector: data.slice(0, 10), readyAt: 1_800_200_000n, data }, block: 6_900_100n, logIndex: k, txHash: h(`flood ${k}`) });
    });
    const keeperSet = rawLog({ address: d.vault, abi: VAULT_V32, eventName: "KeeperSet", args: { keeper: "0x00000000000000000000000000000000000000c4" }, block: 6_900_101n, logIndex: 0, txHash: h("keeper set") });
    w.addLogs("bittensor", [...flood, keeperSet]);
    expect((await w.tick()).outcome).toBe("done");
    const subjects = w.sent.map((m) => m.subject);
    expect(subjects.filter((s) => s.includes("An owner change was scheduled on the vault: setPayoutDelay"))).toHaveLength(12);
    expect(subjects).toContain(`[CASCADE CRITICAL] Too many scheduled owner changes to track: 12 more beside the ${MAX_LIVE_ITEMS} tracked`);
    expect(subjects).toContain("[CASCADE CRITICAL] Admin event: vault KeeperSet");
    // the tick's writes went in: the reading, and the record still at its cap
    expect(await rows("SELECT at FROM readings")).toHaveLength(1);
    const meta = await rows<{ v: string }>(`SELECT v FROM meta WHERE k = '${ITEMS_KEY}'`);
    expect(parseItems(meta[0]?.v)).toHaveLength(MAX_LIVE_ITEMS);
    // the twelve refused are kept apart, in full, to be taken in once there is room
    const apart = await rows<{ v: string }>(`SELECT v FROM meta WHERE k = '${REFUSED_KEY}'`);
    expect(parseRefused(apart[0]?.v).items).toHaveLength(12);
  });
});

describe("R4: a flood of critical alerts can't resend the same first emails forever (D's unconfirmed item)", () => {
  it("about 300 new Scheduled in one tick: at most criticalEmailsPerTick (25) critical emails a tick, each Scheduled emailed exactly once, the rest the next ticks", async () => {
    const w = tickWorld({ over: { DEPLOYMENT: JSON.stringify(deploymentV32), ALERT_MODE: "send", ALERT_TO: "owner@example.com" } });
    const d = w.cfg.deployment;
    const flood = Array.from({ length: 300 }, (_, k) => {
      const data = encodeFunctionData({ abi: SCHEDULABLE.vault, functionName: "setPayoutDelay", args: [BigInt(3600 + k)] });
      return rawLog({ address: d.vault, abi: VAULT_V32, eventName: "Scheduled", args: { id: keccak256(data), kind: 0, selector: data.slice(0, 10), readyAt: 1_800_200_000n, data }, block: 6_900_100n, logIndex: k, txHash: h(`flood ${k}`) });
    });
    w.addLogs("bittensor", flood);
    const scheduled = () => w.sent.filter((m) => m.subject.includes("An owner change was scheduled on the vault: setPayoutDelay"));
    const criticalsSent: number[] = [];
    for (let i = 0; i < 14; i++) {
      const before = w.sent.filter((m) => m.subject.startsWith("[CASCADE CRITICAL]")).length;
      expect((await w.tick()).outcome).toBe("done");
      criticalsSent.push(w.sent.filter((m) => m.subject.startsWith("[CASCADE CRITICAL]")).length - before);
      w.advance();
    }
    expect(Math.max(...criticalsSent)).toBeLessThanOrEqual(25);
    expect(criticalsSent[0]).toBe(25);
    // every one of the 300 went out, once (each email names its own item: the same subject, its own body)
    const bodies = scheduled().map((m) => m.text);
    expect(bodies).toHaveLength(300);
    expect(new Set(bodies).size).toBe(300);
    // and the tick after the last sends nothing more
    expect(criticalsSent.at(-1)).toBe(0);
  });
});

describe("a v3.2 deployment's parks, end to end (Task 56)", () => {
  it("a front-door batch that parked, then was delivered later with deliverParked, passes the batch check with no hold; while parked its message isn't counted as arrived", async () => {
    const w = tickWorld({ over: { DEPLOYMENT: JSON.stringify(deploymentV32) } });
    const d = w.cfg.deployment;
    const user = `0x${"d".repeat(40)}` as Hex;
    const amount = 2n * 10n ** 18n;
    const id = 5n;
    const message = encodeBatchMessage(id, [{ user, amount }], []);
    const key = batchKey(8453n, d.frontDoor, message);
    const parkKey = parkKeyOf(8453n, d.frontDoor, d.vault, message);
    const m1 = h("a parked batch's message");
    w.addLogs("base", [
      rawLog({ address: d.frontDoor, abi: FRONT_DOOR_V32, eventName: "DepositRequested", args: { batchId: id, user, amount, payer: user }, block: 37_000_010n, logIndex: 0, txHash: h("deposit 5") }),
      rawLog({ address: d.baseAdapter, abi: ADAPTER_V32, eventName: "Sent", args: { messageId: m1, destChain: 964n, sender: d.frontDoor, recipient: d.vault, amount, fee: 1n, gasLimit: 1n }, block: 37_000_020n, logIndex: 0, txHash: h("close 5") }),
      rawLog({ address: d.frontDoor, abi: FRONT_DOOR_V32, eventName: "BatchClosed", args: { id, totalDeposits: amount, nDeposits: 1n, nRedeems: 0n, fee: 1n, potUsed: 0n, potCarried: 0n }, block: 37_000_020n, logIndex: 1, txHash: h("close 5") }),
    ]);
    const parkTx = h("park 5");
    w.addLogs("bittensor", [
      rawLog({ address: d.bitAdapter, abi: BIT_ADAPTER_V32, eventName: "BatchParked", args: { key: parkKey, messageId: m1, recipient: d.vault, sender: d.frontDoor, amount, converted: true, reason: STAKE_MISSING }, block: 6_900_120n, logIndex: 0, txHash: parkTx }),
      rawLog({ address: d.bitAdapter, abi: BIT_ADAPTER_V32, eventName: "Delivered", args: { messageId: m1, sourceChain: 8453n, sender: d.frontDoor, recipient: d.vault, amount }, block: 6_900_120n, logIndex: 1, txHash: parkTx }),
    ]);
    expect((await w.tick()).outcome).toBe("done");
    // parked: the message hasn't arrived, and nothing is held
    expect(await rows(`SELECT dst_tx FROM messages WHERE message_id = '${m1}'`)).toEqual([{ dst_tx: null }]);
    // ten minutes on, the keeper's deliverParked: the vault's BatchDelivered and outcome, then the adapter's ParkedDelivered
    w.advance(10);
    const dt = h("deliverParked 5");
    w.addLogs("bittensor", [
      rawLog({ address: d.vault, abi: VAULT_V32, eventName: "BatchDelivered", args: { key, sourceChain: 8453n, frontDoor: d.frontDoor, batchId: id, amount }, block: 6_900_230n, logIndex: 0, txHash: dt }),
      rawLog({ address: d.vault, abi: VAULT_V32, eventName: "Deposited", args: { key, user, assets: amount, shares: 1n }, block: 6_900_230n, logIndex: 1, txHash: dt }),
      rawLog({ address: d.bitAdapter, abi: BIT_ADAPTER_V32, eventName: "ParkedDelivered", args: { key: parkKey }, block: 6_900_230n, logIndex: 2, txHash: dt }),
    ]);
    for (let n = 0; n < 3; n++) {
      expect((await w.tick()).outcome).toBe("done");
      w.advance();
    }
    expect(await rows("SELECT status, message_id FROM batch_checks")).toEqual([{ status: "ok", message_id: m1 }]);
    expect((await w.status()).hold).toEqual({ active: false, ids: [] });
    expect(await rows("SELECT rule FROM alerts WHERE rule IN ('bridge.batch_mismatch', 'ccip.unexpected_source', 'bridge.parked', 'monitor.bridge_rule_failed', 'monitor.rule_failed')")).toEqual([]);
  });
});

describe("R4-O round 4: the monitor reads ForeverMoney's state where the rail now primary converts", () => {
  const N = "0x00000000000000000000000000000000000b2b2b" as Hex;
  const N2 = "0x00000000000000000000000000000000000b1b1b" as Hex;
  const NEW = "0x00000000000000000000000000000000000a2fa0" as Hex;
  const healthy = { isPaused: false, migrationReadyAt: 0n, migrationFinished: false, pausedUntil: 0n, pauseableAfter: 0n, migrationTarget: "0x0000000000000000000000000000000000000000" as Hex, migrationExecuted: false, pendingAdmin: ["0x0000000000000000000000000000000000000000", 0] as [Hex, number], backing: 101n * 10n ** 18n };
  /** after a migration: the deploy's vault finished; the replacement pair N/N2, whose Bittensor adapter names ForeverMoney's
   * new vault NEW, primary on both chains (or not yet: `switched` false); a redeem request waits in the open batch */
  function migratedWorld(switched: boolean) {
    return tickWorld({
      over: { DEPLOYMENT: JSON.stringify(deploymentV32) },
      setup: (s) => {
        s.bit.alpha.migrationExecuted = true;
        s.bit.alpha.migrationFinished = true;
        s.bit.vaults[NEW] = { ...healthy };
        s.base.openBatch = [7n, 1_700_000_000n, 0n, 0n, 0n, 1n];
        s.base.rails[N] = { remoteAdapter: N2, remoteChainId: 964n, enabled: true, known: true };
        s.bit.rails[N2] = { remoteAdapter: N, remoteChainId: 8453n, enabled: true, known: true, alphaVault: NEW };
        if (switched) {
          for (const a of Object.keys(s.base.rails)) if (a !== N) s.base.rails[a as Hex].enabled = false;
          for (const a of Object.keys(s.bit.rails)) if (a !== N2) s.bit.rails[a as Hex].enabled = false;
          s.base.primaryBridge = N;
          s.bit.primaryBridge = N2;
        }
      },
    });
  }
  const latest = async () => expand((await rows<{ json: string }>("SELECT json FROM readings ORDER BY at DESC"))[0].json);
  const open = async (rule: string) => (await rows<{ alert_key: string; subject: string }>(`SELECT alert_key, subject FROM alerts WHERE rule = '${rule}' AND resolved_at IS NULL`)).map((r) => [r.alert_key, r.subject]);

  it("after the switch the new vault is read: rail.alpha_vault and rail.payouts_closed clear, and the new vault's pause fires rail.alpha_vault", async () => {
    const w = migratedWorld(true);
    w.state.bit.doorStates[peerIdOf(8453n, w.cfg.deployment.frontDoor)] = 1;
    // ticks 1-2: the primary halves aren't read yet (railCandidates), so the deploy's vault is read: migrated
    await w.tick();
    w.advance();
    await w.tick();
    expect((await latest()).bittensor?.state.alphaVaults).toEqual([w.cfg.tokens.bittensor.alphaVault]);
    expect((await open("rail.alpha_vault")).map((x) => x[0])).toEqual(["rail.alpha_vault"]);
    // rail.payouts_closed reads the vault's primary's own canSendPayouts() (R4, S-H1): N2's, which converts at NEW and
    // reads open from tick 2 (tick 1 named it, unread: unjudged), so the old vault's migration never closed the new rail
    expect(await open("rail.payouts_closed")).toEqual([]);
    // tick 3: the readings name N2's AlphaVault, NEW: read there, healthy, so rail.alpha_vault clears too
    w.advance();
    await w.tick();
    expect((await latest()).bittensor?.state.alphaVaults).toEqual([NEW]);
    expect((await latest()).bittensor?.state.alpha).toMatchObject({ isPaused: false, migrationFinished: false, migrationReadyAt: 0n });
    // the target rule still reads the deploy adapter's own vault
    expect((await latest()).bittensor?.state.deployAlpha).toMatchObject({ vault: w.cfg.tokens.bittensor.alphaVault, migrationFinished: true });
    expect(await open("rail.alpha_vault")).toEqual([]);
    expect(await open("rail.payouts_closed")).toEqual([]);
    // the new vault paused: rail.alpha_vault fires again, naming it
    w.state.bit.vaults[NEW].isPaused = true;
    w.advance();
    await w.tick();
    expect(await open("rail.alpha_vault")).toEqual([["rail.alpha_vault", "ForeverMoney's AlphaVault is paused"]]);
    const facts = (await rows<{ body: string }>("SELECT body FROM alerts WHERE rule = 'rail.alpha_vault' AND resolved_at IS NULL"))[0].body;
    expect(facts).toContain(NEW);
  });

  it("before the switch the deploy's vault governs: its notice holds rail.payouts_closed open though a healthy new vault is named by a non-primary pair", async () => {
    const w = migratedWorld(false);
    w.state.bit.alpha.migrationExecuted = false;
    w.state.bit.alpha.migrationFinished = false;
    w.state.bit.alpha.migrationReadyAt = 1_900_000_000n;
    for (let i = 0; i < 4; i++) {
      await w.tick();
      w.advance();
    }
    expect((await latest()).bittensor?.state.alphaVaults).toEqual([w.cfg.tokens.bittensor.alphaVault]);
    expect((await open("rail.payouts_closed")).map((x) => x[0])).toEqual(["rail.payouts_closed:redeems:7"]);
    expect((await open("rail.alpha_vault")).map((x) => x[1])).toEqual(["ForeverMoney's AlphaVault is a migration is announced"]);
  });
});

describe("a v3.2 deployment's rails, end to end (Task 57c)", () => {
  it("rails.incoherent judges a primary outside BRIDGES from the halves the readings before named (railCandidates): it fires and holds on the fourth tick", async () => {
    // the front door switched alone to N, a Base adapter BRIDGES doesn't list; N's Bittensor half N' was never enabled on
    // the vault, so every batch closed would park in N'
    const N = "0x00000000000000000000000000000000000b2b2b" as Hex;
    const N2 = "0x00000000000000000000000000000000000b1b1b" as Hex;
    const w = tickWorld({
      over: { DEPLOYMENT: JSON.stringify(deploymentV32) },
      setup: (s) => {
        // the old primary, disabled for the switch (still known: the front door takes payouts through it)
        for (const a of Object.keys(s.base.rails)) s.base.rails[a as Hex].enabled = false;
        s.base.primaryBridge = N;
        s.base.rails[N] = { remoteAdapter: N2, remoteChainId: 964n, enabled: true, known: true };
        s.bit.rails[N2] = { remoteAdapter: N, remoteChainId: 8453n, enabled: false, known: false };
      },
    });
    expect(w.cfg.bridges.base).not.toContain(N);
    expect(w.cfg.bridges.bittensor).not.toContain(N2);
    // the launch door Active on the vault (the fake answers Unknown for a door it isn't told of: no launch door, moot)
    w.state.bit.doorStates[peerIdOf(8453n, w.cfg.deployment.frontDoor)] = 1;
    const latest = async () => expand((await rows<{ json: string }>("SELECT json FROM readings ORDER BY at DESC"))[0].json);
    const open = async () => (await rows<{ alert_key: string }>("SELECT alert_key FROM alerts WHERE rule = 'rails.incoherent' AND resolved_at IS NULL")).map((r) => r.alert_key);
    const held = async () => (await rows<{ id: string }>("SELECT id FROM holds WHERE rule = 'rails.incoherent'")).map((r) => r.id);
    // 1. the front door's primary is read (N), but only BRIDGES' halves: N isn't among them
    expect((await w.tick()).outcome).toBe("done");
    expect((await latest()).base?.state.rails?.[N]).toBeUndefined();
    // 2. the last reading named N as the front door's primary: N is read, and names its half N'
    w.advance();
    await w.tick();
    expect((await latest()).base?.state.rails?.[N]).toEqual({ remote: N2, remoteChainId: 964n, enabled: true, known: true, ...RAIL_SETUP.base });
    expect((await latest()).bittensor?.state.rails?.[N2]).toBeUndefined();
    // 3. the last reading named N' as the half of the front door's primary: N' is read on Bittensor, refused now, but
    // the reading before can't confirm it
    w.advance();
    await w.tick();
    // (its canSendPayouts(), R4 S-H1: open, its AlphaVault the deploy's, healthy)
    expect((await latest()).bittensor?.state.rails?.[N2]).toEqual({ remote: N, remoteChainId: 8453n, enabled: false, known: false, ...RAIL_SETUP.bittensor, canSendPayouts: true });
    expect(await open()).toEqual([]);
    expect(await held()).toEqual([]);
    // 4. two readings of both chains: the alert and its hold
    w.advance();
    await w.tick();
    expect(await open()).toEqual(["rails.incoherent:batches"]);
    expect(await held()).toHaveLength(1);
    expect((await held())[0]).toMatch(/^rails\.incoherent:batches:\d+:\d+$/);
  });
});
