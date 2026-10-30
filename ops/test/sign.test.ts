import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { type Address, encodeFunctionData, getAddress, type Hex, numberToHex } from "viem";
import { describe, expect, it } from "vitest";
import { BASE_V3 } from "../src/config.ts";
import { buildPlanV3 } from "../src/plan.ts";
import { PAUSE_ABI } from "../src/pause.ts";
import { knownContracts, liveRoles, prepareSign, servePage } from "../src/sign.ts";
import { renderPage, signLogic } from "../src/sign-page.ts";
import { checkCalls, KNOWN_ABI, type WalletView, walletFile } from "../src/wallet.ts";
import { COLDKEY, fakeChain, v3Record } from "./fake-keeper.ts";
import { ROLES } from "./launch-roles.ts";

const launch = v3Record("live", buildPlanV3(4, 9, COLDKEY, "launch", ROLES));
const a = launch.plan.addresses as ReturnType<typeof buildPlanV3>["addresses"];
const enc = (functionName: string, args?: readonly unknown[]) => encodeFunctionData({ abi: KNOWN_ABI, functionName, args } as never) as Hex;
const ACCEPT = enc("acceptOwnership");
const OWNER = ROLES.owner.bittensor;
const OTHER = getAddress("0x00000000000000000000000000000000000e7e01");
const HASH = `0x${"ab".repeat(32)}`;
/** 2027-01-15T08:00:00.000Z */
const NOW = 1_800_000_000_000;
const tmp = () => mkdtempSync(join(tmpdir(), "ops-sign-"));
const char = (code: number) => String.fromCharCode(code);
const L = signLogic();

/** The hand-off's calls for a plain-account owner, checked as pnpm ops sign checks them. */
const handoffView = (): WalletView =>
  checkCalls(
    walletFile({
      title: "Cascade v3-launch: accept ownership",
      deployment: "v3-launch",
      now: NOW,
      calls: [
        { chainId: 964, to: a.vault, data: ACCEPT, label: "acceptOwnership() on the vault", from: OWNER },
        { chainId: 8453, to: a.frontDoor, data: ACCEPT, label: "acceptOwnership() on the front door", from: ROLES.owner.base },
      ],
    }),
    knownContracts(launch),
    NOW,
  );
/** One Ledger owning both chains, as at the launch. */
const LEDGER = getAddress("0x00000000000000000000000000000000000a0b03");
const ledgerLaunch = v3Record("live", buildPlanV3(4, 9, COLDKEY, "launch", { ...ROLES, owner: { base: LEDGER, bittensor: LEDGER } }));
const la = ledgerLaunch.plan.addresses as ReturnType<typeof buildPlanV3>["addresses"];
/** The launch's hand-off file as pnpm ops handoff --for-wallet writes it: two Base calls, then one on
 * Bittensor, from the same Ledger, in no required order. */
const acceptAllView = (): WalletView =>
  checkCalls(
    walletFile({
      title: "Cascade v3-launch: accept ownership",
      deployment: "v3-launch",
      now: NOW,
      calls: [
        { chainId: 8453, to: la.frontDoor, data: ACCEPT, label: "acceptOwnership() on the front door", from: LEDGER },
        { chainId: 8453, to: la.staker, data: ACCEPT, label: "acceptOwnership() on the staker", from: LEDGER },
        { chainId: 964, to: la.vault, data: ACCEPT, label: "acceptOwnership() on the vault", from: LEDGER },
      ],
    }),
    knownContracts(ledgerLaunch),
    NOW,
  );
/** Two cardinality steps, which must go in order, from the account given with --from. */
const stepsView = (): WalletView =>
  checkCalls(
    walletFile({
      title: "Cascade: grow the oracle pools' observation slots",
      ordered: true,
      now: NOW,
      calls: [1_200, 1_800].map((n, i) => ({
        chainId: 8453,
        to: BASE_V3.TAO_WETH_POOL,
        data: enc("increaseObservationCardinalityNext", [n]),
        gas: 15_100_000,
        label: `increaseObservationCardinalityNext(${n}), step ${i + 1}`,
        from: OWNER,
      })),
    }),
    knownContracts(null),
    NOW,
  );

