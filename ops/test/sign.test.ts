import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { encodeFunctionData, getAddress, type Hex, numberToHex } from "viem";
import { describe, expect, it } from "vitest";
import { BASE_V3 } from "../src/config.ts";
import { buildPlanV3 } from "../src/plan.ts";
import { knownContracts, prepareSign, servePage } from "../src/sign.ts";
import { renderPage, signLogic } from "../src/sign-page.ts";
import { checkCalls, KNOWN_ABI, type WalletView, walletFile } from "../src/wallet.ts";
import { COLDKEY, v3Record } from "./fake-keeper.ts";
import { ROLES } from "./launch-roles.ts";

const launch = v3Record("live", buildPlanV3(4, 9, COLDKEY, "launch", ROLES));
const a = launch.plan.addresses as ReturnType<typeof buildPlanV3>["addresses"];
const enc = (functionName: string, args?: readonly unknown[]) => encodeFunctionData({ abi: KNOWN_ABI, functionName, args } as never) as Hex;
const ACCEPT = enc("acceptOwnership");
const OWNER = ROLES.owner.bittensor;
const OTHER = getAddress("0x00000000000000000000000000000000000e7e01");
const HASH = `0x${"ab".repeat(32)}`;
const tmp = () => mkdtempSync(join(tmpdir(), "ops-sign-"));

/** The hand-off's calls for a plain-account owner, checked as pnpm ops sign checks them. */
const handoffView = (): WalletView =>
  checkCalls(
    walletFile({
      title: "Cascade v3-launch: accept ownership",
      deployment: "v3-launch",
      now: 1_800_000_000_000,
      calls: [
        { chainId: 964, to: a.vault, data: ACCEPT, label: "acceptOwnership() on the vault", from: OWNER, sender: "the owner" },
        { chainId: 8453, to: a.frontDoor, data: ACCEPT, label: "acceptOwnership() on the front door", from: ROLES.owner.base, sender: "the owner" },
      ],
    }),
    knownContracts(launch),
  );
/** Two cardinality steps, which must go in order. */
const stepsView = (): WalletView =>
  checkCalls(
    walletFile({
      title: "Cascade: grow the oracle pools' observation slots",
      ordered: true,
      now: 1,
      calls: [1_200, 1_800].map((n, i) => ({
        chainId: 8453,
        to: BASE_V3.TAO_WETH_POOL,
        data: enc("increaseObservationCardinalityNext", [n]),
        gas: 15_100_000,
        label: `step ${i + 1}`,
        from: OWNER,
        sender: "the account you chose with --from",
      })),
    }),
    knownContracts(null),
  );

