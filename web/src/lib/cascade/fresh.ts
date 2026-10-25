import type { Clients } from "./chain";

/** How old the newest block may be before a server counts as behind. Bittensor makes a block every
 * 12 seconds, so five minutes is a server that has stopped following the chain. */
const MAX_AGE_S = 300;
export const FRESH_TRIES = 4;

/** Every server asked was behind: an old picture of the chain must not be shown as the current one. */
export class StaleChainError extends Error {
  constructor() {
    super("Bittensor's public node is behind right now, so we can't show up-to-date figures. Trying again shortly.");
    this.name = "StaleChainError";
  }
}

/** The newest block of an up-to-date server. A public endpoint can answer from a server that has
 * fallen behind, so an old answer is asked again (it may land on another) before giving up. */
export async function freshTip(c: Pick<Clients, "bittensor">, nowMs: number = Date.now()): Promise<bigint> {
  for (let i = 0; i < FRESH_TRIES; i++) {
    const b = await c.bittensor.getBlock({ blockTag: "latest" });
    if (nowMs / 1000 - Number(b.timestamp) <= MAX_AGE_S) return b.number as bigint;
  }
  throw new StaleChainError();
}
