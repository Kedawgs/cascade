import { type Address, getAddress, type Hex, isAddress } from "viem";
import { fromJson, toJson } from "./memory.ts";
import type { ChainName } from "./types.ts";

// What the v3.2 keeper knows of its deployment (design-keeper-worker.md §1, deployment.ts): its addresses, chain ids
// and start blocks, the 24 h max wait (the web's own value), the USDC delivery flag, the operator's top-up limit, and
// what must hold for life (Task 46b's list B). Built from the record on the PC (keeper/deployment-v32.ts) and from the
// Worker's DEPLOYMENT var (Task 50b's config-from-record writes it with encodeDeployment).

/** One getter's value that holds for life (an immutable, a constant): read and compared every hour. */
export interface ForLifeValue {
  chain: ChainName;
  /** The contract's name, for the message */
  contract: string;
  address: Address;
  /** The getter, its Solidity return type, and the value it must return (an address, a number or a word, as text) */
  fn: string;
  returns: "address" | "uint256" | "uint64" | "bytes32" | "bool";
  want: string;
}

/** One contract's runtime code: keccak256 of the frozen build's, filled in from the plan, CBOR metadata stripped. */
export interface ForLifeCode {
  chain: ChainName;
  contract: string;
  address: Address;
  codeHash: Hex;
}

/** One of the oracle's pools on Base: its fee() as planned (route 0's tier for it; immutable in the pool), and its
 * observation slots in use, which only grow, at least the oracle's window needs. */
export interface ForLifePool {
  /** "TAO/WETH" or "WETH/USDC", for the message */
  pair: string;
  address: Address;
  fee: number;
}

export interface DeploymentV32 {
  version: "v3.2";
  /** The deployment's name (OPS_DEPLOYMENT, the monitor's DEPLOYMENT): v3.2-launch */
  name: string;
  chainIds: Record<ChainName, number>;
  /** The vault's launch chain (its launchChain(): Base's id) */
  launchChain: bigint;
  addresses: {
    vault: Address;
    vaultLens: Address;
    frontDoor: Address;
    doorLens: Address;
    bitAdapter: Address;
    baseAdapter: Address;
    staker: Address;
    oracle: Address;
  };
  /** The v3.2 keeper: the address the keeper signs as, and the one keeper() names on both contracts */
  keeper: Address;
  /** The vault's coldkey (the ADDRESS_MAPPING of its address; the for-life list checks it is) */
  vaultColdkey: Hex;
  /** When the vault was created: its create's block time on Bittensor (unix seconds), read once when the deployment is
   * built. Its lastStakeAt is never before it. */
  vaultCreatedAt: number;
  /** Where each chain's log scans start: its first create's block */
  startBlocks: Record<ChainName, bigint>;
  /** The longest the keeper holds a batch with entries that can close, from its start: the web's own
   * (NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S, deployments.json batchMaxWaitS), 86,400 at launch */
  batchMaxWaitS: number;
  /** deployments.json's usdcDelivery: off means no delivery at all (Task 50a) */
  usdcDelivery: boolean;
  /** The most the keeper adds to a payout's bridge fee above the entries' ceiling, in wei, whole rao
   * (OPS_PAYOUT_TOPUP_MAX; the founder's default 0: a fee above the ceiling waits) */
  payoutTopUpMax: bigint;
  /** The most the keeper may spend on each chain in 24 hours, gas plus value, in wei (Task 50a; OPS_KEEPER_SPEND_CAP_*,
   * the founder's ~a third of the keeper's gas by default): over it, nothing more is sent on that chain */
  spendCap: Record<ChainName, bigint>;
  /** ForeverMoney's AlphaVault on Bittensor (the Bittensor adapter's), Uniswap's QuoterV2 on Base and the WETH -> USDC
   * path the close's ETH price is quoted on, each chain's CCIP OffRamp, the staking precompile */
  alphaVault: Address;
  quoterV2: Address;
  ethUsdcPath: Hex;
  offRamps: Record<ChainName, Address>;
  /** Task 52: each chain's CCIP OnRamp 2.0.0 and chain selector, where the park job and the FAILURE re-execution
   * rebuild a message from (its CCIPMessageSent). Optional: a deployment without them runs no park job and re-executes
   * nothing (said once). */
  onRamps?: Record<ChainName, Address>;
  selectors?: Record<ChainName, bigint>;
  /** Task 52: the most the keeper pays as a park refund's CCIP fee (refundParked's msg.value, quoteRefund's quote), in wei
   * (OPS_PARK_REFUND_FEE_MAX); absent: v32/parked.ts PARK_REFUND_FEE_MAX. Above it, the refund waits. */
  parkRefundFeeMax?: bigint;
  /** Task 52 fix round 1 (the founder's ruling: by hand only at launch): whether the keeper re-executes Cascade's CCIP
   * FAILUREs by itself (OPS_REEXEC_AUTO=on). Absent or false: off. The keeper then reports each FAILURE with the hand
   * command to run (pnpm ops reexec), and re-executes nothing. On only after the rehearsals (Task 61). */
  reexecAuto?: boolean;
  stakingPrecompile: Address;
  /** Task 46b's "for life" list (B): what is checked every hour, never the stored verify.ok (readiness.ts also checks
   * the vault's coldkey, its staking flag and its lastStakeAt) */
  forLife: { values: ForLifeValue[]; code: ForLifeCode[]; pools: ForLifePool[] };
  /** R4 (D-M2, C-M2): the adapter pairs added after the deploy (runbook §8's switch: pnpm ops add-pair writes them into the
   * record), oldest first, each with the blocks its adapters were created at, where its scans start. The deploy's own
   * pair is `addresses.baseAdapter` and `addresses.bitAdapter`. The park job, the conversions, the FAILURE watch and the
   * hand park and reexec commands work every pair (adapterPairs): an old pair stays, since it can still hold parks and
   * late refunds. Absent: the deploy's pair alone. */
  pairs?: AdapterPair[];
}

