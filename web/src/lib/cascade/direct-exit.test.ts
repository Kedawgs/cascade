import { readFileSync } from "node:fs";
import { type Address, BaseError, ContractFunctionRevertedError, type Hex, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { BASE_CHAIN, DIRECT_ORIGIN, VAULT_LENS, VAULT_V32 } from "./abi";
import type { Clients } from "./chain";
import { explorer, RPC } from "./config";
import {
  BASE_DONE,
  BITTENSOR_BY_HAND,
  BITTENSOR_WALLET_CHAIN,
  type BittensorChain,
  type BittensorWallet,
  CANT_SWITCH,
  CONTRACT_WALLET_REFUSAL,
  DECLINED,
  DirectExitStop,
  type DirectExitReads,
  directExitPaid,
  directExitValue,
  directExitView,
  ensureBittensor,
  estimateText,
  EXIT_WORK_GAS,
  exitGasFloor,
  exitGasLimit,
  GAS_NOTE,
  HELD_NOTE,
  isContractWallet,
  LOST,
  NETWORK_NOTE,
  needTaoText,
  NO_GAS,
  NO_TAO_GAS,
  NOTHING_STAKED,
  ORIGIN_DONE,
  ORIGIN_STEP_LABEL,
  ORIGIN_STEP_NOTE,
  ORIGIN_STEP_WHY,
  outcomeLines,
  readDirectExit,
  REVERTED,
  runDirectStep,
  STAKE_CHANGED,
  STILL_CONFIRMING,
  SWITCH_BACK_LABEL,
  SWITCH_BACK_NOTE,
  SWITCH_DECLINED,
  switchBackNote,
  unconfirmedHolds,
  UNSTAKE_SHORT,
  LOW_GAS,
  VAULT_PAUSED,
  type WalletInfo,
  type WithdrawalTx,
  estimateOnBittensor,
  withdrawLabel,
  WOULD_FAIL,
  ZERO_VALUE,
} from "./direct-exit";
import type { FlowCall } from "./flows";
import { STAKE_MISSING } from "./trail";
import { RAO } from "./units";
import { enc, event, H, LAUNCH, type Log, OTHER, USER, V32 } from "./__fixtures__/v32-chains";

// Task 59b: the emergency "Withdraw on Bittensor" (v3.2 only): the vault's own redeemDirect, sent from the holder's
// wallet on Bittensor EVM, never through ForeverMoney, the bridge or the front door.

const SHARES = 4n * 10n ** 22n;
const SUPPLY = 10n ** 24n;
const ASSETS = 102n * 10n ** 16n;
/** The vault's assetsForRedeem, restated (CascadeMath: 1e6 virtual shares, 1 wei of virtual assets, rounded down),
 * floored to rao as redeemDirect floors it. */
const VALUE = (((SHARES * (ASSETS + 1n)) / (SUPPLY + 10n ** 6n)) / RAO) * RAO;
const reads = (over: Partial<DirectExitReads> = {}): DirectExitReads => ({
  shares: SHARES,
  supply: SUPPLY,
  totalAssets: ASSETS,
  origin: 8453n,
  stakeMissing: false,
  paused: false,
  // 0.1 TAO: above the direct exit's gas floor at the price below (FLOOR_GAS at 6 gwei, about 0.0201 TAO)
  gasWei: 10n ** 17n,
  codeBase: "0x",
  codeBittensor: "0x",
  baseDoors: 1n,
  // the launch's two listed hotkeys, its unstakeGas and the vault's EXIT_GAS_RESERVE (contracts/README.md, the caller's
  // gas rule); Bittensor's 5 gwei base fee with viem's 20% headroom, and a tip (0 on Bittensor today; non-zero here, so
  // the test sees it passed on)
  hotkeyCount: 2n,
  unstakeGas: 400_000n,
  exitGasReserve: 2_000_000n,
  gasPriceWei: 6_000_000_000n,
  priorityFeeWei: 1_000_000n,
  ...over,
});
/** The withdrawal's least gas at those reads: the walk's 2,000,000 (Task 65's reserve) + 2 × 400,000, the delegatecall's
 * 1/64 holdback on it (ceil(2,800,000 / 63) = 44,445) and the exit's own 500,000. */
const FLOOR_GAS = 3_344_445n;
/** That gas at 6 gwei: 0.02006667 TAO. */
const FLOOR_WEI = FLOOR_GAS * 6_000_000_000n;
const DELEGATED: Hex = `0xef0100${"11".repeat(20)}`;
const CONTRACT: Hex = "0x608060405234801561001057600080fd5b50";

/** A wallet on chain `chain`, which knows Bittensor EVM already (`known`) or adds it when asked. */
function wallet(
  o: { chain?: number; known?: boolean; unknownError?: unknown; switchError?: unknown; addError?: unknown; addSwitches?: boolean; sendError?: unknown } = {},
) {
  let chain = o.chain ?? 964;
  let known = o.known ?? true;
  const steps: string[] = [];
  const sent: FlowCall[] = [];
  /** The gas limit and fees each send named (undefined: the wallet sets its own). */
  const txs: (WithdrawalTx | undefined)[] = [];
  const w: BittensorWallet = {
    chainId: async () => chain,
    switchChain: async () => {
      steps.push("switch");
      if (o.switchError) throw o.switchError;
      if (!known) throw o.unknownError ?? Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
      chain = 964;
    },
    addChain: async () => {
      steps.push("add");
      if (o.addError) throw o.addError;
      known = true;
      if (o.addSwitches !== false) chain = 964;
    },
    send: async (c, tx) => {
      steps.push(`send on ${chain}`);
      if (o.sendError) throw o.sendError;
      sent.push(c);
      txs.push(tx);
      return H(0xd1);
    },
  };
  return { w, steps, sent, txs };
}

/** Bittensor as the page reads it: `r` at every read, a simulation that passes or reverts `revert`, a gas estimate from
 * the account (`estimate`, 300,000 unless given; an error thrown), a receipt, and an earlier transaction's receipt as a
 * look-up finds it (`mined`: none yet, either status, or a read that fails). */
function chain(
  r: DirectExitReads | (() => DirectExitReads),
  o: {
    revert?: string;
    unreachable?: boolean;
    estimate?: bigint | Error;
    status?: "success" | "reverted";
    logs?: Log[];
    lost?: boolean;
    mined?: "success" | "reverted" | null | "throws";
  } = {},
) {
  const simulated: FlowCall[] = [];
  const estimated: FlowCall[] = [];
  const c: BittensorChain = {
    read: async () => (typeof r === "function" ? r() : r),
    simulate: async (call) => {
      simulated.push(call);
      if (o.unreachable) throw new Error("fetch failed");
      return o.revert ? { ok: false, revert: o.revert } : { ok: true };
    },
    estimate: async (call) => {
      estimated.push(call);
      if (o.estimate instanceof Error) throw o.estimate;
      return o.estimate ?? 300_000n;
    },
    wait: async () => {
      if (o.lost) throw new Error("Timed out while waiting for transaction");
      return { status: o.status ?? "success", logs: (o.logs ?? []) as never };
    },
    mined: async () => {
      if (o.mined === "throws") throw new Error("fetch failed");
      return o.mined ?? null;
    },
  };
  return { c, simulated, estimated };
}

const run = (step: "origin" | "withdraw" | "base", w: BittensorWallet, c: BittensorChain, shownShares = SHARES, kind: WalletInfo = { connectorId: "injected" }) =>
  runDirectStep(step, { wallet: w, chain: c, d: V32, account: USER, shownShares, kind });
const stop = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof DirectExitStop) return e;
    throw e;
  }
  throw new Error("no stop");
};

