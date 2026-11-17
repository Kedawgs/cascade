import { type Address, type Hex, keccak256 } from "viem";
import { VAULT_LENS, DOOR } from "../../ops/src/keeper/core/abi.ts";
import { scrubSecrets } from "../../ops/src/keeper/core/failures.ts";
import type { JournalRow, JournalStatus } from "../../ops/src/keeper/core/journal.ts";
import { fromJson, toJson } from "../../ops/src/keeper/core/memory.ts";
import { balanceOf, codeAt, read } from "../../ops/src/keeper/core/rpc.ts";
import { CHAIN_LEGACY, coordinatorOf, HAND_LEASE_MS, type KeeperEnv, readConfig } from "./config.ts";
import type { JournalPatch, KeeperCoordinator } from "./coordinator.ts";
import { PATCH_FIELDS } from "./journal.ts";
import { replacementProblem, rowProblem, type StoredRow, unsignedOf } from "./proof.ts";
import { statusRpc } from "./rpc.ts";
import { KeyProblem, keeperKey } from "./signer.ts";

// The control routes (design-keeper-worker.md §3, §4, §6): the PC's lease (pnpm ops run and the one-shot commands), the
// kill switch, the deliveries switch, a final refusal tried again, and the status. Every route needs the control token
// (Authorization: Bearer); the Worker keeps only its SHA-256 (CONTROL_TOKEN_SHA256) and compares in constant time. Every
// route is rate limited per client before the token is checked. workers.dev is off: the keeper's own hostname only.

const json = (status: number, body: unknown) => new Response(toJson(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const refuse = (status: number, error: string) => json(status, { error });

const hexBytes = (hex: string): Uint8Array | undefined => {
  if (!/^[0-9a-f]{64}$/.test(hex)) return undefined;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
};

/** Whether the request carries the control token: its SHA-256 equal to CONTROL_TOKEN_SHA256, compared in constant
 * time. Undefined when the Worker has no token set. */
export async function authorized(req: Request, env: Pick<KeeperEnv, "CONTROL_TOKEN_SHA256">): Promise<boolean | undefined> {
  const want = hexBytes((env.CONTROL_TOKEN_SHA256 ?? "").trim().toLowerCase());
  if (!want) return undefined;
  const m = /^Bearer (\S{16,512})$/.exec(req.headers.get("authorization") ?? "");
  const got = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(m?.[1] ?? "")));
  const equal = (crypto.subtle as unknown as { timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean }).timingSafeEqual(got, want);
  return Boolean(m) && equal;
}

const text = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined);

