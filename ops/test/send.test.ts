import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, type Hex, numberToHex, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { maxGasPrices, paths, targets, WALLET } from "../src/config.ts";
import { buildPlan } from "../src/plan.ts";
import { RpcError, type Rpc } from "../src/rpc.ts";
import { castArg, type Ctx, ReceiptTimeout, redact, replaceCall, RevertedOnChain, type Runner, SendRefused, sendCall, sendCreate } from "../src/send.ts";
import type { CallRequest, CreateRequest } from "../src/types.ts";
import { revert } from "./fake-keeper.ts";

const HASH = `0x${"ab".repeat(32)}` as Hex;
const SENTINEL = "NEVER-PRINT-ME";

function fixture(
  over: {
    chainId?: number;
    nonce?: number;
    latestNonce?: number;
    /** eth_estimateGas: "fail" a plain error, "custom" a revert with NothingToStake()'s data, "rpc" the node's own error (-32005), else the gas */
    estimate?: "fail" | "custom" | "rpc" | bigint;
    /** eth_gasPrice, in wei (5 gwei) */
    gasPrice?: bigint;
    /** eth_maxPriorityFeePerGas, in wei (1 mwei) */
    priorityFee?: bigint;
    receipt?: "none" | "reverted" | "throws";
    /** What an eth_call of the sent call at `block` answers (a reverted receipt's replay); unset: the node has no eth_call */
    replay?: (block: string) => unknown;
    /** What eth_getTransactionByHash answers for a pending transaction of the wallet's (replaceCall): fields over the
     * default (the wallet's, at `nonce`, unmined, 5 gwei fees), or null for none */
    pendingTx?: null | Partial<{ from: Address; nonce: Hex; blockNumber: Hex | null; gasPrice: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex }>;
    created?: Address;
    signer?: Address;
    castFails?: boolean;
    castErrors?: string;
    codeAfter?: number;
  } = {},
) {
  const calls: { method: string; params: unknown[] }[] = [];
  const runs: { file: string; args: string[] }[] = [];
  const logs: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "ops-send-"));
  const passwordFile = join(dir, "pw");
  let broadcast = false;
  let codeReads = 0;
  writeFileSync(passwordFile, SENTINEL);
  const rpc: Rpc = {
    async request(chain, method, params) {
      calls.push({ method, params });
      const t = targets({}).rehearsal[chain];
      switch (method) {
        case "eth_chainId":
          return numberToHex(over.chainId ?? t.chainId);
        case "eth_getTransactionCount": {
          const n = over.nonce ?? 0;
          if (params[1] === "latest") return numberToHex(over.latestNonce ?? n);
          return numberToHex(broadcast && over.castFails ? n + 1 : n);
        }
        case "eth_estimateGas":
          if (over.estimate === "fail") throw new Error("execution reverted");
          // NothingToStake()
          if (over.estimate === "custom") throw new RpcError("bittensor eth_estimateGas: execution reverted", 3, "0xd23fa2a3");
          if (over.estimate === "rpc") throw new RpcError("bittensor eth_estimateGas: limit exceeded", -32005);
          return numberToHex(over.estimate ?? 1_000_001n);
        case "eth_gasPrice":
          return numberToHex(over.gasPrice ?? 5_000_000_000n);
        case "eth_maxPriorityFeePerGas":
          return numberToHex(over.priorityFee ?? 1_000_000n);
        case "eth_getTransactionReceipt":
          if (over.receipt === "none") return null;
          if (over.receipt === "throws") throw new Error("fetch failed");
          return {
            status: over.receipt === "reverted" ? "0x0" : "0x1",
            blockNumber: "0x10",
            gasUsed: numberToHex(900_000n),
            effectiveGasPrice: numberToHex(5_000_000_000n),
            contractAddress: over.created ?? null,
            logs: [{ address: WALLET, topics: [HASH], data: "0x" }],
          };
        case "eth_getCode":
          // a load-balanced RPC can answer from a node a block behind
          return codeReads++ < (over.codeAfter ?? 0) ? "0x" : "0x6080";
        case "eth_call":
          if (over.replay) return over.replay(params[1] as string);
          break;
        case "eth_getTransactionByHash":
          if (over.pendingTx === null) return null;
          return {
            from: WALLET,
            nonce: numberToHex(over.nonce ?? 0),
            blockNumber: null,
            gasPrice: numberToHex(5_000_000_000n),
            maxFeePerGas: numberToHex(5_000_000_000n),
            maxPriorityFeePerGas: numberToHex(1_000_000n),
            ...over.pendingTx,
          };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const runner: Runner = {
    async run(file, args) {
      runs.push({ file, args });
      if (args[0] === "wallet") return { code: 0, stdout: `${over.signer ?? WALLET}
`, stderr: "" };
      if (over.castErrors) return { code: 1, stdout: "", stderr: over.castErrors };
      broadcast = true;
      if (over.castFails) return { code: 1, stdout: "", stderr: "Error: server returned an error response" };
      return { code: 0, stdout: `{"deployer":"${WALLET}","deployedTo":"${over.created ?? WALLET}","transactionHash":"${HASH}"}`, stderr: "" };
    },
  };
  const ctx: Ctx = {
    live: false,
    targets: targets({}).rehearsal,
    rpc,
    runner,
    paths: { ...paths({}), passwordFile },
    log: (l) => logs.push(l),
    receiptTimeoutMs: 50,
    pollMs: 5,
  };
  const sends = () => runs.filter((r) => r.args[0] !== "wallet");
  return { ctx, calls, runs, logs, sends };
}

const plan = buildPlan(0, 0, `0x${"11".repeat(32)}`);
const create = plan.steps.find((s) => s.id === "bitAdapter") as CreateRequest;
const call: CallRequest = {
  chain: "bittensor",
  nonce: 0,
  label: "stake idle TAO",
  to: plan.addresses.vault,
  abi: parseAbi(["function stakeIdle()"]),
  functionName: "stakeIdle",
  args: [],
};

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SendRefused) return e.reason;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("send", () => {
  it("refuses a live RPC without --live", async () => {
    const f = fixture();
    f.ctx.targets = targets({}).live;
    expect(await refusal(sendCall(f.ctx, call))).toBe("not-live");
    expect(f.calls).toHaveLength(0);
    expect(f.runs).toHaveLength(0);
  });

  it("refuses a local RPC with --live", async () => {
    const f = fixture();
    f.ctx.live = true;
    expect(await refusal(sendCall(f.ctx, call))).toBe("not-live");
    expect(f.calls).toHaveLength(0);
  });

  it("refuses a wrong chain id", async () => {
    const f = fixture({ chainId: 1 });
    expect(await refusal(sendCall(f.ctx, call))).toBe("chain-id");
    expect(f.runs).toHaveLength(0);
  });

  it("refuses a nonce that differs from the plan", async () => {
    const f = fixture({ nonce: 3 });
    expect(await refusal(sendCall(f.ctx, call))).toBe("nonce");
    expect(f.calls.some((c) => c.method === "eth_estimateGas")).toBe(false);
    expect(f.runs).toHaveLength(0);
  });

  it("M1: refuses a send whose gas price is over the chain's cap (OPS_MAX_GAS_PRICE_*), and sends under it", async () => {
    const f = fixture({ gasPrice: 7_500_000_000n });
    const e = (await sendCall({ ...f.ctx, maxGasPrice: { bittensor: 5_000_000_000n } }, call).catch((e: unknown) => e)) as SendRefused;
    expect(e).toBeInstanceOf(SendRefused);
    expect(e.reason).toBe("fee");
    expect(e.message).toBe("Bittensor: the gas price is 7.5 gwei, over the 5 gwei cap (OPS_MAX_GAS_PRICE_BITTENSOR); stake idle TAO waits for it to fall; nothing sent");
    expect(f.sends()).toEqual([]);
    // the other chain's cap doesn't apply, and no cap means no check
    await sendCall({ ...f.ctx, maxGasPrice: { base: 1n } }, call);
    await sendCall(f.ctx, call);
    expect(f.sends()).toHaveLength(2);
    // the caps from the environment: gwei, decimals allowed, sensible defaults
    expect(maxGasPrices({})).toEqual({ base: 5_000_000_000n, bittensor: 100_000_000_000n });
    expect(maxGasPrices({ OPS_MAX_GAS_PRICE_BASE: " 0.5 ", OPS_MAX_GAS_PRICE_BITTENSOR: "12.25" })).toEqual({ base: 500_000_000n, bittensor: 12_250_000_000n });
    for (const bad of ["0", "-1", "1e3", "5 gwei", "0.0000000001"]) expect(() => maxGasPrices({ OPS_MAX_GAS_PRICE_BASE: bad }), bad).toThrow(/OPS_MAX_GAS_PRICE_BASE/);
  });

  it("refuses when the estimate fails", async () => {
    const f = fixture({ estimate: "fail" });
    expect(await refusal(sendCall(f.ctx, call))).toBe("estimate");
    expect(f.runs).toHaveLength(0);
  });

  it("estimates with no gas price", async () => {
    const f = fixture({ created: plan.addresses.bitAdapter });
    await sendCreate(f.ctx, create, plan.addresses.bitAdapter);
    await sendCall(f.ctx, call);
    const est = f.calls.filter((c) => c.method === "eth_estimateGas").map((c) => Object.keys(c.params[0] as object).sort());
    expect(est).toEqual([
      ["data", "from"],
      ["data", "from", "to", "value"],
    ]);
  });

  it("passes key material by path only", async () => {
    const f = fixture({ estimate: "fail" });
    await refusal(sendCall(f.ctx, call)).catch(() => undefined);
    const ok = fixture();
    await sendCall(ok.ctx, call);
    const args = ok.sends()[0].args;
    expect(args[args.indexOf("--password-file") + 1]).toBe(ok.ctx.paths.passwordFile);
    expect(args[args.indexOf("--keystore") + 1]).toBe(ok.ctx.paths.keystore);
    expect(args).not.toContain("--private-key");
    expect([...f.logs, ...ok.logs].join("\n")).not.toContain(SENTINEL);
    // no source line that names the password file also reads a file
    const src = new URL("../src/", import.meta.url);
    for (const file of readdirSync(src, { recursive: true }).filter((n) => String(n).endsWith(".ts"))) {
      for (const line of readFileSync(new URL(String(file).replaceAll("\\", "/"), src), "utf8").split("\n")) {
        if (line.includes("passwordFile")) expect(line).not.toMatch(/read/i);
      }
    }
  });

  it("sets the gas limit to 1.25× the estimate, legacy on Bittensor", async () => {
    const f = fixture();
    await sendCall(f.ctx, call);
    const bit = f.sends()[0].args;
    expect(bit[bit.indexOf("--gas-limit") + 1]).toBe("1250002");
    expect(bit).toContain("--legacy");
    expect(bit).toContain("--gas-price");
    await sendCall(f.ctx, { ...call, chain: "base" });
    expect(f.sends()[1].args).not.toContain("--legacy");
    expect(f.sends()[1].args).not.toContain("--gas-price");
  });

  it("sends with the request's own gas limit, and refuses an estimate above it", async () => {
    const f = fixture({ estimate: 55_100_000n });
    await sendCall(f.ctx, { ...call, gasLimit: 57_000_000n });
    const args = f.sends()[0].args;
    expect(args[args.indexOf("--gas-limit") + 1]).toBe("57000000");

    const over = fixture({ estimate: 57_000_001n });
    expect(await refusal(sendCall(over.ctx, { ...call, gasLimit: 57_000_000n }))).toBe("estimate");
    expect(over.sends()).toHaveLength(0);
  });

  it("logs one plain line with the estimated cost", async () => {
    const f = fixture();
    await sendCall(f.ctx, call);
    expect(f.logs[0]).toBe("Bittensor: stake idle TAO — est. 1,000,001 gas ≈ 0.005000005 TAO");
  });

  it("a create landing at another address fails", async () => {
    const f = fixture({ created: WALLET });
    await expect(sendCreate(f.ctx, create, plan.addresses.bitAdapter)).rejects.toThrow(/expected .* at/i);
  });

  it("a create whose code shows up a moment later succeeds", async () => {
    const f = fixture({ created: plan.addresses.bitAdapter, codeAfter: 2 });
    await expect(sendCreate(f.ctx, create, plan.addresses.bitAdapter)).resolves.toMatchObject({ address: plan.addresses.bitAdapter });
  });

  it("a create with still no code after the wait fails", async () => {
    const f = fixture({ created: plan.addresses.bitAdapter, codeAfter: 1_000 });
    await expect(sendCreate(f.ctx, create, plan.addresses.bitAdapter)).rejects.toThrow(/no code/);
  });

  it("a reverted receipt fails", async () => {
    const f = fixture({ receipt: "reverted" });
    await expect(sendCall(f.ctx, call)).rejects.toThrow(/reverted/);
  });

  it("a reverted receipt carries the reason a replay of the call at its block gives, the block before if that one passes, else none", async () => {
    // replayed at the receipt's block (0x10): the router's "Too little received"
    const revertsAt = (at: string) => (block: string) => {
      if (block === at) throw revert("Too little received");
      return "0x";
    };
    const raced = fixture({ receipt: "reverted", replay: revertsAt("0x10") });
    const e = await sendCall(raced.ctx, call).catch((e: unknown) => e);
    expect(e).toBeInstanceOf(RevertedOnChain);
    expect((e as RevertedOnChain).reason).toBe("Error(Too little received)");
    expect((e as Error).message).toBe(`Bittensor: stake idle TAO reverted on chain (transaction ${HASH}, Error(Too little received))`);
    const replays = raced.calls.filter((c) => c.method === "eth_call").map((c) => c.params[1]);
    expect(replays).toEqual(["0x10"]);
    expect(raced.calls.find((c) => c.method === "eth_call")?.params[0]).toMatchObject({ from: WALLET, to: call.to, value: "0x0" });
    // the block's end state passes it; the block before reverts it
    const before = fixture({ receipt: "reverted", replay: revertsAt("0xf") });
    expect(((await sendCall(before.ctx, call).catch((e: unknown) => e)) as RevertedOnChain).reason).toBe("Error(Too little received)");
    expect(before.calls.filter((c) => c.method === "eth_call").map((c) => c.params[1])).toEqual(["0x10", "0xf"]);
    // both pass (the state moved within the block), or the node didn't answer: no reason, still a revert
    for (const replay of [() => "0x" as const, () => { throw new RpcError("bittensor eth_call: limit exceeded", -32005); }]) {
      const none = fixture({ receipt: "reverted", replay });
      const err = (await sendCall(none.ctx, call).catch((e: unknown) => e)) as RevertedOnChain;
      expect(err).toBeInstanceOf(RevertedOnChain);
      expect(err.reason).toBeUndefined();
      expect(err.message).toBe(`Bittensor: stake idle TAO reverted on chain (transaction ${HASH})`);
    }
  });

  it("a receipt timeout stops with the hash", async () => {
    const f = fixture({ receipt: "none" });
    const err = await sendCall(f.ctx, call).catch((e) => e);
    expect(err).toBeInstanceOf(ReceiptTimeout);
    expect(err.hash).toBe(HASH);
  });

  it("refuses a keystore that signs as another account", async () => {
    const f = fixture({ signer: "0x1111111111111111111111111111111111111111" });
    expect(await refusal(sendCall(f.ctx, call))).toBe("signer");
    expect(f.sends()).toHaveLength(0);
    const w = f.runs[0].args;
    expect(w.slice(0, 2)).toEqual(["wallet", "address"]);
    expect(w[w.indexOf("--password-file") + 1]).toBe(f.ctx.paths.passwordFile);
  });

  it("refuses while an earlier transaction is still waiting to be mined", async () => {
    const f = fixture({ nonce: 1, latestNonce: 0 });
    expect(await refusal(sendCall(f.ctx, { ...call, nonce: 1 }))).toBe("waiting");
    expect(f.runs).toHaveLength(0);
  });

  it("names the contract's error when the estimate fails", async () => {
    const f = fixture({ estimate: "custom" });
    const err = await sendCall(f.ctx, call).catch((e) => e);
    expect(err).toBeInstanceOf(SendRefused);
    expect(err.message).toMatch(/NothingToStake\(\)/);
  });

  it("an RPC error while waiting becomes a ReceiptTimeout with the hash", async () => {
    const f = fixture({ receipt: "throws" });
    const err = await sendCall(f.ctx, call).catch((e) => e);
    expect(err).toBeInstanceOf(ReceiptTimeout);
    expect(err.hash).toBe(HASH);
  });

  it("cast failing after the node accepted the transaction is a ReceiptTimeout, not a plain failure", async () => {
    const f = fixture({ castFails: true });
    const err = await sendCall(f.ctx, call).catch((e) => e);
    expect(err).toBeInstanceOf(ReceiptTimeout);
    expect(err.nonce).toBe(0);
  });

  it("never prints an RPC address, which can carry an API key", async () => {
    const f = fixture({ castErrors: "error sending request for url (http://127.0.0.1:8547/ogrpc?network=bittensor&dkey=SECRETKEY)" });
    f.ctx.targets = { ...f.ctx.targets, bittensor: { ...f.ctx.targets.bittensor, rpcUrl: "http://127.0.0.1:8547/ogrpc?network=bittensor&dkey=SECRETKEY" } };
    const err = await sendCall(f.ctx, call).catch((e) => e);
    expect(err.message).toMatch(/failed/);
    expect(err.message).not.toContain("SECRETKEY");
    expect(f.logs.join(" ")).not.toContain("SECRETKEY");
  });

  it("never prints an API key carried in the RPC address's path", async () => {
    const url = "http://127.0.0.1:8547/v2/sECRETKEY";
    const f = fixture({ castErrors: `error sending request for url (${url}): connection refused` });
    f.ctx.targets = { ...f.ctx.targets, bittensor: { ...f.ctx.targets.bittensor, rpcUrl: url } };
    const err = await sendCall(f.ctx, call).catch((e) => e);
    expect(err.message).toContain("(http://127.0.0.1:8547/…)");
    expect(err.message).not.toContain("ECRETKEY");
    // the address is cut at whitespace, a quote, a bracket or a parenthesis, so the text after it stays
    const targets = { base: f.ctx.targets.base, bittensor: { ...f.ctx.targets.bittensor, rpcUrl: url } };
    expect(redact(targets, `at "${url}" [${url}] ${url}\nnext`)).toBe('at "http://127.0.0.1:8547/…" [http://127.0.0.1:8547/…] http://127.0.0.1:8547/…\nnext');
  });

  it("returns the receipt's logs", async () => {
    const f = fixture();
    expect((await sendCall(f.ctx, call)).logs).toEqual([{ address: WALLET, topics: [HASH], data: "0x" }]);
  });

  it("castArg formats the Base adapter Config tuple", () => {
    const base = plan.steps.find((s) => s.id === "baseAdapter")!;
    const config = {
      type: "tuple",
      components: ["router", "token", "localChainId", "remoteChainId", "remoteSelector", "remoteAdapter", "gasBase", "gasPerEntry"].map(
        (name, i) => ({ name, type: [2, 3, 4, 6, 7].includes(i) ? (i === 4 ? "uint64" : "uint256") : "address" }),
      ),
    } as const;
    expect(castArg(base.args[0], config)).toBe(
      `(0x881e3A65B4d4a04dD529061dd0071cf975F58bCD,0xf3081494B87e8D5fb7960f066E931D1D0e6E3d67,8453,964,2135107236357186872,${plan.addresses.bitAdapter},540000,26450)`,
    );
    const payouts = {
      type: "tuple[]",
      components: [
        { name: "user", type: "address" },
        { name: "shares", type: "uint256" },
        { name: "assets", type: "uint256" },
      ],
    } as const;
    expect(castArg([{ user: WALLET, shares: 5n, assets: 7n }], payouts)).toBe(`[(${WALLET},5,7)]`);
  });
});

describe("replaceCall: the keeper's own pending transaction, sent again at the same nonce with a higher fee", () => {
  const baseCall: CallRequest = {
    chain: "base",
    nonce: 0,
    label: "close the open batch and send it to Bittensor",
    to: plan.addresses.frontDoor,
    abi: parseAbi(["function closeBatch() payable"]),
    functionName: "closeBatch",
    args: [],
    value: 10n,
  };
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

  it("sends the same call at the same nonce, legacy on Bittensor, with the gas price 12.5% over the pending transaction's (never under the market's)", async () => {
    const f = fixture();
    const r = await replaceCall(f.ctx, call, HASH);
    expect(r).toMatchObject({ replaced: true, cancelled: false, hash: HASH, block: 16 });
    expect(f.sends()).toHaveLength(1);
    const args = f.sends()[0].args;
    expect(args.slice(0, 3)).toEqual(["send", call.to, "stakeIdle()"]);
    expect(args).toContain("--legacy");
    expect(flag(args, "--nonce")).toBe("0");
    // 5 gwei pending, 5 gwei market: 5.625 gwei
    expect(flag(args, "--gas-price")).toBe("5625000000");
    expect(args).not.toContain("--priority-gas-price");
    // the estimate's 1.25×, as any send
    expect(flag(args, "--gas-limit")).toBe(String((1_000_001n * 125n + 99n) / 100n));
    expect(args.at(-1)).toBe("--async");
    // it asked for the pending transaction, and the wallet's mined nonce, before anything
    expect(f.calls.map((c) => c.method).slice(0, 3)).toEqual(["eth_chainId", "eth_getTransactionByHash", "eth_getTransactionCount"]);
    expect(f.calls.find((c) => c.method === "eth_getTransactionByHash")?.params).toEqual([HASH]);
    expect(f.logs.some((l) => l.includes("replacing") && l.includes("nonce 0"))).toBe(true);
  });

  it("on Base (EIP-1559) bumps both the fee cap and the tip by 12.5%, and keeps the call's value", async () => {
    const f = fixture({ pendingTx: { maxFeePerGas: numberToHex(8_000_000_000n), maxPriorityFeePerGas: numberToHex(2_000_000n) } });
    expect(await replaceCall(f.ctx, baseCall, HASH)).toMatchObject({ replaced: true, cancelled: false });
    const args = f.sends()[0].args;
    expect(args).not.toContain("--legacy");
    expect(flag(args, "--gas-price")).toBe("9000000000");
    expect(flag(args, "--priority-gas-price")).toBe("2250000");
    expect(flag(args, "--value")).toBe("10");
    expect(args.slice(0, 3)).toEqual(["send", baseCall.to, "closeBatch()"]);
  });

  it("takes the market's gas price when that is higher than the bump", async () => {
    const f = fixture({ pendingTx: { gasPrice: numberToHex(1_000_000_000n) } });
    await replaceCall(f.ctx, call, HASH);
    expect(flag(f.sends()[0].args, "--gas-price")).toBe("5000000000");
  });

  it("when the call would fail now, cancels the nonce instead: a transfer of nothing to the wallet, 21,000 gas, and says so", async () => {
    const f = fixture({ estimate: "custom" });
    const r = await replaceCall(f.ctx, call, HASH);
    expect(r).toMatchObject({ replaced: true, cancelled: true, hash: HASH });
    const args = f.sends()[0].args;
    expect(args.slice(0, 4)).toEqual(["send", WALLET, "--value", "0"]);
    expect(flag(args, "--gas-limit")).toBe("21000");
    expect(flag(args, "--nonce")).toBe("0");
    expect(f.logs).toContainEqual("Bittensor: stake idle TAO would fail now (NothingToStake()): nonce 0 is cancelled instead");
  });

  it("I3: cancels only on a genuine revert: when the node didn't answer the estimate (a rate limit, a timeout), nothing is sent and it is tried again later", async () => {
    for (const estimate of ["rpc", "fail"] as const) {
      const f = fixture({ estimate });
      const r = await replaceCall(f.ctx, call, HASH);
      expect(r).toMatchObject({ replaced: false, reason: expect.stringMatching(/^Bittensor: the node didn't answer the estimate of stake idle TAO \(.*\); nothing cancelled$/) });
      expect(f.sends()).toEqual([]);
      expect(f.logs.some((l) => l.includes("cancel"))).toBe(false);
    }
  });

  it("M1: refuses, never cancels, a replacement whose fee would be over the chain's cap; the tip is never under the node's suggested one", async () => {
    // 5 gwei pending, bumped to 5.625: over a 5 gwei cap
    const capped = fixture();
    const r = await replaceCall({ ...capped.ctx, maxGasPrice: { bittensor: 5_000_000_000n } }, call, HASH);
    expect(r).toMatchObject({ replaced: false, reason: "Bittensor: the replacement would go out at 5.625 gwei, over the 5 gwei cap (OPS_MAX_GAS_PRICE_BITTENSOR); it waits for the price to fall" });
    expect(capped.sends()).toEqual([]);
    expect(capped.calls.some((c) => c.method === "eth_estimateGas")).toBe(false);
    // under the cap it goes; on Base the tip is the node's suggestion when that is above the bumped one
    const roomy = fixture({ priorityFee: 3_000_000n });
    await replaceCall({ ...roomy.ctx, maxGasPrice: { base: 20_000_000_000n } }, baseCall, HASH);
    expect(flag(roomy.sends()[0].args, "--priority-gas-price")).toBe("3000000");
    expect(flag(roomy.sends()[0].args, "--gas-price")).toBe("5625000000");
  });

  it("M6: cast refusing the replacement (underpriced, nonce too low) is a plain failure that says so, never 'no receipt yet': nonce 0 was pending already", async () => {
    const f = fixture({ castFails: true });
    const e = await replaceCall(f.ctx, call, HASH).catch((e: unknown) => e);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(ReceiptTimeout);
    expect((e as Error).message).toBe("Bittensor: stake idle TAO (replacing 0xabababababababababababababababababababababababababababababababab) was not sent: Error: server returned an error response");
  });

  it("sends nothing when there is nothing of the wallet's to replace at that nonce, and says why", async () => {
    const cases: [ReturnType<typeof fixture>, RegExp][] = [
      [fixture({ pendingTx: null }), /not in the node's pool any more/],
      [fixture({ pendingTx: { blockNumber: "0x10" } }), /was mined meanwhile \(block 16\)/],
      [fixture({ pendingTx: { from: "0x1111111111111111111111111111111111111111" } }), /is not the test wallet's at nonce 0: nothing to replace/],
      [fixture({ pendingTx: { nonce: "0x7" } }), /is not the test wallet's at nonce 0/],
      [fixture({ latestNonce: 1 }), /the wallet's mined nonce is 1, so nonce 0 is no longer pending/],
    ];
    for (const [f, why] of cases) {
      const r = await replaceCall(f.ctx, call, HASH);
      expect(r).toMatchObject({ replaced: false, reason: expect.stringMatching(why) });
      expect(f.sends()).toEqual([]);
    }
  });

  it("goes through the live gate and the chain-id check, and the keystore's account", async () => {
    expect(await refusal(replaceCall({ ...fixture().ctx, live: true }, call, HASH))).toBe("not-live");
    expect(await refusal(replaceCall(fixture({ chainId: 1 }).ctx, call, HASH))).toBe("chain-id");
    const wrong = fixture({ signer: "0x1111111111111111111111111111111111111111" });
    expect(await refusal(replaceCall(wrong.ctx, call, HASH))).toBe("signer");
    expect(wrong.sends()).toEqual([]);
  });

  it("a replacement with no receipt in its turn is a ReceiptTimeout with its hash and the call, so it can be replaced again", async () => {
    const f = fixture({ receipt: "none" });
    const e = (await replaceCall(f.ctx, call, HASH).catch((e: unknown) => e)) as ReceiptTimeout;
    expect(e).toBeInstanceOf(ReceiptTimeout);
    expect(e.hash).toBe(HASH);
    expect(e.request).toBe(call);
    // and one that reverts is a RevertedOnChain
    await expect(replaceCall(fixture({ receipt: "reverted" }).ctx, call, HASH)).rejects.toBeInstanceOf(RevertedOnChain);
  });
});

describe("send as another signer (the guardian, the owner)", () => {
  const GUARDIAN: Address = "0x000000000000000000000000000000000000B0b1";
  const guardian = { address: GUARDIAN, keystore: "/keys/guardian.json", passwordFile: "/keys/guardian.pw", name: "the guardian" };

  it("reads its nonces, estimates from it and signs with its own keystore", async () => {
    const f = fixture({ signer: GUARDIAN });
    f.ctx.signer = guardian;
    await sendCall(f.ctx, call);
    expect(new Set(f.calls.filter((c) => c.method === "eth_getTransactionCount").map((c) => c.params[0]))).toEqual(new Set([GUARDIAN]));
    expect((f.calls.find((c) => c.method === "eth_estimateGas")!.params[0] as { from: Address }).from).toBe(GUARDIAN);
    for (const args of [f.runs.find((r) => r.args[0] === "wallet")!.args, f.sends()[0].args]) {
      expect(args[args.indexOf("--keystore") + 1]).toBe("/keys/guardian.json");
      expect(args[args.indexOf("--password-file") + 1]).toBe("/keys/guardian.pw");
    }
  });

  it("refuses a keystore that signs as anyone else, naming the signer", async () => {
    const f = fixture();
    f.ctx.signer = guardian;
    const err = await sendCall(f.ctx, call).catch((e) => e);
    expect(err).toBeInstanceOf(SendRefused);
    expect(err.message).toBe(`the keystore signs as ${WALLET}, not the guardian ${GUARDIAN}; nothing sent`);
    expect(f.sends()).toHaveLength(0);
  });

  it("without one, signs as the test wallet as before", async () => {
    const f = fixture({ signer: GUARDIAN });
    const err = await sendCall(f.ctx, call).catch((e) => e);
    expect(err.message).toBe(`the keystore signs as ${GUARDIAN}, not the test wallet ${WALLET}; nothing sent`);
  });
});
