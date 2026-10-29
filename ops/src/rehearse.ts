import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import {
  type Abi,
  type Address,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  formatUnits,
  type Hex,
  hexToBigInt,
  hexToNumber,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  parseAbiParameters,
  parseSignature,
} from "viem";
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { loadArtifact } from "./artifacts.ts";
import { BASE_V3, cadenceFromEnv, type ChainName, type Env, isV3Deployment, LIVE, PRECOMPILE, paths, recordPath, targets, WALLET } from "./config.ts";
import { deploy } from "./deploy.ts";
import { close as keeperClose, deliver as keeperDeliver, payouts as keeperPayouts, stake as keeperStake } from "./keeper/actions.ts";
import { checkDelivery, DESTINATION_BASE } from "./keeper/delivery.ts";
import { keeperDeps } from "./keeper/state.ts";
import { cadenceOf, isPlanV3, ROUTE_0, rolesOf } from "./plan.ts";
import { type DeploymentRecord, saveRecord } from "./record.ts";
import {
  CCIP_ROUTER_ABI,
  type CallFrame,
  calldataGas,
  ccipSendIn,
  deliveryMessage,
  extraArgsGas,
  type Measured,
  forkPermitDomain,
  formatReceivers,
  type RoundTripDeps,
  runRoundTrip,
  type StepReport,
  standInDebits,
} from "./roundtrip.ts";
import { cardinalitySteps, cardinalityTxs, readPool } from "./cardinality.ts";
import { launchRolesFromEnv } from "./roles.ts";
import { balanceOf, chainIdOf, createRpc, nonceOf, read, type Rpc } from "./rpc.ts";
import { type Ctx, describeRevert, execFileRunner } from "./send.ts";
import { ownedContracts, verify } from "./verify.ts";
import { contractName } from "./handoff.ts";

const BITTENSOR_ARCHIVE = "https://archive.chain.opentensor.ai";
/** Forks always use the public Base RPC, so a keyed RPC from .env never lands in anvil's log. */
const PUBLIC_BASE_RPC = "https://mainnet.base.org";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TAO = 10n ** 18n;
/** Native TAO the staking stand-in pays unstakes from (RehearsalPrecompiles.sol). */
const STAND_IN_FLOAT = 100_000n * TAO;

async function waitUp(rpc: Rpc, chain: ChainName, ms = 180_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await chainIdOf(rpc, chain);
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`the local ${chain} fork did not start: ${(e as Error).message}`);
      await sleep(1_000);
    }
  }
}

export interface Rehearsal {
  ctx: Ctx;
  stop(): void;
}

/** Two local anvil forks at the live state with their own chain ids (31337, 31338), so nothing signed
 * here can be replayed on Base or Bittensor; stand-ins at Bittensor's precompile addresses. */
export async function startForks(env: Env, log: (l: string) => void): Promise<Rehearsal> {
  const p = paths(env);
  const t = targets(env);
  mkdirSync(p.deploymentsDir, { recursive: true });
  const anvil = join(p.foundryBin, process.platform === "win32" ? "anvil.exe" : "anvil");
  const procs: ChildProcess[] = [];
  const start = (args: string[], name: string) => {
    const out = openSync(join(p.deploymentsDir, name), "w");
    procs.push(spawn(anvil, args, { stdio: ["ignore", out, out], windowsHide: true }));
  };
  const stop = () => {
    for (const c of procs) c.kill();
  };
  try {
    start(["--fork-url", PUBLIC_BASE_RPC, "--port", "8545", "--chain-id", "31337"], "rehearsal-anvil-base.log");
    start(
      ["--fork-url", BITTENSOR_ARCHIVE, "--port", "8547", "--chain-id", "31338", "--retries", "12", "--fork-retry-backoff", "20000", "--timeout", "60000"],
      "rehearsal-anvil-bittensor.log",
    );
    const rpc = createRpc(t.rehearsal, { minIntervalMs: { bittensor: 0 } });
    await waitUp(rpc, "base");
    await waitUp(rpc, "bittensor");
    const standIns: [string, string][] = [
      ["RehearsalAddressMapping", PRECOMPILE.addressMapping],
      ["RehearsalStaking", PRECOMPILE.staking],
      ["RehearsalBalanceTransfer", PRECOMPILE.balanceTransfer],
    ];
    for (const [name, addr] of standIns) {
      await rpc.request("bittensor", "anvil_setCode", [addr, loadArtifact(p.contractsDir, name).deployedBytecode]);
    }
    await rpc.request("bittensor", "anvil_setBalance", [PRECOMPILE.staking, numberToHex(STAND_IN_FLOAT)]);
    for (const chain of ["base", "bittensor"] as const) {
      await rpc.request(chain, "anvil_setBalance", [WALLET, numberToHex(10n ** 18n)]);
      // the forked Bittensor block has no prevrandao, which anvil's EVM requires; a local block has one
      await rpc.request(chain, "evm_mine", []);
    }
    log("Started local forks of Base and Bittensor (chain ids 31337 and 31338)");
    const ctx: Ctx = { live: false, targets: t.rehearsal, rpc, runner: execFileRunner, paths: p, log, receiptTimeoutMs: 120_000, pollMs: 500 };
    return { ctx, stop };
  } catch (e) {
    stop();
    throw e;
  }
}