export async function control(req: Request, env: KeeperEnv): Promise<Response> {
  const url = new URL(req.url);
  const routes = ["/v1/lease", "/v1/journal", "/v1/keeper/status", "/v1/keeper/stop", "/v1/keeper/start", "/v1/keeper/deliveries", "/v1/keeper/retry"];
  if (!routes.includes(url.pathname)) return refuse(404, "not found");
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  if (env.KEEPER_LIMITER && !(await env.KEEPER_LIMITER.limit({ key: `${url.pathname}:${ip}` })).success) return refuse(429, "too many requests: try again in a minute");
  const allowed = await authorized(req, env);
  if (allowed === undefined) return refuse(503, "the keeper's control token isn't set (CONTROL_TOKEN_SHA256): pnpm keeper:new-token");
  if (!allowed) return refuse(401, "not the keeper's control token");
  const wantMethod = url.pathname === "/v1/keeper/status" ? "GET" : "POST";
  if (req.method !== wantMethod) return refuse(405, `use ${wantMethod}`);

  const { config, problems } = readConfig(env);
  if (!config) return refuse(503, `the keeper is not configured: ${problems.join("; ")}`);
  const stub = coordinatorOf(env, config.deployment.name) as unknown as DurableObjectStub<KeeperCoordinator>;
  const body = wantMethod === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
  const by = text(body.by, 120) ?? "someone with the control token";
  /** Every answer names the deployment, so the PC can check it reached the Worker it meant */
  const ok = (b: object) => json(200, { ...b, deployment: config.deployment.name });

  switch (url.pathname) {
    case "/v1/lease": {
      const action = body.action;
      if (action === "break") return ok(await stub.breakLease({ by }));
      const holder = text(body.holder, 120);
      // the cron's lease never comes over HTTP: every holder here is a hand run
      if (!holder?.startsWith("hand:")) return refuse(400, 'a lease holder here is a hand run ("hand:…")');
      const ttlMs = Math.min(Number(body.ttlS ?? HAND_LEASE_MS / 1000) * 1000, 2 * HAND_LEASE_MS) || HAND_LEASE_MS;
      if (action === "acquire") return ok(await stub.acquire({ holder, kind: "hand", ttlMs }));
      const token = Number(body.token);
      if (!Number.isInteger(token)) return refuse(400, "renew and release need the lease's token");
      if (action === "renew") return ok(await stub.renew({ holder, token, ttlMs }));
      if (action === "release") return ok(await stub.release({ holder, token }));
      return refuse(400, "action is acquire, renew, release or break");
    }
    case "/v1/journal": {
      // a hand run's journal (the Worker's own): every write fenced by its lease in the object, as the cron's are. The rows
      // it reads carry no signed transaction (the re-review's N5): each raw without its signature, which the spend cap
      // reads all the same, and which no node would take
      if (body.action === "since") return ok({ rows: served(await stub.since({ sinceMs: Number(body.sinceMs) || 0 })) });
      if (body.action === "pending") return ok({ rows: served(await stub.pending()) });
      const holder = text(body.holder, 120);
      const token = Number(body.token);
      if (!holder?.startsWith("hand:") || !Number.isInteger(token)) return refuse(400, "a hand run's journal write needs its lease's holder and token");
      const next = body.next as { hash?: unknown; raw?: unknown } | undefined;
      // a row, or a replacement, only with its proof: its signed transaction is its request, signed by the keeper's key
      // (proof.ts; the review's Important 1), so a leaked token can never steer what the keeper signs
      // the Worker's own key (R4, D-M1: a hand run signs with it, the founder's 2026-11-07 decision), never DEPLOYMENT's
      // keeper, which stays the plan's first after a rotation
      let me: Address;
      try {
        me = keeperKey(env.KEEPER_PRIVATE_KEY).address;
      } catch (e) {
        if (e instanceof KeyProblem) return refuse(503, `the Worker's key can't be read (${e.message}): no hand run's row is taken`);
        throw e;
      }
      const proof = { keeper: me, chainIds: config.deployment.chainIds, legacy: CHAIN_LEGACY };
      if (body.action === "writeAhead" && typeof body.row === "string") {
        let row: StoredRow;
        try {
          row = fromJson<StoredRow>(body.row);
        } catch {
          return refuse(400, "the row is not JSON");
        }
        if (row?.status !== "signed" || row.hashes?.length !== 1 || row.requestRaw !== undefined) return refuse(400, "a hand run writes a row ahead as signed, with its one hash");
        // a cancel is taken only as a row whose request is that cancel (the re-review's N1, as re-ruled): proof.ts
        const bad = await rowProblem(row, proof);
        if (bad) return refuse(400, `the row is not proven by its own signed transaction (${bad}); nothing written`);
        return ok(await stub.writeAhead({ holder, token, row: body.row }));
      }
      if (body.action === "replaced" && typeof body.hash === "string" && typeof next?.hash === "string" && typeof next.raw === "string") {
        const found = await stub.rowOf({ hash: body.hash });
        if (!found) return refuse(400, `the journal has no send with transaction ${body.hash}`);
        const row = fromJson<StoredRow>(found);
        // only this run's own row, still signed or sent (the review's W1): a cancel is never attached to a row marked never
        // sent, nor to another run's, which the next cron could then re-sign in the cancel's place
        const mine = ownRowProblem(row, holder, body.hash, true);
        if (mine) return refuse(400, `the replacement is refused: ${mine}, and ${mine.includes("written by") ? "a hand run replaces only its own" : "only a row still signed or sent is replaced"}; nothing written`);
        const hashOk = /^0x[0-9a-fA-F]{2,}$/.test(next.raw) && keccak256(next.raw as Hex).toLowerCase() === next.hash.toLowerCase();
        // the row's request again, or the keeper's cancel at its nonce; the row's request stays the one its first
        // transaction proved
        const bad = hashOk ? await replacementProblem(next.raw, row, proof) : "its hash is not its signed transaction's";
        if (bad) return refuse(400, `the replacement is not proven by its own signed transaction (${bad}); nothing written`);
        return ok(await stub.replaced({ holder, token, hash: body.hash, next: { hash: next.hash, raw: next.raw } }));
      }
      if (body.action === "update" && typeof body.patch === "string") {
        const bad = patchProblem(body.patch);
        if (bad) return refuse(400, `the journal update is refused (${bad}); nothing written`);
        // each patch on this run's own row only, a status change only on a row still signed or sent (the review's W1): a row
        // marked never sent never becomes sent here (the Worker's settle alone learns that)
        for (const p of fromJson<JournalPatch[]>(body.patch)) {
          const found = await stub.rowOf({ hash: p.hash });
          if (!found) continue;
          const row = fromJson<StoredRow>(found);
          const mine = ownRowProblem(row, holder, p.hash, p.patch.status !== undefined);
          if (mine) return refuse(400, `the journal update is refused (${mine}: ${mine.includes("written by") ? "a hand run changes only its own rows" : "a hand run changes the status only of a row still signed or sent"}); nothing written`);
        }
        return ok(await stub.update({ holder, token, patch: body.patch }));
      }
      return refuse(400, "action is writeAhead, replaced, update, since or pending");
    }
    case "/v1/keeper/stop": {
      const reason = text(body.reason, 500);
      if (!reason) return refuse(400, 'a stop needs a reason: pnpm ops keeper stop --reason "…"');
      return ok({ control: await stub.stop({ reason, by }) });
    }
    case "/v1/keeper/start":
      return ok({ control: await stub.start({ by }) });
    case "/v1/keeper/deliveries":
      if (typeof body.on !== "boolean") return refuse(400, "deliveries takes on: true or false");
      return ok({ control: await stub.deliveries({ on: body.on, by }) });
    case "/v1/keeper/retry": {
      const key = text(body.key, 200);
      if (!key) return refuse(400, "retry needs the action's key, as keeper status shows it under final");
      return ok(await stub.retry({ key, by }));
    }
    default: {
      const stored = fromJson<Record<string, unknown>>(await stub.status({ runs: Number(url.searchParams.get("runs") ?? 40) }));
      return ok({ ...stored, key: await keyStatus(env, config) });
    }
  }
}

