import { randomUUID } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { type Address, formatEther, type Hex, numberToHex } from "viem";
import type { Env } from "../config.ts";
import type { DeploymentV32 } from "./core/deployment.ts";
import { chainLabel, unit } from "./core/errors.ts";
import { KeeperNotReady } from "./core/failures.ts";
import type { Journal, JournalRow } from "./core/journal.ts";
import { fromJson, toJson } from "./core/memory.ts";
import type { ClaimPolicy } from "./core/rewards.ts";
import type { RoundOptions } from "./core/round.ts";
import type { Rpc } from "./core/rpc.ts";
import type { Signer } from "./core/send.ts";
import type { ChainName } from "./core/types.ts";
import type { RailsEnv } from "./core/v32/rails.ts";
import type { GivenProof } from "./core/v32/reexec.ts";
import type { ExecutionInputsAnswer } from "./core/v32/ccip-api.ts";

// The PC's side of the keeper Worker (design-keeper-worker.md §3, §6): a v3.2 hand run takes the Worker's lease over
// HTTPS (OPS_KEEPER_URL, the keeper's own hostname, with OPS_KEEPER_CONTROL_TOKEN), waits up to 3 minutes while a cron
// run holds it, renews it every 2 minutes and before every send, and releases it on exit; `pnpm ops keeper …` stops,
// starts and reads the Worker. v3-launch's keeper keeps its file lock (runlock.ts) and never comes here.

/** The lease is no longer this hand run's (broken, or run out): the send is refused, and a `run` stops (a KeeperNotReady
 * stop: another keeper may be acting). */
export class LeaseLost extends KeeperNotReady {}

/** The lease couldn't be taken: another hand run holds it, the cron kept it 3 minutes, or the Worker can't be reached. */
export class NoLease extends Error {}

/** A route answered with an error (a wrong token, a bad request). */
export class ControlError extends Error {}

const HAND_LEASE_S = 600;
const RENEW_EVERY_MS = 120_000;
const WAIT_MS = 180_000;
const POLL_MS = 5_000;

export interface ControlOptions {
  url: string;
  token: string;
  log(line: string): void;
  fetch?: typeof fetch;
  /** Who this is, for the Worker's log ("founder@PC") */
  by?: string;
  /** This hand run's lease holder name ("hand:<host>:<pid>:<id>") */
  holder?: string;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  /** Runs `f` every 2 minutes until the returned stop is called (default: an unref'd interval) */
  every?(f: () => Promise<void>, ms: number): () => void;
}

export interface HandLease {
  holder: string;
  token: number;
  /** The Worker's deliveries switch, as the grant read it */
  deliveries: boolean;
  /** The Worker's send journal, through this lease (Task 50a's spend cap sums the Worker's sends and this run's) */
  journal: Journal;
  /** Before every send: refused (LeaseLost) once the lease is gone */
  renew(): Promise<void>;
  release(): Promise<void>;
}

const who = () => {
  try {
    return `${userInfo().username}@${hostname()}`;
  } catch {
    return hostname();
  }
};

export class KeeperControl {
  private o: Required<Pick<ControlOptions, "url" | "token" | "log">> & ControlOptions;

  constructor(o: ControlOptions) {
    this.o = { ...o, url: o.url.replace(/\/+$/, "") };
  }