describe("the page's checks before it sends (its pure logic)", () => {
  const L = signLogic();
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

  it("sends one call at a time, never one already done, and in order when the file says so", () => {
    expect(L.canSend(["ready", "ready"], 1, false, false)).toBe(true);
    expect(L.canSend(["ready", "ready"], 0, false, true)).toBe(false);
    expect(L.canSend(["confirmed", "ready"], 0, false, false)).toBe(false);
    expect(L.canSend(["sent", "ready"], 0, false, false)).toBe(false);
    expect(L.canSend(["reverted"], 0, false, false)).toBe(true);
    expect(L.canSend(["ready", "ready"], 1, true, false)).toBe(false);
    expect(L.canSend(["reverted", "ready"], 1, true, false)).toBe(false);
    expect(L.canSend(["confirmed", "ready"], 1, true, false)).toBe(true);
  });

  it("reads a receipt and an error the way MetaMask gives them", () => {
    expect(L.receiptStatus({ status: "0x1" })).toBe("success");
    expect(L.receiptStatus({ status: "0x0" })).toBe("reverted");
    expect(L.errorText({ code: 4001, message: "User denied transaction signature." })).toBe("you rejected it in MetaMask.");
    expect(L.errorText({ code: -32000, message: "insufficient funds" })).toBe("insufficient funds");
    expect(L.explorerTx(964, HASH)).toBe(`https://evm.taostats.io/tx/${HASH}`);
    expect(L.explorerTx(8453, HASH)).toBe(`https://basescan.org/tx/${HASH}`);
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
}

function fakeWallet(o: WalletOpts) {
  const s = { connected: false, chainId: o.chainId, known: new Set(o.known ?? ["0x2105", "0x3c4"]) };
  const requests: { method: string; params?: unknown[] }[] = [];
  const eth = {
    isMetaMask: true,
    on: () => undefined,
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      requests.push(params === undefined ? { method } : { method, params });
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
          if (!o.stuck) s.chainId = p[0].chainId;
          return null;
        case "wallet_addEthereumChain":
          s.known.add(p[0].chainId);
          s.chainId = p[0].chainId;
          return null;
        case "eth_sendTransaction":
          return HASH;
        case "eth_getTransactionReceipt":
          return { status: o.reverts ? "0x0" : "0x1", blockNumber: "0x10" };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { eth, requests, sends: () => requests.filter((r) => r.method === "eth_sendTransaction") };
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

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

/** Runs the page's script (from `html`, or as renderPage makes it) with `wallet` as window.ethereum. */
async function openPage(view: WalletView, wallet?: WalletOpts, html = renderPage(view).html) {
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  if (!script) throw new Error("no script");
  const els = new Map<string, FakeElement>();
  for (const m of html.matchAll(/<[a-z0-9]+ [^>]*id="([^"]+)"[^>]*>/g)) els.set(m[1], new FakeElement(m[1], /\sdisabled[\s>]/.test(m[0])));
  const w = wallet ? fakeWallet(wallet) : undefined;
  vm.runInNewContext(script, {
    window: w ? { ethereum: w.eth } : {},
    document: { getElementById: (id: string) => els.get(id) ?? null },
    setTimeout: (f: () => void) => setImmediate(f),
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
    const p = await openPage(handoffView(), { accounts: [OTHER], chainId: "0x3c4" });
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
    const p = await openPage(handoffView(), { accounts: [OWNER], chainId: "0x2105", stuck: true });
    await p.el("send-0").click();
    expect(p.w.requests).toContainEqual({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x3c4" }] });
    expect(p.w.sends()).toEqual([]);
    expect(p.el("status-0").textContent).toMatch(/on Base \(chain id 8453\), but this call is for Bittensor EVM/);

    const declined = await openPage(handoffView(), { accounts: [OWNER], chainId: "0x2105", declineSwitch: true });
    await declined.el("send-0").click();
    expect(declined.w.sends()).toEqual([]);
    expect(declined.el("status-0").textContent).toBe("Not sent: you rejected it in MetaMask.");
  });

  it("adds Bittensor EVM to MetaMask when it doesn't know it, then sends", async () => {
    const p = await openPage(handoffView(), { accounts: [OWNER], chainId: "0x2105", known: ["0x2105"] });
    await p.el("send-0").click();
    expect(p.w.requests).toContainEqual({
      method: "wallet_addEthereumChain",
      params: [{ chainId: "0x3c4", chainName: "Bittensor EVM", nativeCurrency: { name: "TAO", symbol: "TAO", decimals: 18 }, rpcUrls: ["https://lite.chain.opentensor.ai"], blockExplorerUrls: ["https://evm.taostats.io"] }],
    });
    expect(p.w.sends()).toEqual([{ method: "eth_sendTransaction", params: [{ from: OWNER, to: a.vault, data: ACCEPT, value: "0x0", chainId: "0x3c4" }] }]);
  });

  it("sends exactly the file's call, shows the hash, waits for the receipt, and won't send it twice", async () => {
    const p = await openPage(handoffView(), { accounts: [OWNER], chainId: "0x3c4" });
    await p.el("send-0").click();
    expect(p.w.sends()).toEqual([{ method: "eth_sendTransaction", params: [{ from: OWNER, to: a.vault, data: ACCEPT, value: "0x0", chainId: "0x3c4" }] }]);
    expect(p.w.requests).toContainEqual({ method: "eth_getTransactionReceipt", params: [HASH] });
    expect(p.el("status-0").textContent).toBe(`Done: mined in block 16. Transaction ${HASH} (https://evm.taostats.io/tx/${HASH})`);
    expect(p.el("status-0").className).toBe("status good");
    expect(p.el("send-0").disabled).toBe(true);
    expect(p.el("send-0").textContent).toBe("Done");
    await p.el("send-0").click();
    expect(p.w.sends()).toHaveLength(1);
    // the other call is on Base, from the Base owner: this account and chain are refused for it
    await p.el("send-1").click();
    expect(p.w.sends()).toHaveLength(1);
  });

  it("says so when the transaction reverts, and keeps the next ordered step waiting", async () => {
    const p = await openPage(stepsView(), { accounts: [OWNER], chainId: "0x2105", reverts: true });
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
    const p = await openPage(stepsView(), { accounts: [OWNER], chainId: "0x2105" });
    expect(p.el("send-1").disabled).toBe(true);
    await p.el("send-0").click();
    expect(p.el("send-1").disabled).toBe(false);
    await p.el("send-1").click();
    expect(p.w.sends()).toHaveLength(2);
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
    const p = await openPage(view, { accounts: [OWNER], chainId: "0x3c4" }, html);
    await p.el("send-0").click();
    expect(p.w.sends()).toHaveLength(1);
    const wrong = await openPage(view, { accounts: [OTHER], chainId: "0x3c4" }, html);
    await wrong.el("send-0").click();
    expect(wrong.w.sends()).toEqual([]);
  });
});

describe("the page's HTML", () => {
  it("shows each call plainly: network, contract and role, function, arguments, value, sender and calldata", () => {
    const { html } = renderPage(handoffView());
    expect(html).toContain("<dt>Network</dt><dd>Bittensor EVM (chain id 964)</dd>");
    expect(html).toContain(`<dt>Contract</dt><dd>Vault on Bittensor<br><code>${a.vault}</code></dd>`);
    expect(html).toContain("<dt>Function</dt><dd><code>acceptOwnership()</code></dd>");
    expect(html).toContain("<dt>Arguments</dt><dd>none</dd>");
    expect(html).toContain("<dt>Value</dt><dd>0 TAO</dd>");
    expect(html).toContain(`<dt>Send from</dt><dd><code>${OWNER}</code> (the owner)</dd>`);
    expect(html).toContain(`<dt>Calldata</dt><dd><code class="data">${ACCEPT}</code></dd>`);
    expect(html).toContain(`<dt>Contract</dt><dd>Front door on Base<br><code>${a.frontDoor}</code></dd>`);
    const steps = renderPage(stepsView()).html;
    expect(steps).toContain("<dt>Arguments</dt><dd><code>observationCardinalityNext</code> (uint16) = <code>1200</code></dd>");
    expect(steps).toMatch(/<dt>Gas limit<\/dt><dd>15,100,000/);
  });

  it("has nothing to type into, and says it never asks for seed words or keys", () => {
    const { html } = renderPage(handoffView());
    expect(html).not.toMatch(/<input|<textarea|<select|<form|contenteditable/i);
    expect(html).toMatch(/never asks for your seed words, recovery phrase, private key or password/);
  });

  it("escapes what the file says", () => {
    const v = handoffView();
    v.calls[0].label = `<img src=x onerror="alert(1)">`;
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

describe("pnpm ops sign <file>", () => {
  const write = (body: unknown) => {
    const path = join(tmp(), "calls.json");
    writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
    return path;
  };
  const handoffFile = () =>
    walletFile({
      title: "Cascade v3-launch: accept ownership",
      deployment: "v3-launch",
      now: 1_800_000_000_000,
      calls: [{ chainId: 964, to: a.vault, data: ACCEPT, label: "acceptOwnership() on the vault", from: OWNER, sender: "the owner" }],
    });

  it("reads the file, checks it against its deployment's live record, and renders the page", () => {
    const asked: string[] = [];
    const p = prepareSign(write(handoffFile()), (name) => (asked.push(name), launch));
    expect(asked).toEqual(["v3-launch"]);
    expect(p.view.calls[0].contract).toBe("Vault on Bittensor");
    expect(p.lines[1]).toBe(`  1. Bittensor EVM (chain id 964): Vault on Bittensor ${a.vault}`);
    expect(p.page.html).toContain("Vault on Bittensor");
    expect(p.page.csp).toMatch(/^default-src 'none'/);
  });

  it("refuses a file whose deployment has no live record, one edited to call something else, and one that isn't JSON", () => {
    expect(() => prepareSign(write(handoffFile()), () => null)).toThrow(/deployment v3-launch, but there's no live record for it/);
    const edited = handoffFile();
    edited.calls[0].to = getAddress("0x00000000000000000000000000000000000bad01");
    expect(() => prepareSign(write(edited), () => launch)).toThrow(/is not one of this deployment's contracts/);
    expect(() => prepareSign(write("{ not json"), () => launch)).toThrow(/can't read .* as a call file/);
  });
});
