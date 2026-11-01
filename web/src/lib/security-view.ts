import { explorer } from "./cascade/config";
import type { Amount, Bucket, FlowChain, FlowV1, Notice, Scheduled } from "./cascade/flow";
import { validatorName, validatorSs58 } from "./cascade/validators";
import { formatDateTime, formatDuration, formatPercent, formatRelative, formatTao, formatUsdCompact, shortAddress } from "./format";

// The security page's view models: a pure function from the monitor's flow document (and the visitor's clock)
// to what the page draws. Facts only: the amber conditions here are the page's own simple public ones.
// The wording never claims safety; it says "checked", "passing", "monitored".

export type Tone = "ok" | "amber" | "stale";
export type StepId = "wallet" | "swap" | "backing" | "bridge" | "vault" | "validator" | "vaultOut" | "bridgeBack" | "swapOut" | "walletOut";
export interface StepView {
  id: StepId;
  name: string;
  chain: string;
  headline: string;
  say: string;
  figures: { label: string; value: string }[];
  link: { label: string; href: string } | null;
  tone: Tone;
}
export interface NoticeView { tone: "info"; title: string; body: string; href: string | null }
export interface PageView {
  status: { kind: "passing" | "notOptimal" | "cantCheck" | "waiting"; text: string; detail: string | null };
  notices: NoticeView[];
  stepsIn: StepView[];
  stepsOut: StepView[];
}

const DASH = "–";

/** A reading older than this on the visitor's clock is stale, whatever the document said when it was built (the
 * monitor's own limit, indexer/src/flow.ts STALE_AFTER_S): a cached or long-open document never reads as live. */
export const STALE_AFTER_MS = 600_000;

/** Figures that may show a dash on a fresh chain without their step waiting: only figures that are never a reading.
 * None today: every figure is a number or a name read from the chain. (The first reading after a deploy has no sell
 * quote, so "A $1,000 payout costs" is a dash and its step waits for the next reading, a minute later: not exempt.) */
const NEVER_A_READING: ReadonlySet<string> = new Set<string>();

/** An amount string as a bigint; null for anything that isn't plain decimal digits. */
function big(x: Amount | undefined): bigint | null {
  return typeof x === "string" && /^\d+$/.test(x) ? BigInt(x) : null;
}
/** An amount in whole units (`decimals` places below), as a number; null when unknown. */
function units(x: Amount | undefined, decimals: number): number | null {
  const b = big(x);
  if (b === null) return null;
  const n = Number(b) / 10 ** decimals;
  return Number.isFinite(n) ? n : null;
}
/** TAO to two places, without a pointless ".00": "80", "1,234.50". */
const tao2 = (n: number) => formatTao(n, 2).replace(/\.00$/, "");
const taoText = (n: number | null) => (n === null ? DASH : `${tao2(n)} TAO`);

/** How far a quote fell short of the 30-minute average price, as "about 0.7%". Never below 0%. */
function costText(shortfall: number | null): string {
  return shortfall === null || !Number.isFinite(shortfall) ? DASH : `about ${formatPercent(Math.max(0, shortfall))}`;
}

const SAY = {
  wallet: "You start with USDC in your own wallet. Cascade never holds your keys.",
  swap: "Your USDC is swapped for TAO on Base, on Uniswap. The pools' depth sets what a swap costs.",
  backing: "The TAO you get on Base is ForeverMoney's bridged TAO, backed by real TAO on Bittensor.",
  bridge: "Cascade groups deposits into batches and sends them to Bittensor over Chainlink. The bridge has a limit that refills over time.",
  vault: "Your TAO is staked by the vault, and you hold vault shares that grow as rewards come in.",
  validator: "The validator the vault stakes with. It earns the staking rewards and keeps a cut.",
  vaultOut: "When you withdraw, the vault unstakes your TAO and queues it to be sent back.",
  bridgeBack: "Unstaked TAO crosses back to Base over Chainlink. The bridge has a limit that refills over time.",
  swapOut: "The TAO is swapped back to USDC on Base, on Uniswap.",
  walletOut: "USDC lands back in your wallet.",
} as const;

