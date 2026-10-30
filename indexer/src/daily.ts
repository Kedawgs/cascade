import { type Hex, hexToBigInt, hexToNumber, numberToHex } from "viem";
import { APY_WINDOW_BLOCKS, basketTwrKey, decodeTwr, netApyPercent } from "./apy.ts";
import { buildDigest, digestDue } from "./digest.ts";
import { renderDigest, sendAll } from "./email.ts";
import { type JobDeps, watchdog, type WatchdogResult } from "./hourly.ts";
import { Budget, createRpc, type Rpc } from "./rpc.ts";
import { expandHour } from "./snapshot.ts";
import { loadTickState, setMeta } from "./store.ts";
import { STORAGE_QUERY } from "./subtensor.ts";
import { dayOf, historyOf } from "./tick.ts";

// The daily job (13:00 UTC): the watchdog again, then the digest, sent once per UTC day (meta.digest_date): its
// arrival is itself a heartbeat. It has its own budget: a handful of subrequests for the APY's archive reads.

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The 30-day APY after the reward cut, the site's way (web/src/lib/cascade/reads.ts readApyPercent): the stake
 * hotkey's BasketTwr now and 216,000 blocks back, through the storage-query precompile, from an archive node.
 * Undefined when it can't be read or stood behind. */
export async function readApy(rpc: Rpc, hotkey: Hex, rewardCutBps: number): Promise<number | undefined> {
  try {
    const head = (await rpc.call("bittensor", "eth_getBlockByNumber", ["latest", false])) as { number?: Hex; timestamp?: Hex } | null;
    if (!head?.number || !head.timestamp) return undefined;
    const now = hexToBigInt(head.number);
    if (now <= APY_WINDOW_BLOCKS) return undefined;
    const then = now - APY_WINDOW_BLOCKS;
    const key = basketTwrKey(hotkey);
    const [twrNow, twrThen, thenBlock] = await rpc.batch("bittensor", [
      { method: "eth_call", params: [{ to: STORAGE_QUERY, data: key }, numberToHex(now)] },
      { method: "eth_call", params: [{ to: STORAGE_QUERY, data: key }, numberToHex(then)] },
      { method: "eth_getBlockByNumber", params: [numberToHex(then), false] },
    ]);
    const past = (thenBlock as { timestamp?: Hex } | null)?.timestamp;
    if (!past) return undefined;
    return netApyPercent({
      twrNow: decodeTwr(twrNow as Hex),
      twrThen: decodeTwr(twrThen as Hex),
      seconds: hexToNumber(head.timestamp) - hexToNumber(past),
      rewardCutBps,
    });
  } catch (e) {
    console.warn(`digest: the APY couldn't be read: ${message(e)}`);
    return undefined;
  }
}

export interface DailyDeps extends JobDeps {
  fetch: typeof fetch;
}

/** The daily job: the watchdog, then the digest if today's hasn't gone out. */
export async function runDaily(deps: DailyDeps): Promise<{ watchdog: WatchdogResult; digest: "sent" | "already" | "failed" }> {
  const w = await watchdog(deps);
  const { cfg, nowS } = deps;
  const db = deps.env.DB;
  let state: Awaited<ReturnType<typeof loadTickState>>;
  try {
    state = await loadTickState(db, nowS);
  } catch (e) {
    console.error(`daily: the database can't be read: ${message(e)}`);
    return { watchdog: w, digest: "failed" };
  }
  if (!digestDue(state.meta, nowS)) return { watchdog: w, digest: "already" };

  const history = historyOf(state);
  const bit = history.bittensor[0];
  const rpc = createRpc({ urls: { base: cfg.rpc.base, baseLogs: cfg.rpc.baseLogs, bittensor: cfg.rpc.bittensor }, fetch: deps.fetch, budget: new Budget(6), timeoutMs: 15_000 });
  const hotkey = bit?.state.stakeHotkey ?? cfg.deployment.stakeHotkey;
  const apyPercent = bit?.state.rewardCutBps === undefined ? undefined : await readApy(rpc, hotkey, bit.state.rewardCutBps);
  let content: Awaited<ReturnType<typeof buildDigest>>;
  try {
    content = await buildDigest({
      db,
      nowS,
      base: history.base[0],
      bit,
      hours: state.hours.flatMap((r) => {
        const h = expandHour(r.json);
        return h ? [h] : [];
      }),
      cursors: state.cursors,
      openAlerts: state.openAlerts,
      activeHolds: state.activeHolds,
      meta: state.meta,
      apyPercent,
    });
  } catch (e) {
    console.error(`daily: the digest couldn't be built: ${message(e)}`);
    return { watchdog: w, digest: "failed" };
  }
  const sent = await sendAll(deps.env, cfg, [{ id: 0, ...renderDigest(content) }]);
  if (sent.sent.length === 0) {
    console.error(`daily: the digest couldn't be sent (${sent.failed.map((f) => f.code).join(", ")})`);
    return { watchdog: w, digest: "failed" };
  }
  try {
    await setMeta(db, "digest_date", dayOf(nowS)).run();
  } catch (e) {
    console.error(`daily: the digest went out but couldn't be recorded: ${message(e)}`);
  }
  return { watchdog: w, digest: "sent" };
}
