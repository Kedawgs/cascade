import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { MonitorClient } from "../../../ops/src/keeper/core/hold.ts";
import { monitorOf, type World } from "../../../ops/test/keeper-v32-world.ts";
import type { KeeperEnv } from "../../src/config.ts";
import type { KeeperCoordinator } from "../../src/coordinator.ts";
import { cronRun, type RunOptions } from "../../src/run.ts";
import { fakeChains } from "../fake-chains.ts";
export type { Fetched } from "../fake-chains.ts";

// The worker tests' harness: the fake chains (../fake-chains.ts) behind a spied fetch, for this run's throwaway key
// (vitest.config.ts), and the Durable Object of the tests' deployment.

export type TestEnv = KeeperEnv & { TEST_TOKEN: string; KEEPER_PRIVATE_KEY: string };
export const testEnv = env as unknown as TestEnv;
export const KEY = testEnv.KEEPER_PRIVATE_KEY as Hex;
export const ME = privateKeyToAccount(KEY).address;
export const NAME = "v3.2-launch";

export const coordinator = (name = NAME, e: Pick<KeeperEnv, "COORDINATOR"> = testEnv) => e.COORDINATOR.get(e.COORDINATOR.idFromName(name)) as DurableObjectStub<KeeperCoordinator>;
/** A coordinator of its own, for a test that must not share one */
export const ownCoordinator = () => coordinator(`lease-test-${crypto.randomUUID()}`);

/** The world's monitor for the runs a test makes (keeperRun): set by chains() */
let currentMonitor: MonitorClient | null = null;

/** A cron run against the fake chains, the world's monitor read by its rails (the Worker's default reads the MONITOR
 * binding: tests of that call cronRun themselves). */
export const keeperRun = async (e: KeeperEnv, o: RunOptions = {}) => {
  const r = await cronRun(e, { monitor: currentMonitor, ...o });
  // every line the run made reaches setup.ts's scan for the key, printed or not
  (globalThis as unknown as { __printed?: string[] }).__printed?.push(...r.lines);
  return r;
};

/** A fake world for the keeper's key (`me`: ME unless a test names another, a rotated key's), its fetch installed: every
 * request the Worker makes is answered by it. */
export function chains(over: (w: World) => void = () => undefined, me: Address = ME) {
  const c = fakeChains(me, over);
  currentMonitor = monitorOf(c.w);
  vi.spyOn(globalThis, "fetch").mockImplementation(c.fetch);
  return c;
}

/** A batch with entries that can close: the world's default open batch, past its max wait. */
export const closeDue = (w: World) => {
  w.door.start = BigInt(w.time.base - 90_000);
};

/** The keeper started (a fresh Durable Object reads as stopped). */
export async function started() {
  await coordinator().start({ by: "the tests" });
}

/** The saved memory's text, read inside the object */
export const savedMemory = () =>
  runInDurableObject(coordinator(), (_o, state) => String((state.storage.sql.exec("SELECT text FROM memory WHERE id = 1").toArray()[0] as { text?: string } | undefined)?.text ?? "null"));

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
