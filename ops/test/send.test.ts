import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, type Hex, numberToHex, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { paths, targets, WALLET } from "../src/config.ts";
import { buildPlan } from "../src/plan.ts";
import { RpcError, type Rpc } from "../src/rpc.ts";
import { castArg, type Ctx, ReceiptTimeout, type Runner, SendRefused, sendCall, sendCreate } from "../src/send.ts";
import type { CallRequest, CreateRequest } from "../src/types.ts";

const HASH = `0x${"ab".repeat(32)}` as Hex;
const SENTINEL = "NEVER-PRINT-ME";

function fixture(over: { chainId?: number; nonce?: number; latestNonce?: number; estimate?: "fail" | "custom" | bigint; receipt?: "none" | "reverted" | "throws"; created?: Address; signer?: Address; castFails?: boolean; castErrors?: string } = {}) {
  const calls: { method: string; params: unknown[] }[] = [];
  const runs: { file: string; args: string[] }[] = [];
  const logs: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "ops-send-"));
  const passwordFile = join(dir, "pw");
  let broadcast = false;
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
          return numberToHex(over.estimate ?? 1_000_001n);
        case "eth_gasPrice":
          return numberToHex(5_000_000_000n);
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
          return "0x6080";
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

  it("logs one plain line with the estimated cost", async () => {
    const f = fixture();
    await sendCall(f.ctx, call);
    expect(f.logs[0]).toBe("Bittensor: stake idle TAO — est. 1,000,001 gas ≈ 0.005000005 TAO");
  });

  it("a create landing at another address fails", async () => {
    const f = fixture({ created: WALLET });
    await expect(sendCreate(f.ctx, create, plan.addresses.bitAdapter)).rejects.toThrow(/expected .* at/i);
  });

  it("a reverted receipt fails", async () => {
    const f = fixture({ receipt: "reverted" });
    await expect(sendCall(f.ctx, call)).rejects.toThrow(/reverted/);
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
