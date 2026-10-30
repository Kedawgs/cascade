import { createHash } from "node:crypto";
import type { WalletView } from "./wallet.ts";

/** What the page's script gets about each call: only what it sends. What the page shows is HTML made
 * here (renderPage), and nothing on the page can change either. */
export interface PageCall {
  chainId: number;
  to: string;
  data: string;
  value: string;
  gas?: string;
  from: string;
}
export interface PageData {
  ordered: boolean;
  calls: PageCall[];
}
type CallState = "ready" | "busy" | "sent" | "confirmed" | "reverted";
interface WalletState {
  accounts: string[];
  chainId: string | null;
}
type Readiness = { ok: true } | { ok: false; problem: "connect" | "account" | "chain"; reason: string };

/** The page's decisions as pure functions of plain data: the tests call them here, and the page gets
 * this function's own source (toString), so it uses nothing but its arguments and the language's
 * built-ins. */
export function signLogic() {
  const NETWORKS: Record<number, { name: string; symbol: string; currency: string; rpc: string; explorer: string }> = {
    8453: { name: "Base", symbol: "ETH", currency: "Ether", rpc: "https://mainnet.base.org", explorer: "https://basescan.org" },
    964: { name: "Bittensor EVM", symbol: "TAO", currency: "TAO", rpc: "https://lite.chain.opentensor.ai", explorer: "https://evm.taostats.io" },
  };
  const toHex = (n: string | number): string => `0x${BigInt(n).toString(16)}`;
  const sameAddress = (x: unknown, y: unknown): boolean => typeof x === "string" && typeof y === "string" && x.toLowerCase() === y.toLowerCase();
  const chainNumber = (id: unknown): number | null => {
    if (typeof id !== "string" && typeof id !== "number") return null;
    try {
      return Number(BigInt(id));
    } catch {
      return null;
    }
  };
  const isChain = (id: unknown, chainId: number): boolean => chainNumber(id) === chainId;
  const networkName = (id: unknown): string => {
    const n = chainNumber(id);
    if (n === null) return "an unknown network";
    return NETWORKS[n] ? `${NETWORKS[n].name} (chain id ${n})` : `chain id ${n}`;
  };
  const codeOf = (e: unknown): unknown => (typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined);

  /** Whether `call` may be sent now: MetaMask connected, its selected account the call's sender, on the
   * call's chain. Anything else is refused, with what to do about it. */
  function readiness(call: PageCall, w: WalletState): Readiness {
    if (!w.accounts.length) return { ok: false, problem: "connect", reason: "Connect MetaMask first." };
    if (!sameAddress(w.accounts[0], call.from)) {
      return {
        ok: false,
        problem: "account",
        reason: `MetaMask is using ${w.accounts[0]}, but this call must be sent from ${call.from}. Nothing was sent. Select that account in MetaMask (your Ledger's), then click Send again.`,
      };
    }
    if (!isChain(w.chainId, call.chainId)) {
      return { ok: false, problem: "chain", reason: `MetaMask is on ${networkName(w.chainId)}, but this call is for ${networkName(call.chainId)}. Nothing was sent.` };
    }
    return { ok: true };
  }

  /** eth_sendTransaction's parameters, from the call alone. chainId too: MetaMask refuses a transaction
   * whose chainId isn't the network it is on. */
  function txParams(call: PageCall): Record<string, string> {
    const p: Record<string, string> = { from: call.from, to: call.to, data: call.data, value: toHex(call.value), chainId: toHex(call.chainId) };
    if (call.gas) p.gas = toHex(call.gas);
    return p;
  }

  const switchParams = (chainId: number) => [{ chainId: toHex(chainId) }];

  /** wallet_addEthereumChain's parameters, for a chain MetaMask doesn't know yet. */
  function addChainParams(chainId: number) {
    const n = NETWORKS[chainId];
    if (!n) return null;
    return [{ chainId: toHex(chainId), chainName: n.name, nativeCurrency: { name: n.currency, symbol: n.symbol, decimals: 18 }, rpcUrls: [n.rpc], blockExplorerUrls: [n.explorer] }];
  }

  /** MetaMask's "unrecognized chain" (4902), which some versions wrap in an internal error. */
  const isUnknownChain = (e: unknown): boolean => codeOf(e) === 4902 || codeOf((e as { data?: { originalError?: unknown } } | null)?.data?.originalError) === 4902;

  /** One call at a time; never one sent or done; in order when the file says so. */
  function canSend(states: CallState[] | string[], i: number, ordered: boolean, busy: boolean): boolean {
    if (busy) return false;
    if (states[i] !== "ready" && states[i] !== "reverted") return false;
    if (ordered) for (let j = 0; j < i; j++) if (states[j] !== "confirmed") return false;
    return true;
  }

  const receiptStatus = (r: unknown): "success" | "reverted" => ((r as { status?: unknown } | null)?.status === "0x1" ? "success" : "reverted");
  const blockText = (r: unknown): string => String(chainNumber((r as { blockNumber?: unknown } | null)?.blockNumber) ?? "?");
  const explorerTx = (chainId: number, hash: string): string => `${NETWORKS[chainId] ? NETWORKS[chainId].explorer : ""}/tx/${hash}`;
  function errorText(e: unknown): string {
    if (codeOf(e) === 4001) return "you rejected it in MetaMask.";
    const m = typeof e === "object" && e !== null ? (e as { message?: unknown }).message : undefined;
    return typeof m === "string" && m ? m : String(e);
  }
  const walletText = (w: WalletState): string => (w.accounts.length ? `Connected: ${w.accounts[0]} on ${networkName(w.chainId)}.` : "Not connected.");
  const buttonText = (s: string): string =>
    s === "busy" ? "Sending…" : s === "sent" ? "Waiting for the receipt…" : s === "confirmed" ? "Done" : s === "reverted" ? "Send again" : "Send";

  return {
    readiness,
    txParams,
    switchParams,
    addChainParams,
    isUnknownChain,
    canSend,
    receiptStatus,
    blockText,
    explorerTx,
    errorText,
    walletText,
    buttonText,
    networkName,
    isChain,
  };
}

