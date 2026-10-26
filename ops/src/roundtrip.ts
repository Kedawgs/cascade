import {
  type Address,
  decodeEventLog,
  decodeFunctionData,
  domainSeparator,
  encodeAbiParameters,
  formatEther,
  formatUnits,
  type Hex,
  hexToBigInt,
  parseAbi,
  parseAbiParameters,
} from "viem";
import { type ChainName, LIVE } from "./config.ts";
import { chainLabel, unit } from "./send.ts";

/** One step of the v3 round trip, as measured on the forks. */
export interface StepReport {
  step: string;
  chain: ChainName;
  /** Who pays the gas: the user's own wallet, the keeper (the test wallet), or CCIP's executor (out of
   * the bridge fee the other chain paid; the rehearsal relays by hand). */
  payer: "user" | "keeper" | "bridge";
  gasUsed: bigint;
  /** gasUsed × the fork's gas price, in wei of ETH (Base) or TAO (Bittensor) */
  costWei: bigint;
  /** The bridge fee the step paid, in the same unit (the closes and the payout) */
  bridgeFeeWei?: bigint;
  /** A relay: the gas the receiving adapter needs, and the limit the message gave it (enforced) */
  receiver?: { need: bigint; limit: bigint };
  /** What the step did, in words */
  detail: string;
}

/** The delivery's USDC, measured on the user's balance, and the floors deliver enforces. */
export interface DeliveryResult {
  usdcBefore: bigint;
  usdcAfter: bigint;
  /** What the front door's Delivered event says it paid */
  usdcOut: bigint;
  floors: { user: bigint; twap: bigint; keeper: bigint };
}

/** A step's measurement; the round trip names it. */
export type Measured = Omit<StepReport, "step">;

/** The round trip's steps on the two forks; each sends one transaction and measures it. */
export interface RoundTripDeps {
  permitStake(): Promise<Measured>;
  closeBatch(which: "deposit" | "redeem"): Promise<Measured>;
  relayToBittensor(which: "deposit" | "redeem"): Promise<Measured>;
  stake(): Promise<Measured>;
  requestRedeem(): Promise<Measured>;
  processPayouts(): Promise<Measured>;
  relayToBase(): Promise<Measured>;
  deliver(): Promise<Measured & { delivery: DeliveryResult }>;
}

export const ROUND_TRIP = [
  "permit stake",
  "close the deposit batch",
  "deliver the deposit batch on Bittensor",
  "stake the vault's TAO",
  "request a redeem with USDC delivery",
  "close the redeem batch",
  "deliver the redeem batch on Bittensor",
  "process the payout",
  "deliver the payout on Base",
  "deliver USDC",
] as const;

const PAYER = { user: "the user", keeper: "the keeper", bridge: "CCIP's executor, out of the bridge fee" } as const;

const amount = (chain: ChainName, wei: bigint) => `${formatEther(wei)} ${unit(chain)}`;

/** One line per step: its chain, gas and fee, who pays, and what it did. */
export function formatStep(n: number, r: StepReport): string {
  const bridge = r.bridgeFeeWei === undefined ? "" : `; bridge fee ${amount(r.chain, r.bridgeFeeWei)}`;
  return `${String(n).padStart(2)}. ${chainLabel(r.chain)} — ${r.step}: ${r.gasUsed.toLocaleString("en-US")} gas, ${amount(r.chain, r.costWei)} (${PAYER[r.payer]})${bridge}. ${r.detail}`;
}

const usdc = (units: bigint) => `${formatUnits(units, 6)} USDC`;

/** The largest of the floors deliver enforces. */
export const deliveryFloor = (f: DeliveryResult["floors"]) => [f.user, f.twap, f.keeper].reduce((a, b) => (a > b ? a : b));

/** Passes when the user's USDC rose by what the front door says it delivered, and by at least the
 * floor; the line says so. Throws otherwise. */
