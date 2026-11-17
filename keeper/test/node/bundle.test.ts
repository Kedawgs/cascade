import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeDeployment } from "../../../ops/src/keeper/core/deployment.ts";
import { fromJson } from "../../../ops/src/keeper/core/memory.ts";
import { KeeperControl, keeperCommand } from "../../../ops/src/keeper/lease-client.ts";
import { deploymentFor, healthyStatus } from "../../../ops/test/keeper-v32-world.ts";
import { fakeChains } from "../fake-chains.ts";

// The Worker as it is deployed (design-keeper-worker.md §1, §4, §8): `wrangler deploy --dry-run` bundles it with one
// copy of viem and of noble's hashes; then that very bundle runs on Miniflare with its Durable Object persisted to disk,
// is shut down and started again on the same storage (a redeploy), and resumes its memory; and the PC's lease client
// takes the lease from it, which the cron then respects.

const KEEPER = join(import.meta.dirname, "..", "..");
const require_ = createRequire(import.meta.url);
const out = mkdtempSync(join(tmpdir(), "keeper-bundle-"));
const persist = mkdtempSync(join(tmpdir(), "keeper-persist-"));
let meta: { inputs: Record<string, unknown> };
let bundled: { status: number | null; stdout: string; stderr: string };

beforeAll(() => {
  const wrangler = join(realpathSync(require_.resolve("wrangler/package.json")), "..", "bin", "wrangler.js");
  bundled = spawnSync(process.execPath, [wrangler, "deploy", "--dry-run", "--outdir", out, "--env", "test", "--metafile", join(out, "meta.json")], {
    cwd: KEEPER,
    // no telemetry, no update check: the bundle is made offline
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_HIDE_BANNER: "true" },
    encoding: "utf8",
    timeout: 120_000,
  });
  if (bundled.status === 0) meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
}, 150_000);

afterAll(() => {
  rmSync(out, { recursive: true, force: true });
  rmSync(persist, { recursive: true, force: true });
});

/** The package directories (under node_modules/.pnpm) the bundle's inputs come from, for packages matching `name` */
const roots = (name: RegExp) => [...new Set(Object.keys(meta.inputs).filter((p) => name.test(p)).map((p) => p.replace(/(\.pnpm\/[^/]+\/node_modules\/(@[^/]+\/)?[^/]+)\/.*/, "$1")))];