// ---- the forks' plumbing ----

type Log = { address: Address; topics: Hex[]; data: Hex };
type Receipt = { status: Hex; gasUsed: Hex; effectiveGasPrice: Hex; logs: Log[]; transactionHash: Hex };

async function receiptOf(rpc: Rpc, chain: ChainName, hash: Hex): Promise<Receipt> {
  for (let i = 0; i < 240; i++) {
    const r = (await rpc.request(chain, "eth_getTransactionReceipt", [hash])) as Receipt | null;
    if (r) return r;
    await sleep(500);
  }
  throw new Error(`transaction ${hash} was not mined on the ${chain} fork`);
}

const gasOf = (r: Receipt) => ({ gasUsed: hexToBigInt(r.gasUsed), costWei: hexToBigInt(r.gasUsed) * hexToBigInt(r.effectiveGasPrice) });

const setBalance = (rpc: Rpc, chain: ChainName, who: Address, wei: bigint) => rpc.request(chain, "anvil_setBalance", [who, numberToHex(wei)]);

const blockTime = async (rpc: Rpc, chain: ChainName) =>
  hexToNumber(((await rpc.request(chain, "eth_getBlockByNumber", ["latest", false])) as { timestamp: Hex }).timestamp);

async function warp(rpc: Rpc, chain: ChainName, seconds: number) {
  await rpc.request(chain, "evm_increaseTime", [seconds]);
  await rpc.request(chain, "evm_mine", []);
}

const traceOf = async (rpc: Rpc, chain: ChainName, hash: Hex) =>
  (await rpc.request(chain, "debug_traceTransaction", [hash, { tracer: "callTracer" }])) as CallFrame;

/** Runs `send` as an account the fork lets us impersonate (a CCIP router or token pool), then puts its
 * balance back: the top-up only pays the gas. */
async function impersonating<T>(ctx: Ctx, chain: ChainName, from: Address, send: () => Promise<T>): Promise<T> {
  const { rpc } = ctx;
  const before = await balanceOf(rpc, chain, from);
  await rpc.request(chain, "anvil_impersonateAccount", [from]);
  await setBalance(rpc, chain, from, before + TAO);
  try {
    return await send();
  } finally {
    await setBalance(rpc, chain, from, before);
    await rpc.request(chain, "anvil_stopImpersonatingAccount", [from]);
  }
}

/** One transaction from an impersonated account, with `gas` as its limit when given (else anvil's estimate). */
async function submit(ctx: Ctx, chain: ChainName, tx: { from: Address; to: Address; data: Hex; gas?: bigint }, label: string): Promise<Receipt> {
  let hash: Hex;
  try {
    const { gas, ...rest } = tx;
    hash = (await ctx.rpc.request(chain, "eth_sendTransaction", [{ ...rest, ...(gas === undefined ? {} : { gas: numberToHex(gas) }) }])) as Hex;
  } catch (e) {
    throw new Error(`${label} would fail (${describeRevert(ctx, e)})`);
  }
  const r = await receiptOf(ctx.rpc, chain, hash);
  if (r.status !== "0x1") throw new Error(`${label} reverted (transaction ${hash})`);
  return r;
}

const sendAs = (ctx: Ctx, chain: ChainName, from: Address, to: Address, data: Hex, label: string) =>
  impersonating(ctx, chain, from, () => submit(ctx, chain, { from, to, data }, label));