  private async call<T>(path: string, body?: Record<string, unknown>): Promise<T & { deployment: string }> {
    const f = this.o.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.o.url}${path}`, {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${this.o.token}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify({ ...body, by: this.o.by ?? who() }) } : {}),
      });
    } catch (e) {
      throw new NoLease(`the keeper's control route can't be reached (${(e as Error).message.split("\n")[0]}): nothing sent. If Cloudflare is down, a one-shot command may go ahead with --without-lease "<reason>"`);
    }
    const out = fromJson<T & { deployment: string; error?: string }>(await res.text());
    if (!res.ok) throw new ControlError(`the keeper answered ${res.status}: ${out.error ?? "no reason given"}`);
    return out;
  }

  status(runs = 20) {
    return this.call<Record<string, unknown>>(`/v1/keeper/status?runs=${runs}`);
  }
  stop(reason: string) {
    return this.call<{ control: Record<string, unknown> }>("/v1/keeper/stop", { reason });
  }
  start() {
    return this.call<{ control: Record<string, unknown> }>("/v1/keeper/start", {});
  }
  deliveries(on: boolean) {
    return this.call<{ control: Record<string, unknown> }>("/v1/keeper/deliveries", { on });
  }
  retry(key: string) {
    return this.call<{ ok: boolean; why?: string }>("/v1/keeper/retry", { key });
  }
  breakLease() {
    return this.call<{ was: { holder: string | null; kind: string | null; token: number } }>("/v1/lease", { action: "break" });
  }

  /** The lease for this hand run, for deployment `expect`: granted, or after waiting up to 3 minutes while a cron run
   * holds it; refused at once while another hand run holds it. It renews itself every 2 minutes. */
  async acquire(expect: string): Promise<HandLease> {
    const holder = this.o.holder ?? `hand:${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    const now = this.o.now ?? Date.now;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const ask = () =>
      this.call<{ granted: boolean; token?: number; holder?: string; kind?: string; until?: number; why?: string; control?: { deliveries?: boolean } }>("/v1/lease", { action: "acquire", holder, ttlS: HAND_LEASE_S });
    const deadline = now() + WAIT_MS;
    let said = false;
    for (;;) {
      const r = await ask();
      if (r.deployment !== expect) throw new NoLease(`the keeper at OPS_KEEPER_URL runs ${r.deployment}, not ${expect}: set OPS_KEEPER_URL to this deployment's keeper; nothing sent`);
      if (r.granted) return this.held(holder, r.token as number, r.control?.deliveries !== false);
      const until = new Date(r.until ?? 0).toISOString();
      if (r.kind !== "cron") {
        throw new NoLease(`another hand run (${r.holder}) holds the keeper's lease until ${until}: never run two keepers at once; if none is running, free it with pnpm ops keeper lease --break; nothing sent`);
      }
      if (now() >= deadline) throw new NoLease(`the Worker's run still holds the keeper's lease after 3 minutes: try again, or stop the Worker first (pnpm ops keeper stop --reason "…"); nothing sent`);
      if (!said) {
        this.o.log(`The Worker's run (${r.holder}) holds the keeper's lease until ${until}: waiting for it, at most 3 minutes`);
        said = true;
      }
      await sleep(POLL_MS);
    }
  }

  private journal(holder: string, token: number): Journal {
    return leaseJournal((path, body) => this.call(path, body), holder, token, this.o.log);
  }

  private held(holder: string, token: number, deliveries: boolean): HandLease {
    let lost: string | undefined;
    let released = false;
    const renewNow = async () => {
      if (lost) throw new LeaseLost(lost);
      const r = await this.call<{ ok: boolean; why?: string }>("/v1/lease", { action: "renew", holder, token, ttlS: HAND_LEASE_S }).catch((e: Error) => ({ ok: false, why: e.message }));
      if (!r.ok) {
        lost = `LEASE LOST: ${r.why ?? "the Worker refused the renew"}; this hand run sends nothing more`;
        this.o.log(lost);
        throw new LeaseLost(lost);
      }
    };
    const every =
      this.o.every ??
      ((f: () => Promise<void>, ms: number) => {
        const t = setInterval(() => void f().catch(() => undefined), ms);
        t.unref();
        return () => clearInterval(t);
      });
    const stopTimer = every(() => (lost || released ? Promise.resolve() : renewNow()), RENEW_EVERY_MS);
    this.o.log(`The keeper's lease is this hand run's (token ${token}): the Worker's cron waits until it is released`);
    return {
      holder,
      token,
      deliveries,
      journal: this.journal(holder, token),
      renew: renewNow,
      release: async () => {
        if (released) return;
        released = true;
        stopTimer();
        if (lost) return;
        const r = await this.call<{ ok: boolean; why?: string }>("/v1/lease", { action: "release", holder, token }).catch((e: Error) => ({ ok: false, why: e.message }));
        if (!r.ok) this.o.log(`The lease wasn't released (${r.why}); it runs out by itself within 10 minutes`);
      },
    };
  }
}

/** The Worker's journal for this hand run (design §4: one journal, the write-ahead before every broadcast): each
 * write fenced by the lease in the Durable Object (a refused write-ahead or replacement is never broadcast: LeaseLost);
 * a status change of this run's own rows written through (refused: said, and the next cron run settles the row by its
 * hash). A row this hand run didn't write (the Worker's, an earlier hand run's) is left to the Worker (the T50b
 * re-review's N6): what this run's settling learns of it counts for this run's spend cap only and is never written, so
 * the Worker's next run settles it itself, adopting it into its watch: its late receipt reported, its bridge message
 * recorded. */
