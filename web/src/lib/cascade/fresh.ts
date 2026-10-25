import type { Clients } from "./chain";

/** How old the newest block may be before a server counts as behind. Bittensor makes a block every
 * 12 seconds, so five minutes is a server that has stopped following the chain. */
const MAX_AGE_S = 300;
export const FRESH_TRIES = 4;
/** How long Base's clock reading is reused before it is read again. */
const CLOCK_TTL_MS = 60_000;

/** Every server asked was behind: an old picture of the chain must not be shown as the current one. */
export class StaleChainError extends Error {
  constructor() {
    super("Bittensor's public node is behind right now, so we can't show up-to-date figures. Trying again shortly.");
    this.name = "StaleChainError";
  }
}

const clockOffsets = new WeakMap<object, { offsetMs: number; at: number }>();

/** Now, by Base's clock (a block every 2 seconds) rather than the device's: a device clock that is
 * minutes off must not make a healthy node look stale, or a stale one healthy. The device clock is the
 * fallback when Base can't be read. */
async function chainNowMs(c: Partial<Pick<Clients, "base">>): Promise<number> {
  if (!c.base) return Date.now();
  const cached = clockOffsets.get(c.base);
  if (cached && Date.now() - cached.at < CLOCK_TTL_MS) return Date.now() + cached.offsetMs;
  try {
    const b = await c.base.getBlock({ blockTag: "latest" });
    const offsetMs = Number(b.timestamp) * 1000 - Date.now();
    clockOffsets.set(c.base, { offsetMs, at: Date.now() });
    return Date.now() + offsetMs;
  } catch {
    return Date.now();
  }
}

/** The newest block of an up-to-date server. A public endpoint can answer from a server that has
 * fallen behind, so an old answer is asked again (it may land on another) before giving up. */
export async function freshTip(c: Pick<Clients, "bittensor"> & Partial<Pick<Clients, "base">>, nowMs?: number): Promise<bigint> {
  const now = nowMs ?? (await chainNowMs(c));
  for (let i = 0; i < FRESH_TRIES; i++) {
    const b = await c.bittensor.getBlock({ blockTag: "latest" });
    if (now / 1000 - Number(b.timestamp) <= MAX_AGE_S) return b.number as bigint;
  }
  throw new StaleChainError();
}