/** A Base transaction the user signs with its fork-only key: chain id 31337, so it means nothing on Base. */
async function sendAsUser(ctx: Ctx, user: PrivateKeyAccount, to: Address, data: Hex, label: string, value = 0n): Promise<Receipt> {
  const { rpc } = ctx;
  let gas: bigint;
  try {
    gas = hexToBigInt((await rpc.request("base", "eth_estimateGas", [{ from: user.address, to, data, value: numberToHex(value) }])) as Hex);
  } catch (e) {
    throw new Error(`${label} would fail (${describeRevert(ctx, e)})`);
  }
  const block = (await rpc.request("base", "eth_getBlockByNumber", ["latest", false])) as { baseFeePerGas: Hex };
  const tip = 1_000_000n;
  const raw = await user.signTransaction({
    chainId: ctx.targets.base.chainId,
    type: "eip1559",
    to,
    data,
    value,
    nonce: await nonceOf(rpc, "base", user.address),
    gas: (gas * 13n) / 10n,
    maxFeePerGas: hexToBigInt(block.baseFeePerGas) * 2n + tip,
    maxPriorityFeePerGas: tip,
  });
  const hash = (await rpc.request("base", "eth_sendRawTransaction", [raw])) as Hex;
  const r = await receiptOf(rpc, "base", hash);
  if (r.status !== "0x1") throw new Error(`${label} reverted (transaction ${hash})`);
  return r;
}

/** Settles what the staking stand-in could not debit in the transaction (its Debit events): the payer's
 * balance down and the stand-in's up, as the precompile's stake would have moved them. */
async function settleDebits(rpc: Rpc, logs: readonly Log[]) {
  for (const d of standInDebits(logs, PRECOMPILE.staking)) {
    const balance = await balanceOf(rpc, "bittensor", d.who);
    if (balance < d.amount) throw new Error(`the staking stand-in recorded a ${formatEther(d.amount)} TAO stake from ${d.who}, which holds only ${formatEther(balance)}`);
    await setBalance(rpc, "bittensor", d.who, balance - d.amount);
    await setBalance(rpc, "bittensor", PRECOMPILE.staking, (await balanceOf(rpc, "bittensor", PRECOMPILE.staking)) + d.amount);
  }
}

function eventIn(logs: readonly Log[] | undefined, address: Address, abi: Abi, eventName: string): Record<string, unknown> {
  for (const l of logs ?? []) {
    if (l.address.toLowerCase() !== address.toLowerCase()) continue;
    try {
      return decodeEventLog({ abi, eventName, topics: l.topics as [Hex, ...Hex[]], data: l.data } as never).args as Record<string, unknown>;
    } catch {
      // another event
    }
  }
  throw new Error(`the transaction has no ${eventName} event from ${address}`);
}

// ---- the v3 round trip on the forks ----

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function mint(address account, uint256 amount)",
  "function nonces(address owner) view returns (uint256)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);