export function leaseJournal(call: <T>(path: string, body: Record<string, unknown>) => Promise<T>, holder: string, token: number, log: (line: string) => void): Journal {
  const mine: JournalRow[] = [];
  const holding = (hash: string) => mine.find((r) => r.hashes.some((h) => h.toLowerCase() === hash.toLowerCase()));
  /** What this run learned of rows it didn't write, by the hash it was said of */
  const learned = new Map<string, Partial<JournalRow>>();
  const seen = (x: JournalRow): JournalRow => holding(x.hashes[0]) ?? Object.assign({ ...x }, ...x.hashes.map((h) => learned.get(h.toLowerCase()) ?? {}));
  const write = (body: Record<string, unknown>) => call<{ ok: boolean; why?: string }>("/v1/journal", { ...body, holder, token });
  return {
    async writeAhead(row) {
      const r = await write({ action: "writeAhead", row: toJson(row) });
      if (!r.ok) throw new LeaseLost(`${row.request.label} not sent: ${r.why}`);
      mine.push({ ...row, hashes: [...row.hashes] });
    },
    async replaced(hash, next) {
      const r = await write({ action: "replaced", hash, next });
      if (!r.ok) throw new LeaseLost(`the replacement of ${hash} not sent: ${r.why}`);
      const row = holding(hash);
      if (row) {
        row.hashes.push(next.hash);
        row.raw = next.raw;
      }
    },
    async update(hash, patch) {
      const row = holding(hash);
      if (!row) {
        // not this run's row: kept here, never written (the Worker's to settle and watch)
        learned.set(hash.toLowerCase(), { ...learned.get(hash.toLowerCase()), ...patch });
        return;
      }
      Object.assign(row, patch);
      const r = await write({ action: "update", patch: toJson([{ hash, patch }]) }).catch((e: Error) => ({ ok: false, why: e.message }));
      if (!r.ok) log(`The Worker's journal didn't take transaction ${hash}'s change (${r.why}); the next cron run settles it by its hash`);
    },
    async pending() {
      // the Worker's unsettled rows as well as this run's (the spend cap counts every one; settlePending settles them),
      // oldest first, what this run knows over what is stored
      const r = await call<{ rows: string }>("/v1/journal", { action: "pending" });
      const stored = fromJson<JournalRow[]>(r.rows).map(seen);
      const extra = mine.filter((x) => !stored.some((s) => s.hashes[0].toLowerCase() === x.hashes[0].toLowerCase()));
      return [...stored, ...extra].filter((x) => x.status === "signed" || x.status === "sent");
    },
    async since(sinceMs) {
      const r = await call<{ rows: string }>("/v1/journal", { action: "since", sinceMs });
      return fromJson<JournalRow[]>(r.rows).map(seen);
    },
  };
}

/** The control client from ops/.env's OPS_KEEPER_URL and OPS_KEEPER_CONTROL_TOKEN (undefined: either is missing). */
export function controlFromEnv(env: Env, log: (line: string) => void, o: Partial<ControlOptions> = {}): KeeperControl | undefined {
  const url = env.OPS_KEEPER_URL?.trim();
  const token = env.OPS_KEEPER_CONTROL_TOKEN?.trim();
  if (!url || !token) return undefined;
  return new KeeperControl({ url, token, log, ...o });
}

export const NO_CONTROL = "Set OPS_KEEPER_URL (the keeper's own hostname) and OPS_KEEPER_CONTROL_TOKEN (pnpm keeper:new-token) in ops/.env; nothing done";

/** One-shot commands may go ahead without the lease, with a reason (the founder's 2026-11-07 decision): `argv` without
 * `--without-lease "<reason>"`, and the reason. */
export function takeWithoutLease(argv: string[]): { argv: string[]; withoutLease?: string } {
  const i = argv.indexOf("--without-lease");
  if (i < 0) return { argv };
  const reason = argv[i + 1];
  if (argv[0] === "run") throw new Error("--without-lease is for one-shot commands (close, stake, payouts, reexec, claim, adopt, add-hotkey, remove-hotkey, park), never run");
  if (!reason || reason.startsWith("--") || !reason.trim()) throw new Error('--without-lease needs a reason: --without-lease "Cloudflare is down"');
  return { argv: [...argv.slice(0, i), ...argv.slice(i + 2)], withoutLease: reason.trim() };
}

/** A hand run's flags, taken off its arguments before ops' parser sees them: --without-lease "<reason>" (one-shot
 * commands only) and --ignore-monitor-outage --until <time> (Task 50a: an outage, never a hold, at most 24 h; checked
 * against the clock when the rails are built). */
