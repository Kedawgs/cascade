import { describe, expect, it } from "vitest";
import type { FlowV1, Notice } from "./cascade/flow";
import { GENERATED_AT, goodFlow } from "./cascade/__fixtures__/flow-v1";
import { AMBER, flowView, type PageView, type StepView } from "./security-view";

// the visitor's clock at the moment the document arrived
const RECEIVED = 1_800_000_001_000;
const view = (flow: FlowV1 | null, now = RECEIVED, receivedAt = RECEIVED) => flowView(flow ? { flow, receivedAt } : null, now);
const all = (v: PageView) => [...v.stepsIn, ...v.stepsOut];
const step = (v: PageView, id: string): StepView => all(v).find((s) => s.id === id)!;
const figure = (s: StepView, label: string) => s.figures.find((f) => f.label === label)?.value;
const e18 = (n: number) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString();

describe("flowView", () => {
  it("passingWhenAllFresh", () => {
    const f = goodFlow();
    f.backing.ratioPpm = 1_000_000;
    const v = view(f);
    expect(v.status.kind).toBe("passing");
    expect(v.status.text).toBe("All checks passing, last checked 1 minute ago");
    expect(v.status.detail).toBeNull();
    expect(v.stepsIn.map((s) => s.id)).toEqual(["wallet", "swap", "backing", "bridge", "vault", "validator"]);
    expect(v.stepsOut.map((s) => s.id)).toEqual(["vaultOut", "bridgeBack", "swapOut", "walletOut"]);
    expect(all(v).every((s) => s.tone === "ok")).toBe(true);
    expect(v.notices).toEqual([]);
  });

  it("notOptimalWhenBackingBelowOne", () => {
    const v = view(goodFlow()); // 99.9% backed
    expect(step(v, "backing").tone).toBe("amber");
    expect(v.status.kind).toBe("notOptimal");
    expect(v.status.detail).toMatch(/backing/i);
  });

  it("amberStepWhenBridgeHasNoRoom", () => {
    for (const patch of [{ roomLeft: "0" }, { enabled: false }]) {
      const f = goodFlow();
      f.backing.ratioPpm = 1_000_000;
      f.bridgeIn = { ...f.bridgeIn, ...patch };
      const v = view(f);
      expect(step(v, "bridge").tone).toBe("amber");
      expect(step(v, "bridgeBack").tone).toBe("ok");
      expect(v.status.kind).toBe("notOptimal");
      expect(v.status.text).toBe("Conditions aren't optimal right now");
      expect(v.status.detail).toMatch(/bridge/i);
    }
    const g = goodFlow();
    g.bridgeOut = { ...g.bridgeOut, roomLeft: "0" };
    expect(step(view(g), "bridgeBack").tone).toBe("amber");
  });

  it("goes amber when the vault or the front door is paused", () => {
    const f = goodFlow();
    f.vault.paused = true;
    expect(step(view(f), "vault").tone).toBe("amber");
    expect(step(view(f), "vaultOut").tone).toBe("amber");
    const g = goodFlow();
    g.backing.ratioPpm = 1_000_000;
    g.frontDoor.paused = true;
    expect(view(g).status.kind).toBe("notOptimal");
  });

  it("staleChainShowsDashes", () => {
    const f = goodFlow();
    f.chains.bittensor = { block: "1", time: GENERATED_AT - 700, stale: true };
    // what the server sends for a stale chain: nulls
    f.backing = { alphaBacking: null, wTaoSupply: null, lockPoolFmTao: null, fmTaoSupplyBase: null, ratioPpm: null };
    f.bridgeOut = { roomLeft: null, capacity: null, perHour: null, enabled: null, inFlight: 1 };
    f.vault = { totalAssets: null, price: null, pendingPayouts: null, nextPayoutAt: null, paused: null };
    f.validator = { hotkey: null, ourStake: null, takeBps: null, backups: [] };
    const v = view(f);
    expect(v.status.kind).toBe("waiting");
    expect(v.status.text).toBe("Waiting for a fresh reading");
    for (const id of ["backing", "vault", "validator", "vaultOut", "bridgeBack"]) {
      const s = step(v, id);
      expect(s.headline, id).toBe("–");
      expect(s.tone, id).toBe("stale");
      expect(s.figures.length, id).toBeGreaterThan(0);
      for (const fig of s.figures) expect(fig.value, `${id} ${fig.label}`).toBe("–");
    }
    // Base's own numbers still show
    expect(step(v, "swap").headline).toMatch(/\d/);
    expect(step(v, "swap").tone).toBe("ok");
    expect(figure(step(v, "bridge"), "Room left")).toMatch(/\d/);
  });

  it("cantCheckOnNull", () => {
    const v = view(null);
    expect(v.status.kind).toBe("cantCheck");
    expect(v.status.text).toBe("We can't check right now");
    expect(all(v)).toHaveLength(10);
    for (const s of all(v)) for (const fig of s.figures) expect(fig.value).toBe("–");
    expect(v.notices).toEqual([]);
  });

  it("never shows NaN, Infinity or undefined for missing or degenerate numbers", () => {
    const f = goodFlow();
    f.chains.base = null;
    f.swap = { taoWethPoolTao: null, wethUsdcPoolUsdc: null, twapUsdcPerTao: null, spotUsdcPerTao: null, buyQuote1000Tao: null, sellQuote: null };
    f.bridgeIn = { roomLeft: "0", capacity: "0", perHour: "0", enabled: false, inFlight: 0 };
    f.backing.wTaoSupply = "0";
    const g = goodFlow();
    g.swap.twapUsdcPerTao = "0";
    g.swap.sellQuote = { taoIn: "0", usdcOut: "0" };
    g.swap.buyQuote1000Tao = "garbage";
    for (const doc of [view(f), view(g)]) expect(JSON.stringify(doc)).not.toMatch(/NaN|Infinity|undefined/);
  });

  it("the first reading after a deploy has no sell quote: a dash", () => {
    const f = goodFlow();
    f.swap.sellQuote = null;
    const v = view(f);
    expect(figure(step(v, "swapOut"), "A $1,000 payout costs")).toBe("–");
    expect(figure(step(v, "swap"), "A $1,000 deposit costs")).toBe("about 0.7%");
  });

  it("checkedAgoUsesTheServerClock", () => {
    // a visitor whose clock is 3 hours fast: receivedAt and now are both on that clock
    const skew = 3 * 3600_000;
    const f = goodFlow();
    f.backing.ratioPpm = 1_000_000;
    expect(view(f, RECEIVED + skew, RECEIVED + skew).status.text).toBe("All checks passing, last checked 1 minute ago");
    // the older of the two readings counts, and time passing on the visitor's clock adds to it
    f.chains.base!.time = GENERATED_AT - 300;
    expect(view(f).status.text).toBe("All checks passing, last checked 5 minutes ago");
    expect(view(f, RECEIVED + 5 * 60_000).status.text).toBe("All checks passing, last checked 10 minutes ago");
  });

  it("noticeTitlesAndEarliest", () => {
    const f = goodFlow();
    const a = f.addresses;
    const T = "0x00000000000000000000000000000000000000aa";
    const earliest = Date.UTC(2026, 10, 5, 9, 14) / 1000;
    const n: Notice[] = [
      { kind: "paused", chain: "bittensor", contract: a.vault },
      { kind: "ownershipPending", chain: "base", contract: a.frontDoor, target: T, tx: "0xabc" },
      { kind: "guardianProposed", chain: "base", contract: a.frontDoor, target: T, earliest },
      { kind: "bridgeProposed", chain: "bittensor", contract: a.vault, target: T, earliest },
      { kind: "frontDoorProposed", chain: "bittensor", contract: a.vault, target: T },
      { kind: "fmAdminScheduled", chain: "bittensor", contract: a.alphaVault, target: T, earliest },
      { kind: "fmMigration", chain: "bittensor", contract: a.alphaVault, earliest },
      { kind: "fmPaused", chain: "bittensor", contract: a.alphaVault },
    ];
    f.notices = n;
    const v = view(f);
    expect(v.notices.map((x) => x.title)).toEqual([
      "The vault is paused",
      "An ownership change is pending",
      "A new guardian is proposed",
      "A new bridge is proposed",
      "A new front door is proposed",
      "ForeverMoney has scheduled an admin change",
      "ForeverMoney has announced a migration",
      "ForeverMoney's vault is paused",
    ]);
    expect(v.notices.every((x) => x.tone === "info")).toBe(true);
    expect(v.notices[1].body).toContain("can be accepted at any time");
    expect(v.notices[2].body).toContain("can't take effect before Nov 5, 9:14 AM");
    expect(v.notices[4].body).toContain("can be accepted at any time");
    expect(v.notices[1].href).toBe("https://basescan.org/tx/0xabc"); // the transaction when stored
    expect(v.notices[0].href).toContain(a.vault); // else the contract
  });

  it("a stale Base half leaves the backing blank, never the other layer's better number", () => {
    // what the monitor sends when Base minted unbacked FM-TAO and its reading is stale: the lock layer unknown, so no ratio
    const f = goodFlow();
    f.chains.base = { block: "1", time: GENERATED_AT - 700, stale: true };
    f.backing = { alphaBacking: e18(13_992.6), wTaoSupply: e18(13_985.65), lockPoolFmTao: e18(13_985.61), fmTaoSupplyBase: null, ratioPpm: null };
    const v = view(f);
    const s = step(v, "backing");
    expect(s.headline).toBe("–");
    expect(s.tone).toBe("stale");
    expect(JSON.stringify(v)).not.toContain("100.04%");
    expect(v.status.kind).toBe("waiting");
  });

  it("backingHeadlineIsTheRatio", () => {
    expect(step(view(goodFlow()), "backing").headline).toBe("99.90%");
    const g = goodFlow();
    g.backing.ratioPpm = 999_999;
    expect(step(view(g), "backing").headline).toBe("99.99%"); // never rounds up to 100%
  });

  it("validatorNamesAndBackup", () => {
    const s = step(view(goodFlow()), "validator");
    expect(s.headline).toBe("tao.bot");
    expect(figure(s, "Backup validator")).toBe("Yuma");
    expect(figure(s, "Its cut")).toBe("18%");
    expect(figure(s, "Our stake with it")).toBe("1,234.5000 TAO");
    expect(s.link?.href).toMatch(/^https:\/\/taostats\.io\/validators\//);
    const f = goodFlow();
    f.validator.backups = [];
    expect(figure(step(view(f), "validator"), "Backup validator")).toBe("None");
  });

  it("costFigureFromTheQuote", () => {
    const v = view(goodFlow());
    expect(figure(step(v, "swap"), "A $1,000 deposit costs")).toBe("about 0.7%");
    expect(figure(step(v, "swapOut"), "A $1,000 payout costs")).toBe("about 0.7%");
    expect(figure(step(v, "swap"), "Price vs 30-minute average")).toBe("0.3% apart");
    expect(figure(step(v, "swap"), "TAO / WETH pool depth")).toBe("$800K");
    expect(figure(step(v, "swap"), "WETH / USDC pool depth")).toBe("$6M");
    expect(step(v, "swap").headline).toBe("$800K"); // the thinner pool
  });

  it("other figures", () => {
    const v = view(goodFlow());
    const b = step(v, "bridge");
    expect(b.headline).toBe("80 TAO");
    expect(figure(b, "Room left")).toBe("80 of 100 TAO");
    expect(figure(b, "Refills")).toBe("10 TAO per hour");
    expect(figure(b, "Transfers on the way")).toBe("2");
    expect(figure(b, "Next batch sends")).toBe("in 10 minutes");
    const va = step(v, "vault");
    expect(va.headline).toBe("1,234.50 TAO");
    expect(figure(va, "1 share is worth")).toBe("1.0500 TAO");
  });

  it("never passes beside a blank figure on a fresh chain", () => {
    const cases: [string, (f: FlowV1) => void, string][] = [
      ["twap null (oracle reverted)", (f) => { f.swap.twapUsdcPerTao = null; }, "swap"],
      ["ratioPpm null", (f) => { f.backing.ratioPpm = null; }, "backing"],
      ["bucket enabled null", (f) => { f.bridgeIn.enabled = null; }, "bridge"],
    ];
    for (const [name, patch, id] of cases) {
      const f = goodFlow();
      f.backing.ratioPpm = 1_000_000;
      patch(f);
      const v = view(f);
      expect(step(v, id).tone, name).toBe("stale");
      expect(v.status.kind, name).toBe("waiting");
      expect(v.status.text, name).toBe("Waiting for a fresh reading");
    }
  });

  it("the wallet steps never count as unknown", () => {
    const f = goodFlow();
    f.backing.ratioPpm = 1_000_000;
    const v = view(f);
    expect(step(v, "wallet").tone).toBe("ok");
    expect(step(v, "walletOut").tone).toBe("ok");
    expect(v.status.kind).toBe("passing");
  });

  it("noForbiddenWords", () => {
    const f = goodFlow();
    f.vault.paused = true;
    f.bridgeIn.roomLeft = "0";
    f.backing.ratioPpm = 900_000;
    f.notices = [
      { kind: "paused", chain: "base", contract: f.addresses.frontDoor },
      { kind: "ownershipPending", chain: "base", contract: f.addresses.staker, target: "0xaa" },
      { kind: "fmMigration", chain: "bittensor", contract: f.addresses.alphaVault, earliest: 1_900_000_000 },
    ];
    const stale = goodFlow();
    stale.chains.base!.stale = true;
    for (const doc of [view(f), view(goodFlow()), view(stale), view(null)]) {
      expect(JSON.stringify(doc)).not.toMatch(/safe|secure|guarantee/i);
    }
  });

  it("noForbiddenWords covers every amber sentence", () => {
    const flows: FlowV1[] = [];
    const mk = (patch: (f: FlowV1) => void) => { const f = goodFlow(); f.backing.ratioPpm = 1_000_000; patch(f); flows.push(f); };
    mk((f) => { f.backing.ratioPpm = 900_000; }); // backing
    mk((f) => { f.bridgeIn.roomLeft = "0"; }); // bridge
    mk((f) => { f.frontDoor.paused = true; }); // front door
    mk((f) => { f.vault.paused = true; }); // vault
    mk((f) => { f.bridgeOut.enabled = false; }); // bridge back
    const details = flows.map((f) => view(f).status.detail);
    expect(new Set(details).size).toBe(5);
    for (const d of details) expect(d).not.toMatch(/safe|secure|guarantee/i);
    for (const s of Object.values(AMBER)) expect(s).not.toMatch(/safe|secure|guarantee/i);
  });
});
