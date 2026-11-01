import { explorer } from "./cascade/config";
import type { Amount, Bucket, FlowV1, Notice } from "./cascade/flow";
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

const AMBER = {
  backing: "Backing is below 100% right now: the TAO held is less than the bridged TAO issued.",
  bridge: "The bridge has no room, or is switched off, so new deposits wait longer to cross. Your existing stake isn't affected.",
  frontDoor: "The front door is paused, so new deposits and withdrawals can't be requested until it resumes. Your existing stake isn't affected.",
  vault: "The vault is paused, so staking and payouts wait until it resumes.",
  bridgeBack: "The bridge back has no room, or is switched off, so payouts wait longer to reach Base.",
} as const;

const noRoom = (b: Bucket) => b.enabled === false || b.roomLeft === "0";

function bucketFigures(b: Bucket, usable: boolean): { room: string; of: string; refill: string; onTheWay: string } {
  if (!usable) return { room: DASH, of: DASH, refill: DASH, onTheWay: DASH };
  const room = units(b.roomLeft, 18);
  const cap = units(b.capacity, 18);
  const per = units(b.perHour, 18);
  return {
    room: room === null ? DASH : `${tao2(room)} TAO`,
    of: room === null || cap === null ? DASH : `${tao2(room)} of ${tao2(cap)} TAO`,
    refill: per === null ? DASH : `${tao2(per)} TAO per hour`,
    onTheWay: Number.isFinite(b.inFlight) ? String(b.inFlight) : DASH,
  };
}

/** The flow document as the page's view. `nowMs` is the visitor's clock; `receivedAt` (when the document
 * arrived, on that same clock) and the document's own `generatedAt` and reading times date every reading, so
 * a wrong clock on the device can't make an old reading look new. */
