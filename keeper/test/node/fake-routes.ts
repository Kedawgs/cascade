import type { JournalRow } from "../../../ops/src/keeper/core/journal.ts";
import { fromJson, toJson } from "../../../ops/src/keeper/core/memory.ts";
import { KeeperControl } from "../../../ops/src/keeper/lease-client.ts";

// A fake of the keeper Worker's control routes, for the PC's side (the lease client, the v3.2 hand commands): one lease
// and its token, the kill switch, the journal. test/node/bundle.test.ts runs the real ones.

export const URL_ = "https://keeper.example.test";
export const TOKEN = "token-0123456789abcdef";

/** The control routes, faked: one lease, its token, the kill switch */
export function routes(o: { deployment?: string } = {}) {
  const journal: JournalRow[] = [];
  const st = { journal, deliveries: true, holder: null as string | null, kind: null as string | null, token: 0, until: 0, stopped: true, reason: "a new keeper starts stopped" as string | null, now: 1_000_000, calls: [] as { path: string; body: Record<string, unknown> }[], down: false };
  const deployment = o.deployment ?? "v3.2-launch";
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    if (st.down) throw new TypeError("fetch failed");
    const path = new URL(String(input)).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    st.calls.push({ path, body });
    if ((init?.headers as Record<string, string>)?.authorization !== `Bearer ${TOKEN}`) return new Response(toJson({ error: "not the keeper's control token" }), { status: 401 });
    const reply = (b: object) => new Response(toJson({ ...b, deployment }), { status: 200 });
    if (path === "/v1/lease") {
      const free = st.holder === null || st.now >= st.until;
      if (body.action === "acquire") {
        if (!free && st.holder !== body.holder) return reply({ granted: false, why: "held", holder: st.holder, kind: st.kind, until: st.until });
        if (free) st.token++;
        st.holder = body.holder as string;
        st.kind = "hand";
        st.until = st.now + 600_000;
        return reply({ granted: true, token: st.token, until: st.until, control: { stopped: st.stopped, deliveries: st.deliveries } });
      }
      if (body.action === "renew") return reply(st.holder === body.holder && st.token === body.token && st.now < st.until ? { ok: true, until: (st.until = st.now + 600_000) } : { ok: false, why: "the lease is no longer this run's" });
      if (body.action === "release") {
        const ok = st.holder === body.holder && st.token === body.token;
        if (ok) st.holder = null;
        return reply(ok ? { ok: true } : { ok: false, why: "not yours" });
      }
      if (body.action === "break") {
        const was = { holder: st.holder, kind: st.kind, token: st.token };
        st.holder = null;
        st.token++;
        return reply({ was });
      }
    }
    if (path === "/v1/journal") {
      const fenced = st.holder === body.holder && st.token === body.token && st.now < st.until;
      if (body.action === "since") return reply({ rows: toJson(journal.filter((r) => r.at >= (body.sinceMs as number))) });
      if (body.action === "pending") return reply({ rows: toJson(journal.filter((r) => r.status === "signed" || r.status === "sent")) });
      if (!fenced) return reply({ ok: false, why: "the lease is no longer this run's" });
      if (body.action === "writeAhead") journal.push(fromJson<JournalRow>(body.row as string));
      if (body.action === "update") {
        for (const x of fromJson<{ hash: string; patch: Partial<JournalRow> }[]>(body.patch as string)) Object.assign(journal.find((r) => r.hashes.includes(x.hash as never)) ?? {}, x.patch);
      }
      if (body.action === "replaced") {
        const r = journal.find((x) => x.hashes.includes(body.hash as never));
        if (r) r.hashes.push((body.next as { hash: never }).hash);
      }
      return reply({ ok: true });
    }
    if (path === "/v1/keeper/stop") {
      st.stopped = true;
      st.reason = body.reason as string;
      return reply({ control: { stopped: true, reason: st.reason, by: body.by } });
    }
    if (path === "/v1/keeper/start") {
      st.stopped = false;
      return reply({ control: { stopped: false, by: body.by } });
    }
    if (path === "/v1/keeper/status")
      return reply({
        now: st.now,
        control: { stopped: st.stopped, reason: st.reason, by: "founder", at: st.now - 60_000, deliveries: true },
        lease: { holder: st.holder, kind: st.kind, token: st.token, until: st.until },
        memory: { v: 1, tick: 12, nextAt: st.now + 30_000, failing: 0, unexpected: 0, final: { "payouts:0xab": "REPORT: payout batch 0xab…: NotScheduled" }, watching: [], savedAt: st.now - 20_000 },
        pending: [{ chain: "base", nonce: 4, status: "sent", label: "close batch 9 and send it to Bittensor", hashes: ["0xaa"], at: st.now - 40_000 }],
        runs: [{ at: st.now - 60_000, line: "Round 12 (lease token 7): Done: closing the batch" }],
        key: { address: "0x00000000000000000000000000000000000000A1", deploymentKeeper: "0x00000000000000000000000000000000000000A1", matchesDeployment: true, vaultKeeper: "0x00000000000000000000000000000000000000A1", frontDoorKeeper: "0x00000000000000000000000000000000000000A1", codeBase: "none", codeBittensor: "none", ethWei: 5n * 10n ** 15n, taoWei: 10n ** 17n },
      });
    return new Response(toJson({ error: "not found" }), { status: 404 });
  }) as typeof fetch;
  return { st, f };
}

export const make = (r: ReturnType<typeof routes>, lines: string[], over: Partial<ConstructorParameters<typeof KeeperControl>[0]> = {}) =>
  new KeeperControl({ url: URL_, token: TOKEN, fetch: r.f, log: (l) => lines.push(l), holder: "hand:pc:1", by: "founder@pc", sleep: async (ms) => void (r.st.now += ms), now: () => r.st.now, ...over });