/** The page's script: buttons, and MetaMask through window.ethereum. Embedded as source (toString) with
 * signLogic's result and the calls; uses only those and the browser's own globals. It reads nothing from
 * the page: what it sends is `D`, as pnpm ops sign checked it. */
export function pageMain(L: ReturnType<typeof signLogic>, D: PageData): void {
  interface Eth {
    request(a: { method: string; params?: unknown[] }): Promise<unknown>;
    on?(event: string, f: () => void): void;
  }
  const eth = (window as unknown as { ethereum?: Eth }).ethereum;
  const el = (id: string) => document.getElementById(id) as HTMLButtonElement;
  const states: string[] = D.calls.map(() => "ready");
  let busy = false;
  let wallet: WalletState = { accounts: [], chainId: null };

  const say = (i: number, text: string, kind: string) => {
    const s = el(`status-${i}`);
    s.textContent = text;
    s.className = `status ${kind}`;
  };
  const render = () => {
    el("wallet").textContent = eth ? L.walletText(wallet) : "No wallet found in this browser. Open this page in the browser where MetaMask is installed.";
    el("connect").disabled = !eth || busy;
    D.calls.forEach((_c, i) => {
      const b = el(`send-${i}`);
      b.disabled = !eth || !L.canSend(states, i, D.ordered, busy);
      b.textContent = L.buttonText(states[i]);
    });
  };
  const refresh = async () => {
    if (!eth) return;
    const accounts = await eth.request({ method: "eth_accounts" });
    const chainId = await eth.request({ method: "eth_chainId" });
    wallet = { accounts: Array.isArray(accounts) ? accounts.map(String) : [], chainId: typeof chainId === "string" ? chainId : null };
    render();
  };
  const toChain = async (e: Eth, chainId: number) => {
    try {
      await e.request({ method: "wallet_switchEthereumChain", params: L.switchParams(chainId) });
    } catch (err) {
      const add = L.addChainParams(chainId);
      if (!L.isUnknownChain(err) || !add) throw err;
      await e.request({ method: "wallet_addEthereumChain", params: add });
    }
  };
  const receipt = async (e: Eth, i: number, c: PageCall, hash: string) => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        if (!L.isChain(await e.request({ method: "eth_chainId" }), c.chainId)) {
          say(i, `Sent: ${hash}. MetaMask is on another network now: switch it back to ${L.networkName(c.chainId)} to see the receipt here, or look the hash up at ${L.explorerTx(c.chainId, hash)}`, "wait");
          continue;
        }
        const r = await e.request({ method: "eth_getTransactionReceipt", params: [hash] });
        if (r) return r;
      } catch {
        // MetaMask's node didn't answer: ask again
      }
    }
  };
  const send = async (i: number) => {
    if (!eth || !L.canSend(states, i, D.ordered, busy)) return;
    const c = D.calls[i];
    const before = states[i];
    busy = true;
    states[i] = "busy";
    render();
    say(i, "Checking MetaMask…", "wait");
    try {
      await eth.request({ method: "eth_requestAccounts" });
      await refresh();
      let r = L.readiness(c, wallet);
      if (!r.ok && r.problem === "chain") {
        say(i, `Asking MetaMask to switch to ${L.networkName(c.chainId)}…`, "wait");
        await toChain(eth, c.chainId);
        await refresh();
        r = L.readiness(c, wallet);
      }
      if (!r.ok) {
        states[i] = before;
        say(i, r.reason, "bad");
        return;
      }
      say(i, "Check the call on your Ledger's screen, then confirm it in MetaMask…", "wait");
      const hash = String(await eth.request({ method: "eth_sendTransaction", params: [L.txParams(c)] }));
      states[i] = "sent";
      render();
      say(i, `Sent: ${hash}. Waiting for it to be mined…`, "wait");
      const done = await receipt(eth, i, c, hash);
      const block = L.blockText(done);
      if (L.receiptStatus(done) === "success") {
        states[i] = "confirmed";
        say(i, `Done: mined in block ${block}. Transaction ${hash} (${L.explorerTx(c.chainId, hash)})`, "good");
      } else {
        states[i] = "reverted";
        say(i, `REVERTED: transaction ${hash} failed in block ${block}, so it changed nothing (${L.explorerTx(c.chainId, hash)})`, "bad");
      }
    } catch (err) {
      if (states[i] === "busy") states[i] = before;
      say(i, `Not sent: ${L.errorText(err)}`, "bad");
    } finally {
      busy = false;
      render();
    }
  };

  render();
  if (!eth) return;
  const quietly = () => {
    refresh().catch(() => undefined);
  };
  eth.on?.("accountsChanged", quietly);
  eth.on?.("chainChanged", quietly);
  el("connect").addEventListener("click", async () => {
    try {
      await eth.request({ method: "eth_requestAccounts" });
      await refresh();
    } catch (err) {
      el("wallet").textContent = `Not connected: ${L.errorText(err)}`;
    }
  });
  D.calls.forEach((_c, i) => el(`send-${i}`).addEventListener("click", () => send(i)));
  quietly();
}

