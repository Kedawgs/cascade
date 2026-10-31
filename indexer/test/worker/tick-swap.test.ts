import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { wipe } from "./d1-count.ts";
import { h, rows, tickWorld } from "./tick-world.ts";

// A validator's hotkey swap, end to end through the tick: every nominator's stake moves to the validator's new
// hotkey, the vault still lists the old one, so rootStakeRao() and the share price collapse (shares would mint
// cheaply) until the new hotkey is re-added with addHotkey. The monitor must name the new hotkey and hold.

const db = env.DB;
const E18 = 10n ** 18n;
const STAKE = 49n * 10n ** 9n;

beforeEach(async () => {
  await wipe(db);
});

describe("a simulated hotkey swap", () => {
  it("raises stake.divergence naming the new hotkey, with a hold the keeper sees, and the email says to pause and addHotkey it", async () => {
    const w = tickWorld({ over: { ALERT_MODE: "send", ALERT_TO: "owner@example.com" } });
    const old = w.cfg.deployment.stakeHotkey;
    const NEW = h("the validator's new hotkey");
    // two healthy readings
    await w.tick();
    w.advance();
    await w.tick();
    expect((await w.status()).hold.active).toBe(false);

    // the swap: the chain now holds the vault coldkey's stake on NEW; the vault still lists `old`
    const x = w.state.bit;
    x.stakes = { [NEW]: STAKE };
    x.stakingHotkeys = [NEW];
    x.hotkeyOwner = null;
    x.rootStakeRao = 0n;
    x.totalAssets = E18 - 10n ** 12n;
    x.price = (x.totalAssets * E18) / x.totalSupply;

    // reading 3 learns the chain's list (the counted stake before it is remembered), 4 reads the stake on NEW, 5
    // confirms it, and the pair is judged once Bittensor is settled past it (two more ticks)
    const reports = [];
    for (let i = 0; i < 6; i++) {
      w.advance();
      reports.push(await w.tick());
    }
    expect(reports.every((r) => r.outcome === "done")).toBe(true);
    const alerts = await rows<{ alert_key: string; tier: string; subject: string }>("SELECT alert_key, tier, subject FROM alerts WHERE resolved_at IS NULL ORDER BY id");
    const divergence = alerts.find((a) => a.alert_key === `stake.divergence:${NEW}`);
    expect(divergence).toMatchObject({ tier: "critical", subject: "49 TAO of the vault's stake sits on a hotkey the vault doesn't list, and its counted stake fell by as much" });
    expect(alerts.find((a) => a.alert_key === `stake.unlisted:${NEW}`)).toBeUndefined();
    // one hold for the incident: stake.unexplained_drop's (it saw the stake leave the listed hotkey first), else this rule's
    const holds = await rows<{ id: string; cleared_at: number | null }>("SELECT id, cleared_at FROM holds WHERE cleared_at IS NULL");
    const fromDrop = holds.filter((r) => r.id.startsWith("stake.unexplained_drop:"));
    const fromDivergence = holds.filter((r) => r.id.startsWith(`stake.divergence:${NEW}:`));
    expect(fromDivergence).toHaveLength(fromDrop.length ? 0 : 1);
    expect((await w.status()).hold.active).toBe(true);
    const email = w.sent.find((m) => m.subject === "[CASCADE CRITICAL] 49 TAO of the vault's stake sits on a hotkey the vault doesn't list, and its counted stake fell by as much");
    expect(email).toBeDefined();
    expect(email?.text).toContain(`hotkey: ${NEW}`);
    expect(email?.text).toContain(`listed by the vault: ${old}`);
    expect(email?.text).toContain("Guardian: pause() the vault now");
    expect(email?.text).toContain(`addHotkey(${NEW})`);
    expect(email?.text).toContain(fromDrop.length ? "the hold: on, from stake.unexplained_drop" : "The hold is on");

    // the owner re-adds the hotkey: the price recovers, nothing new is raised, and the hold stays until cleared
    x.hotkeys = [old, NEW];
    x.rootStakeRao = STAKE;
    x.totalAssets = 50n * E18;
    x.price = E18;
    const sentBefore = w.sent.length;
    const holdsBefore = (await rows("SELECT id FROM holds")).length;
    for (let i = 0; i < 3; i++) {
      w.advance();
      await w.tick();
    }
    expect((await rows("SELECT id FROM holds")).length).toBe(holdsBefore);
    expect(w.sent.slice(sentBefore).filter((m) => m.subject.includes("doesn't list"))).toEqual([]);
    expect((await w.status()).hold.active).toBe(true);
  });

  it("a stranger's transfer_stake gift onto the vault's coldkey: the stake.unlisted warning names the hotkey, nothing holds", async () => {
    const w = tickWorld({ over: { ALERT_MODE: "send", ALERT_TO: "owner@example.com" } });
    const GIFT = h("a stranger's validator hotkey");
    await w.tick();
    w.advance();
    await w.tick();
    const x = w.state.bit;
    x.stakingHotkeys = [w.cfg.deployment.stakeHotkey, GIFT];
    x.stakes[GIFT] = 500_000n;
    for (let i = 0; i < 6; i++) {
      w.advance();
      await w.tick();
    }
    const alerts = await rows<{ alert_key: string; tier: string; subject: string }>("SELECT alert_key, tier, subject FROM alerts WHERE resolved_at IS NULL ORDER BY id");
    expect(alerts.find((a) => a.alert_key === `stake.unlisted:${GIFT}`)).toMatchObject({ tier: "warning", subject: "0.0005 TAO sits on a hotkey the vault doesn't list (the vault's counted stake didn't fall)" });
    expect(alerts.filter((a) => a.alert_key.startsWith("stake.divergence"))).toEqual([]);
    expect(await rows("SELECT id FROM holds")).toEqual([]);
    expect((await w.status()).hold.active).toBe(false);
    expect(w.sent.filter((m) => m.subject.startsWith("[CASCADE CRITICAL]"))).toEqual([]);
  });

  it("never fires through honest ticks: the keeper stakes, unstakes and claims on the listed hotkey", async () => {
    const w = tickWorld({ over: { ALERT_MODE: "send", ALERT_TO: "owner@example.com" } });
    const hk = w.cfg.deployment.stakeHotkey;
    const x = w.state.bit;
    const steps: (() => void)[] = [
      () => {
        x.stakes[hk] = STAKE + 10n ** 9n;
        x.rootStakeRao = STAKE + 10n ** 9n;
      },
      () => {
        x.stakes[hk] = STAKE - 4n * 10n ** 9n;
        x.rootStakeRao = STAKE - 4n * 10n ** 9n;
        x.balance = 6n * E18;
      },
      () => {
        x.stakes[hk] = STAKE;
        x.rootStakeRao = STAKE;
        x.unclaimed = 0n;
        x.price = E18 + 10n ** 15n;
      },
      () => {
        x.price = E18 + 2n * 10n ** 15n;
      },
    ];
    await w.tick();
    for (const step of steps) {
      step();
      w.advance();
      await w.tick();
    }
    // (the unstake step moves stake with no vault Unstaked log in this fake, which stake.unexplained_drop rightly
    // reports: only the divergence rule is judged here)
    const keys = (await rows<{ alert_key: string }>("SELECT alert_key FROM alerts")).map((r) => r.alert_key);
    expect(keys.filter((k) => k.startsWith("stake.divergence"))).toEqual([]);
    expect((await rows<{ id: string }>("SELECT id FROM holds")).filter((r) => r.id.startsWith("stake.divergence"))).toEqual([]);
    expect(w.sent.filter((m) => m.subject.includes("doesn't list"))).toEqual([]);
  });
});