const redeemedDirect = (user: Address, shares: bigint, assets: bigint, from: Address = V32.vault) =>
  event(from, VAULT_V32, "RedeemedDirect", { user }, enc("uint256, uint256, bool", [shares, assets, false]), 5_000n, H(0xd1), 2);
const shortfallAbsorbed = (amount: bigint, from: Address = V32.vault) => event(from, VAULT_V32, "ShortfallAbsorbed", {}, enc("uint256", [amount]), 5_000n, H(0xd1), 1);

describe("what the page shows (Task 59b)", () => {
  it("estimates the shares' value as the vault prices them, less the exit's own cost (the leaver pays)", () => {
    expect(directExitValue(SHARES, ASSETS, SUPPLY)).toBe(VALUE);
    expect(VALUE % RAO).toBe(0n);
    // about 0.0408 TAO: 4e22 shares of 1e24 in a vault of 1.02 TAO
    expect(VALUE / 10n ** 12n).toBe(40_799n);
    const v = directExitView(reads());
    expect(v.valueWei).toBe(VALUE);
    expect(v.estimate).toBe(estimateText(VALUE));
    expect(estimateText(VALUE)).toBe("About 0.0408 TAO, less any unstake fee the chain charges (none today).");
    expect(withdrawLabel(VALUE)).toBe("Withdraw 0.0408 TAO");
    expect(v.canWithdraw).toBe(true);
    expect(v.hold).toBeNull();
    expect(v.refusal).toBeNull();
    // the notes every visitor sees: the gas and the network
    // the order of magnitude (review of d33c4b5, M3): the withdrawal's least gas limit at today's price
    expect(GAS_NOTE).toBe("Network fees on Bittensor are paid in TAO, so this address needs about 0.02 TAO there, most of it not spent.");
    expect(NETWORK_NOTE).toBe("Your wallet switches to Bittensor EVM (chain 964), and adds it first if it needs to.");
  });

  it("shows the origin step only when it's needed: an address with shares whose home isn't Bittensor itself", () => {
    for (const origin of [0n, 8453n, 42161n]) expect(directExitView(reads({ origin })).originStep, String(origin)).toBe(true);
    expect(directExitView(reads({ origin: DIRECT_ORIGIN })).originStep).toBe(false);
    // nothing to withdraw: no step at all
    const empty = directExitView(reads({ shares: 0n }));
    expect(empty.originStep).toBe(false);
    expect(empty.canWithdraw).toBe(false);
    expect(empty.refusal).toBe(NOTHING_STAKED);
    expect(ORIGIN_STEP_LABEL).toBe("Withdraw here, not from Base");
    expect(ORIGIN_STEP_NOTE).toBe("This address then withdraws on Bittensor, not from Base, until it is switched back.");
    // why someone might set it (the controller's follow-up ruling): it is optional
    expect(ORIGIN_STEP_WHY).toBe("Optional: this stops Base from withdrawing these shares while you leave here.");
    // the withdrawal doesn't wait for it: redeemDirect reads no origin (CascadeVault.sol, redeemDirect)
    expect(directExitView(reads({ origin: 8453n })).canWithdraw).toBe(true);
  });

  it("refuses a contract wallet, in plain words: code at the address on Base or on Bittensor, Base Account, or a smart account not yet deployed", () => {
    for (const [r, w] of [
      [reads({ codeBase: CONTRACT }), {}],
      [reads({ codeBittensor: CONTRACT }), {}],
      [reads(), { connectorId: "baseAccount" }],
      // no code yet, but it runs batches atomically on Base: a key account can't without a delegation, which is code
      [reads(), { connectorId: "injected", atomic: "supported" }],
    ] as const) {
      expect(isContractWallet(r, w)).toBe(true);
      const v = directExitView(r, w);
      expect(v.refusal).toBe(CONTRACT_WALLET_REFUSAL);
      expect([v.canWithdraw, v.canSetOrigin, v.originStep]).toEqual([false, false, false]);
    }
    // a key account, an EIP-7702 one included (its key still signs on Bittensor), is not a contract wallet: the stake
    // form's rule (stake-form.ts contractWalletNote), and the account's code on Bittensor besides
    for (const r of [reads(), reads({ codeBase: DELEGATED }), reads({ codeBittensor: DELEGATED })]) {
      expect(isContractWallet(r, { connectorId: "injected" })).toBe(false);
      expect(isContractWallet(r, { connectorId: "injected", atomic: "ready" })).toBe(false);
    }
    expect(isContractWallet(reads({ codeBase: DELEGATED }), { atomic: "supported" })).toBe(false);
    expect(CONTRACT_WALLET_REFUSAL).toBe(
      "This wallet is a contract account, so it can't withdraw on Bittensor: its address there may belong to someone else. Unstake from Base instead.",
    );
  });

  it("holds the withdrawal, saying why, while the vault is paused, stake is missing, or there's no TAO for gas", () => {
    const paused = directExitView(reads({ paused: true }));
    expect([paused.hold, paused.canWithdraw, paused.canSetOrigin]).toEqual([VAULT_PAUSED, false, true]);
    const missing = directExitView(reads({ stakeMissing: true }));
    expect([missing.hold, missing.canWithdraw, missing.canSetOrigin]).toEqual([STAKE_MISSING, false, true]);
    // no TAO at all: how much it needs, as for too little (review of d33c4b5, M3); the origin step still says NO_GAS
    const dry = directExitView(reads({ gasWei: 0n }));
    expect([dry.hold, dry.canWithdraw, dry.canSetOrigin]).toEqual([needTaoText(FLOOR_WEI, 0n), false, false]);
    const dust = directExitView(reads({ shares: 10n }));
    expect([dust.hold, dust.canWithdraw]).toEqual([ZERO_VALUE, false]);
    expect(VAULT_PAUSED).toBe("Cascade's vault is paused, so withdrawals here wait until it reopens.");
    expect(NO_GAS).toBe("This address has no TAO on Bittensor for the network fee. Send it a little, then come back.");
    expect(ZERO_VALUE).toBe("This stake is too small to pay anything after its own cost.");
  });
});

