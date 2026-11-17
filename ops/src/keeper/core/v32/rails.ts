import { type Address, formatEther, type Hex } from "viem";
import { VAULT_LENS } from "../abi.ts";
import type { KeeperDeps, QueuedDelivery, Rails } from "../actions.ts";
import { chainLabel, scrubSecrets, unit } from "../errors.ts";
import { type MonitorClient, type MonitorOverride, monitorGate, readMonitor } from "../hold.ts";
import { spendRows, spentOn } from "../journal.ts";
import type { KeeperMemory } from "../memory.ts";
import type { ChainName } from "../types.ts";
import type { KeeperDepsV32 } from "./reads.ts";

// v3.2's rails (Task 50a; design-keeper-worker.md §6, with the founder's Phase 10 answers): what a round may send, read
// once a round after the readiness checks and before anything is looked up, replaced or sent.
// - The monitor (hold.ts): a hold stops EVERYTHING, USDC deliveries included (the founder's answer, over the note's
//   recommendation); a monitor that can't be read, or can't see, stops everything too. A hand run's
//   --ignore-monitor-outage --until lifts an outage only.
// - The founder's one exception (2026-11-08): while ForeverMoney's migration notice runs (read on chain at the
//   AlphaVault, migrationReadyAt() != 0 at the head block; a read that fails gives no exception), a hold or an outage
//   lets exactly one action kind through: converting a token park (deliverParked of a token park, Task 52's job, its
//   request tagged by v32/requests.ts convertParkRequest, and the park itself checked on chain at the send path: a token
//   park from the registered door to the vault). The kill switch and the lease still apply. A hold of any kind,
//   ops/hold.json's included, lets the conversion through: the kill switch (pnpm ops keeper stop) is the full stop.
//   migrationFinished is not read (the founder's rule is migrationReadyAt() != 0 alone): a conversion after a finished
//   migration is left to its own simulation (Task 52's note).
// - The controller's ruling for Task 52: while the notice runs, that conversion passes the 24 h spend cap too, counted
//   (its journal row is written ahead like any send's), as a cancel passes it: waiting a day for the cap could cost
//   depositors their funds near the notice's end. So the notice is read at Bittensor's cap as well as under a stop.
// - A payout also needs its key in the monitor's okKeys.
// - usdcDelivery off (deployments.json), or the keeper's deliveries switch off (the host's: the Worker's control row,
//   a hand run's flag): no delivery at all; credits stay claimable.
// - The 24 h spend cap per chain, summed from the journal (gas plus value): at or over it, nothing more is sent on
//   that chain, said loudly; the other chain's sends go on.
// Each is said once when it changes (memory.reads.rails), loudly, and the override's warning every round. The round
// enforces them, and so does the one send path (v32/reads.ts railsCheck), for every v3.2 send from any entry point.

/** What the host gives the rails: where the monitor is read (none: an outage), ops/hold.json's text for a hand run (read
 * each round; undefined: no file), a hand run's --ignore-monitor-outage --until (the Worker never sets it), and the
 * keeper's deliveries switch. */
export interface RailsEnv {
  monitor: MonitorClient | null;
  holdFile?: () => string | undefined;
  override?: MonitorOverride;
  deliveriesOn: boolean;
}

interface RailsMemory {
  /** What was last said, by rail: the monitor's stop, the deliveries' stop, each chain's cap */
  said?: Record<string, string>;
}

const v32 = (deps: KeeperDeps): KeeperDepsV32 => {
  if (!("rails" in deps) || !("readPayoutInputs" in deps)) throw new Error("the v3.2 rails need the v3.2 deps (v32/reads.ts depsV32); nothing sent");
  return deps as KeeperDepsV32;
};

/** The round's rails (core/actions.ts Rails), from the monitor, the journal, the deployment and the host's switches;
 * each change said loudly once. `now` is the round's clock (ms): the monitor's second lag test, the override's end
 * and the spend cap's window go by it. A failed read of the payout delay or the journal throws (the round fails: nothing
 * is sent). */