const ALPHA = parseAbi([
  "function positionOf(address token) view returns (bytes32 validator, uint256 netuid)",
  "function vaultColdkey() view returns (bytes32)",
]);
const STAND_IN = parseAbi([
  "function setColdkeyAlias(address who, bytes32 coldkey)",
  "function seedStake(bytes32 hotkey, bytes32 coldkey, uint256 netuid, uint256 rao)",
]);
const STAKER = parseAbi([
  "function stakeWithPermit(address beneficiary, uint256 usdcIn, uint256 minTaoOut, uint8 routeId, uint256 deadline, uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s) returns (uint256)",
  "function depositFeeUsdc() view returns (uint256)",
  "function swapFeeBps() view returns (uint16)",
  "event Staked(address indexed payer, address indexed beneficiary, uint256 usdcIn, uint256 fees, uint256 taoDeposited)",
]);
const FRONT = parseAbi([
  "function batchInterval() view returns (uint64)",
  "function minDeposit() view returns (uint256)",
  "function depositOf(address user) view returns (uint256)",
  "function redeemOf(address user) view returns (uint256)",
  "function redeemRequestFee() view returns (uint256)",
  "function requestRedeemWithDelivery(uint256 shares, uint128 minUsdcPerTao, uint64 deadline, uint32 destination) payable",
  "function deliveryOf(address user) view returns (uint128 minUsdcPerTao, uint64 deadline, uint32 destination)",
  "function claimable(address user) view returns (uint256)",
  "function maxDeliverySlippageBps() view returns (uint16)",
  "event BatchClosed(uint64 indexed id, uint256 totalDeposits, uint256 nDeposits, uint256 nRedeems, uint256 fee, uint256 potUsed)",
]);
const ORACLE = parseAbi(["function usdcValue(uint256 taoWei) view returns (uint256)"]);
const VAULT = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function rootStakeRao() view returns (uint256)",
  "function payoutDelay() view returns (uint64)",
  "event Staked(bytes32 indexed hotkey, uint256 rao, uint256 measured)",
  "event PayoutBatchQueued(bytes32 indexed key, uint64 indexed sourceChain, uint64 batchId, uint32 count, uint256 total, uint256 price)",
  "event PayoutChunkSent(bytes32 indexed key, uint32 chunk, uint32 taken, uint256 gross, uint256 net, uint256 fee)",
]);
const ADAPTER = parseAbi([
  "event Delivered(bytes32 indexed messageId, uint64 sourceChain, address indexed sender, address indexed recipient, uint256 amount)",
]);
const QUOTER = parseAbi([
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);

/** The user stakes $20 of USDC, as in the owner's test run. */
export const USDC_IN = 20_000_000n;
/** FiatToken v2.2 keeps balances in the mapping at slot 9. */
const USDC_BALANCE_SLOT = 9n;
/** ForeverMoney's AlphaVault's TAO position, seeded in the staking stand-in (20,000 TAO, in rao). */
const ALPHA_SEED_RAO = 20_000n * 10n ** 9n;
/** Calls the stand-in's setup functions; any account will do on a fork. */
const HARNESS: Address = "0x00000000000000000000000000000000c0ffee01";
/** The user's floor: 97% of the oracle's 30-minute price. */
const USER_FLOOR_PCT = 97n;

const usdc = (units: bigint) => `${formatUnits(units, 6)} USDC`;
const tao = (wei: bigint) => `${formatEther(wei)} TAO`;
const eth = (wei: bigint) => `${formatEther(wei)} ETH`;
const short = (h: Hex) => `${h.slice(0, 10)}…`;

/** The ten steps against the deployment on the forks, from a fresh user key; prepares the forks first
 * (the AlphaVault's position in the staking stand-in, the user's ETH and USDC). */
export async function forkRoundTrip(r: Rehearsal, rec: DeploymentRecord, path: string): Promise<RoundTripDeps> {
  const { ctx } = r;
  const { rpc } = ctx;
  if (!isPlanV3(rec.plan)) throw new Error("the round trip needs a v3 deployment");
  const a = rec.plan.addresses;
  const view = (chain: ChainName, address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
    read(rpc, chain, { address, abi, functionName, args });
  const usdcOf = async (who: Address) => (await view("base", BASE_V3.USDC, ERC20, "balanceOf", [who])) as bigint;

  // ForeverMoney's AlphaVault converts through the staking stand-in under its own coldkey
  const [validator, netuid] = (await view("bittensor", LIVE.ALPHA_VAULT, ALPHA, "positionOf", [LIVE.bittensor.TOKEN])) as readonly [Hex, bigint];
  const avColdkey = (await view("bittensor", LIVE.ALPHA_VAULT, ALPHA, "vaultColdkey")) as Hex;
  const setup = (functionName: string, args: unknown[]) =>
    sendAs(ctx, "bittensor", HARNESS, PRECOMPILE.staking, encodeFunctionData({ abi: STAND_IN, functionName, args } as never), `stand-in ${functionName}`);
  await setup("setColdkeyAlias", [LIVE.ALPHA_VAULT, avColdkey]);
  await setup("seedStake", [validator, avColdkey, netuid, ALPHA_SEED_RAO]);

  // the user: a key made for this run, with gas money and $20 of USDC written into USDC's balance slot
  const user = privateKeyToAccount(generatePrivateKey());
  await setBalance(rpc, "base", user.address, 10n ** 17n);
  const slot = keccak256(encodeAbiParameters(parseAbiParameters("address, uint256"), [user.address, USDC_BALANCE_SLOT]));
  await rpc.request("base", "anvil_setStorageAt", [BASE_V3.USDC, slot, pad(numberToHex(USDC_IN), { size: 32 })]);
  if ((await usdcOf(user.address)) !== USDC_IN) {
    throw new Error("writing the user's USDC did not take: USDC's storage no longer keeps balances at slot 9");
  }
  ctx.log(`The user is a key made for this run, on the forks only: ${user.address}, holding ${usdc(USDC_IN)} and 0.1 ETH on Base`);

  const deps = () => keeperDeps(ctx, rec, path, [user.address]);
  const closes: Partial<Record<"deposit" | "redeem", Hex>> = {};
  let payoutHash: Hex | undefined;

  /** Relays the one CCIP message `hash` sent through `from`'s router: the destination pool hands the
   * tokens to the receiving adapter, then the destination router calls it, as CCIP's executor would,
   * with the gas the sending adapter asked CCIP for. The OffRamp gives ccipReceive that limit, so the
   * relay is sent with exactly it for the receiver (plus 21,000 and the calldata): a receiver that needs
   * more fails the step. What it needs is the node's estimate (the least gas that succeeds, before
   * refunds) less those two. */
  async function relay(from: ChainName, hash: Hex) {
    const to: ChainName = from === "base" ? "bittensor" : "base";
    const [srcAdapter, dstAdapter] = from === "base" ? [a.baseAdapter, a.bitAdapter] : [a.bitAdapter, a.baseAdapter];
    const sent = ccipSendIn(await traceOf(rpc, from, hash), LIVE[from].ROUTER);
    if (sent.from.toLowerCase() !== srcAdapter.toLowerCase()) throw new Error(`the message was sent by ${sent.from}, not the adapter ${srcAdapter}`);
    if (sent.destinationChainSelector !== LIVE[to].SELECTOR) throw new Error(`the message is for chain selector ${sent.destinationChainSelector}`);
    const amount = sent.tokenAmounts[0]?.amount ?? 0n;
    if (amount > 0n) {
      // Bittensor's LockRelease pool releases the bridged TAO; Base's BurnMint pool mints it
      const release = to === "bittensor" ? encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [dstAdapter, amount] }) : encodeFunctionData({ abi: ERC20, functionName: "mint", args: [dstAdapter, amount] });
      await sendAs(ctx, to, LIVE[to].POOL, LIVE[to].TOKEN, release, `the ${to} token pool's release`);
    }
    const data = encodeFunctionData({ abi: CCIP_ROUTER_ABI, functionName: "ccipReceive", args: [deliveryMessage(sent, LIVE[from].SELECTOR, LIVE[to].TOKEN)] });
    const limit = extraArgsGas(sent.extraArgs);
    const overhead = 21_000n + calldataGas(data);
    const router = LIVE[to].ROUTER;
    const label = `delivering message ${short(sent.messageId)} with the message's ${limit.toLocaleString("en-US")} gas for the receiver`;
    const { receipt, need } = await impersonating(ctx, to, router, async () => {
      let estimate: bigint;
      try {
        estimate = hexToBigInt((await rpc.request(to, "eth_estimateGas", [{ from: router, to: dstAdapter, data }])) as Hex);
      } catch (e) {
        throw new Error(`${label} would fail (${describeRevert(ctx, e)})`);
      }
      const need = estimate - overhead;
      if (need > limit) {
        throw new Error(`the receiver needs about ${need.toLocaleString("en-US")} gas, more than the message's ${limit.toLocaleString("en-US")}: CCIP would fail this message`);
      }
      return { need, receipt: await submit(ctx, to, { from: router, to: dstAdapter, data, gas: overhead + limit }, label) };
    });
    eventIn(receipt.logs, dstAdapter, ADAPTER, "Delivered");
    if (to === "bittensor") await settleDebits(rpc, receipt.logs);
    const pct = Number((need * 1000n) / limit) / 10;
    const gas = `the receiver needs about ${need.toLocaleString("en-US")} gas of the ${limit.toLocaleString("en-US")} the message gives it (${pct}%), and ran with that limit enforced`;
    return { sent, amount, receipt, gas, receiver: { need, limit } };
  }

  const keeperStep = (chain: ChainName, done: { gasUsed: bigint; costWei: bigint }, detail: string, bridgeFeeWei?: bigint): Measured => ({
    chain,
    payer: "keeper",
    gasUsed: done.gasUsed,
    costWei: done.costWei,
    ...(bridgeFeeWei === undefined ? {} : { bridgeFeeWei }),
    detail,
  });

  return {
    async permitStake() {
      const depositFee = (await view("base", a.staker, STAKER, "depositFeeUsdc")) as bigint;
      const feeBps = BigInt(Number(await view("base", a.staker, STAKER, "swapFeeBps")));
      const fees = depositFee + ((USDC_IN - depositFee) * feeBps) / 10_000n;
      const [taoQuote] = (await view("base", BASE_V3.QUOTER_V2, QUOTER, "quoteExactInput", [ROUTE_0.buyPath, USDC_IN - fees])) as readonly [bigint];
      const minTaoOut = (taoQuote * 99n) / 100n;
      const minDeposit = (await view("base", a.frontDoor, FRONT, "minDeposit")) as bigint;
      if (minTaoOut < minDeposit) throw new Error(`${usdc(USDC_IN)} buys only ${tao(taoQuote)}, under the front door's ${tao(minDeposit)} minimum`);
      const deadline = BigInt((await blockTime(rpc, "base")) + 3600);
      const name = (await view("base", BASE_V3.USDC, ERC20, "name")) as string;
      const version = (await view("base", BASE_V3.USDC, ERC20, "version")) as string;
      const nonce = (await view("base", BASE_V3.USDC, ERC20, "nonces", [user.address])) as bigint;
      const separator = (await view("base", BASE_V3.USDC, ERC20, "DOMAIN_SEPARATOR")) as Hex;
      // the fork's chain id only: nothing signed here may be valid on Base
      const domain = forkPermitDomain(separator, { name, version, verifyingContract: BASE_V3.USDC }, ctx.targets.base.chainId);
      const signature = await user.signTypedData({
        domain,
        types: {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "Permit",
        message: { owner: user.address, spender: a.staker, value: USDC_IN, nonce, deadline },
      });
      const sig = parseSignature(signature);
      const v = sig.v === undefined ? 27 + (sig.yParity ?? 0) : Number(sig.v);
      const data = encodeFunctionData({
        abi: STAKER,
        functionName: "stakeWithPermit",
        args: [user.address, USDC_IN, minTaoOut, 0, deadline, deadline, v, sig.r, sig.s],
      });
      const receipt = await sendAsUser(ctx, user, a.staker, data, "the permit stake");
      const staked = eventIn(receipt.logs, a.staker, STAKER, "Staked") as { fees: bigint; taoDeposited: bigint };
      if ((await view("base", BASE_V3.USDC, ERC20, "nonces", [user.address])) !== nonce + 1n) throw new Error("USDC did not use the permit");
      if ((await usdcOf(user.address)) !== 0n) throw new Error("the stake left USDC with the user");
      const open = (await view("base", a.frontDoor, FRONT, "depositOf", [user.address])) as bigint;
      if (open !== staked.taoDeposited) throw new Error(`the open batch holds ${tao(open)} for the user, not the ${tao(staked.taoDeposited)} staked`);
      return {
        chain: "base",
        payer: "user",
        ...gasOf(receipt),
        detail: `${usdc(USDC_IN)} in by a permit signed with the user's key (permit domain chain id ${domain.chainId}); ${usdc(staked.fees)} in fees to the treasury; ${tao(staked.taoDeposited)} into the open batch (minimum ${tao(minTaoOut)})`,
      };
    },

    async closeBatch(which) {
      await warp(rpc, "base", Number(await view("base", a.frontDoor, FRONT, "batchInterval")));
      const done = await keeperClose(deps(), rec);
      const c = eventIn(done.logs, a.frontDoor, FRONT, "BatchClosed") as { id: bigint; totalDeposits: bigint; nDeposits: bigint; nRedeems: bigint; fee: bigint; potUsed: bigint };
      closes[which] = done.hash;
      if (which === "deposit") {
        rec.rehearsalClose = { gasUsed: done.gasUsed, fee: c.fee };
        saveRecord(path, rec);
      }
      const what = which === "deposit" ? `${c.nDeposits} deposit worth ${tao(c.totalDeposits)}` : `${c.nRedeems} redeem request`;
      return keeperStep("base", done, `batch ${c.id} (${what}) sent as message ${short(done.messageId ?? "0x")}; the redeem fees in its pot paid ${eth(c.potUsed)} of the bridge fee`, c.fee);
    },

    async relayToBittensor(which) {
      const hash = closes[which];
      if (!hash) throw new Error(`the ${which} batch was not closed`);
      const { sent, amount, receipt, gas, receiver } = await relay("base", hash);
      let what: string;
      if (which === "deposit") {
        const shares = (await view("bittensor", a.vault, VAULT, "balanceOf", [user.address])) as bigint;
        if (shares === 0n) throw new Error("the vault minted the user no csTAO");
        what = `${tao(amount)} converted by ForeverMoney's AlphaVault into the vault; the user holds ${formatUnits(shares, 24)} csTAO`;
      } else {
        const q = eventIn(receipt.logs, a.vault, VAULT, "PayoutBatchQueued") as { key: Hex; total: bigint };
        if ((await view("bittensor", a.vault, VAULT, "balanceOf", [user.address])) !== 0n) throw new Error("the user still holds csTAO after redeeming all of it");
        what = `the user's csTAO burned; a payout of ${tao(q.total)} queued (batch ${short(q.key)})`;
      }
      return { chain: "bittensor", payer: "bridge", ...gasOf(receipt), receiver, detail: `message ${short(sent.messageId)}: ${what}; ${gas}` };
    },

    async stake() {
      const done = await keeperStake(deps(), rec);
      await settleDebits(rpc, done.logs ?? []);
      const s = eventIn(done.logs, a.vault, VAULT, "Staked") as { rao: bigint };
      const root = (await view("bittensor", a.vault, VAULT, "rootStakeRao")) as bigint;
      return keeperStep("bittensor", done, `staked ${tao(s.rao * 10n ** 9n)} on the stake hotkey; the vault's root stake reads ${tao(root * 10n ** 9n)} (gas measured against the staking stand-in)`);
    },

    async requestRedeem() {
      const shares = (await view("bittensor", a.vault, VAULT, "balanceOf", [user.address])) as bigint;
      if (shares === 0n) throw new Error("the user holds no csTAO on Bittensor");
      const perTao = (await view("base", a.oracle, ORACLE, "usdcValue", [TAO])) as bigint;
      const minUsdcPerTao = (perTao * USER_FLOOR_PCT) / 100n;
      const deadline = BigInt((await blockTime(rpc, "base")) + 86_400);
      const fee = (await view("base", a.frontDoor, FRONT, "redeemRequestFee")) as bigint;
      const data = encodeFunctionData({ abi: FRONT, functionName: "requestRedeemWithDelivery", args: [shares, minUsdcPerTao, deadline, DESTINATION_BASE] });
      const receipt = await sendAsUser(ctx, user, a.frontDoor, data, "the redeem request", fee);
      if ((await view("base", a.frontDoor, FRONT, "redeemOf", [user.address])) !== shares) throw new Error("the open batch does not hold the user's redeem");
      const [stored] = (await view("base", a.frontDoor, FRONT, "deliveryOf", [user.address])) as readonly [bigint];
      if (stored !== minUsdcPerTao) throw new Error("the front door did not store the delivery preference");
      return {
        chain: "base",
        payer: "user",
        ...gasOf(receipt),
        detail: `all ${formatUnits(shares, 24)} csTAO, delivered as USDC at no less than ${usdc(minUsdcPerTao)} a TAO (${USER_FLOOR_PCT}% of the 30-minute TWAP of ${usdc(perTao)}) for a day; plus the ${eth(fee)} redeem request fee`,
      };
    },

    async processPayouts() {
      const delay = Number(await view("bittensor", a.vault, VAULT, "payoutDelay"));
      await warp(rpc, "bittensor", delay);
      const d = deps();
      const s = await d.readState();
      const due = s.vault.batches.filter((b) => b.cursor < b.count && s.now >= b.queuedAt + s.vault.payoutDelay);
      if (due.length !== 1) throw new Error(`expected one payout batch due after the ${delay}-second delay, found ${due.length}`);
      const done = await keeperPayouts(d, rec, due[0].key);
      await settleDebits(rpc, done.logs ?? []);
      payoutHash = done.hash;
      const c = eventIn(done.logs, a.vault, VAULT, "PayoutChunkSent") as { gross: bigint; net: bigint; fee: bigint };
      return keeperStep(
        "bittensor",
        done,
        `after the ${delay / 3600}-hour payout delay: ${tao(c.gross)} owed, unstaked through the stand-in; ${tao(c.net)} sent to Base as message ${short(done.messageId ?? "0x")}, the bridge fee taken from the payout`,
        c.fee,
      );
    },

    async relayToBase() {
      if (!payoutHash) throw new Error("no payout was sent");
      const before = (await view("base", a.frontDoor, FRONT, "claimable", [user.address])) as bigint;
      const { sent, amount, receipt, gas, receiver } = await relay("bittensor", payoutHash);
      const credited = ((await view("base", a.frontDoor, FRONT, "claimable", [user.address])) as bigint) - before;
      if (credited !== amount) throw new Error(`the front door credited the user ${tao(credited)} of the ${tao(amount)} that arrived`);
      return {
        chain: "base",
        payer: "bridge",
        ...gasOf(receipt),
        receiver,
        detail: `message ${short(sent.messageId)}: ${tao(amount)} credited to the user's claim at the front door; ${gas}`,
      };
    },

    async deliver() {
      const d = deps();
      const check = await checkDelivery(d, user.address);
      if (!check.deliver || check.keeperMinOut === undefined) throw new Error(`the keeper would not deliver: ${check.reason}`);
      const claim = (await view("base", a.frontDoor, FRONT, "claimable", [user.address])) as bigint;
      const [minUsdcPerTao] = (await view("base", a.frontDoor, FRONT, "deliveryOf", [user.address])) as readonly [bigint];
      const twap = (await view("base", a.oracle, ORACLE, "usdcValue", [claim])) as bigint;
      const slippage = BigInt(Number(await view("base", a.frontDoor, FRONT, "maxDeliverySlippageBps")));
      const floors = {
        user: (claim * minUsdcPerTao + TAO - 1n) / TAO,
        twap: (twap * (10_000n - slippage)) / 10_000n,
        keeper: check.keeperMinOut,
      };
      const usdcBefore = await usdcOf(user.address);
      const out = await keeperDeliver(d, rec, user.address);
      if (!out.delivered) throw new Error(`not delivered: ${out.reason}`);
      if (out.usdcOut === undefined) throw new Error("the delivery has no Delivered event for the user");
      const usdcAfter = await usdcOf(user.address);
      return {
        ...keeperStep("base", out, `sold the user's ${tao(claim)} for ${usdc(out.usdcOut)}, paid to the user (${check.reason})`),
        delivery: { usdcBefore, usdcAfter, usdcOut: out.usdcOut, floors },
      };
    },
  };
}

/** A launch on the forks: each chain's final owner, impersonated (as a Safe or timelock can't sign here),
 * accepts the ownership the deploy offered, as the owners will on the live chains with the files from
 * pnpm ops handoff. Until then the read-back records the hand-off as pending and the keeper refuses the
 * round trip. A test plan has nothing to accept. */
export async function acceptHandoffOnForks(ctx: Ctx, rec: DeploymentRecord, log: (l: string) => void): Promise<void> {
  const plan = rec.plan;
  if (!isPlanV3(plan) || cadenceOf(plan) !== "launch") return;
  const roles = rolesOf(plan);
  const accept = encodeFunctionData({ abi: parseAbi(["function acceptOwnership()"]), functionName: "acceptOwnership" });
  for (const [chain, name, address] of ownedContracts(plan)) {
    const owner = roles.owner[chain];
    const what = contractName(name);
    const r = await sendAs(ctx, chain, owner, address, accept, `acceptOwnership() on ${what} by ${owner}`);
    log(`${chain === "base" ? "Base" : "Bittensor"}: ${owner} accepted ownership of ${what} (${hexToBigInt(r.gasUsed).toLocaleString("en-US")} gas)`);
  }
}

/** `pnpm ops rehearse` with OPS_DEPLOYMENT=v3-…: the full v3 deployment and read-back on fresh local
 * forks, then the round trip from a fresh user key, each step's gas and fee printed and kept in the
 * record (rehearsal-<name>.json). The v2 contracts no longer match the build, so a v2 name is refused
 * before anything starts. Returns whether everything passed. */
export async function rehearse(env: Env, log: (l: string) => void): Promise<boolean> {
  if (!isV3Deployment(env)) {
    throw new Error("the rehearsal deploys the v3 contracts: set OPS_DEPLOYMENT=v3-rehearsal (or another v3-… name); the v2 rehearsal record is left as it is");
  }
  const cadence = cadenceFromEnv(env);
  const path = recordPath(env, false);
  const r = await startForks(env, log);
  try {
    // a launch rehearsal takes its roles from the environment like the real one; its round trip's keeper
    // steps sign as the test wallet, so they need OPS_LAUNCH_KEEPER to be the test wallet
    const rec = await deploy(r.ctx, path, { newPlan: true, v3: true, cadence, roles: () => launchRolesFromEnv(env) });
    if (cadence === "launch") {
      // what the owner sends on Base before launch (pnpm ops cardinality): a launch's read-back fails
      // until the TAO/WETH pool has the oracle's 30 minutes of slots reserved
      const pool = BASE_V3.TAO_WETH_POOL;
      for (const t of cardinalityTxs(pool, cardinalitySteps((await readPool(r.ctx, pool)).next))) {
        const grown = await sendAs(r.ctx, "base", WALLET, t.to, t.data, `increaseObservationCardinalityNext(${t.next}) on the TAO/WETH pool`);
        log(`Base: the TAO/WETH pool reserves ${t.next} observation slots (${hexToBigInt(grown.gasUsed).toLocaleString("en-US")} gas)`);
      }
      // the hand-off, as the final owners will accept it: the keeper refuses a launch until they have
      await acceptHandoffOnForks(r.ctx, rec, log);
    }
    rec.verify = await verify(r.ctx, rec);
    saveRecord(path, rec);
    if (!rec.verify.ok) {
      log(`Read-back check failed:\n  ${rec.verify.failures.join("\n  ")}`);
      return false;
    }
    log("Read-back check: everything matches the plan");
    log("The round trip (gas at the forks' prices; Base's small L1 data fee is not included):");
    const reports: StepReport[] = [];
    const { delivery } = await runRoundTrip(await forkRoundTrip(r, rec, path), log, (s) => {
      reports.push(s);
      rec.roundTrip = [...reports];
      saveRecord(path, rec);
    });
    log(formatReceivers(reports));
    const back = Number((delivery.usdcOut * 10_000n) / USDC_IN) / 100;
    log(`In: ${usdc(USDC_IN)} by permit. Out: ${usdc(delivery.usdcOut)} delivered (${back}% back after the fees, both swaps and the payout's bridge fee).`);
    log(`Record: ${path}`);
    return true;
  } finally {
    r.stop();
  }
}
