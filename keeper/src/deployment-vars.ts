import { keccak256, stringToBytes } from "viem";

// The deployment in Worker vars. Cloudflare refuses a var above 5 kB (the first live deploy, 2026-11-16: "Text binding
// 'DEPLOYMENT' is too large, its size of 10 kB exceeds the limit of 5.1 kB"), and a real record's for-life list alone
// is 8.5 kB. So `pnpm config:from-record` prints the deployment as several vars: DEPLOYMENT without its for-life list,
// and the list in numbered parts (DEPLOYMENT_FOR_LIFE_1, _2, ...). DEPLOYMENT says how many parts there are and the
// digest of the whole deployment they were split from (`forLifeParts`), and every part repeats both. The Worker joins
// them before it decodes the deployment, and checks the digest of what it joined. A part missing, extra, out of place,
// edited, or of another printout (even one with as many parts: the R13 review's Medium) is a problem by name and joins
// nothing: the keeper never runs on a for-life list that isn't the one printed. A deployment that fits one var stays
// DEPLOYMENT alone (the tests', a hand-written one), read as it always was.

/** What Cloudflare takes in one var, held a little under its 5.1 kB (wrangler.jsonc's vars are pinned to it). */
export const VAR_MAX_BYTES = 5_000;
/** What the split fills a var to: room under the limit for however Cloudflare counts the binding. */
export const VAR_TARGET_BYTES = 4_500;
/** The most parts the Worker reads (it asks for each by name: 32 vars of 4.5 kB is fourteen times today's list). */
export const MAX_FOR_LIFE_PARTS = 32;

const LISTS = ["values", "code", "pools"] as const;
type ListName = (typeof LISTS)[number];
const PART_KEYS: readonly string[] = ["part", "of", "id", ...LISTS];
const partName = (i: number) => `DEPLOYMENT_FOR_LIFE_${i}`;
const AGAIN = "print the vars again with pnpm config:from-record";

/** A var's size as Cloudflare measures it: the UTF-8 bytes of its compact JSON. */
export const varBytes = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const unset = (v: unknown) => v === undefined || v === null || v === "";
const whole = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 1;
const isDigest = (x: unknown): x is string => typeof x === "string" && /^0x[0-9a-f]{64}$/.test(x);