export function checkDelivered(d: DeliveryResult): string {
  const rose = d.usdcAfter - d.usdcBefore;
  const floor = deliveryFloor(d.floors);
  const floors = `user ${usdc(d.floors.user)}, TWAP ${usdc(d.floors.twap)}, keeper ${usdc(d.floors.keeper)}`;
  if (rose !== d.usdcOut) {
    throw new Error(`the user's USDC rose by ${usdc(rose)}, but the front door reports delivering ${usdc(d.usdcOut)}`);
  }
  if (rose < floor) throw new Error(`the user's USDC rose by only ${usdc(rose)}, below the floor of ${usdc(floor)} (${floors})`);
  return `The user's USDC rose by ${usdc(rose)}, at least the floor of ${usdc(floor)} (${floors}): the round trip delivers`;
}

/** Runs the ten steps in order, printing each one as it lands; stops at the first failure, naming the
 * step. `onStep` sees every report (the rehearsal saves them into its record). */
export async function runRoundTrip(
  deps: RoundTripDeps,
  log: (l: string) => void,
  onStep: (r: StepReport) => void = () => undefined,
): Promise<{ reports: StepReport[]; delivery: DeliveryResult }> {
  const steps: (() => Promise<Measured>)[] = [
    () => deps.permitStake(),
    () => deps.closeBatch("deposit"),
    () => deps.relayToBittensor("deposit"),
    () => deps.stake(),
    () => deps.requestRedeem(),
    () => deps.closeBatch("redeem"),
    () => deps.relayToBittensor("redeem"),
    () => deps.processPayouts(),
    () => deps.relayToBase(),
  ];
  const reports: StepReport[] = [];
  const run = async <T extends Measured>(i: number, f: () => Promise<T>): Promise<T> => {
    let m: T;
    try {
      m = await f();
    } catch (e) {
      throw new Error(`step ${i + 1} (${ROUND_TRIP[i]}) failed: ${(e as Error).message}`);
    }
    const { chain, payer, gasUsed, costWei, bridgeFeeWei, receiver, detail } = m;
    const r: StepReport = {
      step: ROUND_TRIP[i],
      chain,
      payer,
      gasUsed,
      costWei,
      ...(bridgeFeeWei === undefined ? {} : { bridgeFeeWei }),
      ...(receiver === undefined ? {} : { receiver }),
      detail,
    };
    reports.push(r);
    onStep(r);
    log(formatStep(i + 1, r));
    return m;
  };
  for (const [i, f] of steps.entries()) await run(i, f);
  const last = await run(steps.length, () => deps.deliver());
  log(checkDelivered(last.delivery));
  return { reports, delivery: last.delivery };
}

// ---- reading the forks ----

/** The staking stand-in's record of what the real precompile would have debited (RehearsalPrecompiles.sol). */
export const DEBIT_EVENT = parseAbi(["event Debit(address indexed who, uint256 amount)"]);

type Log = { address: Address; topics: Hex[]; data: Hex };

/** The stand-in's Debit events among a receipt's logs, for the rehearsal to settle. */
export function standInDebits(logs: readonly Log[], standIn: Address): { who: Address; amount: bigint }[] {
  return logs.flatMap((l) => {
    if (l.address.toLowerCase() !== standIn.toLowerCase()) return [];
    try {
      const d = decodeEventLog({ abi: DEBIT_EVENT, topics: l.topics as [Hex, ...Hex[]], data: l.data });
      return [{ who: d.args.who, amount: d.args.amount }];
    } catch {
      return [];
    }
  });
}

export const CCIP_ROUTER_ABI = parseAbi([
  "struct EVMTokenAmount { address token; uint256 amount; }",
  "struct EVM2AnyMessage { bytes receiver; bytes data; EVMTokenAmount[] tokenAmounts; address feeToken; bytes extraArgs; }",
  "struct Any2EVMMessage { bytes32 messageId; uint64 sourceChainSelector; bytes sender; bytes data; EVMTokenAmount[] destTokenAmounts; }",
  "function ccipSend(uint64 destinationChainSelector, EVM2AnyMessage message) payable returns (bytes32)",
  "function ccipReceive(Any2EVMMessage message)",
]);

/** A frame of a callTracer trace (debug_traceTransaction). */
export interface CallFrame {
  from: Address;
  to?: Address;
  input: Hex;
  output?: Hex;
  error?: string;
  calls?: CallFrame[];
}

export interface CcipSend {
  /** The adapter that sent it */
  from: Address;
  destinationChainSelector: bigint;
  data: Hex;
  tokenAmounts: readonly { token: Address; amount: bigint }[];
  extraArgs: Hex;
  messageId: Hex;
}