export const AMBER = {
  // by the layer that is short, in the Backing step's own words: TAO held against bridged TAO issued (ForeverMoney's
  // vault), and TAO locked for bridged TAO against the bridged TAO on Base (the lock pool)
  backing: {
    held: "Backing is below 100% right now: the TAO held is less than the bridged TAO issued.",
    locked: "Backing is below 100% right now: the TAO locked for bridged TAO is less than the bridged TAO on Base.",
    both: "Backing is below 100% right now: the TAO held is less than the bridged TAO issued, and the TAO locked for bridged TAO is less than the bridged TAO on Base.",
    short: "Backing is below 100% right now.",
  },
  bridge: "The bridge has no room left, or its lane is closed, so new deposits wait longer to cross. Your existing stake isn't affected.",
  frontDoor: "The front door is paused, so new deposits and withdrawals can't be requested until it resumes. Your existing stake isn't affected.",
  vault: "The vault is paused, so staking and payouts wait until it resumes.",
  bridgeBack: "The bridge back has no room left, or its lane is closed, so payouts wait longer to reach Base.",
} as const;

/** A bridge direction as the page shows it: its headline, its figures (the room's), and whether it has no room.
 * `enabled` false is CCIP's limiter off on both pools: no limit, transfers pass. Only `supported` false (a pool no
 * longer lists the other chain) closes the lane. Anything unknown, or a chain not fresh, is a dash. */
function bucketView(b: Bucket | undefined, usable: boolean): { headline: string; figures: { label: string; value: string }[]; noRoom: boolean } {
  const onTheWay = { label: "Transfers on the way", value: usable && b && Number.isFinite(b.inFlight) ? String(b.inFlight) : DASH };
  const unknown = { headline: DASH, figures: [{ label: "Room left", value: DASH }, { label: "Refills", value: DASH }, onTheWay], noRoom: false };
  if (!usable || !b) return unknown;
  if (b.supported === false) return { headline: "Closed", figures: [{ label: "Room left", value: "None: the lane is closed" }, onTheWay], noRoom: true };
  if (b.supported !== true) return unknown;
  if (b.enabled === false) return { headline: "No limit", figures: [{ label: "Room left", value: "No limit" }, onTheWay], noRoom: false };
  if (b.enabled !== true) return unknown;
  const room = units(b.roomLeft, 18);
  const cap = units(b.capacity, 18);
  const per = units(b.perHour, 18);
  return {
    headline: room === null ? DASH : `${tao2(room)} TAO`,
    figures: [
      { label: "Room left", value: room === null || cap === null ? DASH : `${tao2(room)} of ${tao2(cap)} TAO` },
      { label: "Refills", value: per === null ? DASH : `${tao2(per)} TAO per hour` },
      onTheWay,
    ],
    noRoom: b.roomLeft === "0",
  };
}

/** The flow document as the page's view. `nowMs` is the visitor's clock; `receivedAt` (when the document
 * arrived, on that same clock) and the document's own `generatedAt` and reading times date every reading, so
 * a wrong clock on the device can't make an old reading look new. */