export function flowView(data: { flow: FlowV1; receivedAt: number } | null, nowMs: number): PageView {
  const flow = data?.flow ?? null;
  const baseOk = !!flow?.chains?.base && !flow.chains.base.stale;
  const bitOk = !!flow?.chains?.bittensor && !flow.chains.bittensor.stale;
  const a = flow?.addresses;
  const toneOf = (usable: boolean, amber: boolean): Tone => (!usable ? "stale" : amber ? "amber" : "ok");

  // when a reading was taken, on the visitor's clock
  const takenAt = (time: number) => data!.receivedAt - (flow!.generatedAt - time) * 1000;
  // seconds from the document's moment to `unix`, less the time that has passed since it arrived
  const untilMs = (unix: number) => (unix - flow!.generatedAt) * 1000 - (nowMs - data!.receivedAt);
  const inText = (unix: number | null | undefined, usable: boolean, none: string) => {
    if (!usable || unix === undefined) return DASH;
    if (unix === null) return none;
    const ms = untilMs(unix);
    return ms <= 0 ? "any moment now" : `in ${formatDuration(ms)}`;
  };

  // ---- Base ----
  const sw = flow?.swap;
  const twap = (() => {
    const t = units(sw?.twapUsdcPerTao, 6);
    return t !== null && t > 0 ? t : null;
  })();
  const priced = baseOk && twap !== null;
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

  const v = flow?.vault;
  const val = flow?.validator;
  const frontDoorPaused = baseOk && flow?.frontDoor?.paused === true;
  const vaultPaused = bitOk && v?.paused === true;
  const inRoomOut = flow ? noRoom(flow.bridgeIn) : false;
  const outRoomOut = flow ? noRoom(flow.bridgeOut) : false;
  const bin = flow ? bucketFigures(flow.bridgeIn, baseOk) : bucketFigures({ roomLeft: null, capacity: null, perHour: null, enabled: null, inFlight: 0 }, false);
  const bout = flow ? bucketFigures(flow.bridgeOut, bitOk) : bin;

  const bridgeAmber = baseOk && (frontDoorPaused || inRoomOut);
  const bridgeBackAmber = bitOk && outRoomOut;

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
        { label: "TAO locked for Base", value: bit(bk?.lockPoolFmTao) },
        { label: "Bridged TAO on Base", value: baseOk ? taoText(units(bk?.fmTaoSupplyBase, 18)) : DASH },
      ],
      link: link("AlphaVault on the Bittensor explorer", a && explorer.bittensorAddress(a.alphaVault)),
      tone: toneOf(bitOk, ratio !== null && ratio < 1_000_000),
    },
    {
      id: "bridge", name: "Bridge", chain: "Base to Bittensor",
      headline: !baseOk ? DASH : flow!.bridgeIn.enabled === false ? "Switched off" : bin.room,
      say: SAY.bridge,
      figures: [
        { label: "Room left", value: bin.of },
        { label: "Refills", value: bin.refill },
        { label: "Transfers on the way", value: bin.onTheWay },
        { label: "Next batch sends", value: inText(flow?.batch?.nextSendAt, baseOk, "No batch waiting") },
      ],
      link: link("The lane on Chainlink's explorer", a && explorer.ccipLane(a.baseTokenPool)),
      tone: toneOf(baseOk, bridgeAmber),
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
      id: "bridgeBack", name: "Bridge back", chain: "Bittensor to Base",
      headline: !bitOk ? DASH : flow!.bridgeOut.enabled === false ? "Switched off" : bout.room,
      say: SAY.bridgeBack,
      figures: [
        { label: "Room left", value: bout.of },
        { label: "Refills", value: bout.refill },
        { label: "Transfers on the way", value: bout.onTheWay },
      ],
      link: link("The lane on Chainlink's explorer", a && explorer.ccipLane(a.baseTokenPool)),
      tone: toneOf(bitOk, bridgeBackAmber || frontDoorPaused),
    },
    {
      id: "swapOut", name: "Swap to USDC", chain: "Base", headline: depthHeadline, say: SAY.swapOut,
      figures: [...poolFigures, { label: "A $1,000 payout costs", value: costText(sellCost) }],
      link: link("WETH / USDC pool on Basescan", a && explorer.baseAddress(a.wethUsdcPool)),
      tone: toneOf(baseOk, false),
    },
    { id: "walletOut", name: "Your wallet", chain: "Base", headline: "USDC arrives", say: SAY.walletOut, figures: [], link: null, tone: "ok" },
  ];

  // ---- the top line ----
  let status: PageView["status"];
  if (!data || !flow) {
    status = { kind: "cantCheck", text: "We can't check right now", detail: "The page couldn't reach the monitor, so none of the numbers below are current." };
  } else if (!baseOk || !bitOk) {
    const which = !baseOk && !bitOk ? "Base and Bittensor" : !baseOk ? "Base" : "Bittensor";
    status = { kind: "waiting", text: "Waiting for a fresh reading", detail: `The latest reading from ${which} is too old to show, so those numbers are left blank.` };
  } else {
    const amber = [...stepsIn, ...stepsOut].find((s) => s.tone === "amber");
    if (amber) {
      const detail =
        amber.id === "backing" ? AMBER.backing
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

  return { status, notices: flow ? flow.notices.flatMap((n) => noticeView(n, flow)) : [], stepsIn, stepsOut };
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
 * that started it when the monitor stored one, else to the contract. */
function noticeView(n: Notice, flow: FlowV1): NoticeView[] {
  const who = contractName(n.contract, flow.addresses);
  const base = n.chain === "base";
  const href = n.tx ? (base ? explorer.baseTx(n.tx) : explorer.bittensorTx(n.tx)) : base ? explorer.baseAddress(n.contract) : explorer.bittensorAddress(n.contract);
  const timing =
    typeof n.earliest === "number" && Number.isFinite(n.earliest)
      ? `It can't take effect before ${formatDateTime(new Date(n.earliest * 1000))}.`
      : "It can be accepted at any time.";
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