const STYLE = `
:root { color-scheme: light dark; --bg: #f7f7f5; --fg: #1b1b1b; --muted: #5d5d5d; --card: #fff; --line: #dcdcd6; --good: #11643a; --bad: #a2160f; --warn-bg: #fff4d6; --warn-line: #e0b84a; --btn: #1b4fd8; --btn-fg: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #151515; --fg: #ececec; --muted: #a9a9a9; --card: #1f1f1f; --line: #3a3a3a; --good: #5fd497; --bad: #ff7b72; --warn-bg: #3a2f10; --warn-line: #8a6d1d; --btn: #4b7bff; --btn-fg: #fff; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 780px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 1.5rem; margin: 0 0 4px; }
h2 { font-size: 1.1rem; margin: 0 0 12px; }
.meta, .foot, .order { color: var(--muted); }
.notice { background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 8px; padding: 12px 16px; margin: 16px 0; }
.notice p { margin: 4px 0; }
.wallet { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin: 16px 0; }
.wallet p { margin: 0; overflow-wrap: anywhere; }
ol.calls { list-style: none; padding: 0; margin: 0; }
.call { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin: 0 0 16px; }
.n { display: inline-block; min-width: 1.6em; color: var(--muted); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0 0 16px; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
code { font: 0.92em/1.4 ui-monospace, "Cascadia Mono", Consolas, monospace; overflow-wrap: anywhere; }
button { font: inherit; padding: 8px 18px; border-radius: 6px; border: 0; background: var(--btn); color: var(--btn-fg); cursor: pointer; }
button:disabled { opacity: 0.45; cursor: not-allowed; }
.status { margin: 12px 0 0; overflow-wrap: anywhere; }
.status:empty { display: none; }
.good { color: var(--good); font-weight: 600; }
.bad { color: var(--bad); font-weight: 600; }
@media (max-width: 520px) { dl { grid-template-columns: 1fr; gap: 2px; } dt { margin-top: 8px; } }
`;

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
/** JSON for inside a <script>: no "<" (so no "</script>"). The calls are ASCII only (addresses, hex, numbers). */
const scriptJson = (v: unknown) =>
  JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