export function flowView(data: { flow: FlowV1; receivedAt: number } | null, nowMs: number): PageView {
  const flow = data?.flow ?? null;
  // when a reading was taken, on the visitor's clock
  const takenAt = (time: number) => data!.receivedAt - (flow!.generatedAt - time) * 1000;
  // a chain is fresh when the document says so and, aged on this clock since it arrived, it still is
  const fresh = (c: FlowChain | null | undefined) => !!c && !c.stale && nowMs - takenAt(c.time) <= STALE_AFTER_MS;
  const baseOk = fresh(flow?.chains?.base);
  const bitOk = fresh(flow?.chains?.bittensor);
  const a = flow?.addresses;
  const toneOf = (usable: boolean, amber: boolean): Tone => (!usable ? "stale" : amber ? "amber" : "ok");

  // seconds from the document's moment to `unix`, less the time that has passed since it arrived
  const untilMs = (unix: number) => (unix - flow!.generatedAt) * 1000 - (nowMs - data!.receivedAt);
  // a time, "none" (known: nothing scheduled) or unknown (a dash)
  const inText = (when: Scheduled | undefined, usable: boolean, none: string) => {
    if (!usable) return DASH;
    if (when === "none") return none;
    if (typeof when !== "number" || !Number.isFinite(when)) return DASH;
    const ms = untilMs(when);
    return ms <= 0 ? "any moment now" : `in ${formatDuration(ms)}`;
  };

  // ---- Base ----
  const sw = flow?.swap;
  const twap = (() => {
    const t = units(sw?.twapUsdcPerTao, 6);
    return t !== null && t > 0 ? t : null;
  })();
  const priced = baseOk && twap !== null;
  // Pool depth is an approximation: 2 × what one side holds, priced at the 30-minute average (the TAO side at the TWAP,
  // the USDC side at $1), which is the pool's whole value as if split evenly. With concentrated liquidity only the
  // liquidity in range near the price absorbs a swap, so this overstates the depth a trade meets; the quoted cost of a
  // $1,000 swap below (QuoterV2, fees and price movement included) is the figure that reflects it.
  const taoPoolUsd = priced ? (() => { const t = units(sw!.taoWethPoolTao, 18); return t === null ? null : 2 * t * twap!; })() : null;
  const usdcPoolUsd = baseOk ? (() => { const u = units(sw!.wethUsdcPoolUsdc, 6); return u === null ? null : 2 * u; })() : null;
  const usd = (n: number | null) => (n === null ? DASH : formatUsdCompact(n));
  const depths = [taoPoolUsd, usdcPoolUsd].filter((x): x is number => x !== null);
  // the thinner pool sets the headline: never a better number than the weaker one
  const depthHeadline = depths.length === 2 ? usd(Math.min(...depths)) : DASH;
  const buyTao = baseOk ? units(sw!.buyQuote1000Tao, 18) : null;
  const depositCost = priced && buyTao !== null ? 1 - (buyTao * twap!) / 1000 : null;
  const sellQ = baseOk ? sw?.sellQuote : null;
  const sellCost = (() => {
    if (!priced || !sellQ) return null;
    const tIn = units(sellQ.taoIn, 18);
    const out = units(sellQ.usdcOut, 6);
    return tIn === null || out === null || tIn <= 0 ? null : 1 - out / (tIn * twap!);
  })();
  const spot = baseOk ? units(sw!.spotUsdcPerTao, 6) : null;
  const apart = priced && spot !== null ? `${formatPercent(Math.abs(spot - twap!) / twap!)} apart` : DASH;

  const poolFigures = [
    { label: "TAO / WETH pool depth", value: usd(taoPoolUsd) },
    { label: "WETH / USDC pool depth", value: usd(usdcPoolUsd) },
  ];

  // ---- Bittensor ----
  const bk = flow?.backing;
  const ratio = bitOk && typeof bk?.ratioPpm === "number" && Number.isFinite(bk.ratioPpm) ? bk.ratioPpm : null;
  // floored, so 99.9999% never reads as 100%
  const ratioText = ratio === null ? DASH : `${(Math.floor(ratio / 100) / 100).toFixed(2)}%`;
  const bit = (x: Amount | undefined, d = 18) => (bitOk ? taoText(units(x, d)) : DASH);
  // which layer is short, from the same amounts the figures show (the ratio is their floor, so they agree)
  const short = (held: Amount | undefined, owed: Amount | undefined) => {
    const h = big(held);
    const o = big(owed);
    return h !== null && o !== null && o > 0n && h < o;
  };
  const heldShort = bitOk && short(bk?.alphaBacking, bk?.wTaoSupply);
  const lockShort = bitOk && baseOk && short(bk?.lockPoolFmTao, bk?.fmTaoSupplyBase);
  const backingAmber = heldShort && lockShort ? AMBER.backing.both : heldShort ? AMBER.backing.held : lockShort ? AMBER.backing.locked : AMBER.backing.short;

  const v = flow?.vault;
  const val = flow?.validator;
  const frontDoorPaused = baseOk && flow?.frontDoor?.paused === true;
  const vaultPaused = bitOk && v?.paused === true;
  // a pause unread on a fresh chain: the steps it would turn amber can't say they are passing
  const frontDoorPauseUnknown = baseOk && typeof flow?.frontDoor?.paused !== "boolean";
  const vaultPauseUnknown = bitOk && typeof v?.paused !== "boolean";
  // a bridge direction's two limiters sit one on each chain (the source pool's outbound, the destination's inbound)
  const bothOk = baseOk && bitOk;
  const bin = bucketView(flow?.bridgeIn, bothOk);
  const bout = bucketView(flow?.bridgeOut, bothOk);

  const bridgeAmber = bothOk && (frontDoorPaused || bin.noRoom);
  const bridgeBackAmber = bothOk && bout.noRoom;

  const link = (label: string, href: string | undefined) => (href ? { label, href } : null);

  const validatorHot = bitOk ? (val?.hotkey ?? null) : null;
  const takeBps = bitOk && typeof val?.takeBps === "number" && Number.isFinite(val.takeBps) ? val.takeBps : null;
  const ss58 = validatorHot ? validatorSs58(validatorHot) : undefined;

  const stepsIn: StepView[] = [
    { id: "wallet", name: "Your wallet", chain: "Base", headline: "You send USDC", say: SAY.wallet, figures: [], link: null, tone: "ok" },
    {
      id: "swap", name: "Swap", chain: "Base", headline: depthHeadline, say: SAY.swap,
      figures: [...poolFigures, { label: "A $1,000 deposit costs", value: costText(depositCost) }, { label: "Price vs 30-minute average", value: apart }],
      link: link("TAO / WETH pool on Basescan", a && explorer.baseAddress(a.taoWethPool)), tone: toneOf(baseOk, false),
    },
    {
      id: "backing", name: "Backing", chain: "Bittensor", headline: ratioText, say: SAY.backing,
      figures: [
        { label: "TAO held", value: bit(bk?.alphaBacking) },
        { label: "Bridged TAO issued", value: bit(bk?.wTaoSupply) },
        // the lock pool holds the TAO behind bridged TAO on every lane, not only Base's
        { label: "TAO locked for bridged TAO", value: bit(bk?.lockPoolFmTao) },
        { label: "Bridged TAO on Base", value: baseOk ? taoText(units(bk?.fmTaoSupplyBase, 18)) : DASH },
      ],
      link: link("AlphaVault on the Bittensor explorer", a && explorer.bittensorAddress(a.alphaVault)),
      tone: toneOf(bitOk, ratio !== null && ratio < 1_000_000),
    },
    {
      id: "bridge", name: "Bridge", chain: "Base to Bittensor", headline: bin.headline, say: SAY.bridge,
      figures: [...bin.figures, { label: "Next batch sends", value: inText(flow?.batch?.nextSendAt, baseOk, "No batch waiting") }],
      link: link("The lane on Chainlink's explorer", a && explorer.ccipLane(a.baseTokenPool)),
      tone: toneOf(bothOk, bridgeAmber),
    },
    {
      id: "vault", name: "Vault", chain: "Bittensor", headline: bit(v?.totalAssets), say: SAY.vault,
      figures: [
        { label: "TAO staked", value: bit(v?.totalAssets) },
        { label: "1 share is worth", value: bitOk ? (() => { const p = units(v?.price, 18); return p === null ? DASH : `${formatTao(p)} TAO`; })() : DASH },
        { label: "Waiting to pay out", value: bit(v?.pendingPayouts) },
      ],
      link: link("The vault on the Bittensor explorer", a && explorer.bittensorAddress(a.vault)),
      tone: toneOf(bitOk, vaultPaused),
    },
    {
      id: "validator", name: "Validator", chain: "Bittensor", headline: validatorHot ? validatorName(validatorHot) : DASH, say: SAY.validator,
      figures: [
        // the vault's stake is read in rao
        { label: "Our stake with it", value: bitOk ? (() => { const s = units(val?.ourStake, 9); return s === null ? DASH : `${formatTao(s)} TAO`; })() : DASH },
        { label: "Its cut", value: takeBps === null ? DASH : formatPercent(takeBps / 10_000, takeBps % 100 === 0 ? 0 : 1) },
        { label: "Backup validator", value: bitOk && Array.isArray(val?.backups) ? (val.backups.length ? val.backups.map(validatorName).join(", ") : "None") : DASH },
      ],
      link: link("The validator on taostats", ss58 && explorer.validator(ss58)),
      tone: toneOf(bitOk, false),
    },
  ];

  const stepsOut: StepView[] = [
    {
      id: "vaultOut", name: "Vault", chain: "Bittensor", headline: bit(v?.pendingPayouts), say: SAY.vaultOut,
      figures: [
        { label: "Waiting to send back", value: bit(v?.pendingPayouts) },
        { label: "Next payout batch", value: inText(v?.nextPayoutAt, bitOk, "None queued") },
      ],
      link: link("The vault on the Bittensor explorer", a && explorer.bittensorAddress(a.vault)),
      tone: toneOf(bitOk, vaultPaused),
    },
    {
      id: "bridgeBack", name: "Bridge back", chain: "Bittensor to Base", headline: bout.headline, say: SAY.bridgeBack,
      figures: bout.figures,
      link: link("The lane on Chainlink's explorer", a && explorer.ccipLane(a.baseTokenPool)),
      tone: toneOf(bothOk, bridgeBackAmber || frontDoorPaused),
    },
    {
      id: "swapOut", name: "Swap to USDC", chain: "Base", headline: depthHeadline, say: SAY.swapOut,
      figures: [...poolFigures, { label: "A $1,000 payout costs", value: costText(sellCost) }],
      link: link("WETH / USDC pool on Basescan", a && explorer.baseAddress(a.wethUsdcPool)),
      tone: toneOf(baseOk, false),
    },
    { id: "walletOut", name: "Your wallet", chain: "Base", headline: "USDC arrives", say: SAY.walletOut, figures: [], link: null, tone: "ok" },
  ];

  // a fresh chain's step with any blank figure (its headline or a detail) is not passing: it waits for a reading.
  // So does one whose amber condition is unread (a pause). The wallet steps are words, not readings: they never count.
  const unread: Partial<Record<StepId, boolean>> = {
    bridge: frontDoorPauseUnknown,
    bridgeBack: frontDoorPauseUnknown,
    vault: vaultPauseUnknown,
    vaultOut: vaultPauseUnknown,
  };
  for (const s of [...stepsIn, ...stepsOut]) {
    if (s.id === "wallet" || s.id === "walletOut" || s.tone === "stale") continue;
    const blank = s.headline === DASH || s.figures.some((f) => f.value === DASH && !NEVER_A_READING.has(f.label));
    if (blank || unread[s.id]) s.tone = "stale";
  }

  // ---- the top line ----
  let status: PageView["status"];
  if (!data || !flow) {
    status = { kind: "cantCheck", text: "We can't check right now", detail: "The page couldn't reach the monitor, so none of the numbers below are current." };
  } else if (!baseOk || !bitOk) {
    const which = !baseOk && !bitOk ? "Base and Bittensor" : !baseOk ? "Base" : "Bittensor";
    status = { kind: "waiting", text: "Waiting for a fresh reading", detail: `The latest reading from ${which} is too old to show, so those numbers are left blank.` };
  } else if ([...stepsIn, ...stepsOut].some((s) => s.tone === "stale")) {
    status = { kind: "waiting", text: "Waiting for a fresh reading", detail: "A reading from the chain isn't available yet, so that number is left blank." };
  } else {
    const amber = [...stepsIn, ...stepsOut].find((s) => s.tone === "amber");
    if (amber) {
      const detail =
        amber.id === "backing" ? backingAmber
        : amber.id === "vault" || amber.id === "vaultOut" ? AMBER.vault
        : frontDoorPaused ? AMBER.frontDoor
        : amber.id === "bridgeBack" ? AMBER.bridgeBack
        : AMBER.bridge;
      status = { kind: "notOptimal", text: "Conditions aren't optimal right now", detail };
    } else {
      // the older of the two readings sets "last checked"
      const taken = Math.min(takenAt(flow.chains.base!.time), takenAt(flow.chains.bittensor!.time));
      status = { kind: "passing", text: `All checks passing, last checked ${formatRelative(new Date(taken), nowMs)}`, detail: null };
    }
  }

  return { status, notices: flow ? flow.notices.flatMap((n) => noticeView(n, flow, untilMs)) : [], stepsIn, stepsOut };
}