export async function railsV32(depsIn: KeeperDeps, memory: KeeperMemory, now: number): Promise<Rails> {
  const deps = v32(depsIn);
  const env = deps.rails;
  const d = deps.deployment;
  const m = (memory.reads.rails ??= {}) as RailsMemory;
  const said = (m.said ??= {});
  /** Says `text` when it differs from what was last said for `rail`, `cleared` (if any) when the rail lifts. */
  const tell = (rail: string, text: string | undefined, cleared?: string) => {
    const last = said[rail];
    if (text === last) return;
    if (text === undefined) {
      delete said[rail];
      if (cleared) deps.log(cleared);
      return;
    }
    said[rail] = text;
    deps.log(text);
  };

  const payoutDelayS = Number(await deps.readValue("bittensor", d.addresses.vaultLens, VAULT_LENS, "payoutDelay"));
  const view = await readMonitor({ client: env.monitor, holdFile: env.holdFile?.(), deployment: d.addresses, payoutDelayS, nowMs: now });
  const gate = monitorGate(view, env.override, now);
  tell(
    "monitor",
    gate.stop,
    gate.warn ? "Sends resume under --ignore-monitor-outage: nothing holds the keeper, but the monitor can't see" : "Sends resume: nothing holds the keeper, and the monitor can see",
  );
  if (gate.warn) deps.log(gate.warn);

  const off = !d.usdcDelivery
    ? "USDC DELIVERY OFF: USDC delivery is off for this deployment (deployments.json usdcDelivery): no delivery is sent; credits stay claimable"
    : !env.deliveriesOn
      ? "USDC DELIVERY OFF: the keeper's deliveries switch is off: no delivery is sent; credits stay claimable"
      : undefined;
  tell("deliveries", off, "USDC delivery is on again: deliveries go ahead");

  // a send that can no longer land leaves the sum first; one with a receipt counts its actual cost (settlePending)
  await deps.settleJournal();
  const rows = await spendRows(deps.journal, now);
  const capped = new Set<ChainName>();
  for (const c of ["base", "bittensor"] as const) {
    const spent = spentOn(rows, c, now);
    const cap = d.spendCap[c];
    const over = spent >= cap;
    if (over) capped.add(c);
    const other = c === "base" ? "Bittensor" : "Base";
    // said once when it is reached (with the amount then), once when it lifts
    const text = over
      ? `SPEND CAP: ${chainLabel(c)}: the keeper has sent ${formatEther(spent)} ${unit(c)} in the last 24 hours (gas and value, from its journal), at or over its ${formatEther(cap)} ${unit(c)} cap: nothing more is sent on ${chainLabel(c)} until the 24-hour sum falls under it; ${other}'s sends go on`
      : undefined;
    if (over && said[`cap:${c}`] !== undefined) continue;
    tell(`cap:${c}`, text, `SPEND CAP lifted on ${chainLabel(c)}: the 24-hour sum is under the cap again`);
  }

  // the founder's one exception: under a stop, ForeverMoney's migration notice (read on chain) lets token-park
  // conversions through, and nothing else; at Bittensor's spend cap it lets them past the cap (the controller's ruling for
  // Task 52, counted); a notice that can't be read gives no exception
  let migration = false;
  if (gate.stop || capped.has("bittensor")) {
    try {
      const readyAt = await deps.migrationNotice();
      migration = readyAt !== 0n;
      const capNote = capped.has("bittensor") && gate.stop ? "; they pass Bittensor's 24 h spend cap too (still counted)" : "";
      tell(
        "migration",
        !migration
          ? undefined
          : gate.stop
            ? `MIGRATION NOTICE: ForeverMoney's migration is announced (migrationReadyAt ${readyAt}): while the keeper is held, only token-park conversions go${capNote}`
            : `MIGRATION NOTICE: ForeverMoney's migration is announced (migrationReadyAt ${readyAt}): token-park conversions go past Bittensor's 24 h spend cap (still counted)`,
      );
    } catch (e) {
      const why = scrubSecrets(String((e as Error)?.message ?? e).split("\n")[0]);
      tell(
        "migration",
        gate.stop
          ? `MIGRATION NOTICE unreadable: ForeverMoney's migration notice could not be read (${why}): no exception to the hold, nothing is sent`
          : `MIGRATION NOTICE unreadable: ForeverMoney's migration notice could not be read (${why}): no token-park conversion passes Bittensor's spend cap`,
      );
    }
  } else tell("migration", undefined);

  const rails: Rails = {
    ...(gate.stop ? { stop: gate.stop } : {}),
    ...(gate.stop && migration ? { migrationConversions: true as const } : {}),
    ...(migration ? { migrationNotice: true as const } : {}),
    capped,
    ...(gate.okKeys ? { confirmed: gate.okKeys } : {}),
    ...(off ? { noDeliveries: off } : {}),
  };
  // the one send path checks every send against this answer while it is fresh (v32/reads.ts railsCheck)
  deps.railsSeen(rails);
  return rails;
}

