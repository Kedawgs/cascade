// The site's rules for a saved or seeded scan state, ported from `decode` in
// web/src/lib/cascade/scan-store.ts (main, as merged from web-hardening at 438deaf): a state the site
// would drop whole fails here, naming the rule. No Workers types: Node tests use it too.

const SCAN_VERSION = 1;

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isHash = (x: unknown): boolean => typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x);
const isDecimal = (x: unknown): x is string => typeof x === "string" && /^(0|[1-9]\d{0,77})$/.test(x);
const isUint32 = (x: unknown): boolean => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 0xffff_ffff;

const LISTS = ["delivered", "staked", "payouts", "deposited", "redeemed"] as const;

/** Throws unless `x` is a state the site's `decode` accepts for the scan of `vault` from `from`. */
export function assertValidScanState(x: unknown, vault: string, from: bigint): void {
  const fail = (why: string): never => {
    throw new Error(`the site would drop this scan state: ${why}`);
  };
  if (!isRecord(x)) fail("not an object");
  const s = x as Record<string, unknown>;
  if (s.v !== SCAN_VERSION) fail(`v is ${String(s.v)}, not ${SCAN_VERSION}`);
  if (s.vault !== vault.toLowerCase()) fail("another vault (or not lowercase)");
  if (s.from !== String(from)) fail("another deploy block");
  if (!isDecimal(s.next)) fail("next is not a decimal string");
  const next = BigInt(s.next as string);
  if (next < from) fail("next is before from");
  for (const k of LISTS) if (!Array.isArray(s[k]) || !(s[k] as unknown[]).every(isRecord)) fail(`${k} is not a list of objects`);
  const list = (k: (typeof LISTS)[number]) => s[k] as Record<string, unknown>[];
  const inRange = (e: Record<string, unknown>) => isDecimal(e.block) && BigInt(e.block) >= from && BigInt(e.block) < next && isHash(e.txHash);
  if (!list("delivered").every((e) => inRange(e) && isDecimal(e.batchId) && isHash(e.key))) fail("a delivery is malformed or outside [from, next)");
  if (!list("staked").every(inRange)) fail("a stake is malformed or outside [from, next)");
  if (!list("payouts").every((e) => inRange(e) && isHash(e.key) && isUint32(e.chunk) && isUint32(e.taken))) fail("a payout chunk is malformed or outside [from, next)");
  if (![...list("deposited"), ...list("redeemed")].every((e) => inRange(e) && isHash(e.key) && isDecimal(e.assets))) fail("an account event is malformed or outside [from, next)");
}
