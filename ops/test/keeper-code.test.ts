import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, getAddress, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { CLAIM_POLICY, type ChainName, paths, WALLET } from "../src/config.ts";
import { claim, close, deliver, type KeeperDeps, KeeperHasCode, type KeeperState, payouts, roll, runLoop, stake } from "../src/keeper/actions.ts";
import { DESTINATION_BASE } from "../src/keeper/delivery.ts";
import { payoutsHash } from "../src/keeper/payouts.ts";
import { keeperSigner } from "../src/keeper/signer.ts";
import { keeperDeps } from "../src/keeper/state.ts";
import type { StatusDetail } from "../src/keeper/status.ts";
import { buildPlanV3 } from "../src/plan.ts";
import { saveRecord } from "../src/record.ts";
import type { CallRequest } from "../src/types.ts";
import { COLDKEY, fakeChain, SENT, stubDeps, v3Record } from "./fake-keeper.ts";
import { ROLES } from "./launch-roles.ts";

const TAO = 10n ** 18n;
const T = 1_800_000_000;
const KEY: Hex = `0x${"aa".repeat(32)}`;
const alice: Address = "0x000000000000000000000000000000000000a11c";
/** Where a thief's sweeper code would live: what a stolen key delegates the keeper wallet to. */
const SWEEPER = getAddress("0x00000000000000000000000000000000005eeeee");
/** The keeper wallet's code once a stolen key has signed an EIP-7702 delegation to SWEEPER: 23 bytes. */
const DELEGATED: Hex = `0xef0100${SWEEPER.slice(2).toLowerCase()}`;
/** A contract's code at the keeper's address. */
const CONTRACT: Hex = "0x6080604052";
const rec = v3Record();

/** Every check a keeper command makes before its send passes: a batch to close, a payout due, TAO to stake. */
const due: KeeperState = {
  now: T,
  frontDoor: { canClose: true, nDeposits: 1, nRedeems: 0, paused: false, openStart: T - 600, batchInterval: 600, full: false, now: T },
  closeMaxWaitS: 0,
  alphaVault: { healthy: true },
  vault: {
    paused: false,
    available: TAO,
    minStakeWei: 2n * 10n ** 15n,
    rootStake: 0n,
    nominatorMinWei: 0n,
    batches: [{ key: KEY, queuedAt: T - 7200, cursor: 0, count: 1 }],
    payoutDelay: 3600,
  },
  detail: { claimable: [] } as unknown as StatusDetail,
};
/** An empty batch under a max wait: due a roll. */
const empty: KeeperState = { ...due, frontDoor: { ...due.frontDoor, nDeposits: 0, openStart: T - 7200, batchInterval: 3600 }, closeMaxWaitS: 86_400 };

/** Keeper deps on which every command reaches its send; the keeper wallet's code on each chain is `code`'s
 * (none where it says nothing). */
function world(code: Partial<Record<ChainName, Hex>>, s: KeeperState = due, over: Partial<KeeperDeps> = {}) {
  const sendCall = vi.fn(async (_r: CallRequest) => ({ ...SENT, logs: [] }));
  const signerCode = vi.fn(async (chain: ChainName): Promise<Hex> => code[chain] ?? "0x");
  const deps = stubDeps({
    readState: async () => s,
    quoteClose: async () => 1n,
    payoutLogs: async () => [],
    batchInfo: async () => ({ payoutsHash: payoutsHash([]), count: 0 }),
    // 1.5 TAO waiting, past 25 times the default claim cost; 57M gas at 5 gwei is well within the wallet's 1 TAO
    readRewards: async () => ({
      hotkey: KEY,
      waitingWei: (15n * TAO) / 10n,
      lastClaimAt: T - 86_400,
      now: T,
      taoPriceUsd: 250,
      claimGasRequired: 55_000_000n,
      gasPriceWei: 5_000_000_000n,
      walletWei: TAO,
    }),
    readDelivery: async (user) => ({
      user,
      claimable: TAO,
      pref: { minUsdcPerTao: 240_000_000n, deadline: T + 3600, destination: DESTINATION_BASE },
      quoteUsdc: 252_000_000n,
      twapUsdc: 250_000_000n,
      slippageBps: 150,
      now: T,
    }),
    simulateDeliver: async () => ({ ok: true, usdcOut: 251_000_000n }),
    signerCode,
    sendCall,
    ...over,
  });
  return { deps, sendCall, signerCode };
}

/** Each keeper command, the chain it sends to, and the state that makes it send. */
const COMMANDS: [string, ChainName, (deps: KeeperDeps) => Promise<unknown>, KeeperState][] = [
  ["close", "base", (d) => close(d, rec), due],
  ["roll", "base", (d) => roll(d, rec), empty],
  ["stake", "bittensor", (d) => stake(d, rec), due],
  ["payouts", "bittensor", (d) => payouts(d, rec, KEY), due],
  ["claim", "bittensor", (d) => claim(d, rec, CLAIM_POLICY), due],
  ["deliver", "base", (d) => deliver(d, rec, alice), due],
];
const other = (c: ChainName): ChainName => (c === "base" ? "bittensor" : "base");
const label = (c: ChainName) => (c === "base" ? "Base" : "Bittensor");