describe("withdrawing from Base again (Task 59b follow-up)", () => {
  it("is offered only when the address's home isn't Base and Base has an active door", () => {
    for (const origin of [DIRECT_ORIGIN, 0n, 42161n]) {
      const v = directExitView(reads({ origin }));
      expect([v.switchBack, v.canSwitchBack], String(origin)).toEqual([true, true]);
    }
    // home on Base already: nothing to switch back
    expect(directExitView(reads({ origin: BASE_CHAIN })).switchBack).toBe(false);
    // no active door on Base: the vault would refuse it (UnknownOrigin), so it isn't offered
    expect(directExitView(reads({ origin: DIRECT_ORIGIN, baseDoors: 0n })).switchBack).toBe(false);
    // nothing to withdraw, or a contract wallet: no step at all
    expect(directExitView(reads({ origin: DIRECT_ORIGIN, shares: 0n })).switchBack).toBe(false);
    expect(directExitView(reads({ origin: DIRECT_ORIGIN, codeBase: CONTRACT })).switchBack).toBe(false);
    // shown without gas, but held; a pause or missing stake doesn't hold it (setRedeemOrigin works then)
    expect(directExitView(reads({ origin: DIRECT_ORIGIN, gasWei: 0n }))).toMatchObject({ switchBack: true, canSwitchBack: false });
    expect(directExitView(reads({ origin: DIRECT_ORIGIN, paused: true, stakeMissing: true }))).toMatchObject({ switchBack: true, canSwitchBack: true });
    expect(SWITCH_BACK_LABEL).toBe("Use Base for withdrawals again");
    expect(SWITCH_BACK_NOTE).toBe("Unstaking from Base then works again for this address; withdrawing here still works.");
  });

  it("sends exactly setRedeemOrigin(8453) to the vault, and nothing else", async () => {
    const { w, sent } = wallet({ chain: 8453 });
    const { c, simulated } = chain(reads({ origin: DIRECT_ORIGIN }));
    expect(await run("base", w, c)).toMatchObject({ step: "base", hash: H(0xd1) });
    expect(sent).toEqual([{ key: "setRedeemOrigin", to: V32.vault, abi: VAULT_V32, functionName: "setRedeemOrigin", args: [8453n] }]);
    expect(simulated).toEqual(sent);
  });

  it("sends nothing while Base has no active door, for an address already home on Base, or without gas", async () => {
    const inactive = wallet();
    const read = chain(reads({ origin: DIRECT_ORIGIN, baseDoors: 0n }));
    expect((await stop(run("base", inactive.w, read.c))).message).toBe(WOULD_FAIL);
    expect([inactive.steps, inactive.sent, read.simulated]).toEqual([[], [], []]);
    const home = wallet();
    expect(await run("base", home.w, chain(reads({ origin: BASE_CHAIN })).c)).toEqual({ step: "base" });
    expect([home.steps, home.sent]).toEqual([[], []]);
    const dry = wallet();
    expect((await stop(run("base", dry.w, chain(reads({ origin: DIRECT_ORIGIN, gasWei: 0n })).c))).message).toBe(NO_GAS);
    expect(dry.sent).toEqual([]);
    // the door gone between the read and the simulation: the vault refuses UnknownOrigin, nothing is sent
    const raced = wallet();
    expect((await stop(run("base", raced.w, chain(reads({ origin: DIRECT_ORIGIN }), { revert: "UnknownOrigin" }).c))).message).toBe(WOULD_FAIL);
    expect(raced.sent).toEqual([]);
  });
});