export function takeHandFlags(argv: string[]): { argv: string[]; withoutLease?: string; ignoreMonitorOutageUntil?: string } {
  const w = takeWithoutLease(argv);
  const rest = w.argv;
  const i = rest.indexOf("--ignore-monitor-outage");
  const u = rest.indexOf("--until");
  if (i < 0) {
    if (u >= 0) throw new Error("--until goes with --ignore-monitor-outage");
    return w;
  }
  const until = u >= 0 ? rest[u + 1] : undefined;
  if (!until || until.startsWith("--")) throw new Error("--ignore-monitor-outage needs --until <a UTC time at most 24 hours ahead, e.g. 2027-01-18T14:05Z>");
  const drop = new Set([i, u, u + 1]);
  return { ...w, argv: rest.filter((_x, k) => !drop.has(k)), ignoreMonitorOutageUntil: until };
}

/** What a hand run without the lease says, loudly, before anything. */
export const withoutLeaseWarning = (reason: string): string[] => [
  `WITHOUT THE LEASE: ${reason}.`,
  'WITHOUT THE LEASE: the Worker may act at the same time. Only the nonce keeps two transactions from both landing (one key, one nonce a chain). Stop the Worker first if you can: pnpm ops keeper stop --reason "…"',
  "WITHOUT THE LEASE: the 24 h spend cap counts only this command's sends, not the Worker's.",
];

export type KeeperCommand =
  | { sub: "status"; runs: number }
  | { sub: "stop"; reason: string }
  | { sub: "start" }
  | { sub: "lease-break" }
  | { sub: "deliveries"; on: boolean }
  | { sub: "retry"; key: string };

export const KEEPER_USAGE =
  'pnpm ops keeper status [--runs N] | stop --reason "…" | start | lease --break | deliveries on|off | retry <key>';

/** `pnpm ops keeper <…>`'s arguments. */
export function parseKeeperCommand(argv: string[]): KeeperCommand {
  const [sub, ...rest] = argv;
  const bad = (why: string) => new Error(`pnpm ops keeper ${why}: ${KEEPER_USAGE}`);
  switch (sub) {
    case "status": {
      if (!rest.length) return { sub, runs: 20 };
      if (rest[0] === "--runs" && /^[1-9]\d{0,2}$/.test(rest[1] ?? "") && rest.length === 2) return { sub, runs: Number(rest[1]) };
      throw bad("status takes --runs N (1 to 999)");
    }
    case "stop": {
      if (rest[0] === "--reason" && rest[1]?.trim() && rest.length === 2) return { sub, reason: rest[1].trim() };
      throw bad('stop needs --reason "…"');
    }
    case "start":
      if (rest.length) throw bad("start takes nothing more");
      return { sub };
    case "lease":
      if (rest.length === 1 && rest[0] === "--break") return { sub: "lease-break" };
      throw bad("lease takes --break");
    case "deliveries":
      if (rest.length === 1 && (rest[0] === "on" || rest[0] === "off")) return { sub, on: rest[0] === "on" };
      throw bad("deliveries takes on or off");
    case "retry":
      if (rest.length === 1 && rest[0]) return { sub, key: rest[0] };
      throw bad("retry needs the key keeper status shows under FINAL");
    default:
      throw bad(sub ? `has no ${sub}` : "needs a command");
  }
}

const iso = (ms: unknown) => new Date(Number(ms)).toISOString();