/** The one successful ccipSend to `router` in a transaction's trace: what the adapter handed CCIP. */
export function ccipSendIn(trace: CallFrame, router: Address): CcipSend {
  const found: CallFrame[] = [];
  const walk = (f: CallFrame) => {
    if (f.to?.toLowerCase() === router.toLowerCase() && !f.error) {
      try {
        if (decodeFunctionData({ abi: CCIP_ROUTER_ABI, data: f.input }).functionName === "ccipSend") found.push(f);
      } catch {
        // another of the router's functions
      }
    }
    for (const c of f.calls ?? []) walk(c);
  };
  walk(trace);
  if (found.length !== 1) throw new Error(`expected one ccipSend to the router ${router} in the transaction, found ${found.length}`);
  const f = found[0];
  const { args } = decodeFunctionData({ abi: CCIP_ROUTER_ABI, data: f.input });
  const [destinationChainSelector, m] = args as unknown as [bigint, { data: Hex; tokenAmounts: readonly { token: Address; amount: bigint }[]; extraArgs: Hex }];
  if (!f.output || f.output.length !== 66) throw new Error("the ccipSend in the trace returned no message id");
  return { from: f.from, destinationChainSelector, data: m.data, tokenAmounts: m.tokenAmounts, extraArgs: m.extraArgs, messageId: f.output };
}

/** The destination gas limit in the adapters' GenericExtraArgsV3: tag (4 bytes), then a uint32. */
export function extraArgsGas(extraArgs: Hex): bigint {
  if (!extraArgs.toLowerCase().startsWith("0xa69dd4aa") || extraArgs.length < 18) throw new Error(`extra args ${extraArgs} are not the adapters' V3 tag`);
  return hexToBigInt(`0x${extraArgs.slice(10, 18)}`);
}

/** The message the destination router hands the receiving adapter, from what the source adapter sent:
 * the source adapter as a 32-byte sender, each token as the destination chain's twin. */
export function deliveryMessage(sent: CcipSend, sourceChainSelector: bigint, destToken: Address) {
  return {
    messageId: sent.messageId,
    sourceChainSelector,
    sender: encodeAbiParameters(parseAbiParameters("address"), [sent.from]),
    data: sent.data,
    destTokenAmounts: sent.tokenAmounts.map((t) => ({ token: destToken, amount: t.amount })),
  };
}

/** Calldata gas (4 per zero byte, 16 per other byte): with 21,000, what a transaction pays before it runs. */
export function calldataGas(data: Hex): bigint {
  let gas = 0n;
  for (let i = 2; i < data.length; i += 2) gas += data.slice(i, i + 2) === "00" ? 4n : 16n;
  return gas;
}

/** The domain a rehearsal signs a permit in: the fork's own chain id, and only if the token's
 * separator says so (USDC computes it from the chain at call time). Nothing a rehearsal signs may be
 * valid on Base, so Base's chain id, or a separator for any other chain, fails before anything is signed. */
export function forkPermitDomain(
  separator: Hex,
  domain: { name: string; version: string; verifyingContract: Address },
  forkChainId: number,
): { name: string; version: string; verifyingContract: Address; chainId: number } {
  if (forkChainId === LIVE.base.CHAIN_ID) throw new Error(`a rehearsal never signs a permit for Base's chain id ${LIVE.base.CHAIN_ID}; nothing signed`);
  const d = { ...domain, chainId: forkChainId };
  if (domainSeparator({ domain: d }).toLowerCase() !== separator.toLowerCase()) {
    throw new Error(`the token's permit domain is not for the fork's chain id ${forkChainId}; nothing signed`);
  }
  return d;
}

/** One line for the relays: what each receiver needed of the gas its message gave it. */
export function formatReceivers(reports: readonly StepReport[]): string {
  const parts = reports.flatMap((r) =>
    r.receiver
      ? [`${r.step}: ${r.receiver.need.toLocaleString("en-US")} of ${r.receiver.limit.toLocaleString("en-US")} (${Number((r.receiver.need * 1000n) / r.receiver.limit) / 10}%)`]
      : [],
  );
  return `Receiver gas needed of the message's limit, each relay sent with that limit enforced: ${parts.join("; ")}`;
}