/** Why hand run `holder` may not change `row` (the one holding `hash`) over the route, or undefined (the review's W1): it
 * wrote it, and, for a replacement or a status change (`status`), the row is still signed or sent. */
function ownRowProblem(row: StoredRow, holder: string, hash: string, status: boolean): string | undefined {
  if (row.writer !== holder) return `the row of ${hash} was written by ${row.writer ?? "the Worker or an earlier keeper"}`;
  if (status && row.status !== "signed" && row.status !== "sent") return `the row of ${hash} is ${row.status}`;
  return undefined;
}

/** The rows a route serves (JSON, as the object gives them): each raw without its signature, and no kept first raw. */
function served(rowsJson: string): string {
  return toJson(fromJson<StoredRow[]>(rowsJson).map(({ requestRaw: _kept, ...r }) => ({ ...r, raw: unsignedOf(r.raw) })));
}

const STATUSES: readonly JournalStatus[] = ["signed", "sent", "landed", "reverted", "never-sent", "cancelled", "dropped"];
const HASH = /^0x[0-9a-fA-F]{64}$/;
const whole = (v: unknown) => typeof v === "bigint" && v >= 0n;

/** Why a hand run's journal update (JSON of JournalPatch[]) is refused (the re-review's N2), or undefined: each patch
 * names a transaction by its hash and changes only a row's status, receipt, bridge message, what came back, or the
 * settling's mark, each of its own type. */
