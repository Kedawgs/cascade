import { type Address, getAddress, HttpRequestError } from "viem";
import { describe, expect, it, vi } from "vitest";
import { type Deployment, EXPECTED_DEPLOYMENTS, readDeployment, TOKENS } from "./config";
import { checkWiring, createWiringCheck, peerId, type Wiring } from "./wiring";

const e3 = EXPECTED_DEPLOYMENTS["v3-test"];
const e2 = EXPECTED_DEPLOYMENTS["test-2026-10"];
const deployment = (e: typeof e3): Deployment =>
  readDeployment({
    NEXT_PUBLIC_CASCADE_FRONT_DOOR: e.frontDoor,
    NEXT_PUBLIC_CASCADE_BASE_ADAPTER: e.baseAdapter,
    NEXT_PUBLIC_CASCADE_VAULT: e.vault,
    NEXT_PUBLIC_CASCADE_BIT_ADAPTER: e.bitAdapter,
    NEXT_PUBLIC_CASCADE_BIT_BLOCK: e.bitBlock,
    NEXT_PUBLIC_CASCADE_VAULT_SS58: e.vaultSs58,
    NEXT_PUBLIC_CASCADE_HOTKEY_SS58: e.hotkeySs58,
    NEXT_PUBLIC_CASCADE_STAKER: e.staker,
    NEXT_PUBLIC_CASCADE_ORACLE: e.oracle,
  }) as Deployment;
const D3 = deployment(e3);
const D2 = deployment(e2);
const OTHER = getAddress("0x00000000000000000000000000000000000b0b00");

type Answer = unknown | Error;
/** What each contract answers, as `${chain}:${address}.${function}(${args})` (addresses lowercase): the v2
 * deployment has the same addresses on both chains. */
function wiredAs(d: Deployment, over: Record<string, Answer> = {}): Record<string, Answer> {
  const fd = d.frontDoor.toLowerCase();
  const ba = d.baseAdapter.toLowerCase();
  const v = d.vault.toLowerCase();
  const bt = d.bitAdapter.toLowerCase();
  const answers: Record<string, Answer> = {
    [`base:${fd}.asset()`]: TOKENS.tao,
    [`base:${fd}.vault()`]: d.vault,
    [`base:${fd}.vaultChain()`]: 964n,
    [`base:${fd}.primaryBridge()`]: d.baseAdapter,
    [`base:${fd}.bridgeEnabled(${ba})`]: true,
    [`base:${ba}.token()`]: TOKENS.tao,
    [`base:${ba}.remoteAdapter()`]: d.bitAdapter,
    [`base:${ba}.remoteChainId()`]: 964n,
    [`bittensor:${v}.frontDoorActive(${peerId(8453n, d.frontDoor)})`]: true,
    [`bittensor:${v}.primaryBridge()`]: d.bitAdapter,
    [`bittensor:${v}.bridgeEnabled(${bt})`]: true,
    [`bittensor:${bt}.remoteAdapter()`]: d.baseAdapter,
    [`bittensor:${bt}.remoteChainId()`]: 8453n,
  };
  if (d.staker && d.oracle) {
    const st = d.staker.toLowerCase();
    Object.assign(answers, {
      [`base:${fd}.usdc()`]: TOKENS.usdc,
      [`base:${fd}.oracle()`]: d.oracle,
      [`base:${fd}.swapper()`]: d.staker,
      [`base:${st}.frontDoor()`]: d.frontDoor,
      [`base:${st}.usdc()`]: TOKENS.usdc,
      [`base:${st}.tao()`]: TOKENS.tao,
    });
  }
  return { ...answers, ...over };
}

/** Clients whose multicalls answer from `answers`: a missing entry reverts, as a contract without the
 * function does. `down` makes a chain's whole read fail, as an unreachable node does. */
function chains(answers: Record<string, Answer>, down: { base?: boolean; bittensor?: boolean } = {}) {
  const asked: string[] = [];
  const client = (name: "base" | "bittensor") => ({
    multicall: vi.fn(async ({ contracts, allowFailure }: { contracts: { address: Address; functionName: string; args?: unknown[] }[]; allowFailure: boolean }) => {
      if (down[name]) throw new HttpRequestError({ url: `https://${name}.example`, status: 503 });
      expect(allowFailure).toBe(true);
      return contracts.map((k) => {
        const id = `${name}:${k.address.toLowerCase()}.${k.functionName}(${(k.args ?? []).map((a) => String(a).toLowerCase()).join(",")})`;
        asked.push(id);
        const a = answers[id];
        if (a === undefined || a instanceof Error) return { status: "failure", error: a ?? new Error("reverted") };
        return { status: "success", result: a };
      });
    }),
  });
  return { clients: { base: client("base"), bittensor: client("bittensor") } as never, asked };
}