function parsed(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

/** JSON with every object's keys sorted, so a digest doesn't depend on the order a var's keys come back in. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** The digest of a whole deployment (as encodeDeployment writes it, parsed): keccak256 of its canonical JSON. */
export const deploymentDigest = (deployment: Record<string, unknown>): string => keccak256(stringToBytes(canonical(deployment)));

/** The vars a deployment (as encodeDeployment writes it, parsed) goes into: DEPLOYMENT alone when it fits one var, else
 * DEPLOYMENT without its for-life list (with `forLifeParts`: how many parts, and the whole deployment's digest) and the
 * list's entries, in order, in as few numbered parts as hold them. It throws for what can't be split whole: the
 * deployment's own part, or one entry, above a var; a for-life list with a key this doesn't know, or with no entry. */
export function splitDeploymentVars(deployment: Record<string, unknown>, max: number = VAR_TARGET_BYTES): Record<string, unknown> {
  if (varBytes(deployment) <= max) return { DEPLOYMENT: deployment };
  const { forLife, ...core } = deployment;
  if (!isObject(forLife) || !LISTS.every((l) => Array.isArray(forLife[l]))) throw new Error(`the deployment is ${varBytes(deployment)} bytes, above a Worker var's ${max}, and has no for-life list to split; nothing split`);
  const unknown = Object.keys(forLife).filter((k) => !(LISTS as readonly string[]).includes(k));
  if (unknown.length) throw new Error(`the for-life list has a key the split doesn't carry (${unknown.join(", ")}); nothing split`);
  if ("forLifeParts" in core) throw new Error("the deployment already has a forLifeParts key, which the split writes; nothing split");
  const id = deploymentDigest({ ...core, forLife: { values: forLife.values, code: forLife.code, pools: forLife.pools } });
  // sized with two-digit numbers in `part` and `of`, the most MAX_FOR_LIFE_PARTS needs
  const sized = (lists: Partial<Record<ListName, unknown[]>>) => varBytes({ part: 99, of: 99, id, ...lists });
  if (varBytes({ ...core, forLifeParts: { of: 99, id } }) > max) throw new Error(`the deployment without its for-life list is ${varBytes({ ...core, forLifeParts: { of: 99, id } })} bytes, above a Worker var's ${max}; nothing split`);
  const parts: Partial<Record<ListName, unknown[]>>[] = [];
  let cur: Partial<Record<ListName, unknown[]>> = {};
  for (const list of LISTS) {
    for (const entry of forLife[list] as unknown[]) {
      const next = { ...cur, [list]: [...(cur[list] ?? []), entry] };
      if (sized(next) <= max) {
        cur = next;
        continue;
      }
      if (sized({ [list]: [entry] }) > max) throw new Error(`one entry of the for-life list (${list}) is ${sized({ [list]: [entry] })} bytes, above a Worker var's ${max}; nothing split`);
      parts.push(cur);
      cur = { [list]: [entry] };
    }
  }
  if (Object.keys(cur).length) parts.push(cur);
  if (parts.length === 0) throw new Error(`the deployment is ${varBytes(deployment)} bytes, above a Worker var's ${max}, and its for-life list has no entry to move out; nothing split`);
  if (parts.length > MAX_FOR_LIFE_PARTS) throw new Error(`the for-life list needs ${parts.length} vars, above the ${MAX_FOR_LIFE_PARTS} the keeper reads; nothing split`);
  const vars: Record<string, unknown> = { DEPLOYMENT: { ...core, forLifeParts: { of: parts.length, id } } };
  parts.forEach((p, i) => (vars[partName(i + 1)] = { part: i + 1, of: parts.length, id, ...p }));
  return vars;
}

/** The deployment's text from the Worker's vars, for decodeDeployment: DEPLOYMENT as it is when it comes whole (no
 * `forLifeParts` in it and no part set), else DEPLOYMENT with the for-life list joined from its parts in order, held to
 * the digest DEPLOYMENT names. Every problem is said by the var's name, and any problem leaves no text. */
export function joinDeploymentVars(env: Readonly<Record<string, unknown>>): { text?: string; problems: string[] } {
  const raw = env.DEPLOYMENT;
  if (unset(raw)) return { problems: ["DEPLOYMENT is not set: write it with pnpm config:from-record (Task 67)"] };
  // each part asked for by its name (a Worker's env is not relied on to list its keys)
  const set: number[] = [];
  for (let i = 1; i <= MAX_FOR_LIFE_PARTS + 1; i++) if (!unset(env[partName(i)])) set.push(i);
  const core = parsed(raw);
  const inParts = isObject(core) && Object.hasOwn(core, "forLifeParts");
  if (set.length === 0 && !inParts) return { text: typeof raw === "string" ? raw : JSON.stringify(raw), problems: [] };

  if (!isObject(core)) return { problems: ["DEPLOYMENT is not a JSON object, so its DEPLOYMENT_FOR_LIFE parts can't be joined to it"] };
  if (Object.hasOwn(core, "forLife")) return { problems: [`DEPLOYMENT has its own for-life list, and ${set.length ? `${partName(set[0])} is set` : "says it is in parts (forLifeParts)"} too: one or the other`] };
  const { forLifeParts, ...rest } = core;
  if (!inParts) return { problems: [`${partName(set[0])} is set, but DEPLOYMENT doesn't say how many parts its for-life list is in (forLifeParts): ${AGAIN}`] };
  if (!isObject(forLifeParts) || !whole(forLifeParts.of) || !isDigest(forLifeParts.id) || Object.keys(forLifeParts).length !== 2) {
    return { problems: [`DEPLOYMENT's forLifeParts is not { of, id } (a count of parts and the deployment's digest): ${AGAIN}`] };
  }
  const { of, id } = forLifeParts as { of: number; id: string };
  if (of > MAX_FOR_LIFE_PARTS) return { problems: [`DEPLOYMENT says its for-life list is in ${of} parts, above the ${MAX_FOR_LIFE_PARTS} the keeper reads`] };

  const problems: string[] = [];
  for (let i = 1; i <= of; i++) if (!set.includes(i)) problems.push(`${partName(i)} is missing: DEPLOYMENT says there are ${of}`);
  for (const i of set) if (i > of) problems.push(`${partName(i)} is set, but DEPLOYMENT says there are ${of}`);
  const parts = new Map<number, Record<string, unknown>>();
  for (const i of set) {
    if (i > of) continue;
    const p = parsed(env[partName(i)]);
    if (!isObject(p)) {
      problems.push(`${partName(i)} is not a JSON object`);
      continue;
    }
    if (!whole(p.part) || !whole(p.of)) {
      problems.push(`${partName(i)} doesn't say which part of how many it is (part, of)`);
      continue;
    }
    const unknown = Object.keys(p).filter((k) => !PART_KEYS.includes(k));
    if (unknown.length) {
      problems.push(`${partName(i)} has a key that is no part of a for-life list: ${unknown.map((k) => JSON.stringify(k)).join(", ")}`);
      continue;
    }
    const notList = LISTS.filter((l) => p[l] !== undefined && !Array.isArray(p[l]));
    if (notList.length) {
      problems.push(`${partName(i)}'s ${notList.join(", ")} is not a list`);
      continue;
    }
    if (p.of !== of) problems.push(`${partName(i)} says there are ${p.of} parts, DEPLOYMENT says ${of}`);
    else if (p.part !== i) problems.push(`${partName(i)} says it is part ${p.part} of ${of}, not part ${i}`);
    else if (p.id !== id) problems.push(`${partName(i)} is a part of another deployment than DEPLOYMENT's (its id differs): ${AGAIN}`);
    else parts.set(i, p);
  }
  if (problems.length) return { problems };

  const forLife: Record<ListName, unknown[]> = { values: [], code: [], pools: [] };
  for (let i = 1; i <= of; i++) for (const l of LISTS) forLife[l].push(...((parts.get(i)![l] as unknown[] | undefined) ?? []));
  const joined = { ...rest, forLife };
  // the whole deployment's digest, as the split took it: an entry edited, dropped or added in any var fails here
  if (deploymentDigest(joined) !== id) return { problems: [`the deployment joined from DEPLOYMENT and its ${of} for-life part${of === 1 ? "" : "s"} is not the one they were printed from (its digest differs from forLifeParts.id): ${AGAIN}`] };
  return { text: JSON.stringify(joined), problems: [] };
}