export function patchProblem(text: string): string | undefined {
  let patches: unknown;
  try {
    patches = fromJson<unknown>(text);
  } catch {
    return "it is not JSON";
  }
  if (!Array.isArray(patches) || !patches.length) return "it holds no patch";
  for (const x of patches as { hash?: unknown; patch?: Record<string, unknown> }[]) {
    if (!x || typeof x.hash !== "string" || !HASH.test(x.hash)) return "a patch names no transaction hash";
    const p = x.patch;
    if (!p || typeof p !== "object" || Array.isArray(p)) return `the patch of ${x.hash} is not an object`;
    const extra = Object.keys(p).filter((k) => !(PATCH_FIELDS as readonly string[]).includes(k));
    if (extra.length) return `a patch may change only ${PATCH_FIELDS.join(", ")}, not ${extra.join(", ")}`;
    if (p.status !== undefined && !STATUSES.includes(p.status as JournalStatus)) return `${String(p.status)} is not a journal status`;
    const r = p.receipt as Record<string, unknown> | undefined;
    if (r !== undefined && (!r || typeof r.hash !== "string" || !HASH.test(r.hash) || !Number.isSafeInteger(r.block) || !whole(r.gasUsed) || !whole(r.costWei))) {
      return "its receipt is not {hash, block, gasUsed, costWei}";
    }
    if (p.messageId !== undefined && (typeof p.messageId !== "string" || !HASH.test(p.messageId))) return "its bridge message is not a 32-byte id";
    if (p.returned !== undefined && !whole(p.returned)) return "what came back is not an amount";
    if (p.passedAt !== undefined && !(Number.isSafeInteger(p.passedAt) && (p.passedAt as number) >= 0)) return "its mark is not a block number";
  }
  return undefined;
}

/** What the founder checks before `start` (design §7, Task 67): the key's address, that keeper() names it on the vault
 * (through its lens) and on the front door, that it has no code on either chain, and its balances. Never the key. */
async function keyStatus(env: KeeperEnv, cfg: NonNullable<ReturnType<typeof readConfig>["config"]>): Promise<Record<string, unknown>> {
  let address: Address;
  let redact = (t: string) => t;
  try {
    const k = keeperKey(env.KEEPER_PRIVATE_KEY);
    address = k.address;
    redact = k.redact;
  } catch (e) {
    if (e instanceof KeyProblem) return { problem: e.message };
    throw e;
  }
  const d = cfg.deployment;
  const rpc = statusRpc(cfg);
  // the deployment's keeper is the plan's first (R4, D-M1): after a rotation it differs, and only keeper() on both decides
  const out: Record<string, unknown> = { address, deploymentKeeper: d.keeper, matchesDeployment: address.toLowerCase() === d.keeper.toLowerCase() };
  const tryRead = async (name: string, f: () => Promise<unknown>) => {
    try {
      out[name] = await f();
    } catch (e) {
      out[name] = { error: redact(scrubSecrets((e as Error).message.split("\n")[0])) };
    }
  };
  await tryRead("vaultKeeper", () => read(rpc, "bittensor", { address: d.addresses.vaultLens, abi: VAULT_LENS, functionName: "keeper" }));
  await tryRead("frontDoorKeeper", () => read(rpc, "base", { address: d.addresses.frontDoor, abi: DOOR, functionName: "keeper" }));
  await tryRead("codeBase", async () => ((await codeAt(rpc, "base", address)) as Hex) === "0x" ? "none" : "HAS CODE");
  await tryRead("codeBittensor", async () => ((await codeAt(rpc, "bittensor", address)) as Hex) === "0x" ? "none" : "HAS CODE");
  await tryRead("ethWei", () => balanceOf(rpc, "base", address));
  await tryRead("taoWei", () => balanceOf(rpc, "bittensor", address));
  return out;
}