/** One CCIP adapter pair (R4): the Base adapter (the door's sender, the payouts' receiver) and the Bittensor adapter (the
 * batches' receiver, where they park; the payouts' sender), and where each one's log scans start. */
export interface AdapterPair {
  baseAdapter: Address;
  bitAdapter: Address;
  startBlocks: Record<ChainName, bigint>;
}

/** Every adapter pair of `d`, the deploy's first (its addresses and start blocks), then those added since (d.pairs). */
export function adapterPairs(d: Pick<DeploymentV32, "addresses" | "startBlocks" | "pairs">): AdapterPair[] {
  return [{ baseAdapter: d.addresses.baseAdapter, bitAdapter: d.addresses.bitAdapter, startBlocks: d.startBlocks }, ...(d.pairs ?? [])];
}

/** The pair whose Bittensor adapter is `bitAdapter` (absent: the deploy's first), or undefined when `d` lists none. */
export function pairOfBit(d: Pick<DeploymentV32, "addresses" | "startBlocks" | "pairs">, bitAdapter?: Address): AdapterPair | undefined {
  const all = adapterPairs(d);
  return bitAdapter === undefined ? all[0] : all.find((p) => p.bitAdapter.toLowerCase() === bitAdapter.toLowerCase());
}

/** The pair whose Base adapter is `baseAdapter`, or undefined when `d` lists none. */
export function pairOfBase(d: Pick<DeploymentV32, "addresses" | "startBlocks" | "pairs">, baseAdapter: Address): AdapterPair | undefined {
  return adapterPairs(d).find((p) => p.baseAdapter.toLowerCase() === baseAdapter.toLowerCase());
}

const RAO = 10n ** 9n;
const CHAINS = ["base", "bittensor"] as const;