interface QueueMemory {
  /** The queue as last logged */
  said?: string;
  /** Each candidate's last reading, when a round reads only some (Task 52w fix): by lowercase address */
  last?: Record<string, { claimable: bigint; due: boolean }>;
}

/** Logs the round's delivery queue, oldest credit first, when it changes (who, how much, due or waiting): the founder's
 * "log the queue" (2026-11-05). A queue gone empty is not logged. */
export function queueLogV32(deps: KeeperDeps, memory: KeeperMemory, queueIn: readonly QueuedDelivery[], candidates?: readonly Address[]): void {
  const m = (memory.reads.queue ??= {}) as QueueMemory;
  // a round that reads only some of the candidates (Task 52w fix): each one's last reading stands for the others
  let queue = queueIn;
  if (candidates) {
    const last = (m.last ??= {});
    for (const q of queueIn) last[q.user.toLowerCase()] = { claimable: q.claimable, due: q.due };
    const read = new Set(queueIn.map((q) => q.user.toLowerCase()));
    const present = new Set(candidates.map((u) => u.toLowerCase()));
    for (const k of Object.keys(last)) if (!present.has(k)) delete last[k];
    queue = candidates.flatMap((u) => {
      const k = u.toLowerCase();
      const q = last[k];
      if (!q || (!read.has(k) && q.claimable === 0n)) return [];
      return [{ user: u, claimable: q.claimable, due: q.due }];
    });
  }
  if (!queue.length) {
    m.said = undefined;
    return;
  }
  const text = `Delivery queue (oldest credit first): ${queue.map((q) => `${q.user} ${formatEther(q.claimable)} TAO (${q.due ? "due" : "waits"})`).join(", ")}`;
  if (text === m.said) return;
  m.said = text;
  deps.log(text);
}

/** Why the rails refuse `send` now, or undefined (the one send path applies it to every v3.2 send: v32/reads.ts
 * railsCheck; a one-shot command may ask it first, to say so before it reads anything). A hold, or a monitor that
 * can't see, refuses everything but a token park's conversion during ForeverMoney's migration notice; a chain at its
 * spend cap refuses its sends, but a cancel of the keeper's own stuck nonce (which moves nothing) and, while the notice
 * runs, a token park's conversion (the controller's ruling for Task 52; counted); a delivery needs deliveries on; a
 * payout needs its key confirmed by the monitor (unless an outage is overridden, when there is no per-key check). */
export function railsRefusal(rails: Rails, send: { chain: ChainName; payoutKey?: Hex; delivery?: boolean; conversion?: boolean; cancel?: boolean }): string | undefined {
  // under a stop, only a token park's conversion while ForeverMoney's migration notice runs (the founder's exception)
  if (rails.stop && !(send.conversion && rails.migrationConversions)) return rails.stop;
  // a cancel of the keeper's own stuck nonce passes the spend cap: its worst case is tiny, it can only lower the sum, and
  // a pending send that took its chain to the cap would otherwise strand it there (T51 re-review R1); never a stop. So
  // does a token park's conversion while ForeverMoney's migration notice runs (the controller's ruling for Task 52:
  // waiting a day for the cap could cost depositors near the notice's end), counted all the same
  if (send.cancel || (send.conversion && rails.migrationNotice)) return undefined;
  if (rails.capped?.has(send.chain)) return `${chainLabel(send.chain)} is at the keeper's 24 h spend cap (see SPEND CAP above): nothing more is sent on it`;
  if (send.delivery && rails.noDeliveries) return rails.noDeliveries;
  if (send.payoutKey && rails.confirmed && !rails.confirmed.has(send.payoutKey.toLowerCase())) {
    return `payout batch ${send.payoutKey.slice(0, 10)}… waits for the monitor to confirm it (not in its okKeys)`;
  }
  return undefined;
}