describe("wrangler deploy --dry-run", () => {
  it("bundles the Worker", () => {
    expect(bundled.status, bundled.stderr + bundled.stdout).toBe(0);
    expect(bundled.stdout).toContain("--dry-run: exiting now.");
  });

  it("with one copy of viem and of noble's hashes and curves, the core's imports included, nothing from ops' node_modules", () => {
    expect(roots(/\/viem\//)).toHaveLength(1);
    expect(roots(/@noble\/hashes/)).toHaveLength(1);
    expect(roots(/@noble\/curves/)).toHaveLength(1);
    expect(Object.keys(meta.inputs).filter((p) => p.includes("ops/node_modules"))).toEqual([]);
    expect(Object.keys(meta.inputs).filter((p) => /viem\/_cjs/.test(p))).toEqual([]);
    for (const f of ["ops/src/keeper/core/round.ts", "ops/src/keeper/core/v32/reads.ts", "ops/src/keeper/core/v32/readiness.ts", "ops/src/keeper/core/v32/rails.ts"]) {
      expect(Object.keys(meta.inputs).some((p) => p.endsWith(f)), f).toBe(true);
    }
  });

  it("its aliases are the ES module entries the packages' own exports maps name", () => {
    const config = readFileSync(join(KEEPER, "wrangler.jsonc"), "utf8");
    const alias = (name: string) => new RegExp(`"${name.replace(/[/]/g, "\\/")}": "\\./node_modules/([^"]+)"`).exec(config)?.[1];
    const viem = JSON.parse(readFileSync(join(KEEPER, "node_modules", "viem", "package.json"), "utf8")) as { exports: Record<string, { import: string }> };
    const noble = JSON.parse(readFileSync(join(KEEPER, "node_modules", "@noble", "hashes", "package.json"), "utf8")) as { exports: Record<string, { import: string }> };
    expect(alias("viem")).toBe(`viem/${viem.exports["."].import.slice(2)}`);
    expect(alias("viem/accounts")).toBe(`viem/${viem.exports["./accounts"].import.slice(2)}`);
    expect(alias("@noble/hashes/blake2")).toBe(`@noble/hashes/${noble.exports["./blake2"].import.slice(2)}`);
    // the same versions as ops' own, which the core is tested with
    const ops = JSON.parse(readFileSync(join(KEEPER, "..", "ops", "package.json"), "utf8")) as { dependencies: Record<string, string> };
    const mine = JSON.parse(readFileSync(join(KEEPER, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(mine.dependencies).toEqual({ "@noble/hashes": ops.dependencies["@noble/hashes"], viem: ops.dependencies.viem });
  });
});

describe("the bundle on Miniflare, persisted", () => {
  it("resumes its memory after a restart on the same storage (a redeploy); the PC's lease holds the cron off", async () => {
    expect(bundled.status).toBe(0);
    // Miniflare is wrangler's own (the version wrangler bundles and runs with)
    const { Miniflare, convertV4MiniflareOptions } = (await import(pathToFileURL(createRequire(realpathSync(require_.resolve("wrangler/package.json"))).resolve("miniflare")).href)) as {
      convertV4MiniflareOptions(o: unknown): unknown;
      Miniflare: new (o: unknown) => { dispatchFetch(url: string, init?: RequestInit): Promise<Response>; getWorker(): Promise<{ scheduled(o: { cron: string }): Promise<unknown> }>; dispose(): Promise<void> };
    };
    const key = generatePrivateKey();
    const me = privateKeyToAccount(key).address;
    const token = "bundle-test-token-0123456789";
    const chains = fakeChains(me, (w) => {
      w.door.start = BigInt(w.time.base - 90_000);
      w.fate = (c) => {
        if (c.fn === "closeBatch") {
          w.door.deposits = [];
          w.door.totalDeposits = 0n;
          w.door.id = 8n;
          w.door.start = BigInt(w.time.base);
        }
        return "mine";
      };
    });
    const start = () =>
      new Miniflare(
        convertV4MiniflareOptions({
        resourcePersistencePath: persist,
        telemetry: { enabled: false },
        name: "cascade-keeper",
        modules: true,
        scriptPath: join(out, "index.js"),
        compatibilityDate: "2026-10-14",
        durableObjects: { COORDINATOR: { className: "KeeperCoordinator", useSQLite: true } },
        bindings: {
          DEPLOYMENT: encodeDeployment(deploymentFor({ keeper: me })),
          KEEPER_PRIVATE_KEY: key,
          CONTROL_TOKEN_SHA256: createHash("sha256").update(token).digest("hex"),
          BASE_RPC_URL: "https://base.rpc.test/v2/base-key-0123456789",
          BASE_LOGS_RPC_URL: "https://base-logs.rpc.test/rpc?apikey=logs-key-0123456789",
          BITTENSOR_RPC_URL: "https://bittensor.rpc.test/v1/bit-key-0123456789",
          RPC_SPACING_MS: '{"base":0,"bittensor":0}',
        },
        // every RPC request the bundle makes, answered by the fake chains; the monitor's status through the binding
        outboundService: async (req: Request) => chains.fetch(req.url, { method: "POST", body: await req.text() }),
        serviceBindings: {
          MONITOR: async (req: Request) => new Response(JSON.stringify(new URL(req.url).pathname.endsWith("/v1/price") ? chains.w.monitor.price : healthyStatus(chains.w)), { headers: { "content-type": "application/json" } }),
        },
        }),
      );
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const status = async (mf: InstanceType<typeof Miniflare>) => fromJson<{ memory: { tick: number; nextAt: number } | null; control: { stopped: boolean }; lease: { holder: string | null } }>(await (await mf.dispatchFetch("https://keeper.test/v1/keeper/status", { headers: auth })).text());

    const first = start();
    try {
      await first.dispatchFetch("https://keeper.test/v1/keeper/start", { method: "POST", headers: auth, body: JSON.stringify({ by: "the bundle test" }) });
      await (await first.getWorker()).scheduled({ cron: "* * * * *" });
      expect(chains.w.sends.map((s) => s.fn)).toEqual(["closeBatch"]);
      expect((await status(first)).memory?.tick).toBe(1);
    } finally {
      await first.dispose();
    }

    // the same storage, a new runtime: the memory, the switch and the journal are as the first left them
    const second = start();
    try {
      const s = await status(second);
      expect(s.memory?.tick).toBe(1);
      expect(s.control.stopped).toBe(false);
      const before = chains.fetched.length;
      // its next cron, within the saved back-off, is skipped by that memory (a fresh one would run a round)
      await (await second.getWorker()).scheduled({ cron: "* * * * *" });
      expect(chains.fetched.length).toBe(before);
      expect((await status(second)).memory?.tick).toBe(1);

      // the PC takes the lease over the control route; the cron then does nothing
      const lines: string[] = [];
      const ctl = new KeeperControl({ url: "https://keeper.test", token, fetch: ((u: string, i?: RequestInit) => second.dispatchFetch(u, i)) as typeof fetch, log: (l) => lines.push(l), holder: "hand:bundle-test:1", by: "the bundle test" });
      const lease = await ctl.acquire("v3.2-launch");
      expect((await status(second)).lease.holder).toBe("hand:bundle-test:1");
      await lease.renew();
      await lease.release();
      expect((await status(second)).lease.holder).toBeNull();
      // and the kill switch from the PC
      const said: string[] = [];
      expect(await keeperCommand(["stop", "--reason", "the bundle test"], { OPS_KEEPER_URL: "https://keeper.test", OPS_KEEPER_CONTROL_TOKEN: token }, (l) => said.push(l), { fetch: ((u: string, i?: RequestInit) => second.dispatchFetch(u, i)) as typeof fetch })).toBe(0);
      expect(said).toEqual(["v3.2-launch: STOPPED (the bundle test). The next cron run doesn't start; a send in flight finishes."]);
      expect((await status(second)).control.stopped).toBe(true);
    } finally {
      await second.dispose();
    }
  }, 120_000);
});