const sha256 = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

/** The signing page for `view` (checked by checkCalls), and the CSP to serve it with: one inline script
 * and one inline style, each allowed by its hash, and nothing else from anywhere. */
export function renderPage(view: WalletView): { html: string; csp: string } {
  const data: PageData = {
    ordered: view.ordered,
    calls: view.calls.map((c) => ({ chainId: c.chainId, to: c.to, data: c.data, value: c.value, ...(c.gas ? { gas: c.gas } : {}), from: c.from })),
  };
  const script = `"use strict";\n(${pageMain.toString()})((${signLogic.toString()})(), ${scriptJson(data)});\n`;
  const calls = view.calls
    .map((c, i) => {
      const args = c.fn.args.length ? c.fn.args.map((x) => `<code>${esc(x.name)}</code> (${esc(x.type)}) = <code>${esc(x.value)}</code>`).join("<br>") : "none";
      const gas = c.gas
        ? `${Number(c.gas).toLocaleString("en-US")}, set by this page: leave it as it is in MetaMask (Base refuses a transaction above 16,777,216 gas)`
        : "MetaMask estimates it";
      return `<li class="call">
<h2><span class="n">${i + 1}.</span> ${esc(c.label)}</h2>
<dl>
<dt>Network</dt><dd>${esc(c.network)} (chain id ${c.chainId})</dd>
<dt>Contract</dt><dd>${esc(c.contract)}<br><code>${esc(c.to)}</code></dd>
<dt>Function</dt><dd><code>${esc(c.fn.signature)}</code></dd>
<dt>Arguments</dt><dd>${args}</dd>
<dt>Value</dt><dd>${esc(c.valueText)}</dd>
<dt>Gas limit</dt><dd>${gas}</dd>
<dt>Send from</dt><dd><code>${esc(c.from)}</code> (${esc(c.sender)})</dd>
<dt>Calldata</dt><dd><code class="data">${esc(c.data)}</code></dd>
</dl>
<button type="button" id="send-${i}" disabled>Send</button>
<p class="status" id="status-${i}" role="status" aria-live="polite"></p>
</li>`;
    })
    .join("\n");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Cascade: send with MetaMask</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${esc(view.title)}</h1>
<p class="meta">Prepared ${new Date(view.createdAt).toISOString()}${view.deployment ? ` for the ${esc(view.deployment)} deployment` : ""}. Served by <code>pnpm ops sign</code> to this computer only (127.0.0.1). Stop it with Ctrl-C when you're done.</p>
<section class="notice" aria-label="Safety">
<p><strong>This page never asks for your seed words, recovery phrase, private key or password, and has nothing to type into.</strong> If anything asks you for them, stop: it isn't this page.</p>
<p>MetaMask asks you to confirm each call and your Ledger signs it. Before approving, check that the Ledger and MetaMask show the network, the contract address (To) and the data below.</p>
</section>
<section class="wallet">
<button type="button" id="connect">Connect MetaMask</button>
<p id="wallet">Looking for MetaMask…</p>
</section>
<p class="order">${view.ordered ? "Send these in order: each one waits until the one before it has succeeded." : "Send each call with its own button, one at a time."}</p>
<ol class="calls">
${calls}
</ol>
<p class="foot">Reloading this page forgets what was sent from it: check a call on the explorer (or with <code>pnpm ops ownership</code>, <code>pnpm ops pause</code>'s dry run, or <code>pnpm ops cardinality</code>) before sending it again.</p>
</main>
<script>${script}</script>
</body>
</html>
`;
  const csp = [`default-src 'none'`, `script-src ${sha256(script)}`, `style-src ${sha256(STYLE)}`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`].join("; ");
  return { html, csp };
}