/** Why `d` is not a deployment the keeper can run on (each problem), or none. */
export function deploymentProblems(d: DeploymentV32): string[] {
  const out: string[] = [];
  const addr = (what: string, a: unknown) => {
    if (typeof a !== "string" || !isAddress(a, { strict: false })) out.push(`${what} is not an address`);
  };
  if (d.version !== "v3.2") out.push(`its version is ${String(d.version)}, not v3.2`);
  if (!d.name) out.push("it has no name");
  for (const c of CHAINS) {
    if (!Number.isInteger(d.chainIds?.[c]) || d.chainIds[c] <= 0) out.push(`its ${c} chain id is not a chain id`);
    if (typeof d.startBlocks?.[c] !== "bigint" || d.startBlocks[c] < 0n) out.push(`its ${c} start block is not a block`);
    addr(`its ${c} OffRamp`, d.offRamps?.[c]);
    // Task 52's lane ends, checked when given (both or neither)
    if (d.onRamps !== undefined) addr(`its ${c} OnRamp`, d.onRamps?.[c]);
    if (d.selectors !== undefined && (typeof d.selectors?.[c] !== "bigint" || d.selectors[c] <= 0n)) out.push(`its ${c} CCIP selector is not a selector`);
  }
  if ((d.onRamps === undefined) !== (d.selectors === undefined)) out.push("it names CCIP OnRamps without selectors, or selectors without OnRamps");
  if (d.parkRefundFeeMax !== undefined && (typeof d.parkRefundFeeMax !== "bigint" || d.parkRefundFeeMax <= 0n)) out.push("its park refund fee cap is not an amount of wei above 0");
  if (d.reexecAuto !== undefined && typeof d.reexecAuto !== "boolean") out.push("its automatic re-execution setting is not true or false");
  for (const [k, a] of Object.entries(d.addresses ?? {})) addr(`its ${k}`, a);
  for (const k of ["vault", "vaultLens", "frontDoor", "doorLens", "bitAdapter", "baseAdapter", "staker", "oracle"] as const) if (!d.addresses?.[k]) out.push(`it has no ${k}`);
  addr("its keeper", d.keeper);
  addr("its AlphaVault", d.alphaVault);
  addr("its QuoterV2", d.quoterV2);
  addr("its staking precompile", d.stakingPrecompile);
  if (!Number.isInteger(d.batchMaxWaitS) || d.batchMaxWaitS <= 0) out.push("its batch max wait is not a number of seconds above 0");
  if (typeof d.usdcDelivery !== "boolean") out.push("its usdcDelivery is not true or false");
  if (typeof d.payoutTopUpMax !== "bigint" || d.payoutTopUpMax < 0n || d.payoutTopUpMax % RAO !== 0n) out.push("its payout top-up limit is not a whole number of rao (wei divisible by 1e9)");
  for (const c of CHAINS) {
    const cap = d.spendCap?.[c];
    if (typeof cap !== "bigint" || cap <= 0n) out.push(`its ${c === "base" ? "Base" : "Bittensor"} spend cap is not an amount of wei above 0`);
  }
  if (typeof d.vaultColdkey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(d.vaultColdkey)) out.push("its vault coldkey is not a 32-byte word");
  if (!Number.isInteger(d.vaultCreatedAt) || d.vaultCreatedAt <= 0) out.push("its vault creation time is not a time (unix seconds above 0)");
  if (!Array.isArray(d.forLife?.values) || !Array.isArray(d.forLife?.code) || !Array.isArray(d.forLife?.pools)) out.push("it has no for-life list");
  for (const p of d.forLife?.pools ?? []) {
    addr(`its ${p.pair} pool`, p.address);
    if (!Number.isInteger(p.fee) || p.fee <= 0) out.push(`its ${p.pair} pool's fee is not a fee tier`);
  }
  if (d.pairs !== undefined) {
    if (!Array.isArray(d.pairs)) out.push("its adapter pairs are not a list");
    else {
      const seen = new Set<string>();
      for (const [i, p] of d.pairs.entries()) {
        addr(`its adapter pair ${i + 2}'s Base adapter`, p?.baseAdapter);
        addr(`its adapter pair ${i + 2}'s Bittensor adapter`, p?.bitAdapter);
        for (const c of CHAINS) if (typeof p?.startBlocks?.[c] !== "bigint" || p.startBlocks[c] < 0n) out.push(`its adapter pair ${i + 2}'s ${c} start block is not a block`);
        for (const a of [p?.baseAdapter, p?.bitAdapter]) {
          const k = String(a).toLowerCase();
          if (seen.has(k) || k === String(d.addresses?.baseAdapter).toLowerCase() || k === String(d.addresses?.bitAdapter).toLowerCase()) out.push(`its adapter pair ${i + 2} lists ${String(a)}, an adapter it lists already`);
          seen.add(k);
        }
      }
    }
  }
  return out;
}

/** The deployment as the Worker's DEPLOYMENT var holds it (JSON, bigints tagged). */
export const encodeDeployment = (d: DeploymentV32): string => toJson(d);

/** The DEPLOYMENT var read back and checked: refused, naming every problem, when it is not a v3.2 deployment the keeper
 * can run on. Addresses come back checksummed. */
export function decodeDeployment(text: string): DeploymentV32 {
  const d = fromJson<DeploymentV32>(text);
  const problems = deploymentProblems(d);
  if (problems.length) throw new Error(`the keeper's deployment is not usable: ${problems.join("; ")}; nothing read or sent`);
  return {
    ...d,
    keeper: getAddress(d.keeper),
    addresses: Object.fromEntries(Object.entries(d.addresses).map(([k, a]) => [k, getAddress(a)])) as DeploymentV32["addresses"],
    forLife: { ...d.forLife, pools: d.forLife.pools.map((p) => ({ ...p, address: getAddress(p.address) })) },
    ...(d.pairs ? { pairs: d.pairs.map((p) => ({ ...p, baseAdapter: getAddress(p.baseAdapter), bitAdapter: getAddress(p.bitAdapter) })) } : {}),
  };
}