describe("the keeper refuses to send when its wallet has code", () => {
  it("each command reads the keeper wallet's code on both chains, the one it sends to first, and sends while neither has any", async () => {
    for (const [name, chain, run, s] of COMMANDS) {
      const w = world({}, s);
      await run(w.deps);
      expect(w.sendCall, name).toHaveBeenCalledOnce();
      expect(w.sendCall.mock.calls[0][0].chain, name).toBe(chain);
      expect(w.signerCode.mock.calls, name).toEqual([[chain], [other(chain)]]);
    }
  });

  it("each refuses, sending nothing, when the keeper wallet there holds an EIP-7702 delegation or a contract's code", async () => {
    for (const [name, chain, run, s] of COMMANDS) {
      for (const [code, what] of [
        [DELEGATED, `an EIP-7702 delegation to ${SWEEPER}`],
        [CONTRACT, "5 bytes of contract code"],
      ] as const) {
        const w = world({ [chain]: code }, s);
        const err = await run(w.deps).catch((e: unknown) => e);
        expect(err, name).toBeInstanceOf(KeeperHasCode);
        expect((err as Error).message, name).toBe(
          `${label(chain)}: the keeper wallet ${WALLET} has code (an EIP-7702 delegation or a contract): ${what}; assume its key is compromised; stop and rotate the keeper; nothing sent`,
        );
        expect(w.sendCall, name).not.toHaveBeenCalled();
      }
    }
  });

  it("code on the other chain only stops a send too, naming the chain it is on: one key holds the address on both", async () => {
    // a delegation signed for chain id 0 holds on every chain; and Bittensor may not run EIP-7702 at all,
    // so a delegation on Base must stop Bittensor's sends as well
    for (const [name, chain, run, s] of COMMANDS) {
      const w = world({ [other(chain)]: DELEGATED }, s);
      const err = await run(w.deps).catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(KeeperHasCode);
      expect((err as Error).message, name).toBe(
        `${label(other(chain))}: the keeper wallet ${WALLET} has code (an EIP-7702 delegation or a contract): an EIP-7702 delegation to ${SWEEPER}; assume its key is compromised; stop and rotate the keeper; nothing sent`,
      );
      expect(w.sendCall, name).not.toHaveBeenCalled();
    }
  });

  it("with code on both chains, the refusal names the chain the send goes to", async () => {
    for (const [name, chain, run, s] of COMMANDS) {
      const w = world({ [chain]: CONTRACT, [other(chain)]: DELEGATED }, s);
      await expect(run(w.deps), name).rejects.toThrow(new RegExp(`^${label(chain)}: the keeper wallet .*: 5 bytes of contract code;`));
      expect(w.sendCall, name).not.toHaveBeenCalled();
    }
  });

  it("run stops with the refusal in its log, even at a delivery (whose guard refusals only wait a round), whichever chain has the code", async () => {
    // a delivery is due first, on Base; or a payout, on Bittensor
    const delivery = { ...due, vault: { ...due.vault, batches: [] } };
    const cases: [ChainName, KeeperState][] = [
      ["base", delivery],
      ["bittensor", delivery],
      ["base", due],
      ["bittensor", due],
    ];
    for (const [chain, s] of cases) {
      const lines: string[] = [];
      const w = world({ [chain]: DELEGATED }, s, { deliveryCandidates: async () => [alice], log: (l) => void lines.push(l) });
      await runLoop(w.deps, rec, { intervalMs: 0, maxTicks: 3, policy: CLAIM_POLICY });
      expect(w.sendCall, chain).not.toHaveBeenCalled();
      expect(lines.at(-1), chain).toBe(
        `Stopped: ${label(chain)}: the keeper wallet ${WALLET} has code (an EIP-7702 delegation or a contract): an EIP-7702 delegation to ${SWEEPER}; assume its key is compromised; stop and rotate the keeper; nothing sent`,
      );
    }
  });
});

describe("the keeper wallet's code is read at most once a round", () => {
  it("each chain's at the keeper's address, kept until the next round's refresh, and never kept when the read fails", async () => {
    const launch = v3Record("live", buildPlanV3(0, 0, COLDKEY, "launch", ROLES));
    const path = join(mkdtempSync(join(tmpdir(), "ops-code-")), "r.json");
    saveRecord(path, launch);
    const asked: string[] = [];
    let fail = false;
    const f = fakeChain([], {}, {
      eth_getCode: (chain, p) => {
        asked.push(`${chain} ${p[0]} ${p[1]}`);
        if (fail) throw new Error("node down");
        return chain === "base" ? DELEGATED : "0x";
      },
    });
    const keys = { OPS_KEEPER_KEYSTORE: "/keys/keeper.json", OPS_KEEPER_PASSWORD_FILE: "/keys/keeper.pw" };
    const deps = keeperDeps({ ...f.ctx, signer: keeperSigner(keys, paths({}), launch.plan) }, launch, path);
    expect(await deps.signerCode("base")).toBe(DELEGATED);
    expect(await deps.signerCode("base")).toBe(DELEGATED);
    expect(await deps.signerCode("bittensor")).toBe("0x");
    expect(asked).toEqual([`base ${ROLES.keeper} latest`, `bittensor ${ROLES.keeper} latest`]);
    // the next round reads again
    deps.refresh();
    fail = true;
    await expect(deps.signerCode("base")).rejects.toThrow(/node down/);
    fail = false;
    expect(await deps.signerCode("base")).toBe(DELEGATED);
    expect(await deps.signerCode("base")).toBe(DELEGATED);
    expect(asked).toHaveLength(4);
  });
});