describe("sending it (Task 59b)", () => {
  it("sends the user's shares, all of them as read at the click, to the vault on Bittensor, and nothing else", async () => {
    const { w, steps, sent } = wallet({ chain: 8453 });
    const { c, simulated } = chain(reads());
    const out = await run("withdraw", w, c);
    expect(sent).toEqual([{ key: "redeemDirect", to: V32.vault, abi: VAULT_V32, functionName: "redeemDirect", args: [SHARES, false] }]);
    // simulated first, from the account, as sent
    expect(simulated).toEqual(sent);
    expect(steps).toEqual(["switch", "send on 964"]);
    expect(out).toMatchObject({ step: "withdraw", hash: H(0xd1) });
  });

  it("sends nothing when the shares changed since the user looked", async () => {
    for (const [shown, r, revert] of [
      [SHARES - 1n, reads(), undefined],
      [SHARES, reads({ shares: SHARES + 1n }), undefined],
      // a Base request burned some between the read and the simulation
      [SHARES, reads(), "ERC20InsufficientBalance"],
    ] as const) {
      const { w, sent } = wallet();
      const { c } = chain(r, revert ? { revert } : {});
      expect((await stop(run("withdraw", w, c, shown))).message).toBe(STAKE_CHANGED);
      expect(sent).toEqual([]);
    }
    expect(STAKE_CHANGED).toBe("Your stake changed since you looked, so nothing was sent. Check it and try again.");
  });

  it("the origin step sends setRedeemOrigin(DIRECT_ORIGIN) alone, even while the vault is paused or stake is missing", async () => {
    for (const r of [reads(), reads({ paused: true }), reads({ stakeMissing: true })]) {
      const { w, sent } = wallet();
      const { c } = chain(r);
      expect(await run("origin", w, c)).toMatchObject({ step: "origin", hash: H(0xd1) });
      expect(sent).toEqual([{ key: "setRedeemOrigin", to: V32.vault, abi: VAULT_V32, functionName: "setRedeemOrigin", args: [DIRECT_ORIGIN] }]);
    }
    // already home on Bittensor: nothing to send
    const { w, sent } = wallet();
    expect(await run("origin", w, chain(reads({ origin: DIRECT_ORIGIN })).c)).toEqual({ step: "origin" });
    expect(sent).toEqual([]);
  });

  it("stake missing never consents for the user: the withdrawal is held, and a vault that refuses StakeMissing gets nothing sent", async () => {
    // read missing at the click: nothing simulated, nothing sent, the wallet not even switched
    const held = wallet({ chain: 8453 });
    const read = chain(reads({ stakeMissing: true }));
    expect((await stop(run("withdraw", held.w, read.c))).message).toBe(STAKE_MISSING);
    expect([held.steps, held.sent, read.simulated]).toEqual([[], [], []]);
    // gone missing between the read and the simulation: refused, never sent with the opt-in
    const raced = wallet();
    const sim = chain(reads(), { revert: "StakeMissing" });
    expect((await stop(run("withdraw", raced.w, sim.c))).message).toBe(STAKE_MISSING);
    expect(raced.sent).toEqual([]);
    expect(sim.simulated.map((x) => x.args[1])).toEqual([false]);
    // the page's module never builds a redeem of its own: the one call is flows.ts's, acceptMissing false
    const code = readFileSync(new URL("./direct-exit.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(code.match(/redeemDirect\w*\(/g)).toEqual(["redeemDirectCall("]);
    expect(code).not.toMatch(/acceptMissing|\btrue\s*\]/);
  });

  it("refuses at the click, sending nothing, for a contract wallet, a paused vault, no gas, no shares or a stake worth nothing", async () => {
    for (const [r, why, connector] of [
      [reads({ codeBase: CONTRACT }), CONTRACT_WALLET_REFUSAL, undefined],
      [reads(), CONTRACT_WALLET_REFUSAL, { connectorId: "baseAccount" }],
      [reads(), CONTRACT_WALLET_REFUSAL, { connectorId: "injected", atomic: "supported" }],
      [reads({ paused: true }), VAULT_PAUSED, undefined],
      [reads({ gasWei: 0n }), needTaoText(FLOOR_WEI, 0n), undefined],
      [reads({ shares: 0n }), NOTHING_STAKED, undefined],
      [reads({ shares: 10n }), ZERO_VALUE, undefined],
    ] as const) {
      const { w, steps } = wallet({ chain: 8453 });
      const { c, simulated } = chain(r);
      expect((await stop(run("withdraw", w, c, r.shares, connector))).message).toBe(why);
      expect([steps, simulated]).toEqual([[], []]);
    }
    // the origin step is refused for a contract wallet and without gas too
    for (const r of [reads({ codeBittensor: CONTRACT }), reads({ gasWei: 0n })]) {
      const { w, sent } = wallet();
      await stop(run("origin", w, chain(r).c));
      expect(sent).toEqual([]);
    }
  });

  it("says why a simulation refused, and sends nothing", async () => {
    for (const [revert, why] of [
      ["EnforcedPause", VAULT_PAUSED],
      ["ZeroAmount", ZERO_VALUE],
      ["UnstakeShort", UNSTAKE_SHORT],
      // Revision 28's gas guard: a capped read of the chain's minimum given too little gas
      ["InsufficientGas", LOW_GAS],
      ["TransferFailed", WOULD_FAIL],
      [undefined, WOULD_FAIL],
    ] as const) {
      const { w, sent } = wallet();
      const { c } = chain(reads(), { revert: revert ?? "" });
      const o = revert === undefined ? { ...c, simulate: async () => ({ ok: false }) } : c;
      expect((await stop(run("withdraw", w, o))).message).toBe(why);
      expect(sent).toEqual([]);
    }
    const { w, sent } = wallet();
    expect((await stop(run("withdraw", w, chain(reads(), { unreachable: true }).c))).message).toBe("We couldn't reach Bittensor just now. Nothing was sent. Try again.");
    expect(sent).toEqual([]);
    expect(UNSTAKE_SHORT).toBe("The vault can't unstake this much right now, so nothing was sent. Try again later.");
    expect(WOULD_FAIL).toBe("This wouldn't go through on Bittensor right now, so nothing was sent. Try again in a moment.");
  });

  it("the wallet's answers: declined, no TAO for gas, failed on chain, not confirmed yet", async () => {
    const rejected = Object.assign(new Error("User rejected the request."), { code: 4001 });
    expect((await stop(run("withdraw", wallet({ sendError: rejected }).w, chain(reads()).c))).message).toBe(DECLINED);
    const poor = new Error("insufficient funds for gas * price + value");
    expect((await stop(run("withdraw", wallet({ sendError: poor }).w, chain(reads()).c))).message).toBe(NO_TAO_GAS);
    expect((await stop(run("withdraw", wallet().w, chain(reads(), { status: "reverted" }).c))).message).toBe(REVERTED);
    // the wallet's own estimate or send refused by the vault's gas guard (InsufficientGas, decoded from the vault's ABI)
    const short = new BaseError("The contract function \"redeemDirect\" reverted.", { cause: new ContractFunctionRevertedError({ abi: VAULT_V32, data: toFunctionSelector("InsufficientGas()"), functionName: "redeemDirect" }) });
    expect((await stop(run("withdraw", wallet({ sendError: short }).w, chain(reads()).c))).message).toBe(LOW_GAS);
    // the page names the withdrawal's gas now (review M-6), so the words say to keep it
    expect(LOW_GAS).toBe("This was sent with too little gas, so it didn't go through. Try again, and keep the gas this page sets.");
    const lost = await stop(run("withdraw", wallet().w, chain(reads(), { lost: true }).c));
    expect([lost.message, lost.hash]).toEqual([LOST, H(0xd1)]);
    expect(DECLINED).toBe("You declined in your wallet. Nothing was sent.");
    expect(NO_TAO_GAS).toBe("Network fees on Bittensor are paid in TAO, and this address doesn't have enough. Send it a little TAO there and try again.");
    expect(REVERTED).toBe("This failed on Bittensor. Only the network fee was spent.");
    expect(LOST).toBe("We couldn't confirm it yet. Check it on Bittensor in a few minutes.");
  });
});

describe("after the transaction: what RedeemedDirect and ShortfallAbsorbed say was paid (Task 59b; T19's carry)", () => {
  const PAID = VALUE - RAO;

  it("reads the payment and the exit's own cost from the vault's events in the receipt", async () => {
    const logs = [shortfallAbsorbed(RAO), redeemedDirect(USER, SHARES, PAID)];
    expect(directExitPaid(logs as never, V32, USER)).toEqual({ paidWei: PAID, costWei: RAO });
    const out = await run("withdraw", wallet().w, chain(reads(), { logs }).c);
    expect(out).toEqual({ step: "withdraw", hash: H(0xd1), paid: { paidWei: PAID, costWei: RAO } });
    expect(outcomeLines(out)).toEqual(["You received 0.040799998 TAO on Bittensor.", "0.000000001 TAO of its value went to the cost of unstaking it."]);
    // no cost: one line
    expect(outcomeLines({ step: "withdraw", hash: H(1), paid: { paidWei: VALUE, costWei: 0n } })).toEqual(["You received 0.040799999 TAO on Bittensor."]);
  });

  it("never reads another address's event, or another contract's, as the user's payment", () => {
    const OTHER = "0x000000000000000000000000000000000000b0b0" as Address;
    expect(directExitPaid([redeemedDirect(OTHER, SHARES, PAID)] as never, V32, USER)).toBeNull();
    expect(directExitPaid([redeemedDirect(USER, SHARES, PAID, OTHER)] as never, V32, USER)).toBeNull();
    // a ShortfallAbsorbed from another contract is no cost of this exit
    expect(directExitPaid([shortfallAbsorbed(5n, OTHER), redeemedDirect(USER, SHARES, PAID)] as never, V32, USER)).toEqual({ paidWei: PAID, costWei: 0n });
    expect(outcomeLines({ step: "withdraw", hash: H(1) })).toEqual(["Withdrawn to this address on Bittensor. The receipt can't be read right now, so the amount isn't shown."]);
  });
});

describe("the wallet on Bittensor EVM (Task 59b)", () => {
  it("adds chain 964 when the wallet doesn't know it, then switches to it", async () => {
    const already = wallet();
    await ensureBittensor(already.w);
    expect(already.steps).toEqual([]);
    const known = wallet({ chain: 8453 });
    await ensureBittensor(known.w);
    expect(known.steps).toEqual(["switch"]);
    const unknown = wallet({ chain: 8453, known: false });
    await ensureBittensor(unknown.w);
    expect(unknown.steps).toEqual(["switch", "add"]);
    // a wallet that adds without switching is switched after
    const adds = wallet({ chain: 8453, known: false, addSwitches: false });
    await ensureBittensor(adds.w);
    expect(adds.steps).toEqual(["switch", "add", "switch"]);
    // MetaMask Mobile wraps the 4902
    const mobile = wallet({ chain: 8453, known: false, unknownError: { code: -32603, data: { originalError: { code: 4902 } } } });
    await ensureBittensor(mobile.w);
    expect(mobile.steps).toEqual(["switch", "add"]);
  });

  it("says what to do when the wallet won't", async () => {
    const rejected = Object.assign(new Error("User rejected the request."), { code: 4001 });
    for (const [o, why] of [
      [{ chain: 8453, switchError: rejected }, SWITCH_DECLINED],
      [{ chain: 8453, known: false, addError: rejected }, SWITCH_DECLINED],
      [{ chain: 8453, switchError: new Error("Request of type 'wallet_switchEthereumChain' already pending") }, CANT_SWITCH],
      [{ chain: 8453, known: false, addError: new Error("bad rpc") }, CANT_SWITCH],
    ] as const) {
      const w = wallet(o);
      expect((await stop(ensureBittensor(w.w))).message).toBe(why);
    }
    expect(SWITCH_DECLINED).toBe("Switch your wallet to Bittensor EVM to continue.");
    expect(CANT_SWITCH).toBe(
      "Your wallet couldn't switch to Bittensor EVM. Add it by hand: network Bittensor EVM, RPC https://archive.chain.opentensor.ai, chain ID 964, symbol TAO. Then try again.",
    );
  });

  it("describes chain 964 with the site's own Bittensor RPC and explorer (no new host)", () => {
    expect(BITTENSOR_WALLET_CHAIN).toEqual({
      chainId: "0x3c4",
      chainName: "Bittensor EVM",
      nativeCurrency: { name: "TAO", symbol: "TAO", decimals: 18 },
      rpcUrls: [RPC.bittensor],
      blockExplorerUrls: ["https://evm.taostats.io"],
    });
    expect(explorer.bittensorTx("0x1")).toBe(`${BITTENSOR_WALLET_CHAIN.blockExplorerUrls[0]}/tx/0x1`);
  });
});

describe("the reads (Task 59b)", () => {
  /** Bittensor and Base as the reads ask them: what was asked, at which block. */
  function clients(o: { target?: Address; code?: Hex } = {}) {
    const asked: { address: Address; functionName: string; args?: readonly unknown[] }[] = [];
    const blocks: (bigint | undefined)[] = [];
    const bittensor = {
      getBlockNumber: async () => 6_000_000n,
      multicall: async ({ contracts, blockNumber }: { contracts: typeof asked; blockNumber?: bigint }) => {
        asked.push(...contracts.map(({ address, functionName, args }) => ({ address, functionName, ...(args ? { args } : {}) })));
        blocks.push(blockNumber);
        return [SHARES, SUPPLY, false, ASSETS, DIRECT_ORIGIN, true, o.target ?? V32.vault, 1n, 3n, 450_000n, 2_000_000n];
      },
      getBalance: async ({ address, blockNumber }: { address: Address; blockNumber?: bigint }) => {
        asked.push({ address, functionName: "getBalance" });
        blocks.push(blockNumber);
        return 7n;
      },
      // the price the site's other balance checks use (reads.ts, send-now): viem's maxFeePerGas
      estimateFeesPerGas: async () => {
        asked.push({ address: USER, functionName: "estimateFeesPerGas" });
        return { maxFeePerGas: 6_000_000_000n, maxPriorityFeePerGas: 2_000_000n };
      },
      getCode: async ({ address }: { address: Address }) => {
        asked.push({ address, functionName: "getCode on Bittensor" });
        return o.code;
      },
    };
    const base = {
      getCode: async ({ address }: { address: Address }) => {
        asked.push({ address, functionName: "getCode on Base" });
        return undefined;
      },
    };
    return { c: { bittensor, base } as unknown as Pick<Clients, "base" | "bittensor">, asked, blocks };
  }

  it("reads the vault and its lens on Bittensor at one block, and the account's code on both chains", async () => {
    const { c, asked, blocks } = clients();
    expect(await readDirectExit(c, V32, USER)).toEqual({
      shares: SHARES,
      supply: SUPPLY,
      paused: false,
      totalAssets: ASSETS,
      origin: DIRECT_ORIGIN,
      stakeMissing: true,
      gasWei: 7n,
      codeBase: "0x",
      codeBittensor: "0x",
      baseDoors: 1n,
      hotkeyCount: 3n,
      unstakeGas: 450_000n,
      exitGasReserve: 2_000_000n,
      gasPriceWei: 6_000_000_000n,
      priorityFeeWei: 2_000_000n,
    });
    expect(asked).toEqual([
      { address: V32.vault, functionName: "balanceOf", args: [USER] },
      { address: V32.vault, functionName: "totalSupply" },
      { address: V32.vault, functionName: "paused" },
      { address: V32.vaultLens, functionName: "totalAssets" },
      { address: V32.vaultLens, functionName: "redeemOrigin", args: [USER] },
      { address: V32.vaultLens, functionName: "stakeMissing" },
      { address: V32.vaultLens, functionName: "target" },
      { address: V32.vaultLens, functionName: "activeDoors", args: [8453n] },
      // the caller's gas rule's inputs (review M-6): the walk's positions at most, each removal's least gas, the reserve
      { address: V32.vaultLens, functionName: "hotkeyCount" },
      { address: V32.vaultLens, functionName: "unstakeGas" },
      { address: V32.vaultLens, functionName: "EXIT_GAS_RESERVE" },
      { address: USER, functionName: "getBalance" },
      { address: USER, functionName: "estimateFeesPerGas" },
      { address: USER, functionName: "getCode on Bittensor" },
      { address: USER, functionName: "getCode on Base" },
    ]);
    expect(blocks).toEqual([6_000_000n, 6_000_000n]);
    for (const name of ["target", "activeDoors", "hotkeyCount", "unstakeGas", "EXIT_GAS_RESERVE"]) expect(VAULT_LENS.some((x) => x.type === "function" && x.name === name), name).toBe(true);
  });

  it("trusts no lens that reads another vault, and is v3.2's only", async () => {
    await expect(readDirectExit(clients({ target: USER }).c, V32, USER)).rejects.toThrow();
    await expect(readDirectExit(clients().c, LAUNCH, USER)).rejects.toThrow(/v3\.2/);
    expect((await readDirectExit(clients({ code: CONTRACT }).c, V32, USER)).codeBittensor).toBe(CONTRACT);
  });

  it("never touches ForeverMoney, the bridge or the front door", () => {
    const code = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    for (const f of ["./direct-exit.ts", "./use-direct-exit.ts", "../../components/app/BittensorExitScreen.tsx"]) {
      // the one-transaction staker (a way into the front door), the oracle and Uniswap too (Task 59b review, M1)
      for (const word of [
        "frontDoor",
        "FRONT_DOOR",
        "baseAdapter",
        "bitAdapter",
        "ADAPTER",
        "ALPHA_VAULT",
        "TOKENS",
        "OFFRAMP",
        "doorLens",
        "DOOR_LENS",
        "useFlows",
        "staker",
        "stakerAbi",
        "oracle",
        "UNISWAP",
      ]) {
        expect(code(f), `${f}: ${word}`).not.toContain(word);
      }
    }
  });

  it("sends every step's one call to the vault, whatever the step (Task 59b review, M1)", async () => {
    for (const [step, r] of [
      ["origin", reads()],
      ["withdraw", reads()],
      ["base", reads({ origin: DIRECT_ORIGIN })],
    ] as const) {
      const { w, sent } = wallet();
      const { c, simulated } = chain(r);
      await run(step, w, c);
      expect(sent, step).toHaveLength(1);
      expect([...sent, ...simulated].every((x) => x.to === V32.vault), step).toBe(true);
    }
  });
});

describe("the withdrawal's gas (review M-6: contracts/README.md, the caller's gas rule)", () => {
  /** What the withdrawal is sent with at the fixture's reads, for a gas limit `gas`: the fees read, as checked. */
  const sentWith = (gas: bigint): WithdrawalTx => ({ gas, maxFeePerGas: 6_000_000_000n, maxPriorityFeePerGas: 1_000_000n });

  it("sends redeemDirect with the floor when the estimate is low: the walk's gas, the delegatecall's 1/64 holdback on it, and the exit's own work", async () => {
    expect(EXIT_WORK_GAS).toBe(500_000n);
    expect(exitGasFloor(reads())).toBe(FLOOR_GAS);
    // the walk runs in a library by delegatecall, which forwards at most 63/64 of the gas left (EIP-150): at the setter's
    // top, four hotkeys at 5,000,000, 21,300,000 gas for the walk needs ceil(21,300,000 / 63) = 338,096 more before it
    expect(exitGasFloor(reads({ hotkeyCount: 4n, unstakeGas: 5_000_000n, exitGasReserve: 1_300_000n }))).toBe(21_300_000n + 338_096n + 500_000n);
    const { w, sent, txs } = wallet();
    const { c, estimated } = chain(reads(), { estimate: 300_000n });
    await run("withdraw", w, c);
    expect(txs).toEqual([sentWith(FLOOR_GAS)]);
    // estimated from the account, for the call as sent
    expect(estimated).toEqual(sent);
  });

  it("sends the estimate plus a quarter, rounded up, when that is above the floor", async () => {
    expect(exitGasLimit(2_400_000n, 2_500_000n)).toBe(3_000_000n);
    expect(exitGasLimit(2_400_001n, 2_500_000n)).toBe(3_000_002n);
    expect(exitGasLimit(1_999_999n, 2_500_000n)).toBe(2_500_000n);
    // the floor at the fixture's reads is 3,344,445 (Task 65's 2,000,000 reserve): 3,200,000 × 1.25 = 4,000,000 is above it
    const { w, txs } = wallet();
    await run("withdraw", w, chain(reads(), { estimate: 3_200_000n }).c);
    expect(txs).toEqual([sentWith(4_000_000n)]);
  });

  it("signs the fees the balance was checked at: the price read, and its tip (review of d33c4b5, M2)", async () => {
    const { w, txs } = wallet();
    await run("withdraw", w, chain(reads({ gasPriceWei: 7_000_000_000n, priorityFeeWei: 3n }), { estimate: 300_000n }).c);
    expect(txs).toEqual([{ gas: FLOOR_GAS, maxFeePerGas: 7_000_000_000n, maxPriorityFeePerGas: 3n }]);
  });

  it("holds the withdrawal, and refuses it at the click, while the TAO can't cover that gas at today's price, saying how much it needs", async () => {
    const short = directExitView(reads({ gasWei: FLOOR_WEI - 1n }));
    expect([short.hold, short.canWithdraw]).toEqual([needTaoText(FLOOR_WEI, FLOOR_WEI - 1n), false]);
    expect(short.hold).toBe("This address needs about 0.0201 TAO on Bittensor to cover the network fee (most of it isn't spent), and has 0.0200. Send it a little more, then come back.");
    // the origin step needs far less: still offered
    expect(short.canSetOrigin).toBe(true);
    expect(directExitView(reads({ gasWei: FLOOR_WEI })).hold).toBeNull();
    // none at all: the same words, with what it has (review of d33c4b5, M3)
    expect(directExitView(reads({ gasWei: 0n })).hold).toBe(
      "This address needs about 0.0201 TAO on Bittensor to cover the network fee (most of it isn't spent), and has 0.0000. Send it a little more, then come back.",
    );
    // at the click: an estimate whose limit (4,000,000 × 1.25 = 5,000,000 gas, 0.03 TAO) is above what it holds
    const { w, sent } = wallet();
    const held = reads({ gasWei: 25n * 10n ** 15n });
    expect(directExitView(held).hold).toBeNull();
    const s = await stop(run("withdraw", w, chain(held, { estimate: 4_000_000n }).c));
    expect(s.message).toBe("This address needs about 0.0300 TAO on Bittensor to cover the network fee (most of it isn't spent), and has 0.0250. Send it a little more, then come back.");
    expect(sent).toEqual([]);
    // exactly that much: it goes (review of d33c4b5, M4)
    const exact = wallet();
    await run("withdraw", exact.w, chain(reads({ gasWei: 5_000_000n * 6_000_000_000n }), { estimate: 4_000_000n }).c);
    expect(exact.txs).toEqual([sentWith(5_000_000n)]);
    // read short at the click: held, nothing simulated
    const dry = chain(reads({ gasWei: FLOOR_WEI - 1n }));
    expect((await stop(run("withdraw", wallet().w, dry.c))).message).toBe(needTaoText(FLOOR_WEI, FLOOR_WEI - 1n));
    expect(dry.simulated).toEqual([]);
    // the need rounded up and the balance down, to 0.0001 TAO: neither looks better than it is
    expect(needTaoText(10n ** 14n + 1n, 2n * 10n ** 14n - 1n)).toBe(
      "This address needs about 0.0002 TAO on Bittensor to cover the network fee (most of it isn't spent), and has 0.0001. Send it a little more, then come back.",
    );
  });

  it("an estimate the vault refuses says why; one Bittensor can't answer says so; nothing is sent either way", async () => {
    const refused = new BaseError("The contract function \"redeemDirect\" reverted.", { cause: new ContractFunctionRevertedError({ abi: VAULT_V32, data: toFunctionSelector("UnstakeShort()"), functionName: "redeemDirect" }) });
    const a = wallet();
    expect((await stop(run("withdraw", a.w, chain(reads(), { estimate: refused }).c))).message).toBe(UNSTAKE_SHORT);
    const b = wallet();
    expect((await stop(run("withdraw", b.w, chain(reads(), { estimate: new Error("fetch failed") }).c))).message).toBe("We couldn't reach Bittensor just now. Nothing was sent. Try again.");
    expect([a.sent, b.sent]).toEqual([[], []]);
  });

  it("estimates from the user's own account, the call as it is sent (review of d33c4b5, M4)", async () => {
    const asked: unknown[] = [];
    const c = { bittensor: { estimateContractGas: async (p: unknown) => (asked.push(p), 412_345n) } } as unknown as Pick<Clients, "bittensor">;
    const call = { key: "redeemDirect", to: V32.vault, abi: VAULT_V32, functionName: "redeemDirect", args: [SHARES, false] as const };
    expect(await estimateOnBittensor(c, USER, call)).toBe(412_345n);
    expect(asked).toEqual([{ account: USER, address: V32.vault, abi: VAULT_V32, functionName: "redeemDirect", args: [SHARES, false] }]);
  });

  it("names no gas or fees for the origin step or the switch back: the wallet sets its own", async () => {
    for (const [step, r] of [
      ["origin", reads()],
      ["base", reads({ origin: DIRECT_ORIGIN })],
    ] as const) {
      const { w, txs } = wallet();
      const { c, estimated } = chain(r);
      await run(step, w, c);
      expect([txs, estimated], step).toEqual([[undefined], []]);
    }
  });
});

describe("the page's follow-ups (Task 59b review, M3-M7)", () => {
  const originSet = (user: Address, chainId: bigint, from: Address = V32.vault) => event(from, VAULT_V32, "RedeemOriginSet", { user }, enc("uint64", [chainId]), 5_000n, H(0xd1), 0);

  it("M3: confirms the origin step and the switch back from the vault's RedeemOriginSet for the account, never by assumption", async () => {
    const origin = await run("origin", wallet().w, chain(reads(), { logs: [originSet(USER, DIRECT_ORIGIN)] }).c);
    expect(origin).toEqual({ step: "origin", hash: H(0xd1), confirmed: true });
    expect(outcomeLines(origin)).toEqual([ORIGIN_DONE]);
    const back = await run("base", wallet().w, chain(reads({ origin: DIRECT_ORIGIN }), { logs: [originSet(USER, 8453n)] }).c);
    expect(back).toEqual({ step: "base", hash: H(0xd1), confirmed: true });
    expect(outcomeLines(back)).toEqual([BASE_DONE]);
    expect(ORIGIN_DONE).toBe("Done: this address now withdraws here, not from Base.");
    expect(BASE_DONE).toBe("Done: this address now uses Base for withdrawals.");
  });

  it("M3: with no such event in the receipt, reads the origin again; still not set, it says it can't confirm it yet", async () => {
    // another user's event, another contract's, or another chain's are no confirmation: the read decides
    let n = 0;
    const settled = chain(() => (n++ === 0 ? reads() : reads({ origin: DIRECT_ORIGIN })), { logs: [originSet(OTHER, DIRECT_ORIGIN), originSet(USER, DIRECT_ORIGIN, OTHER), originSet(USER, 8453n)] });
    const read = await run("origin", wallet().w, settled.c);
    expect(read).toEqual({ step: "origin", hash: H(0xd1), confirmed: true });
    expect(n).toBe(2);
    // the read shows the old origin still: not confirmed, never "done"
    const stale = await run("origin", wallet().w, chain(reads()).c);
    expect(stale).toEqual({ step: "origin", hash: H(0xd1), confirmed: false });
    expect(outcomeLines(stale)).toEqual([LOST]);
    // the read failing confirms nothing either
    let m = 0;
    const down = chain(() => {
      if (m++ > 0) throw new Error("fetch failed");
      return reads({ origin: DIRECT_ORIGIN });
    });
    expect(await run("base", wallet().w, down.c)).toEqual({ step: "base", hash: H(0xd1), confirmed: false });
    // nothing sent (already home): nothing to confirm, nothing said
    expect(outcomeLines({ step: "origin" })).toEqual([]);
  });

  it("M5: the switch back is 'Use Base for withdrawals again', and its note says exactly what changes for each origin", () => {
    expect(SWITCH_BACK_LABEL).toBe("Use Base for withdrawals again");
    // home on Bittensor: Base worked before, so "again"
    expect(switchBackNote(DIRECT_ORIGIN)).toBe(SWITCH_BACK_NOTE);
    expect(SWITCH_BACK_NOTE).toBe("Unstaking from Base then works again for this address; withdrawing here still works.");
    // no origin yet (shares only from the reward cut): Base never worked for it
    expect(switchBackNote(0n)).toBe("Unstaking from Base then works for this address; withdrawing here still works.");
    // another chain: that chain's front door stops unstaking it
    expect(switchBackNote(42161n)).toBe("Unstaking from Base then works for this address, and no longer from the other chain it uses now; withdrawing here still works.");
  });

  it("M6: a wallet that can't switch is told the network to add by hand: the RPC and the chain id", async () => {
    expect(BITTENSOR_BY_HAND).toBe(`network Bittensor EVM, RPC ${RPC.bittensor}, chain ID 964, symbol TAO`);
    expect(CANT_SWITCH).toBe(`Your wallet couldn't switch to Bittensor EVM. Add it by hand: ${BITTENSOR_BY_HAND}. Then try again.`);
    const w = wallet({ chain: 8453, known: false, addError: new Error("bad rpc") });
    expect((await stop(ensureBittensor(w.w))).message).toContain(RPC.bittensor);
  });

  it("M7: after a withdrawal it couldn't confirm, no second one is sent until its receipt shows or the shares change", async () => {
    const unconfirmed = { hash: H(0xd1), shares: SHARES };
    // still not mined, the shares as they were: held, nothing simulated or sent, and the first one named
    const held = wallet();
    const pending = chain(reads(), { mined: null });
    const s = await stop(runDirectStep("withdraw", { wallet: held.w, chain: pending.c, d: V32, account: USER, shownShares: SHARES, kind: { connectorId: "injected" }, unconfirmed }));
    expect([s.message, s.hash]).toEqual([STILL_CONFIRMING, H(0xd1)]);
    expect([held.steps, held.sent, pending.simulated]).toEqual([[], [], []]);
    expect(STILL_CONFIRMING).toBe("Your last withdrawal isn't confirmed yet, so nothing more was sent. Check it on Bittensor in a few minutes.");
    // a withdrawal dropped and never mined holds the button until a reload (review, Minor 7): the page says so beside it
    expect(HELD_NOTE).toBe("If your last withdrawal never shows on Bittensor, reload this page to try again.");
    const page = readFileSync(new URL("../../components/app/BittensorExitScreen.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/\{held && \(?\s*<p[^>]*>\s*\{HELD_NOTE\}\s*<\/p>\s*\)?\}/);
    // a receipt that can't be read holds too: never a second redeem on a guess
    const down = chain(reads(), { mined: "throws" });
    await expect(runDirectStep("withdraw", { wallet: wallet().w, chain: down.c, d: V32, account: USER, shownShares: SHARES, kind: {}, unconfirmed })).rejects.toThrow(STILL_CONFIRMING);
    // its receipt shows (mined, either way): the click goes on as usual
    for (const mined of ["success", "reverted"] as const) {
      const go = wallet();
      await runDirectStep("withdraw", { wallet: go.w, chain: chain(reads(), { mined }).c, d: V32, account: USER, shownShares: SHARES, kind: {}, unconfirmed });
      expect(go.sent, mined).toHaveLength(1);
    }
    // the shares changed since (the first one burned them): the page's usual checks decide, nothing held
    const moved = wallet();
    await runDirectStep("withdraw", { wallet: moved.w, chain: chain(reads({ shares: SHARES / 2n }), { mined: null }).c, d: V32, account: USER, shownShares: SHARES / 2n, kind: {}, unconfirmed });
    expect(moved.sent).toHaveLength(1);
    // the origin step and the switch back aren't held by it
    expect(await run("origin", wallet().w, chain(reads(), { mined: null }).c)).toMatchObject({ step: "origin" });
  });

  it("M7: the page holds its withdraw button meanwhile, from the same rule", () => {
    const u = { hash: H(0xd1), shares: SHARES };
    expect(unconfirmedHolds(null, SHARES, false)).toBe(false);
    expect(unconfirmedHolds(u, SHARES, false)).toBe(true);
    // the receipt seen, or the shares re-read as changed: not held
    expect(unconfirmedHolds(u, SHARES, true)).toBe(false);
    expect(unconfirmedHolds(u, SHARES - 1n, false)).toBe(false);
  });
});