describe("checkWiring", () => {
  it("passes a v3 deployment wired as the build's config says", async () => {
    expect(await checkWiring(chains(wiredAs(D3)).clients, D3)).toBe("ok");
  });

  it("passes a v2 deployment, asking it nothing only v3 contracts have", async () => {
    const c = chains(wiredAs(D2));
    expect(await checkWiring(c.clients, D2)).toBe("ok");
    expect(c.asked.some((x) => /\.(usdc|oracle|swapper|frontDoor|tao)\(\)$/.test(x))).toBe(false);
  });

  it("refuses any one link that points elsewhere: the front door, the staker, the Base adapter, and the vault and adapter on Bittensor", async () => {
    const fd = D3.frontDoor.toLowerCase();
    const st = D3.staker!.toLowerCase();
    const ba = D3.baseAdapter.toLowerCase();
    const v = D3.vault.toLowerCase();
    const bt = D3.bitAdapter.toLowerCase();
    const miswired: Record<string, Answer> = {
      [`base:${fd}.vault()`]: OTHER,
      [`base:${fd}.asset()`]: OTHER,
      [`base:${fd}.vaultChain()`]: 1n,
      [`base:${fd}.primaryBridge()`]: OTHER,
      [`base:${fd}.bridgeEnabled(${ba})`]: false,
      [`base:${fd}.usdc()`]: OTHER,
      [`base:${fd}.oracle()`]: OTHER,
      [`base:${fd}.swapper()`]: OTHER,
      [`base:${st}.frontDoor()`]: OTHER,
      [`base:${st}.usdc()`]: OTHER,
      [`base:${st}.tao()`]: OTHER,
      [`base:${ba}.token()`]: OTHER,
      [`base:${ba}.remoteAdapter()`]: OTHER,
      [`base:${ba}.remoteChainId()`]: 1n,
      [`bittensor:${v}.frontDoorActive(${peerId(8453n, D3.frontDoor)})`]: false,
      [`bittensor:${v}.primaryBridge()`]: OTHER,
      [`bittensor:${v}.bridgeEnabled(${bt})`]: false,
      [`bittensor:${bt}.remoteAdapter()`]: OTHER,
      [`bittensor:${bt}.remoteChainId()`]: 1n,
    };
    for (const [id, answer] of Object.entries(miswired)) {
      expect(await checkWiring(chains(wiredAs(D3, { [id]: answer })).clients, D3), id).toBe("mismatch");
    }
  });

  it("refuses a contract that doesn't answer a read (not the contract the config names)", async () => {
    const st = D3.staker!.toLowerCase();
    expect(await checkWiring(chains(wiredAs(D3, { [`base:${st}.frontDoor()`]: new Error("reverted") })).clients, D3)).toBe("mismatch");
  });

  it("keys the front door in the vault's registry as CascadeVault.peerId does", () => {
    // read from the v3 test vault: peerId(8453, front door)
    expect(peerId(8453n, D3.frontDoor)).toBe("0xaa3c5e1ca9ef9ca97292ed2102c9c768d1f4161139efdc975dc4295d90482b0b");
  });

  it("refuses a deployment missing from the committed list without reading anything", async () => {
    const c = chains(wiredAs({ ...D3, vault: OTHER }));
    expect(await checkWiring(c.clients, { ...D3, vault: OTHER })).toBe("mismatch");
    expect(c.asked).toEqual([]);
  });

  it("throws when either chain can't be read, never answering ok", async () => {
    await expect(checkWiring(chains(wiredAs(D3), { base: true }).clients, D3)).rejects.toThrow();
    await expect(checkWiring(chains(wiredAs(D3), { bittensor: true }).clients, D3)).rejects.toThrow();
  });
});

describe("createWiringCheck", () => {
  const session = () => {
    const kept = new Map<string, string>();
    return { get: (k: string) => kept.get(k) ?? null, set: (k: string, v: string) => void kept.set(k, v), kept };
  };

  it("checks once a session: a pass is kept (also across reloads of the tab) and never read again", async () => {
    const s = session();
    const check = vi.fn(async (): Promise<Wiring> => "ok");
    const wired = createWiringCheck({} as never, D3, check, s);
    expect(await Promise.all([wired(), wired()])).toEqual(["ok", "ok"]);
    expect(await wired()).toBe("ok");
    expect(check).toHaveBeenCalledTimes(1);
    // a reload in the same tab: the pass is in session storage
    const again = vi.fn(async (): Promise<Wiring> => "mismatch");
    expect(await createWiringCheck({} as never, D3, again, s)()).toBe("ok");
    expect(again).not.toHaveBeenCalled();
    // another deployment's pass is not this one's
    expect(await createWiringCheck({} as never, D2, again, s)()).toBe("mismatch");
  });

  it("keeps a mismatch for the session too, but never stores it as a pass", async () => {
    const s = session();
    const check = vi.fn(async (): Promise<Wiring> => "mismatch");
    const wired = createWiringCheck({} as never, D3, check, s);
    expect(await wired()).toBe("mismatch");
    expect(await wired()).toBe("mismatch");
    expect(check).toHaveBeenCalledTimes(1);
    expect([...s.kept.values()]).not.toContain("ok");
  });

  it("keeps no failed read: the next call checks again", async () => {
    const check = vi
      .fn<() => Promise<Wiring>>()
      .mockRejectedValueOnce(new Error("archive node down"))
      .mockResolvedValueOnce("ok");
    const wired = createWiringCheck({} as never, D3, check, session());
    await expect(wired()).rejects.toThrow("archive node down");
    expect(await wired()).toBe("ok");
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("works without session storage (blocked, or a private window)", async () => {
    const broken = {
      get: () => {
        throw new Error("SecurityError");
      },
      set: () => {
        throw new Error("SecurityError");
      },
    };
    expect(await createWiringCheck({} as never, D3, async () => "ok", broken)()).toBe("ok");
  });
});