/** `pnpm ops keeper status` in lines. */
export function statusLines(s: Record<string, unknown>): string[] {
  const c = s.control as { stopped: boolean; reason: string | null; by: string | null; at: number | null; deliveries: boolean; deliveriesBy?: string | null };
  const l = s.lease as { holder: string | null; kind: string | null; token: number; until: number };
  const m = s.memory as { tick: number; nextAt: number; failing: number; final: Record<string, string>; watching: { chain: string; what: string; hashes: string[] }[]; savedAt: number } | null;
  const pending = (s.pending ?? []) as { chain: string; nonce: number; status: string; label: string; hashes: string[]; at: number }[];
  const k = s.key as Record<string, unknown> | undefined;
  const out = [
    `Keeper ${s.deployment}: ${c.stopped ? `STOPPED (${c.reason ?? "no reason given"})` : "running"}${c.by ? `, by ${c.by}` : ""}${c.at ? ` at ${iso(c.at)}` : ""}`,
    `Deliveries: ${c.deliveries ? "on" : `OFF${c.deliveriesBy ? `, by ${c.deliveriesBy}` : ""}`}`,
    l.holder && Number(s.now) < l.until ? `Lease: ${l.holder} (${l.kind}, token ${l.token}) until ${iso(l.until)}` : `Lease: free (token ${l.token})`,
  ];
  if (!m) out.push("Memory: none yet (no run has committed)");
  else if ((m as { unreadable?: boolean }).unreadable) out.push(`MEMORY UNREADABLE: the saved memory does not parse (saved ${iso(m.savedAt)}); runs fail until it is cleared`);
  else {
    out.push(`Memory: round ${m.tick}, next round due ${iso(m.nextAt)}, ${m.failing} failed rounds in a row; saved ${iso(m.savedAt)}`);
    for (const [key, why] of Object.entries(m.final ?? {})) out.push(`FINAL (not tried again until pnpm ops keeper retry <key>): ${key}: ${why}`);
    for (const u of m.watching ?? []) out.push(`Watching: ${u.chain} ${u.what} (${u.hashes.join(", ")})`);
  }
  for (const p of pending) out.push(`Unsettled: ${p.chain === "base" ? "Base" : "Bittensor"} nonce ${p.nonce} ${p.status}: ${p.label} (${p.hashes.join(", ")}), since ${iso(p.at)}`);
  if (k?.problem) out.push(`Key: ${String(k.problem)}`);
  else if (k) {
    const shown = (v: unknown) => (v && typeof v === "object" && "error" in v ? `can't read (${String((v as { error: string }).error)})` : String(v));
    const amount = (v: unknown, unit: string) => (typeof v === "bigint" ? `${formatEther(v)} ${unit}` : `${unit} ${shown(v)}`);
    // the chain decides who the keeper is (R4, D-M1): keeper() on both contracts; the deployment's is the plan's first
    const named = (v: unknown) => typeof v === "string" && v.toLowerCase() === String(k.address).toLowerCase();
    const both = named(k.vaultKeeper) && named(k.frontDoorKeeper);
    out.push(
      `Key: ${k.address}, keeper() on both contracts: ${both ? "yes" : "NO"}; keeper() on the vault: ${shown(k.vaultKeeper)}, on the front door: ${shown(k.frontDoorKeeper)}; the plan's first keeper: ${k.matchesDeployment ? "this key" : `${String(k.deploymentKeeper)} (another: after a rotation, as expected)`}; code on Base: ${shown(k.codeBase)}, on Bittensor: ${shown(k.codeBittensor)}; ${amount(k.ethWei, "ETH")}, ${amount(k.taoWei, "TAO")}`,
    );
  }
  const runs = (s.runs ?? []) as { at: number; line: string }[];
  if (runs.length) out.push("Last runs:", ...runs.map((r) => `  ${iso(r.at)}  ${r.line}`));
  return out;
}

/** `pnpm ops keeper …`: 0 done, 1 refused. */
export async function keeperCommand(argv: string[], env: Env, log: (line: string) => void, o: Partial<ControlOptions> = {}): Promise<number> {
  const cmd = parseKeeperCommand(argv);
  const ctl = controlFromEnv(env, log, o);
  if (!ctl) {
    log(NO_CONTROL);
    return 1;
  }
  switch (cmd.sub) {
    case "status": {
      for (const line of statusLines(await ctl.status(cmd.runs))) log(line);
      return 0;
    }
    case "stop": {
      const r = await ctl.stop(cmd.reason);
      log(`${r.deployment}: STOPPED (${cmd.reason}). The next cron run doesn't start; a send in flight finishes.`);
      return 0;
    }
    case "start": {
      const r = await ctl.start();
      log(`${r.deployment}: started. The next cron run, within a minute, goes ahead.`);
      return 0;
    }
    case "lease-break": {
      const r = await ctl.breakLease();
      log(
        r.was.holder
          ? `${r.deployment}: the lease is free (it was ${r.was.holder}'s, ${r.was.kind}, token ${r.was.token}). Its old holder can no longer renew or write.`
          : `${r.deployment}: the lease was free already (token ${r.was.token}).`,
      );
      return 0;
    }
    case "deliveries": {
      const r = await ctl.deliveries(cmd.on);
      log(`${r.deployment}: deliveries ${cmd.on ? "on" : "OFF: credits stay claimable"}.`);
      return 0;
    }
    case "retry": {
      const r = await ctl.retry(cmd.key);
      log(r.ok ? `${r.deployment}: ${cmd.key} is tried again from the next run.` : `${r.deployment}: not done: ${r.why}`);
      return r.ok ? 0 : 1;
    }
  }
}