function contractName(addr: string, a: FlowV1["addresses"]): string {
  const x = addr.toLowerCase();
  if (x === a.vault?.toLowerCase()) return "The vault";
  if (x === a.frontDoor?.toLowerCase()) return "The front door";
  if (x === a.staker?.toLowerCase()) return "The staker";
  if (x === a.alphaVault?.toLowerCase()) return "ForeverMoney's vault";
  return shortAddress(addr);
}

/** One event as a blue notice, or nothing for a kind this page doesn't know yet. Links to the transaction
 * that started it when the monitor stored one, else to the contract. `untilMs` is how long until a time, on the
 * visitor's clock: an earliest time already past says it can take effect now. */
function noticeView(n: Notice, flow: FlowV1, untilMs: (unix: number) => number): NoticeView[] {
  const who = contractName(n.contract, flow.addresses);
  const base = n.chain === "base";
  const href = n.tx ? (base ? explorer.baseTx(n.tx) : explorer.bittensorTx(n.tx)) : base ? explorer.baseAddress(n.contract) : explorer.bittensorAddress(n.contract);
  const timing =
    typeof n.earliest !== "number" || !Number.isFinite(n.earliest)
      ? "It can be accepted at any time."
      : untilMs(n.earliest) <= 0
        ? "It can take effect now."
        : `It can't take effect before ${formatDateTime(new Date(n.earliest * 1000))}.`;
  const to = n.target ? ` to ${shortAddress(n.target)}` : "";
  const make = (title: string, body: string): NoticeView[] => [{ tone: "info", title, body, href }];
  switch (n.kind) {
    case "paused":
      return make(`${who} is paused`, "Nothing new goes through it until it is unpaused.");
    case "ownershipPending":
      return make("An ownership change is pending", `Ownership of ${who.toLowerCase().startsWith("the ") ? who.toLowerCase() : who} is moving${to}. ${timing}`);
    case "guardianProposed":
      return make("A new guardian is proposed", `${who} has a proposed guardian${n.target ? `: ${shortAddress(n.target)}` : ""}. ${timing}`);
    case "bridgeProposed":
      return make("A new bridge is proposed", `${who} has a proposed bridge${n.target ? `: ${shortAddress(n.target)}` : ""}. ${timing}`);
    case "frontDoorProposed":
      return make("A new front door is proposed", `${who} has a proposed front door${n.target ? `: ${shortAddress(n.target)}` : ""}. ${timing}`);
    case "fmAdminScheduled":
      return make("ForeverMoney has scheduled an admin change", `ForeverMoney's vault backs the bridged TAO${to ? `; its admin is changing${to}` : ""}. ${timing}`);
    case "fmMigration":
      return make("ForeverMoney has announced a migration", `ForeverMoney's vault backs the bridged TAO${n.target ? `; it is moving to ${shortAddress(n.target)}` : ""}. ${timing}`);
    case "fmPaused":
      return make("ForeverMoney's vault is paused", "It backs the bridged TAO, and is paused for now.");
    default:
      return [];
  }
}
