import { describe, expect, it } from "vitest";
import type { FlowV1, Notice } from "./cascade/flow";
import { GENERATED_AT, goodFlow, goodFlowV32 } from "./cascade/__fixtures__/flow-v1";
import { formatDateTime } from "./format";
import { AMBER, flowView, heroNumbers, type PageView, type StepView, ROUTE_POOL_FEES, swapCost } from "./security-view";

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
    expect(v.stepsOut.map((s) => s.id)).toEqual(["request", "vaultOut", "bridgeBack", "swapOut", "walletOut"]);
    expect(all(v).every((s) => s.tone === "ok")).toBe(true);
    expect(v.notices).toEqual([]);
  });

  it("notOptimalWhenBackingBelowOne", () => {
    const v = view(goodFlow()); // 99.9% backed
    expect(step(v, "backing").tone).toBe("amber");
    expect(v.status.kind).toBe("notOptimal");
    expect(v.status.detail).toMatch(/backing/i);
  });

  it("the backing sentence names the layer that is short, as the figures show it", () => {
    // the AlphaVault layer short (999 held against 1,000 issued), the lock layer full
    const held = view(goodFlow());
    expect(held.status.detail).toBe(AMBER.backing.held);
    expect(figure(step(held, "backing"), "TAO held")).toBe("999 TAO");
    // the lock layer short (the reviewer's case, fresh: Base minted 20,000 against a lock of 13,985.61)
    const f = goodFlow();
    f.backing = { alphaBacking: e18(13_992.6), wTaoSupply: e18(13_985.65), lockPoolFmTao: e18(13_985.61), fmTaoSupplyBase: e18(20_000), ratioPpm: 699_280 };
    const lock = view(f);
    expect(step(lock, "backing").headline).toBe("69.92%");
    expect(lock.status.detail).toBe(AMBER.backing.locked);
    expect(figure(step(lock, "backing"), "TAO locked for bridged TAO")).toBe("13,985.61 TAO");
    expect(figure(step(lock, "backing"), "Bridged TAO on Base")).toBe("20,000 TAO");
    // both short
    const g = goodFlow();
    g.backing = { ...g.backing, lockPoolFmTao: e18(990), ratioPpm: 990_000 };
    expect(view(g).status.detail).toBe(AMBER.backing.both);
    for (const s of [AMBER.backing.held, AMBER.backing.locked, AMBER.backing.both]) expect(s).toMatch(/^Backing is below 100% right now/);
    expect(AMBER.backing.locked).toContain("TAO locked for bridged TAO");
    expect(AMBER.backing.locked).toContain("bridged TAO on Base");
    expect(AMBER.backing.held).toContain("TAO held");
  });

  it("amberStepWhenBridgeHasNoRoom", () => {
    // no room left, or a lane closed (a pool no longer lists the other chain)
    for (const patch of [{ roomLeft: "0" }, { supported: false, enabled: null, roomLeft: null, capacity: null, perHour: null }]) {
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

  it("a limiter that is off is no limit (ok), a closed lane is amber, an unknown one waits", () => {
    const base = () => { const f = goodFlow(); f.backing.ratioPpm = 1_000_000; return f; };
    // CCIP's isEnabled false on both pools: transfers pass unlimited
    const off = base();
    off.bridgeIn = { roomLeft: null, capacity: null, perHour: null, enabled: false, supported: true, inFlight: 1 };
    off.bridgeOut = { ...off.bridgeIn, inFlight: 0 };
    const v = view(off);
    for (const id of ["bridge", "bridgeBack"]) {
      expect(step(v, id).headline, id).toBe("No limit");
      expect(step(v, id).tone, id).toBe("ok");
      expect(figure(step(v, id), "Room left"), id).toBe("No limit");
      for (const fig of step(v, id).figures) expect(fig.value, `${id} ${fig.label}`).not.toBe("–");
    }
    expect(v.status.kind).toBe("passing");
    expect(JSON.stringify(v)).not.toMatch(/switched off/i);
    // a lane closed: amber, its own words
    const closed = base();
    closed.bridgeIn = { roomLeft: null, capacity: null, perHour: null, enabled: null, supported: false, inFlight: 0 };
    const c = view(closed);
    expect(step(c, "bridge").headline).toBe("Closed");
    expect(step(c, "bridge").tone).toBe("amber");
    expect(c.status.kind).toBe("notOptimal");
    expect(c.status.detail).toMatch(/closed/i);
    // support unknown: the step waits, whatever the limiter says
    const unknown = base();
    unknown.bridgeIn = { ...unknown.bridgeIn, supported: null };
    expect(step(view(unknown), "bridge").tone).toBe("stale");
    expect(view(unknown).status.kind).toBe("waiting");
  });

  it("a bridge direction needs both chains fresh: its two pools sit one on each", () => {
    const f = goodFlow();
    f.backing.ratioPpm = 1_000_000;
    f.chains.base = { block: "1", time: GENERATED_AT - 700, stale: true };
    const v = view(f);
    expect(step(v, "bridgeBack").headline).toBe("–");
    expect(step(v, "bridgeBack").tone).toBe("stale");
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
    f.bridgeOut = { roomLeft: null, capacity: null, perHour: null, enabled: null, supported: null, inFlight: 1 };
    f.vault = { totalAssets: null, price: null, pendingPayouts: null, nextPayoutAt: null, paused: null };
    f.validator = { hotkey: null, ourStake: null, takeBps: null, backups: null };
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
    // Base's own numbers still show; the bridge in needs the lock pool on Bittensor too
    expect(step(v, "swap").headline).toMatch(/\d/);
    expect(step(v, "swap").tone).toBe("ok");
    expect(figure(step(v, "bridge"), "Room left")).toBe("–");
    expect(step(v, "bridge").tone).toBe("stale");
  });

  it("cantCheckOnNull", () => {
    const v = view(null);
    expect(v.status.kind).toBe("cantCheck");
    expect(v.status.text).toBe("We can't check right now");
    expect(all(v)).toHaveLength(11);
    for (const s of all(v)) for (const fig of s.figures) expect(fig.value).toBe("–");
    expect(v.notices).toEqual([]);
  });

  it("never shows NaN, Infinity or undefined for missing or degenerate numbers", () => {
    const f = goodFlow();
    f.chains.base = null;
    f.swap = { taoWethPoolTao: null, wethUsdcPoolUsdc: null, twapUsdcPerTao: null, spotUsdcPerTao: null, buyQuote1000Tao: null, sellQuote: null };
    f.bridgeIn = { roomLeft: "0", capacity: "0", perHour: "0", enabled: false, supported: true, inFlight: 0 };
    f.backing.wTaoSupply = "0";
    const g = goodFlow();
    g.swap.twapUsdcPerTao = "0";
    g.swap.sellQuote = { taoIn: "0", usdcOut: "0" };
    g.swap.buyQuote1000Tao = "garbage";
    for (const doc of [view(f), view(g)]) expect(JSON.stringify(doc)).not.toMatch(/NaN|Infinity|undefined/);
  });

  it("the first reading after a deploy has no sell quote: a dash, and that step waits (for one minute)", () => {
    const f = goodFlow();
    f.backing.ratioPpm = 1_000_000;
    f.swap.sellQuote = null;
    const v = view(f);
    expect(figure(step(v, "swapOut"), "A $1,000 payout costs")).toBe("–");
    expect(step(v, "swapOut").tone).toBe("stale");
    expect(figure(step(v, "swap"), "A $1,000 deposit costs")).toBe("about 0.9%");
    expect(step(v, "swap").tone).toBe("ok");
    expect(v.status.kind).toBe("waiting");
  });

  it("the quoter reverted: both swap steps wait, never passing beside the blank costs", () => {
    const f = goodFlow();
    f.backing.ratioPpm = 1_000_000;
    f.swap.buyQuote1000Tao = null;
    f.swap.sellQuote = null;
    const v = view(f);
    for (const id of ["swap", "swapOut"]) expect(step(v, id).tone, id).toBe("stale");
    expect(step(v, "swap").headline).toBe("$800K"); // the headline alone is fine: a blank figure still counts
    expect(v.status.kind).toBe("waiting");
  });

  it("any blank figure on a fresh chain makes its step wait, not only a blank headline", () => {
    const cases: [string, (f: FlowV1) => void, string][] = [
      ["our stake unread", (f) => { f.validator.ourStake = null; }, "validator"],
      ["the cut unread", (f) => { f.validator.takeBps = null; }, "validator"],
      ["spot price unread", (f) => { f.swap.spotUsdcPerTao = null; }, "swap"],
      ["the USDC pool unread", (f) => { f.swap.wethUsdcPoolUsdc = null; }, "swap"],
      ["TAO held unread", (f) => { f.backing.alphaBacking = null; }, "backing"],
      ["the share price unread", (f) => { f.vault.price = null; }, "vault"],
      ["the refill unread", (f) => { f.bridgeOut.perHour = null; }, "bridgeBack"],
    ];
    for (const [name, patch, id] of cases) {
      const f = goodFlow();
      f.backing.ratioPpm = 1_000_000;
      patch(f);
      const v = view(f);
      expect(step(v, id).figures.some((x) => x.value === "–"), name).toBe(true);
      expect(step(v, id).tone, name).toBe("stale");
      expect(v.status.kind, name).toBe("waiting");
    }
  });

  it("an unknown is a dash and its step waits; only a known none reads as none", () => {
    const cases: [string, (f: FlowV1) => void, string[], [string, string] | null][] = [
      ["open batch unread", (f) => { f.batch.nextSendAt = null; }, ["bridge"], ["Next batch sends", "–"]],
      ["payout batches unread", (f) => { f.vault.nextPayoutAt = null; }, ["vaultOut"], ["Next payout batch", "–"]],
      ["hotkey set unread", (f) => { f.validator.backups = null; }, ["validator"], ["Backup validator", "–"]],
      ["the vault's pause unread", (f) => { f.vault.paused = null; }, ["vault", "vaultOut"], null],
      ["the front door's pause unread", (f) => { f.frontDoor.paused = null; }, ["bridge", "bridgeBack"], null],
    ];
    for (const [name, patch, ids, fig] of cases) {
      const f = goodFlow();
      f.backing.ratioPpm = 1_000_000;
      patch(f);
      const v = view(f);
      for (const id of ids) expect(step(v, id).tone, `${name}: ${id}`).toBe("stale");
      if (fig) expect(figure(step(v, ids[0]), fig[0]), name).toBe(fig[1]);
      expect(v.status.kind, name).toBe("waiting");
    }
    // known to be empty: words, and passing
    const f = goodFlow();
    f.backing.ratioPpm = 1_000_000;
    f.batch.nextSendAt = "none";
    f.vault.nextPayoutAt = "none";
    f.validator.backups = [];
    const v = view(f);
    expect(figure(step(v, "bridge"), "Next batch sends")).toBe("No batch waiting");
    expect(figure(step(v, "vaultOut"), "Next payout batch")).toBe("None queued");
    expect(figure(step(v, "validator"), "Backup validator")).toBe("None");
    expect(v.status.kind).toBe("passing");
  });

  it("a payout batch that has just finished: none queued, never 'any moment now'", () => {
    // flowOf skips a batch at count 0 (its struct zeroed, queuedAt 0) and sends "none"
    const f = goodFlow();
    f.backing.ratioPpm = 1_000_000;
    f.vault.nextPayoutAt = "none";
    const v = view(f);
    expect(figure(step(v, "vaultOut"), "Next payout batch")).toBe("None queued");
    expect(step(v, "vaultOut").tone).toBe("ok");
    expect(JSON.stringify(v)).not.toContain("any moment now");
  });

  it("re-ages the document on the visitor's clock: a reading over 10 minutes old is stale, whatever the document says", () => {
    const f = goodFlow(); // both read 60 s before the document
    f.backing.ratioPpm = 1_000_000;
    // 9 minutes after it arrived: 10 minutes old exactly, still fresh
    expect(view(f, RECEIVED + 9 * 60_000).status.kind).toBe("passing");
    // a moment later (a cached or long-open document): stale, every number from it a dash
    const v = view(f, RECEIVED + 9 * 60_000 + 1);
    expect(v.status.kind).toBe("waiting");
    expect(v.status.text).toBe("Waiting for a fresh reading");
    for (const id of ["swap", "backing", "bridge", "vault", "validator", "vaultOut", "bridgeBack", "swapOut"]) {
      expect(step(v, id).tone, id).toBe("stale");
      expect(step(v, id).headline, id).toBe("–");
    }
    // only the older chain's reading ages out first
    const g = goodFlow();
    g.backing.ratioPpm = 1_000_000;
    g.chains.base!.time = GENERATED_AT - 300;
    const w = view(g, RECEIVED + 6 * 60_000);
    expect(step(w, "swap").tone).toBe("stale");
    expect(step(w, "vault").tone).toBe("ok");
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

  it("itemScheduled: v3.2's pending scheduled items, in plain words, with who can still cancel each (Task 60; T55's notice)", () => {
    const f = goodFlow();
    const a = f.addresses;
    const readyAt = Date.UTC(2027, 0, 20, 9, 14) / 1000;
    const G = "0x00000000000000000000000000000000000000aa";
    f.notices = [
      { kind: "itemScheduled", chain: "bittensor", contract: a.vault, earliest: readyAt, tx: "0xabc", item: { id: "0x01", kind: "Ordinary", setter: "setRewardVesting", args: { period: "259200" } } },
      { kind: "itemScheduled", chain: "base", contract: a.frontDoor, target: G, earliest: readyAt, item: { id: "0x02", kind: "GuardianSwap", setter: "setGuardian", args: { newGuardian: G } } },
      { kind: "itemScheduled", chain: "bittensor", contract: a.vault, earliest: GENERATED_AT - 60, item: { id: "0x03", kind: "Reopen", setter: "setOutflowLimits", args: { bps: "2000", minDaily: "10000000000000000000" } } },
      // calldata the monitor couldn't decode
      { kind: "itemScheduled", chain: "bittensor", contract: a.vault, earliest: readyAt, item: { id: "0x04", kind: "Ordinary", setter: null, args: null } },
    ];
    const v = view(f);
    expect(v.notices.map((x) => x.title)).toEqual(Array(4).fill("A change is scheduled"));
    expect(v.notices.map((x) => x.body)).toEqual([
      "The vault has a change scheduled: how fast rewards are added (setRewardVesting with period 259200), ready from Jan 20, 9:14 AM; the guardian can still cancel it.",
      "The front door has a change scheduled: the guardian (setGuardian with newGuardian 0x0000…00aa), ready from Jan 20, 9:14 AM; the owner can still cancel it.",
      "The vault has a change scheduled: the daily unstake limit (setOutflowLimits with bps 2000, minDaily 10000000000000000000), ready now; the owner can still cancel it.",
      "The vault has a change scheduled whose details couldn't be read, ready from Jan 20, 9:14 AM; the guardian can still cancel it.",
    ]);
    expect(v.notices.every((x) => x.tone === "info")).toBe(true);
    // the transaction that scheduled it when stored, else the contract
    expect(v.notices[0].href).toBe("https://evm.taostats.io/tx/0xabc");
    expect(v.notices[1].href).toContain(a.frontDoor);
  });

  it("itemScheduled: every setter the page knows in plain words, the raw form after it; any other as decoded (the web copy audit, N8)", () => {
    const f = goodFlow();
    const words: Record<string, string> = {
      setPayoutDelay: "the wait before payouts",
      setOutflowLimits: "the daily unstake limit",
      setRewardCut: "Cascade's reward cut",
      setRewardVesting: "how fast rewards are added",
      setStakeHotkey: "the validator",
      moveStake: "the validator",
      activateBridge: "a new bridge",
      activateFrontDoor: "a new front door",
      setGuardian: "the guardian",
      transferOwnership: "the owner",
      setOracle: "the price check",
      setSwapper: "the swap contract",
    };
    const setters = [...Object.keys(words), "setSomethingElse", "constructor", "toString"];
    f.notices = setters.map((setter, i) => ({ kind: "itemScheduled", chain: "bittensor", contract: f.addresses.vault, item: { id: `0x${i}`, kind: "Ordinary", setter, args: {} } }));
    const bodies = view(f).notices.map((x) => x.body);
    setters.forEach((setter, i) => {
      const what = Object.hasOwn(words, setter) ? `${words[setter]} (${setter})` : setter;
      expect(bodies[i], setter).toBe(`The vault has a change scheduled: ${what}; the guardian can still cancel it.`);
    });
  });

  it("says what a pause holds, by the contract paused: v3.2's front door only deposits and the automatic sale (the web copy audit, S3 to S5)", () => {
    const f = goodFlow();
    const a = f.addresses;
    f.notices = [
      { kind: "paused", chain: "base", contract: a.frontDoor.toUpperCase().replace(/^0X/, "0x") },
      { kind: "paused", chain: "bittensor", contract: a.vault },
      { kind: "paused", chain: "base", contract: a.staker },
    ];
    expect(view(f).notices.map((x) => [x.title, x.body])).toEqual([
      ["The front door is paused", "New deposits and automatic USDC payouts wait until it is unpaused. Unstake requests, cancels and claims still work."],
      ["The vault is paused", "Deposits on their way, payouts and direct withdrawals wait until it is unpaused. Nobody's funds move."],
      ["The staker is paused", "Nothing new goes through it until it is unpaused."],
    ]);
    const door = goodFlow();
    door.backing.ratioPpm = 1_000_000;
    door.frontDoor.paused = true;
    expect(view(door).status.detail).toBe(
      "The front door is paused, so new deposits and automatic USDC payouts wait until it resumes. You can still ask to unstake, cancel, and claim TAO that's already back. Your existing stake isn't affected.",
    );
    const vault = goodFlow();
    vault.backing.ratioPpm = 1_000_000;
    vault.vault.paused = true;
    expect(view(vault).status.detail).toBe("The vault is paused, so deposits on their way, payouts and direct withdrawals wait until it resumes. Nobody's funds move.");
  });

  it("says what ForeverMoney's pause or move means for the reader, and v3.2's other states in their words (S12, N1 to N4)", () => {
    const f = goodFlow();
    const a = f.addresses;
    f.notices = [
      { kind: "fmMigration", chain: "bittensor", contract: a.alphaVault, target: "0x00000000000000000000000000000000000000aa", earliest: GENERATED_AT + 3600 },
      { kind: "fmPaused", chain: "bittensor", contract: a.alphaVault },
      { kind: "stakeMissing", chain: "bittensor", contract: a.vault },
      { kind: "parked", chain: "bittensor", contract: a.vault },
      { kind: "payoutsClosed", chain: "bittensor", contract: a.vault },
      { kind: "routeDisabled", chain: "base", contract: a.frontDoor },
    ];
    expect(view(f).notices.map((x) => [x.title, x.body])).toEqual([
      [
        "ForeverMoney has announced a migration",
        "ForeverMoney, which issues the TAO used on Base, has announced a move to new contracts. Unstakes through Base are on hold from now until Cascade has a replacement bridge live; requests made meanwhile keep your stake. A regular wallet can still withdraw on Bittensor. Your staked TAO isn't affected.",
      ],
      ["ForeverMoney's vault is paused", "ForeverMoney, which issues the TAO used on Base, is paused. Deposits and unstakes through Base wait until it resumes. Your staked TAO isn't affected."],
      ["The validator has changed its key", "Deposits and unstakes wait until the new key is listed. A direct withdrawal on Bittensor would pay a lower price for now."],
      ["Some deposits are waiting on Bittensor", "They couldn't be delivered to the vault yet and are set aside. They'll be delivered when possible, or sent back to Base after 14 days."],
      ["Unstakes through Base are on hold", "The bridge can't send payouts right now. Requests keep your stake; a regular wallet can withdraw on Bittensor."],
      ["Cascade's route is switched off", "Deposits and unstakes through Base wait. Turning it back on takes at least 7 days' public notice."],
    ]);
  });

  it("starts the money-out map at the request on Base, and says each step as it is on v3.2 (the web copy audit's flow)", () => {
    const f = goodFlow();
    f.backing.ratioPpm = 1_000_000;
    const v = view(f);
    const r = step(v, "request");
    expect([r.name, r.chain, r.headline]).toEqual(["Your request", "Base", "You ask to unstake"]);
    expect(r.say).toBe("You ask on Base and pay a small ETH fee. Requests travel to Bittensor together in the next batch.");
    expect(figure(r, "Next batch sends")).toBe(figure(step(v, "bridge"), "Next batch sends"));
    expect(r.link?.href).toContain(f.addresses.frontDoor);
    expect(r.tone).toBe("ok");
    expect(step(v, "vaultOut").say).toBe(
      "The vault takes your shares and queues your TAO. It waits 24 hours, then is unstaked and sent back. A daily limit applies, and shares from a deposit under a day old wait.",
    );
    expect(step(v, "swapOut").say).toBe("The TAO is swapped back to USDC on Base, on Uniswap. Only at your minimum price or better; otherwise it waits for you to claim.");
    expect(step(v, "walletOut").say).toBe("USDC lands back in your wallet, or TAO if you claim it yourself.");
    expect(step(v, "vault").say).toBe(
      "Your TAO is staked by the vault, and you hold vault shares. Each share is worth more TAO as rewards come in. New shares can be unstaked through Base after about a day.",
    );
    expect(step(v, "backing").say).toBe(
      "The TAO you get on Base is ForeverMoney's bridged TAO. It is meant to be backed one for one by TAO on Bittensor; the figure here is the live check.",
    );
    expect(step(v, "bridge").say).toContain("If a batch can't be delivered on arrival it waits on Bittensor and is sent back to Base after 14 days.");
    // a paused front door still takes requests: the step stays ok; an unread open batch is a dash, and it waits
    const paused = goodFlow();
    paused.frontDoor.paused = true;
    expect(step(view(paused), "request").tone).toBe("ok");
    const unread = goodFlow();
    unread.batch.nextSendAt = null;
    expect(step(view(unread), "request").tone).toBe("stale");
    const stale = goodFlow();
    stale.chains.base = { block: "1", time: GENERATED_AT - 700, stale: true };
    expect(figure(step(view(stale), "request"), "Next batch sends")).toBe("–");
  });

  it("leaves out a notice kind it doesn't know, or an item it can't read, and never fails on one (the live v3-launch page too)", () => {
    const f = goodFlow();
    const a = f.addresses;
    f.notices = [
      { kind: "somethingNew", chain: "base", contract: a.frontDoor } as unknown as Notice,
      { kind: "itemScheduled", chain: "bittensor", contract: a.vault, item: { id: "0x05", kind: "Ordinary", setter: 7, args: { period: 1 } } } as unknown as Notice,
      { kind: "paused", chain: "bittensor", contract: a.vault },
    ];
    const v = view(f);
    expect(v.notices.map((x) => x.title)).toEqual(["A change is scheduled", "The vault is paused"]);
    // a setter or arguments that aren't strings read as details that couldn't be read
    expect(v.notices[0].body).toBe("The vault has a change scheduled whose details couldn't be read; the guardian can still cancel it.");
  });

  it("noticeTitlesAndEarliest", () => {
    const f = goodFlow();
    const a = f.addresses;
    const T = "0x00000000000000000000000000000000000000aa";
    // after the document's moment (GENERATED_AT is Jan 15, 2027, 8:00 UTC)
    const earliest = Date.UTC(2027, 0, 20, 9, 14) / 1000;
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
    expect(v.notices[2].body).toContain("It can't take effect before Jan 20, 9:14 AM.");
    expect(v.notices[4].body).toContain("can be accepted at any time");
    expect(v.notices[1].href).toBe("https://basescan.org/tx/0xabc"); // the transaction when stored
    expect(v.notices[0].href).toContain(a.vault); // else the contract
  });

  it("an earliest time already past says it can take effect now, never 'can't take effect before' a past date", () => {
    const f = goodFlow();
    const a = f.addresses;
    const past = Date.UTC(2026, 10, 5, 9, 14) / 1000;
    f.notices = [
      { kind: "guardianProposed", chain: "base", contract: a.frontDoor, target: "0xaa", earliest: past },
      // due 2 minutes after the document's moment: not yet when it arrives, past 3 minutes later on the visitor's clock
      { kind: "bridgeProposed", chain: "base", contract: a.frontDoor, target: "0xaa", earliest: GENERATED_AT + 120 },
    ];
    const v = view(f);
    expect(v.notices[0].body).toContain("It can take effect now.");
    expect(v.notices[0].body).not.toContain("can't take effect before");
    expect(v.notices[1].body).toContain("It can't take effect before");
    expect(view(f, RECEIVED + 3 * 60_000).notices[1].body).toContain("It can take effect now.");
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
    expect(figure(step(v, "swap"), "A $1,000 deposit costs")).toBe("about 0.9%");
    expect(figure(step(v, "swapOut"), "A $1,000 payout costs")).toBe("about 0.9%");
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
      ["lane support unknown", (f) => { f.bridgeOut.supported = null; }, "bridgeBack"],
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

  describe("v3.2's live parts, from the monitor's exits part (the web copy audit's N2, N5 and S9)", () => {
    const v32 = () => {
      const f = goodFlowV32();
      f.backing.ratioPpm = 1_000_000;
      return f;
    };

    it("the money-out Vault step: today's limit, about what it has used, and the live wait before payout, in its words too (S9)", () => {
      const v = view(v32());
      const out = step(v, "vaultOut");
      expect(figure(out, "Daily unstake limit")).toBe("200 TAO");
      expect(figure(out, "Used today")).toBe("about 30 TAO");
      expect(figure(out, "Wait before payout")).toBe("24 hours");
      expect(out.say).toBe("The vault takes your shares and queues your TAO. It waits 24 hours, then is unstaked and sent back. A daily limit applies, and shares from a deposit under a day old wait.");
      expect(v.status.kind).toBe("passing");
      const half = v32();
      half.exits!.payoutDelayS = 43_200;
      expect(step(view(half), "vaultOut").say).toContain("It waits 12 hours, then");
      expect(figure(step(view(half), "vaultOut"), "Wait before payout")).toBe("12 hours");
      // unread: a dash (the step waits), and the words assert no time
      const unread = v32();
      unread.exits = { ...unread.exits!, payoutDelayS: null, dailyLimit: null, usedToday: null };
      const u = step(view(unread), "vaultOut");
      expect([figure(u, "Daily unstake limit"), figure(u, "Used today"), figure(u, "Wait before payout")]).toEqual(["–", "–", "–"]);
      expect(u.say).toBe("The vault takes your shares and queues your TAO. It waits a set time, then is unstaked and sent back. A daily limit applies, and shares from a deposit under a day old wait.");
      expect(u.tone).toBe("stale");
    });

    it("the Bridge step: the deposits waiting on Bittensor (N2), and when the oldest is sent back to Base", () => {
      expect(figure(step(view(v32()), "bridge"), "Waiting to be delivered")).toBe("None");
      expect(figure(step(view(v32()), "bridge"), "Sent back to Base from")).toBeUndefined();
      const parked = v32();
      parked.exits = { ...parked.exits!, parked: e18(3), parkedRefundFrom: GENERATED_AT + 86_400 };
      const b = step(view(parked), "bridge");
      expect(figure(b, "Waiting to be delivered")).toBe("3 TAO");
      expect(figure(b, "Sent back to Base from")).toBe(formatDateTime(new Date((GENERATED_AT + 86_400) * 1000)));
      const unknown = v32();
      unknown.exits = { ...unknown.exits!, parked: null, parkedRefundFrom: null };
      expect(figure(step(view(unknown), "bridge"), "Waiting to be delivered")).toBe("–");
      expect(step(view(unknown), "bridge").tone).toBe("stale");
    });

    it("a paused front door on v3.2 holds the USDC sale, not the bridge back: payouts still land (the copy audit's flagged behaviour)", () => {
      const f = v32();
      f.frontDoor.paused = true;
      const v = view(f);
      expect(step(v, "bridgeBack").tone).toBe("ok");
      expect(step(v, "swapOut").tone).toBe("amber");
      expect(step(v, "bridge").tone).toBe("amber");
      expect(v.status.detail).toBe(AMBER.frontDoor);
      // its pause unread: the sale's step waits, the bridge back doesn't
      const u = v32();
      u.frontDoor.paused = null;
      expect(step(view(u), "swapOut").tone).toBe("stale");
      expect(step(view(u), "bridgeBack").tone).toBe("ok");
      // v3-launch's document (no exits part) keeps its own
      const old = goodFlow();
      old.frontDoor.paused = true;
      expect(step(view(old), "bridgeBack").tone).toBe("amber");
      expect(step(view(old), "swapOut").tone).toBe("ok");
    });

    it("a v3-launch document has none of these figures", () => {
      const v = view(goodFlow());
      expect(figure(step(v, "vaultOut"), "Daily unstake limit")).toBeUndefined();
      expect(figure(step(v, "bridge"), "Waiting to be delivered")).toBeUndefined();
    });
  });

  it("noForbiddenWords covers every amber sentence", () => {
    const flows: FlowV1[] = [];
    const mk = (patch: (f: FlowV1) => void) => { const f = goodFlow(); f.backing.ratioPpm = 1_000_000; patch(f); flows.push(f); };
    mk((f) => { f.backing.ratioPpm = 900_000; }); // backing
    mk((f) => { f.bridgeIn.roomLeft = "0"; }); // bridge
    mk((f) => { f.frontDoor.paused = true; }); // front door
    mk((f) => { f.vault.paused = true; }); // vault
    mk((f) => { f.bridgeOut.supported = false; }); // bridge back (closed)
    const details = flows.map((f) => view(f).status.detail);
    expect(new Set(details).size).toBe(5);
    for (const d of details) expect(d).not.toMatch(/safe|secure|guarantee/i);
    for (const s of Object.values(AMBER).flatMap((x) => (typeof x === "string" ? [x] : Object.values(x)))) expect(s).not.toMatch(/safe|secure|guarantee/i);
  });
});

describe("heroNumbers", () => {
  it("leads with the backing and when the chain was last read, then the swap and the bridge, as the map shows them", () => {
    const f = goodFlow();
    const v = view(f);
    const { lead, row } = heroNumbers(v);
    expect(lead).toEqual([
      { value: step(v, "backing").headline, label: "Bridged TAO backed", tone: step(v, "backing").tone },
      { value: v.checkedAgo, label: "Last on-chain check" },
    ]);
    expect(v.checkedAgo).toMatch(/ago|just now/);
    expect(row.map((r) => r.label)).toEqual(["Pool depth on Base", "About what a $1,000 deposit costs", "Bridge room to Bittensor"]);
    expect(row[0]!.value).toBe(step(v, "swap").headline);
    expect(row[1]!.value).toBe(figure(step(v, "swap"), "A $1,000 deposit costs")!.replace(/^about\s+/, ""));
    expect(row[1]!.value).not.toMatch(/about/);
    expect(row[2]!.value).toBe(step(v, "bridge").headline);
  });

  it("shows dashes, never a stale figure, when the map has none", () => {
    const { lead, row } = heroNumbers(view(null));
    for (const s of [...lead, ...row]) expect(s.value).toBe("–");
  });

  it("still says how old a stale reading is", () => {
    const f = goodFlow();
    f.chains.bittensor = { block: "1", time: f.generatedAt - 3600, stale: true };
    const v = view(f);
    expect(heroNumbers(v).lead[0]!.value).toBe("–");
    expect(heroNumbers(v).lead[1]!.value).toMatch(/hour/);
  });
});

describe("what a $1,000 swap costs", () => {
  const DEPOSIT_FEE = 0.0015 + 0.05 / 1000; // Cascade's 0.15% and $0.05, on $1,000
  it("is the quote against the 30-minute average plus Cascade's fee, and never under the pools' own fees", () => {
    expect(ROUTE_POOL_FEES).toBe(0.0035); // TAO / WETH at 0.3%, WETH / USDC at 0.05%
    // an ordinary reading: 0.7% against the average, 0.855% with Cascade's fee
    expect(swapCost(0.007, DEPOSIT_FEE)).toBeCloseTo(0.00855, 10);
    // the price has moved the swap's way (the buy is "cheaper than the average"): the old figure read 0.0%; now the
    // pools' fees and Cascade's, about 0.5%
    for (const vsAverage of [0, -0.0001, -0.01, -0.2]) expect(swapCost(vsAverage, DEPOSIT_FEE)).toBeCloseTo(0.00505, 10);
    // a payout pays Cascade's percentage only
    expect(swapCost(-0.01, 0.0015)).toBeCloseTo(0.005, 10);
    // nothing to measure: nothing said (a dash on the page), never a number
    for (const none of [null, Number.NaN, Number.POSITIVE_INFINITY]) expect(swapCost(none, DEPOSIT_FEE)).toBeNull();
  });
});