/** Runs `body` under this hand run's lease (or, with `withoutLease`, after the loud warning): the lease released after,
 * whatever happens, and on Ctrl-C. `renew` is what every send calls first. */
export async function underLease<T>(
  o: { control: KeeperControl | undefined; deployment: string; withoutLease?: string; log(line: string): void; onInterrupt?: (release: () => Promise<void>) => () => void },
  body: (h: { renew: () => Promise<void>; lease?: HandLease }) => Promise<T>,
): Promise<T> {
  if (o.withoutLease !== undefined) {
    for (const line of withoutLeaseWarning(o.withoutLease)) o.log(line);
    return body({ renew: async () => undefined });
  }
  if (!o.control) throw new NoLease(`${NO_CONTROL.replace("; nothing done", "")}: a v3.2 hand run takes the Worker's lease (or, for a one-shot command, --without-lease "<reason>"); nothing sent`);
  const lease = await o.control.acquire(o.deployment);
  const off = o.onInterrupt?.(lease.release) ?? (() => undefined);
  try {
    return await body({ renew: lease.renew, lease });
  } finally {
    off();
    await lease.release();
  }
}


/** A v3.2 keeper command by hand, from what cli.ts builds (the deployment, the cast signer, the RPC, the rails): under the
 * Worker's lease and its journal, or for a one-shot command --without-lease "<reason>", said loudly; every send and
 * replacement renews the lease first. `run` loops on the core's rounds; a one-shot command first checks the live
 * readiness (T50 M6), then the rails, read again before each send (a payout batch's too: the review's Important 4). A hand
 * close or payout first warns when its lane has a CCIP FAILURE of Cascade's open (Task 52w: a round would hold it).
 * `reexec` (pnpm ops reexec, Task 52w) is a one-shot command too: without its --send it only checks, so it takes no lease;
 * so are Task 53's claim, adopt, add-hotkey, remove-hotkey and park (core/v32/hand.ts). The v3.2 core loads only here. */
export interface HandCommandV32 {
  cmd: HandCmdV32;
  /** reexec's: the message, where its committee results come from (--from-tx, --proof; Task 65: `executionInputs`, the
   * CCIP API's reader, when no attempt on chain carries them), its gas, whether it sends */
  reexec?: { id: Hex; fromTx?: Hex; proof?: GivenProof; gas?: number; send: boolean; emptyProof?: true; executionInputs?: (id: Hex) => Promise<ExecutionInputsAnswer> };
  /** Task 53's one-shots' (claim, adopt, add-hotkey, remove-hotkey, park): the hotkey or the park's key they name, and
   * whether they send (--send) */
  oneShot?: { hotkey?: Hex; key?: Hex; send: boolean };
  live: boolean;
  /** The deployment's name, which the Worker's lease must be for */
  name: string;
  deployment: DeploymentV32;
  signer: Signer;
  rpc: Rpc;
  logs?: Rpc;
  logsWindow?: Partial<Record<ChainName, bigint>>;
  chains: Record<ChainName, { chainId: number; legacy: boolean }>;
  maxGasPrice?: Partial<Record<ChainName, bigint>>;
  receiptTimeoutMs: number;
  pollMs?: number;
  sleep?(ms: number): Promise<void>;
  /** The rails, given the Worker's deliveries switch (true without the lease) */
  rails(deliveriesOn: boolean): RailsEnv;
  /** The control routes (OPS_KEEPER_URL): absent on the local forks, where no lease is taken */
  control?: KeeperControl;
  withoutLease?: string;
  policy: ClaimPolicy;
  log(line: string): void;
  onInterrupt?(release: () => Promise<void>): () => void;
  /** run's loop options (tests: maxTicks, the sleep, the clock) */
  runOptions?: Partial<RoundOptions>;
}

/** The v3.2 hand commands: run, the one-shots close, stake and payouts, which send as they are run; and the one-shots that
 * check first and send only with --send (pnpm ops reexec, Task 52w; claim, adopt, add-hotkey, remove-hotkey and park, Task
 * 53), which take no lease without it. */
export type HandCmdV32 = "run" | "close" | "stake" | "payouts" | "reexec" | HandCheckFirst;
export type HandCheckFirst = "claim" | "adopt" | "add-hotkey" | "remove-hotkey" | "park";
export const HAND_CHECK_FIRST: readonly HandCheckFirst[] = ["claim", "adopt", "add-hotkey", "remove-hotkey", "park"];