describe("the page's checks before it sends (its pure logic)", () => {
  const call = { chainId: 964, to: a.vault, data: ACCEPT, value: "0", from: OWNER };

  it("refuses until MetaMask is connected as the call's sender, on the call's chain", () => {
    expect(L.readiness(call, { accounts: [], chainId: "0x3c4" })).toEqual({ ok: false, problem: "connect", reason: "Connect MetaMask first." });
    const wrong = L.readiness(call, { accounts: [OTHER], chainId: "0x3c4" });
    expect(wrong).toMatchObject({ ok: false, problem: "account" });
    expect(!wrong.ok && wrong.reason).toMatch(new RegExp(`using ${OTHER}, but this call must be sent from ${OWNER}`));
    // only the account MetaMask has selected counts, not another one it has also connected
    expect(L.readiness(call, { accounts: [OTHER, OWNER], chainId: "0x3c4" })).toMatchObject({ ok: false, problem: "account" });
    const base = L.readiness(call, { accounts: [OWNER.toLowerCase()], chainId: "0x2105" });
    expect(base).toMatchObject({ ok: false, problem: "chain" });
    expect(!base.ok && base.reason).toMatch(/on Base \(chain id 8453\), but this call is for Bittensor EVM \(chain id 964\)/);
    expect(L.readiness(call, { accounts: [OWNER], chainId: null })).toMatchObject({ ok: false, problem: "chain" });
    expect(L.readiness(call, { accounts: [OWNER], chainId: "0x7a69" })).toMatchObject({ ok: false, problem: "chain" });
    // MetaMask may give the address in lower case
    expect(L.readiness(call, { accounts: [OWNER.toLowerCase()], chainId: "0x3c4" })).toEqual({ ok: true });
  });

  it("builds the transaction from the file alone: from, to, data, value 0, its chain id, and its gas limit when it has one", () => {
    expect(L.txParams(call)).toEqual({ from: OWNER, to: a.vault, data: ACCEPT, value: "0x0", chainId: "0x3c4" });
    expect(L.txParams({ ...call, chainId: 8453, gas: "15100000" })).toEqual({ from: OWNER, to: a.vault, data: ACCEPT, value: "0x0", chainId: "0x2105", gas: numberToHex(15_100_000) });
  });

  it("asks MetaMask to switch to the call's chain, and can add Bittensor EVM (and Base) when it doesn't know it", () => {
    expect(L.switchParams(964)).toEqual([{ chainId: "0x3c4" }]);
    expect(L.addChainParams(964)).toEqual([
      {
        chainId: "0x3c4",
        chainName: "Bittensor EVM",
        nativeCurrency: { name: "TAO", symbol: "TAO", decimals: 18 },
        rpcUrls: ["https://lite.chain.opentensor.ai"],
        blockExplorerUrls: ["https://evm.taostats.io"],
      },
    ]);
    expect(L.addChainParams(8453)).toEqual([
      { chainId: "0x2105", chainName: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://mainnet.base.org"], blockExplorerUrls: ["https://basescan.org"] },
    ]);
    expect(L.addChainParams(31337)).toBeNull();
    expect(L.isUnknownChain({ code: 4902 })).toBe(true);
    // some MetaMask versions wrap it
    expect(L.isUnknownChain({ code: -32603, data: { originalError: { code: 4902 } } })).toBe(true);
    expect(L.isUnknownChain({ code: 4001 })).toBe(false);
    expect(L.isUnknownChain(null)).toBe(false);
  });

  it("sends one call at a time, never one already sent or done, and in order when the file says so", () => {
    expect(L.canSend(["ready", "ready"], 1, false, false)).toBe(true);
    expect(L.canSend(["ready", "ready"], 0, false, true)).toBe(false);
    expect(L.canSend(["confirmed", "ready"], 0, false, false)).toBe(false);
    expect(L.canSend(["sent", "ready"], 0, false, false)).toBe(false);
    expect(L.canSend(["sent", "ready"], 1, false, false)).toBe(true);
    expect(L.canSend(["reverted"], 0, false, false)).toBe(true);
    expect(L.canSend(["ready", "ready"], 1, true, false)).toBe(false);
    expect(L.canSend(["sent", "ready"], 1, true, false)).toBe(false);
    expect(L.canSend(["reverted", "ready"], 1, true, false)).toBe(false);
    expect(L.canSend(["confirmed", "ready"], 1, true, false)).toBe(true);
  });

  it("holds back a call on another chain while one waits for its receipt, and says to switch back to see a result", () => {
    const calls = [{ chainId: 8453 }, { chainId: 8453 }, { chainId: 964 }];
    // call 2 waits on Base: call 3 (Bittensor) is held back, call 1 (Base) isn't
    expect(L.waitingOn(calls, ["ready", "sent", "ready"], 2)).toBe(1);
    expect(L.waitingOn(calls, ["ready", "sent", "ready"], 0)).toBeNull();
    // nothing waits once it is mined, nor before it is sent
    for (const s of ["ready", "confirmed", "reverted", "mismatch"]) expect(L.waitingOn(calls, ["ready", s, "ready"], 2), s).toBeNull();
    expect(L.waitRefusal(1, 8453, 964, HASH)).toBe(
      `Not sent: call 2 is still waiting for its receipt on Base (chain id 8453), and this call would switch MetaMask to Bittensor EVM (chain id 964), where that receipt can't be read. Send it once call 2 shows Done. Call 2 on the explorer: https://basescan.org/tx/${HASH}`,
    );
    expect(L.awayText(8453, HASH)).toBe(`Sent; switch MetaMask back to Base (chain id 8453) to see its result (or check https://basescan.org/tx/${HASH})`);
    expect(L.buttonText("sent")).toBe("Waiting for the receipt…");
    expect(L.buttonText("sent", 8453)).toBe("Sent: switch MetaMask back to Base");
  });

  it("reads a receipt and an error the way MetaMask gives them", () => {
    expect(L.receiptStatus({ status: "0x1" })).toBe("success");
    expect(L.receiptStatus({ status: "0x0" })).toBe("reverted");
    expect(L.errorText({ code: 4001, message: "User denied transaction signature." })).toBe("you rejected it in MetaMask.");
    expect(L.errorText({ code: -32000, message: "insufficient funds" })).toBe("insufficient funds");
    expect(L.explorerTx(964, HASH)).toBe(`https://evm.taostats.io/tx/${HASH}`);
    expect(L.explorerTx(8453, HASH)).toBe(`https://basescan.org/tx/${HASH}`);
    // about 5 minutes of 3-second polls before it says a transaction looks stuck
    expect(L.POLL_MS * L.STUCK_POLLS).toBe(300_000);
  });

  it("compares the mined transaction with the call: from, to, data, value and chain id", () => {
    const mined = { from: OWNER.toLowerCase(), to: a.vault.toLowerCase(), input: ACCEPT, value: "0x0", chainId: "0x3c4" };
    expect(L.txMismatch(call, mined)).toEqual([]);
    expect(L.txMismatch(call, { ...mined, input: enc("pause") })).toEqual(["data"]);
    expect(L.txMismatch(call, { ...mined, from: OTHER, to: OTHER, value: "0x1", chainId: "0x2105" })).toEqual(["from", "to", "value", "chain id"]);
    // a node that leaves chainId out isn't a mismatch: the receipt was read on the call's chain
    const { chainId: _, ...noChainId } = mined;
    expect(L.txMismatch(call, noChainId)).toEqual([]);
    // nothing to compare
    expect(L.txMismatch(call, null)).toBeNull();
  });

  it("chooses MetaMask by its EIP-6963 announcement, else the browser's default wallet with a note naming it", () => {
    const metamask = { isMetaMask: true };
    const rabby = { isMetaMask: true, isRabby: true };
    const info = (rdns: string, name: string) => ({ uuid: "u", name, icon: "", rdns });
    const both = [
      { info: info("io.rabby", "Rabby Wallet"), provider: rabby },
      { info: info("io.metamask", "MetaMask"), provider: metamask },
    ];
    // MetaMask, even when another wallet holds window.ethereum
    expect(L.pickProvider(both, rabby)).toEqual({ provider: metamask, metamask: true, note: "Using MetaMask (it announced itself as io.metamask)." });
    expect(L.pickProvider([both[0]], rabby)).toEqual({
      provider: rabby,
      metamask: false,
      note: "MetaMask didn't announce itself on this page, so this is the browser's default wallet (window.ethereum): Rabby Wallet (io.rabby). Make sure it is the wallet you mean before you send.",
    });
    expect(L.pickProvider([], metamask)?.note).toMatch(/default wallet \(window\.ethereum\): a wallet that says it is MetaMask but didn't announce itself\./);
    expect(L.pickProvider([], {})?.note).toMatch(/default wallet \(window\.ethereum\): a wallet that doesn't say which it is\./);
    // another wallet calling itself MetaMask isn't io.metamask; its name is shown in printable ASCII only
    const impostor = { info: info("io.evil", `Meta${char(0x202e)}Mask`), provider: rabby };
    expect(L.pickProvider([impostor], rabby)).toMatchObject({ provider: rabby, metamask: false, note: expect.stringContaining("Meta?Mask (io.evil)") });
    expect(L.pickProvider([impostor], undefined)).toBeNull();
    expect(L.pickProvider([], undefined)).toBeNull();
  });
});

// ---- the page's own script, run against a fake MetaMask and a fake DOM ----

interface WalletOpts {
  accounts: string[];
  chainId: string;
  /** the chains MetaMask knows (default both) */
  known?: string[];
  declineSwitch?: boolean;
  /** MetaMask answers the switch but stays where it was */
  stuck?: boolean;
  reverts?: boolean;
  /** no receipt until mine() */
  pending?: boolean;
  /** what eth_getTransactionByHash reports, over what was sent */
  mined?: Record<string, unknown>;
}

function fakeWallet(o: WalletOpts) {
  const s = { connected: false, chainId: o.chainId, known: new Set(o.known ?? ["0x2105", "0x3c4"]), mined: !o.pending };
  const requests: { method: string; params?: unknown[] }[] = [];
  /** each request with the chain MetaMask was on when it came in */
  const asked: { method: string; chainId: string }[] = [];
  const listeners: Record<string, ((x: unknown) => void)[]> = {};
  /** MetaMask moves to another network and tells the page (EIP-1193 chainChanged) */
  const moveTo = (chainId: string) => {
    if (s.chainId === chainId) return;
    s.chainId = chainId;
    for (const f of listeners.chainChanged ?? []) f(chainId);
  };
  /** what each hash sent: the first send's hash is HASH, each later one its own */
  const sent = new Map<string, Record<string, string>>();
  const eth = {
    isMetaMask: true,
    on: (event: string, f: (x: unknown) => void) => {
      listeners[event] = [...(listeners[event] ?? []), f];
    },
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      requests.push(params === undefined ? { method } : { method, params });
      asked.push({ method, chainId: s.chainId });
      const p = (params ?? []) as { chainId: string }[];
      switch (method) {
        case "eth_accounts":
          return s.connected ? [...o.accounts] : [];
        case "eth_requestAccounts":
          s.connected = true;
          return [...o.accounts];
        case "eth_chainId":
          return s.chainId;
        case "wallet_switchEthereumChain":
          if (o.declineSwitch) throw { code: 4001, message: "User rejected the request." };
          if (!s.known.has(p[0].chainId)) throw { code: 4902, message: `Unrecognized chain ID "${p[0].chainId}"` };
          if (!o.stuck) moveTo(p[0].chainId);
          return null;
        case "wallet_addEthereumChain":
          s.known.add(p[0].chainId);
          moveTo(p[0].chainId);
          return null;
        case "eth_sendTransaction": {
          const hash = sent.size === 0 ? HASH : `0x${String(sent.size + 1).padStart(64, "0")}`;
          sent.set(hash, params?.[0] as Record<string, string>);
          return hash;
        }
        case "eth_getTransactionReceipt":
          return s.mined ? { status: o.reverts ? "0x0" : "0x1", blockNumber: "0x10" } : null;
        case "eth_getTransactionByHash": {
          const tx = sent.get(String(params?.[0]));
          return tx ? { from: tx.from.toLowerCase(), to: tx.to.toLowerCase(), input: tx.data, value: tx.value, chainId: tx.chainId, ...o.mined } : null;
        }
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return {
    eth,
    requests,
    asked,
    sends: () => requests.filter((r) => r.method === "eth_sendTransaction"),
    mine: () => {
      s.mined = true;
    },
    /** the owner switches MetaMask's network by hand */
    switchTo: moveTo,
  };
}

class FakeElement {
  textContent = "";
  className = "";
  readonly id: string;
  disabled: boolean;
  private click_?: () => unknown;
  constructor(id: string, disabled: boolean) {
    this.id = id;
    this.disabled = disabled;
  }
  addEventListener(type: string, f: () => unknown) {
    if (type === "click") this.click_ = f;
  }
  /** A click on a disabled button does nothing, as in a browser. */
  async click() {
    if (!this.disabled) await this.click_?.();
  }
}

const settle = async (turns = 20) => {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
};

interface PageOpts {
  wallet?: WalletOpts;
  /** whether the wallet announces itself as MetaMask (EIP-6963); default yes */
  announce?: boolean;
  /** window.ethereum, when it is another wallet's */
  injected?: unknown;
  /** the page as served, if not as renderPage makes it here */
  html?: string;
}

/** Runs the page's script with a fake MetaMask, announced by EIP-6963 and at window.ethereum. */
async function openPage(view: WalletView, o: PageOpts = {}) {
  const html = o.html ?? renderPage(view).html;
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  if (!script) throw new Error("no script");
  const els = new Map<string, FakeElement>();
  for (const m of html.matchAll(/<[a-z0-9]+ [^>]*id="([^"]+)"[^>]*>/g)) els.set(m[1], new FakeElement(m[1], /\sdisabled[\s>]/.test(m[0])));
  const w = o.wallet ? fakeWallet(o.wallet) : undefined;
  const announced = w && o.announce !== false ? [{ info: { uuid: "1", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider: w.eth }] : [];
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const win = {
    ethereum: o.injected ?? w?.eth,
    addEventListener: (type: string, f: (e: unknown) => void) => {
      listeners[type] = [...(listeners[type] ?? []), f];
    },
    // a wallet answers a request for providers by announcing itself, as MetaMask does
    dispatchEvent: (e: { type: string }) => {
      if (e.type === "eip6963:requestProvider") for (const detail of announced) for (const f of listeners["eip6963:announceProvider"] ?? []) f({ detail });
      return true;
    },
  };
  vm.runInNewContext(script, {
    window: win,
    document: { getElementById: (id: string) => els.get(id) ?? null },
    setTimeout: (f: () => void) => setImmediate(f),
    Event: class {
      readonly type: string;
      constructor(type: string) {
        this.type = type;
      }
    },
  });
  await settle();
  const el = (id: string) => {
    const e = els.get(id);
    if (!e) throw new Error(`no #${id}`);
    return e;
  };
  return { el, w: w as ReturnType<typeof fakeWallet>, script };
}

describe("the page (its script, against a fake MetaMask)", () => {
  it("won't send from another account: it says which one to select, and asks nothing else of MetaMask", async () => {
    const p = await openPage(handoffView(), { wallet: { accounts: [OTHER], chainId: "0x3c4" } });
    expect(p.el("provider").textContent).toBe("Using MetaMask (it announced itself as io.metamask).");
    await p.el("connect").click();
    expect(p.el("wallet").textContent).toBe(`Connected: ${OTHER} on Bittensor EVM (chain id 964).`);
    await p.el("send-0").click();
    expect(p.w.sends()).toEqual([]);
    expect(p.w.requests.map((r) => r.method)).not.toContain("wallet_switchEthereumChain");
    expect(p.el("status-0").textContent).toMatch(new RegExp(`must be sent from ${OWNER}`));
    expect(p.el("status-0").className).toBe("status bad");
    // nothing went out: once the right account is selected it can be tried again
    expect(p.el("send-0").disabled).toBe(false);
  });

  it("switches MetaMask to the call's chain first, and won't send while it is on another", async () => {
    const p = await openPage(handoffView(), { wallet: { accounts: [OWNER], chainId: "0x2105", stuck: true } });
    await p.el("send-0").click();
    expect(p.w.requests).toContainEqual({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x3c4" }] });
    expect(p.w.sends()).toEqual([]);
    expect(p.el("status-0").textContent).toMatch(/on Base \(chain id 8453\), but this call is for Bittensor EVM/);

    const declined = await openPage(handoffView(), { wallet: { accounts: [OWNER], chainId: "0x2105", declineSwitch: true } });
    await declined.el("send-0").click();
    expect(declined.w.sends()).toEqual([]);
    expect(declined.el("status-0").textContent).toBe("Not sent: you rejected it in MetaMask.");
  });

  it("adds Bittensor EVM to MetaMask when it doesn't know it, then sends", async () => {
    const p = await openPage(handoffView(), { wallet: { accounts: [OWNER], chainId: "0x2105", known: ["0x2105"] } });
    await p.el("send-0").click();
    expect(p.w.requests).toContainEqual({
      method: "wallet_addEthereumChain",
      params: [{ chainId: "0x3c4", chainName: "Bittensor EVM", nativeCurrency: { name: "TAO", symbol: "TAO", decimals: 18 }, rpcUrls: ["https://lite.chain.opentensor.ai"], blockExplorerUrls: ["https://evm.taostats.io"] }],
    });
    expect(p.w.sends()).toEqual([{ method: "eth_sendTransaction", params: [{ from: OWNER, to: a.vault, data: ACCEPT, value: "0x0", chainId: "0x3c4" }] }]);
  });

  it("sends exactly the file's call, shows the hash, checks what was mined, and won't send it twice", async () => {
    const p = await openPage(handoffView(), { wallet: { accounts: [OWNER], chainId: "0x3c4" } });
    await p.el("send-0").click();
    expect(p.w.sends()).toEqual([{ method: "eth_sendTransaction", params: [{ from: OWNER, to: a.vault, data: ACCEPT, value: "0x0", chainId: "0x3c4" }] }]);
    expect(p.w.requests).toContainEqual({ method: "eth_getTransactionReceipt", params: [HASH] });
    expect(p.w.requests).toContainEqual({ method: "eth_getTransactionByHash", params: [HASH] });
    expect(p.el("status-0").textContent).toBe(
      `Done: mined in block 16, and the mined transaction matches this call (from, to, data, value, chain). Transaction ${HASH} (https://evm.taostats.io/tx/${HASH})`,
    );
    expect(p.el("status-0").className).toBe("status good");
    expect(p.el("send-0").disabled).toBe(true);
    expect(p.el("send-0").textContent).toBe("Done");
    await p.el("send-0").click();
    expect(p.w.sends()).toHaveLength(1);
    // the other call is on Base, from the Base owner: this account and chain are refused for it
    await p.el("send-1").click();
    expect(p.w.sends()).toHaveLength(1);
  });

  it("warns loudly when the mined transaction isn't the call it sent", async () => {
    const p = await openPage(handoffView(), { wallet: { accounts: [OWNER], chainId: "0x3c4", mined: { input: enc("pause") } } });
    await p.el("send-0").click();
    expect(p.el("status-0").textContent).toBe(
      `WARNING: the mined transaction is NOT the call this page sent: its data differs. Check transaction ${HASH} on the explorer now: https://evm.taostats.io/tx/${HASH}`,
    );
    expect(p.el("status-0").className).toBe("status bad");
    const swapped = await openPage(handoffView(), { wallet: { accounts: [OWNER], chainId: "0x3c4", mined: { to: OTHER, from: OTHER } } });
    await swapped.el("send-0").click();
    expect(swapped.el("status-0").textContent).toMatch(/^WARNING: the mined transaction is NOT the call this page sent: its from, to differ\./);
  });

  it("doesn't lock the page while it waits, and points to the explorer once 5 minutes pass unmined", async () => {
    const p = await openPage(handoffView(), { wallet: { accounts: [OWNER], chainId: "0x3c4", pending: true } });
    const sending = p.el("send-0").click();
    await settle(L.STUCK_POLLS + 20);
    expect(p.w.sends()).toHaveLength(1);
    expect(p.el("send-0").disabled).toBe(true);
    expect(p.el("send-0").textContent).toBe("Waiting for the receipt…");
    // free again as soon as the hash came back: the other call and Connect can be used
    expect(p.el("send-1").disabled).toBe(false);
    expect(p.el("connect").disabled).toBe(false);
    expect(p.el("status-0").textContent).toBe(
      `Sent: ${HASH}. Still not mined after 5 minutes or more: check it on the explorer, https://evm.taostats.io/tx/${HASH}. This page keeps checking.`,
    );
    p.w.mine();
    await sending;
    expect(p.el("status-0").textContent).toMatch(/^Done: mined in block 16/);
  });

  it("never asks Bittensor for a Base call's receipt: off Base it says to switch back, and shows Done once MetaMask is back", async () => {
    const p = await openPage(acceptAllView(), { wallet: { accounts: [LEDGER], chainId: "0x2105", pending: true } });
    const sending = p.el("send-1").click();
    await settle();
    expect(p.el("send-1").textContent).toBe("Waiting for the receipt…");
    // MetaMask goes over to Bittensor (as sending call 3 once made it), and the Base call is mined meanwhile
    p.w.switchTo("0x3c4");
    p.w.mine();
    await settle(50);
    const awayText = `Sent; switch MetaMask back to Base (chain id 8453) to see its result (or check https://basescan.org/tx/${HASH})`;
    expect(p.el("status-1").textContent).toBe(awayText);
    expect(p.el("status-1").className).toBe("status wait");
    expect(p.el("send-1").textContent).toBe("Sent: switch MetaMask back to Base");
    const offBase = () => p.w.asked.filter((r) => (r.method === "eth_getTransactionReceipt" || r.method === "eth_getTransactionByHash") && r.chainId !== "0x2105");
    expect(offBase()).toEqual([]);
    // back on Base: the receipt is read there, and the call is done
    p.w.switchTo("0x2105");
    await sending;
    expect(p.el("status-1").textContent).toBe(
      `Done: mined in block 16, and the mined transaction matches this call (from, to, data, value, chain). Transaction ${HASH} (https://basescan.org/tx/${HASH})`,
    );
    expect(p.el("send-1").textContent).toBe("Done");
    expect(offBase()).toEqual([]);
  });

  it("won't send a Bittensor call while a Base call waits for its receipt: it says why and links the waiting call", async () => {
    const p = await openPage(acceptAllView(), { wallet: { accounts: [LEDGER], chainId: "0x2105", pending: true } });
    const sending = p.el("send-1").click();
    await settle();
    // call 3 can be clicked, and is refused before MetaMask is asked anything
    expect(p.el("send-2").disabled).toBe(false);
    await p.el("send-2").click();
    expect(p.w.sends()).toHaveLength(1);
    expect(p.w.asked.map((r) => r.method)).not.toContain("wallet_switchEthereumChain");
    expect(p.w.asked.filter((r) => r.chainId !== "0x2105")).toEqual([]);
    expect(p.el("status-2").textContent).toBe(
      `Not sent: call 2 is still waiting for its receipt on Base (chain id 8453), and this call would switch MetaMask to Bittensor EVM (chain id 964), where that receipt can't be read. Send it once call 2 shows Done. Call 2 on the explorer: https://basescan.org/tx/${HASH}`,
    );
    expect(p.el("status-2").className).toBe("status bad");
    expect(p.el("send-2").textContent).toBe("Send");
    // another Base call still goes
    const other = p.el("send-0").click();
    await settle();
    expect(p.w.sends()).toHaveLength(2);
    // once call 2 is done, call 3 goes: MetaMask switches to Bittensor and sends it
    p.w.mine();
    await sending;
    await other;
    expect(p.el("send-1").textContent).toBe("Done");
    await p.el("send-2").click();
    expect(p.w.sends()).toHaveLength(3);
    expect(p.w.requests).toContainEqual({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x3c4" }] });
    expect(p.el("status-2").textContent).toMatch(/^Done: mined in block 16, and the mined transaction matches this call/);
  });

  it("says so when the transaction reverts, and keeps the next ordered step waiting", async () => {
    const p = await openPage(stepsView(), { wallet: { accounts: [OWNER], chainId: "0x2105", reverts: true } });
    expect(p.el("send-1").disabled).toBe(true);
    await p.el("send-0").click();
    expect(p.w.sends()[0].params).toEqual([
      { from: OWNER, to: BASE_V3.TAO_WETH_POOL, data: enc("increaseObservationCardinalityNext", [1_200]), value: "0x0", chainId: "0x2105", gas: numberToHex(15_100_000) },
    ]);
    expect(p.el("status-0").textContent).toMatch(/^REVERTED: transaction .* failed in block 16/);
    expect(p.el("status-0").className).toBe("status bad");
    expect(p.el("send-1").disabled).toBe(true);
    expect(p.el("send-0").textContent).toBe("Send again");
  });

  it("unlocks an ordered step once the one before it has succeeded", async () => {
    const p = await openPage(stepsView(), { wallet: { accounts: [OWNER], chainId: "0x2105" } });
    expect(p.el("send-1").disabled).toBe(true);
    await p.el("send-0").click();
    expect(p.el("send-1").disabled).toBe(false);
    await p.el("send-1").click();
    expect(p.w.sends()).toHaveLength(2);
  });

  it("uses MetaMask, by its announcement, even when another wallet holds window.ethereum", async () => {
    const other = fakeWallet({ accounts: [OWNER], chainId: "0x3c4" });
    const p = await openPage(handoffView(), { wallet: { accounts: [OWNER], chainId: "0x3c4" }, injected: other.eth });
    await p.el("send-0").click();
    expect(p.w.sends()).toHaveLength(1);
    expect(other.requests).toEqual([]);
  });

  it("without MetaMask's announcement, uses window.ethereum and says so on the page", async () => {
    const p = await openPage(handoffView(), { wallet: { accounts: [OWNER], chainId: "0x3c4" }, announce: false });
    expect(p.el("provider").textContent).toMatch(/^MetaMask didn't announce itself on this page, so this is the browser's default wallet/);
    expect(p.el("provider").className).toBe("note bad");
    await p.el("send-0").click();
    expect(p.w.sends()).toHaveLength(1);
  });

  it("without a wallet in the browser, says so and offers nothing to click", async () => {
    const p = await openPage(handoffView());
    expect(p.el("wallet").textContent).toMatch(/No wallet found in this browser/);
    expect(p.el("connect").disabled).toBe(true);
    expect(p.el("send-0").disabled).toBe(true);
  });

  it("runs the same as Node itself serves it (types stripped by Node, not by the test runner)", async () => {
    const view = handoffView();
    const src = pathToFileURL(fileURLToPath(new URL("../src/sign-page.ts", import.meta.url))).href;
    const html = execFileSync(process.execPath, ["--input-type=module", "-e", `import { renderPage } from ${JSON.stringify(src)}; process.stdout.write(renderPage(JSON.parse(process.argv[1])).html);`, JSON.stringify(view)], {
      encoding: "utf8",
    });
    const p = await openPage(view, { wallet: { accounts: [OWNER], chainId: "0x3c4" }, html });
    await p.el("send-0").click();
    expect(p.w.sends()).toHaveLength(1);
    expect(p.el("status-0").textContent).toMatch(/^Done: mined in block 16, and the mined transaction matches this call/);
    const wrong = await openPage(view, { wallet: { accounts: [OTHER], chainId: "0x3c4" }, html });
    await wrong.el("send-0").click();
    expect(wrong.w.sends()).toEqual([]);
  });
});

describe("the page's HTML", () => {
  it("is built from the decoded calls and the record: headings, effects, sender roles, selectors and words", () => {
    const { html } = renderPage(handoffView());
    expect(html).toContain("<h1>Cascade v3-launch: 2 calls to send from MetaMask</h1>");
    expect(html).toContain('<h2><span class="n">1.</span> acceptOwnership() on the Vault (Bittensor)</h2>');
    expect(html).toContain(`<p class="effect">acceptOwnership(): makes ${OWNER} the owner of the Vault on Bittensor</p>`);
    expect(html).toContain("<dt>Network</dt><dd>Bittensor EVM (chain id 964)</dd>");
    expect(html).toContain(`<dt>Contract</dt><dd>Vault on Bittensor<br><code>${a.vault}</code></dd>`);
    expect(html).toContain("<dt>Function</dt><dd><code>acceptOwnership()</code></dd>");
    expect(html).toContain("<dt>Arguments</dt><dd>none</dd>");
    expect(html).toContain("<dt>Value</dt><dd>0 TAO</dd>");
    expect(html).toContain(`<dt>Send from</dt><dd><code>${OWNER}</code> (the owner on Bittensor, from the deployment record)</dd>`);
    expect(html).toContain("<dt>Selector</dt><dd><code>0x79ba5097</code></dd>");
    expect(html).toContain("<dt>Parameters</dt><dd>none</dd>");
    expect(html).toContain(`<dt>Calldata</dt><dd><code class="data">${ACCEPT}</code></dd>`);
    expect(html).toContain('<h2><span class="n">2.</span> acceptOwnership() on the Front door (Base)</h2>');
    // the file's own words only as notes
    expect(html).toContain('<p class="note">Note from the file: acceptOwnership() on the vault</p>');
    expect(html).toContain('<p class="note">File title: Cascade v3-launch: accept ownership</p>');
    const steps = renderPage(stepsView()).html;
    expect(steps).toContain("<dt>Arguments</dt><dd><code>observationCardinalityNext</code> (uint16) = <code>1200</code></dd>");
    expect(steps).toContain(`<dt>Parameters</dt><dd>1: <code>${"0".repeat(61)}4b0</code></dd>`);
    expect(steps).toMatch(/<dt>Gas limit<\/dt><dd>15,100,000/);
    expect(steps).toContain("<h1>Cascade: 2 calls to send from MetaMask</h1>");
  });

  it("heads a pause call labelled as something else with what it decodes to", () => {
    const v = checkCalls(
      walletFile({
        title: "routine maintenance",
        deployment: "v3-launch",
        now: NOW,
        calls: [{ chainId: 8453, to: a.frontDoor, data: enc("pause"), label: "pause() is harmless: it only refreshes the page", from: ROLES.guardian.base }],
      }),
      knownContracts(launch),
      NOW,
    );
    const { html } = renderPage(v);
    expect(html).toContain('<h2><span class="n">1.</span> pause() on the Front door (Base)</h2>');
    expect(html).toContain(
      '<p class="effect">pause(): stops deposits, redeem requests, batch closes and USDC deliveries on the Front door until the owner unpauses (claims stay open)</p>',
    );
    expect(html).toContain('<p class="note">Note from the file: pause() is harmless: it only refreshes the page</p>');
    expect(html.match(/harmless/g)).toHaveLength(1);
    expect(html).toContain(`(the guardian on Base, from the deployment record)`);
  });

  it("says plainly what the Ledger shows and what to compare, and to disconnect afterwards", () => {
    const { html } = renderPage(handoffView());
    expect(html).toMatch(/never asks for your seed words, recovery phrase, private key or password/);
    expect(html).toContain("Debug data");
    expect(html).toMatch(/Hex \(Data\) tab/);
    expect(html).toMatch(/compare the selector, each parameter word and the To address with the call below/);
    expect(html).toMatch(/turn Blind signing and Debug data off again/);
    expect(html).toMatch(/disconnect this site in MetaMask \(Connected sites\)/);
    // no claim that a blind-signing Ledger shows the call by itself
    expect(html).not.toMatch(/the Ledger and MetaMask show the network/);
  });

  it("shows the file's age warning", () => {
    const v = checkCalls(walletFile({ title: "t", deployment: "v3-launch", now: NOW, calls: [{ chainId: 964, to: a.vault, data: ACCEPT, label: "acceptOwnership()", from: OWNER }] }), knownContracts(launch), NOW + 48 * 3_600_000);
    expect(renderPage(v).html).toContain('<p class="warning">WARNING: This file was prepared 48 hours ago (2027-01-15T08:00:00.000Z): make it again with --for-wallet unless you know it is still right.</p>');
    expect(renderPage(handoffView()).html).not.toContain('class="warning"');
  });

  it("has nothing to type into", () => {
    expect(renderPage(handoffView()).html).not.toMatch(/<input|<textarea|<select|<form|contenteditable/i);
  });

  it("escapes what the file says", () => {
    const v = handoffView();
    v.calls[0].label = `acceptOwnership() <img src=x onerror="alert(1)">`;
    v.title = "</script><script>alert(1)</script>";
    const { html } = renderPage(v);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<img");
    expect(html.match(/<script>/g)).toHaveLength(1);
  });

  it("is self-contained under a strict CSP: its one script and one style by hash, nothing loaded from anywhere", () => {
    const { html, csp } = renderPage(handoffView());
    const sha = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
    const style = html.match(/<style>([\s\S]*)<\/style>/)?.[1] ?? "";
    expect(csp).toBe(`default-src 'none'; script-src ${sha(script)}; style-src ${sha(style)}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    expect(html).not.toMatch(/\ssrc=|<link|\sstyle=|\son[a-z]+=/i);
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html.match(/<style/g)).toHaveLength(1);
  });
});

// ---- the server ----

function get(port: number, path: string, host: string, method = "GET", address = "127.0.0.1") {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = request({ host: address, port, path, method, headers: { host }, timeout: 5_000 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

describe("pnpm ops sign's server", () => {
  const page = { html: "<!doctype html><p>the page</p>", csp: "default-src 'none'" };

  it("listens on 127.0.0.1 only, on a port the system picks, and serves the one page with its CSP", async () => {
    const s = await servePage(page);
    try {
      expect(s.address).toBe("127.0.0.1");
      expect(s.port).toBeGreaterThan(0);
      expect(s.url).toBe(`http://127.0.0.1:${s.port}/`);
      const host = `127.0.0.1:${s.port}`;
      const r = await get(s.port, "/", host);
      expect(r.status).toBe(200);
      expect(r.body).toBe(page.html);
      expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(r.headers["content-security-policy"]).toBe(page.csp);
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["referrer-policy"]).toBe("no-referrer");
      expect(r.headers["x-frame-options"]).toBe("DENY");
      expect(r.headers["cross-origin-opener-policy"]).toBe("same-origin");
      expect((await get(s.port, "/other", host)).status).toBe(404);
      expect((await get(s.port, "/", host, "POST")).status).toBe(405);
      // a page reached under another name (DNS rebinding, or a proxy) gets nothing
      expect((await get(s.port, "/", `evil.example:${s.port}`)).status).toBe(403);
      expect((await get(s.port, "/", `localhost:${s.port}`)).status).toBe(403);
    } finally {
      await s.close();
    }
  });

  it("can't be reached on this computer's network addresses, and is gone once closed", async () => {
    const s = await servePage(page);
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal);
    try {
      if (lan) await expect(get(s.port, "/", `127.0.0.1:${s.port}`, "GET", lan.address)).rejects.toThrow();
    } finally {
      await s.close();
    }
    await expect(get(s.port, "/", `127.0.0.1:${s.port}`)).rejects.toThrow(/ECONNREFUSED/);
  });
});

const write = (body: unknown) => {
  const path = join(tmp(), "calls.json");
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
};
const handoffFile = () =>
  walletFile({
    title: "Cascade v3-launch: accept ownership",
    deployment: "v3-launch",
    now: NOW,
    calls: [{ chainId: 964, to: a.vault, data: ACCEPT, label: "acceptOwnership() on the vault", from: OWNER }],
  });
/** A reader of the contracts' live roles that no test expects to be called unless it gives its own. */
const noReads = async (): Promise<never> => {
  throw new Error("no live read expected");
};
const opts = (o: Partial<Parameters<typeof prepareSign>[1]> = {}): Parameters<typeof prepareSign>[1] => ({
  deployment: "v3-launch",
  recordOf: () => launch,
  now: NOW,
  readRoles: noReads,
  ...o,
});

describe("pnpm ops sign <file>", () => {
  it("reads the file, checks it against its deployment's live record, and renders the page", async () => {
    const asked: string[] = [];
    const p = await prepareSign(write(handoffFile()), opts({ recordOf: (name) => (asked.push(name), launch) }));
    expect(asked).toEqual(["v3-launch"]);
    expect(p.view.calls[0].heading).toBe("acceptOwnership() on the Vault (Bittensor)");
    expect(p.lines[1]).toBe(`  1. acceptOwnership() on the Vault (Bittensor) ${a.vault}`);
    expect(p.page.html).toContain("acceptOwnership() on the Vault (Bittensor)");
    expect(p.page.csp).toMatch(/^default-src 'none'/);
  });

  it("refuses a file for another deployment than OPS_DEPLOYMENT (or --deployment)", async () => {
    await expect(prepareSign(write(handoffFile()), opts({ deployment: "v3-test" }))).rejects.toThrow(
      /this file is for deployment v3-launch, but this run's deployment is v3-test \(OPS_DEPLOYMENT, or --deployment\): run it with OPS_DEPLOYMENT=v3-launch or --deployment v3-launch/,
    );
    // the pool steps name no deployment: any run may serve them
    const pools = walletFile({
      title: "t",
      ordered: true,
      now: NOW,
      calls: [{ chainId: 8453, to: BASE_V3.TAO_WETH_POOL, data: enc("increaseObservationCardinalityNext", [1_200]), gas: 15_100_000, label: "increaseObservationCardinalityNext(1200)", from: OWNER }],
    });
    expect((await prepareSign(write(pools), opts({ deployment: "v3-test", recordOf: () => null }))).view.calls).toHaveLength(1);
  });

  it("warns of a file more than a day old, in the terminal and on the page", async () => {
    const p = await prepareSign(write(handoffFile()), opts({ now: NOW + 48 * 3_600_000 }));
    expect(p.lines[1]).toMatch(/^WARNING: This file was prepared 48 hours ago/);
    expect(p.page.html).toContain('<p class="warning">WARNING: This file was prepared 48 hours ago');
  });

  it("refuses a file whose deployment has no live record, one edited to call something else, one with a hidden character, and one that isn't JSON", async () => {
    await expect(prepareSign(write(handoffFile()), opts({ recordOf: () => null }))).rejects.toThrow(/deployment v3-launch, but there's no live record for it/);
    const edited = handoffFile();
    edited.calls[0].to = getAddress("0x00000000000000000000000000000000000bad01");
    await expect(prepareSign(write(edited), opts())).rejects.toThrow(/is not one of this deployment's contracts/);
    const hidden = handoffFile();
    hidden.calls[0].label = `acceptOwnership()${char(0x200b)} on the vault`;
    await expect(prepareSign(write(hidden), opts())).rejects.toThrow(/call 1: label .*printable ASCII/);
    await expect(prepareSign(write("{ not json"), opts())).rejects.toThrow(/can't read .* as a call file/);
  });
});

describe("pause and unpause after the guardian or owner is replaced on-chain: the contracts' live roles", () => {
  const NEW_GUARDIAN = getAddress("0x00000000000000000000000000000000000b0b99");
  const NEW_OWNER = getAddress("0x00000000000000000000000000000000000a0b99");
  const fileOf = (calls: Parameters<typeof walletFile>[0]["calls"]) => walletFile({ title: "t", deployment: "v3-launch", now: NOW, calls });
  const on = (fn: "pause" | "unpause", from: Address, to = a.frontDoor, chainId = 8453) => ({ chainId, to, data: enc(fn), label: `${fn}()`, from });
  /** The contracts' answers now: the front door's roles as given (else the record's), the vault's as the
   * record says. Each read is recorded. */
  const live = (frontDoor: { guardian?: Address; owner?: Address } = {}) => {
    const reads: [string, string][] = [];
    const readRoles = async (chain: string, address: Address) => {
      reads.push([chain, address]);
      return address === a.frontDoor
        ? { guardian: frontDoor.guardian ?? ROLES.guardian.base, owner: frontDoor.owner ?? ROLES.owner.base }
        : { guardian: ROLES.guardian.bittensor, owner: ROLES.owner.bittensor };
    };
    return { reads, readRoles };
  };
  const failing = async (): Promise<never> => {
    throw new Error("RPC down");
  };

  it("accepts a rotated guardian's pause when the contract says it is the guardian now, reading each target once", async () => {
    const l = live({ guardian: NEW_GUARDIAN });
    const p = await prepareSign(write(fileOf([on("pause", NEW_GUARDIAN), on("pause", ROLES.guardian.bittensor, a.vault, 964)])), opts({ readRoles: l.readRoles }));
    expect(l.reads).toEqual([
      ["base", a.frontDoor],
      ["bittensor", a.vault],
    ]);
    const role = `the guardian on Base, read from the contract now (the record says ${ROLES.guardian.base})`;
    expect(p.view.calls.map((c) => c.senderRole)).toEqual([role, "the guardian on Bittensor, from the deployment record"]);
    expect(p.lines).toContain(`     Base (chain id 8453), value 0 ETH, from ${NEW_GUARDIAN} (${role})`);
    expect(p.page.html).toContain(`<dt>Send from</dt><dd><code>${NEW_GUARDIAN}</code> (${role})</dd>`);
    expect(p.view.warnings).toEqual([]);
  });

  it("refuses that file when the live read fails, saying why, or when the contract names someone else", async () => {
    await expect(prepareSign(write(fileOf([on("pause", NEW_GUARDIAN)])), opts({ readRoles: failing }))).rejects.toThrow(
      new RegExp(
        `call 1: ${NEW_GUARDIAN} is not a role in the deployment record nor read from the contract now that may send pause\\(\\) to the Front door on Base .*; the contract's live guardian and owner couldn't be read \\(RPC down\\), so only the record's roles count`,
      ),
    );
    await expect(prepareSign(write(fileOf([on("pause", NEW_GUARDIAN)])), opts({ readRoles: live({ guardian: OTHER }).readRoles }))).rejects.toThrow(
      /is not a role in the deployment record nor read from the contract now that may send pause\(\)/,
    );
  });

  it("falls back to the record's roles when the read fails, and says so", async () => {
    const p = await prepareSign(write(fileOf([on("pause", ROLES.guardian.base)])), opts({ readRoles: failing }));
    expect(p.view.calls[0].senderRole).toBe("the guardian on Base, from the deployment record");
    const warning = "Couldn't read the Front door's guardian and owner on Base now (RPC down): its pause() and unpause() are checked against the deployment record's roles only.";
    expect(p.view.warnings).toEqual([warning]);
    expect(p.lines).toContain(`WARNING: ${warning}`);
    expect(p.page.html).toContain('<p class="warning">WARNING: Couldn&#39;t read the Front door&#39;s guardian and owner on Base now (RPC down)');
  });

  it("takes unpause from the owner the contract names now, and never from a guardian", async () => {
    const rotated = live({ guardian: NEW_GUARDIAN, owner: NEW_OWNER });
    const p = await prepareSign(write(fileOf([on("unpause", NEW_OWNER)])), opts({ readRoles: rotated.readRoles }));
    expect(p.view.calls[0].senderRole).toBe(`the owner on Base, read from the contract now (the record says ${ROLES.owner.base})`);
    // unpause is onlyOwner: the guardian, live or recorded, is refused
    await expect(prepareSign(write(fileOf([on("unpause", NEW_GUARDIAN)])), opts({ readRoles: rotated.readRoles }))).rejects.toThrow(/may send unpause\(\) to the Front door on Base/);
    await expect(prepareSign(write(fileOf([on("unpause", ROLES.guardian.base)])), opts({ readRoles: rotated.readRoles }))).rejects.toThrow(/may send unpause\(\)/);
    // pause takes the live owner too
    expect((await prepareSign(write(fileOf([on("pause", NEW_OWNER)])), opts({ readRoles: rotated.readRoles }))).view.calls[0].senderRole).toBe(
      `the owner on Base, read from the contract now (the record says ${ROLES.owner.base})`,
    );
  });

  it("keeps acceptOwnership to the record's owner: nothing is read, and an owner only the contract names is refused", async () => {
    const l = live({ owner: NEW_OWNER });
    const accept = { chainId: 8453, to: a.frontDoor, data: ACCEPT, label: "acceptOwnership()", from: NEW_OWNER };
    await expect(prepareSign(write(fileOf([accept])), opts({ readRoles: l.readRoles }))).rejects.toThrow(
      /is not a role in the deployment record that may send acceptOwnership\(\) to the Front door on Base/,
    );
    expect(l.reads).toEqual([]);
  });

  it("reads each contract's guardian() and owner() through the chain's RPC", async () => {
    const f = fakeChain([PAUSE_ABI], { guardian: () => NEW_GUARDIAN, owner: () => NEW_OWNER });
    expect(await liveRoles(f.ctx, "base", a.frontDoor)).toEqual({ guardian: NEW_GUARDIAN, owner: NEW_OWNER });
    expect(f.calls.map((c) => [c.chain, c.fn, c.to])).toEqual([
      ["base", "guardian", a.frontDoor],
      ["base", "owner", a.frontDoor],
    ]);
  });

  it("gives up on an RPC that doesn't answer, so a hung node can't hold up an emergency pause", async () => {
    const hung = { rpc: { request: () => new Promise<never>(() => {}) } };
    await expect(liveRoles(hung, "bittensor", a.vault, 20)).rejects.toThrow(/Bittensor RPC didn't answer within 0\.02s/);
  });
});