export async function handCommandV32(o: HandCommandV32): Promise<number> {
  const [reads, readiness, actions, rails, memory, journal, round, reexec, hand, oneShots] = await Promise.all([
    import("./core/v32/reads.ts"),
    import("./core/v32/readiness.ts"),
    import("./core/v32/actions.ts"),
    import("./core/v32/rails.ts"),
    import("./core/memory.ts"),
    import("./core/journal.ts"),
    import("./core/round.ts"),
    import("./core/v32/reexec.ts"),
    import("./core/v32/reexec-hand.ts"),
    import("./core/v32/hand.ts"),
  ]);
  const checkFirst = (HAND_CHECK_FIRST as readonly string[]).includes(o.cmd);
  const target = actions.targetV32(o.deployment);
  const body = async (h: { renew: () => Promise<void>; lease?: HandLease }): Promise<number> => {
    const m = memory.freshMemory();
    const deps = reads.depsV32({
      rpc: o.rpc,
      ...(o.logs ? { logs: o.logs } : {}),
      ...(o.logsWindow ? { logsWindow: o.logsWindow } : {}),
      deployment: o.deployment,
      signer: o.signer,
      send: {
        chains: o.chains,
        ...(o.maxGasPrice ? { maxGasPrice: o.maxGasPrice } : {}),
        receiptTimeoutMs: o.receiptTimeoutMs,
        ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
        ...(o.sleep ? { sleep: o.sleep } : {}),
      },
      // the Worker's journal through the lease, so the 24 h spend cap counts the Worker's sends too; without the lease,
      // this process's alone
      journal: h.lease?.journal ?? journal.memoryJournal(),
      memory: m,
      rails: o.rails(h.lease?.deliveries ?? true),
      log: o.log,
      ...(o.cmd === "reexec" && o.reexec?.executionInputs ? { executionInputs: o.reexec.executionInputs } : {}),
    });
    // every send, and every replacement, renews the lease first: a lease lost since stops it before anything is signed
    const sendCall = deps.sendCall;
    deps.sendCall = async (req) => {
      await h.renew();
      return sendCall(req);
    };
    const replace = deps.replace;
    if (replace) {
      // the core's options passed on (T51 re-review R1): a claim's, or a capped chain's, replacement is the cancel
      deps.replace = async (req, pending, opts) => {
        await h.renew();
        return replace(req, pending, opts);
      };
    }
    if (o.cmd === "run") {
      return round.runCommand(async () => ({ deps, rec: target, policy: o.policy }), o.log, { intervalMs: 60_000, live: o.live, policy: o.policy, ...o.runOptions });
    }
    // a one-shot command: the live readiness first, then the rails before each send, read fresh each time (a hold raised
    // while an earlier send waited for its receipt stops the later ones), as each round of run reads them
    await readiness.checkReadyV32(deps, m, Date.now());
    if (o.cmd === "reexec") {
      const x = o.reexec;
      if (!x) throw new Error("pnpm ops reexec needs a bridge message id; nothing sent");
      // Task 65: the canary's live empty-proof test (runbook 3.5)
      if (x.emptyProof) return hand.emptyProofByHand(deps, target, m, { id: x.id, send: x.send, live: o.live, now: Date.now() });
      return hand.reexecByHand(deps, target, m, { id: x.id, send: x.send, live: o.live, now: Date.now(), ...(x.fromTx ? { fromTx: x.fromTx } : {}), ...(x.proof ? { proof: x.proof } : {}), ...(x.gas !== undefined ? { gas: x.gas } : {}) });
    }
    // Task 53's one-shots: each checks and says what the round would, simulates, and sends only with --send
    if (checkFirst) {
      const x = { ...(o.oneShot?.hotkey ? { hotkey: o.oneShot.hotkey } : {}), ...(o.oneShot?.key ? { key: o.oneShot.key } : {}), send: o.oneShot?.send === true, live: o.live, now: Date.now() };
      if ((o.cmd === "add-hotkey" || o.cmd === "remove-hotkey") && !x.hotkey) throw new Error(`pnpm ops ${o.cmd} needs the hotkey; nothing sent`);
      if (o.cmd === "claim") return oneShots.claimByHand(deps, target, m, { ...x, policy: o.policy });
      if (o.cmd === "adopt") return oneShots.adoptByHand(deps, target, m, x);
      if (o.cmd === "add-hotkey") return oneShots.addHotkeyByHand(deps, target, m, x);
      if (o.cmd === "remove-hotkey") return oneShots.removeHotkeyByHand(deps, target, m, x);
      return oneShots.parkByHand(deps, target, m, x);
    }
    const refusal = async (send: { chain: ChainName; payoutKey?: Hex }) => rails.railsRefusal(await rails.railsV32(deps, m, Date.now()), send);
    /** A CCIP FAILURE of Cascade's open on this command's lane: said before it sends (the round would hold it; the operator
     * decides). A lane that can't be read is said too; the command goes on. */
    const warnLane = async (direction: "Base → Bittensor" | "Bittensor → Base", what: string) => {
      try {
        for (const f of await reexec.laneFailures(deps, direction)) o.log(reexec.laneWarning(deps, f, what));
      } catch (e) {
        o.log(`WARNING: this command's lane (${direction}) could not be checked for a CCIP FAILURE of Cascade's (${(e as Error).message.split("\n")[0]}); it goes on`);
      }
    };
    const refused = (why: string) => {
      o.log(`Not sent: ${why}`);
      return 1;
    };
    const done = (d: { hash: string; costWei: bigint; messageId?: string }, chain: ChainName) => {
      o.log(`Done (transaction ${d.hash}, cost ${formatEther(d.costWei)} ${unit(chain)})`);
      if (d.messageId) o.log(`Bridge message ${d.messageId} sent. Follow it with: pnpm ops track ${d.messageId}${o.live ? " --live" : ""}`);
    };
    if (o.cmd === "close" || o.cmd === "stake") {
      const chain: ChainName = o.cmd === "close" ? "base" : "bittensor";
      const why = await refusal({ chain });
      if (why) return refused(why);
      if (o.cmd === "close") await warnLane("Base → Bittensor", "close");
      // during ForeverMoney's migration notice a hand close is the notice's one close (R4: hand.ts closeByHand)
      done(await (o.cmd === "close" ? oneShots.closeByHand(deps, target) : actions.stakeV32(deps, target)), chain);
      return 0;
    }
    const s = await deps.readState();
    const due = s.vault.batches.filter((b) => b.cursor < b.count && s.now >= b.queuedAt + s.vault.payoutDelay);
    if (!due.length) o.log("No payout batch is due.");
    else await warnLane("Bittensor → Base", "payout");
    let code = 0;
    for (const b of due) {
      const why = await refusal({ chain: "bittensor", payoutKey: b.key });
      if (why) {
        code = refused(why);
        continue;
      }
      done(await actions.payoutsV32(deps, target, b.key), "bittensor");
    }
    return code;
  };

  // a re-run by hand, or one of Task 53's one-shots, without --send signs and sends nothing: it takes no lease, so the
  // Worker's rounds go on meanwhile
  if ((o.cmd === "reexec" && o.reexec?.send !== true) || (checkFirst && o.oneShot?.send !== true)) {
    o.log("Checking only (no --send): nothing is signed or sent, so the Worker's lease is not taken");
    return body({ renew: async () => undefined });
  }
  // the local forks have no Worker: no lease unless OPS_KEEPER_URL names one (a rehearsal's wrangler dev, Task 61)
  if (!o.live && !o.control && o.withoutLease === undefined) {
    o.log("Rehearsal: no OPS_KEEPER_URL, so no lease is taken (the forks have no Worker)");
    return body({ renew: async () => undefined });
  }
  return underLease({ control: o.control, deployment: o.name, ...(o.withoutLease !== undefined ? { withoutLease: o.withoutLease } : {}), log: o.log, ...(o.onInterrupt ? { onInterrupt: o.onInterrupt } : {}) }, body);
}

/** Why `rpc` can't serve the vault's history (the review's Minor 7: the hand run probes as config-from-record does): the
 * vault's creation block has no logs of the vault there (a pruned node). Undefined when it can. */
export async function historyProblem(rpc: Rpc, vault: Address, block: number): Promise<string | undefined> {
  const logs = (await rpc.request("bittensor", "eth_getLogs", [{ address: vault, fromBlock: numberToHex(block), toBlock: numberToHex(block) }])) as unknown[];
  if (Array.isArray(logs) && logs.length) return undefined;
  return `this ${chainLabel("bittensor")} RPC has no logs at block ${block}, where the vault was created: it doesn't keep history (a pruned node); use an archive node (archive.chain.opentensor.ai); nothing sent`;
}

export { toJson };
