import { describe, expect, it } from "vitest";
import { decodeDeployment, encodeDeployment } from "../../../ops/src/keeper/core/deployment.ts";
import { deploymentFor } from "../../../ops/test/keeper-v32-world.ts";
import { readConfig } from "../../src/config.ts";
import { deploymentDigest, joinDeploymentVars, MAX_FOR_LIFE_PARTS, splitDeploymentVars, VAR_MAX_BYTES, VAR_TARGET_BYTES, varBytes } from "../../src/deployment-vars.ts";

// Cloudflare refuses a Worker var above 5 kB (the first live deploy, 2026-11-16: "Text binding 'DEPLOYMENT' is too
// large, its size of 10 kB exceeds the limit of 5.1 kB"), and a real record's for-life list alone is 8.5 kB. So the
// deployment goes into several vars: DEPLOYMENT without its for-life list, and that list in numbered parts. DEPLOYMENT
// names how many parts there are and the whole deployment's digest (forLifeParts), every part repeats both, and the
// Worker checks the digest of what it joined. A part missing, extra, out of place, edited or of another printout is a
// problem by name: the keeper never runs on a for-life list that isn't the one printed.

type Json = Record<string, unknown>;
const AGAIN = "print the vars again with pnpm config:from-record";

/** a deployment as config:from-record prints it, its for-life list padded to `values` entries at `address` */
function encoded(values: number, address = `0x${"ab".repeat(20)}`): Json {
  const d = JSON.parse(encodeDeployment(deploymentFor({}))) as Json & { forLife: { values: unknown[]; code: unknown[]; pools: unknown[] } };
  const value = (i: number) => ({ chain: "bittensor", contract: "CascadeVault", address, fn: `setting${i}`, returns: "uint256", value: { $bigint: String(10n ** 18n + BigInt(i)) } });
  const code = (i: number) => ({ chain: "base", contract: `Contract${i}`, address: `0x${"cd".repeat(20)}`, codeHash: `0x${"ef".repeat(32)}` });
  return { ...d, forLife: { values: Array.from({ length: values }, (_, i) => value(i)), code: Array.from({ length: 12 }, (_, i) => code(i)), pools: d.forLife.pools } };
}

const BASE = { COORDINATOR: undefined as never, BASE_RPC_URL: "https://a.test", BASE_LOGS_RPC_URL: "https://b.test", BITTENSOR_RPC_URL: "https://c.test" };
const partNames = (vars: Json) => Object.keys(vars).filter((k) => k !== "DEPLOYMENT");
const without = (vars: Json, k: string) => Object.fromEntries(Object.entries(vars).filter(([name]) => name !== k));

describe("the deployment in vars of at most 5 kB", () => {
  it("a deployment that fits one var stays DEPLOYMENT alone, as before", () => {
    const d = encoded(2);
    expect(varBytes(d)).toBeLessThanOrEqual(VAR_TARGET_BYTES);
    const vars = splitDeploymentVars(d);
    expect(Object.keys(vars)).toEqual(["DEPLOYMENT"]);
    expect(vars.DEPLOYMENT).toEqual(d);
    expect(vars.DEPLOYMENT).not.toHaveProperty("forLifeParts");
    const j = joinDeploymentVars(vars);
    expect(j.problems).toEqual([]);
    expect(JSON.parse(j.text!)).toEqual(d);
  });

  it("a real-sized one splits: DEPLOYMENT without the for-life list but with the parts' count and the deployment's digest, the list in numbered parts, every var under the limit, and the join gives back the same deployment in the same order", () => {
    const d = encoded(60);
    expect(varBytes(d)).toBeGreaterThan(2 * VAR_MAX_BYTES);
    const vars = splitDeploymentVars(d);
    const names = Object.keys(vars);
    const n = names.length - 1;
    expect(names[0]).toBe("DEPLOYMENT");
    expect(n).toBeGreaterThanOrEqual(3);
    expect(names.slice(1)).toEqual(names.slice(1).map((_, i) => `DEPLOYMENT_FOR_LIFE_${i + 1}`));
    expect(vars.DEPLOYMENT).not.toHaveProperty("forLife");
    const id = deploymentDigest(d);
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect((vars.DEPLOYMENT as Json).forLifeParts).toEqual({ of: n, id });
    for (const [name, v] of Object.entries(vars)) expect(varBytes(v), name).toBeLessThanOrEqual(VAR_TARGET_BYTES);
    names.slice(1).forEach((name, i) => expect(vars[name]).toMatchObject({ part: i + 1, of: n, id }));
    const j = joinDeploymentVars(vars);
    expect(j.problems).toEqual([]);
    // the joined text is the deployment itself: no forLifeParts left in it
    expect(JSON.parse(j.text!)).toEqual(d);
    // the lists' order is kept (the for-life check reads them in the record's order)
    expect((JSON.parse(j.text!) as typeof d & { forLife: { values: { fn: string }[] } }).forLife.values.map((v) => v.fn)).toEqual(Array.from({ length: 60 }, (_, i) => `setting${i}`));
    // and it decodes as the deployment it was
    expect(decodeDeployment(j.text!)).toEqual(decodeDeployment(JSON.stringify(d)));
  });

  it("the digest doesn't depend on the order of an object's keys, and does on every value and on a list's order", () => {
    const d = encoded(3) as Json & { forLife: { values: Json[] } };
    const reversed = Object.fromEntries(Object.entries(d).reverse());
    expect(deploymentDigest(reversed)).toBe(deploymentDigest(d));
    expect(deploymentDigest({ ...d, name: "another" })).not.toBe(deploymentDigest(d));
    expect(deploymentDigest({ ...d, forLife: { ...d.forLife, values: [...d.forLife.values].reverse() } })).not.toBe(deploymentDigest(d));
  });

  it("the parts may be text, as DEPLOYMENT may (a var pasted as a string), and their keys may come back in any order", () => {
    const d = encoded(60);
    const vars = splitDeploymentVars(d);
    const asText = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, JSON.stringify(v)]));
    const j = joinDeploymentVars(asText);
    expect(j.problems).toEqual([]);
    expect(JSON.parse(j.text!)).toEqual(d);
    const shuffled = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, Object.fromEntries(Object.entries(v as Json).reverse())]));
    expect(joinDeploymentVars(shuffled).problems).toEqual([]);
    expect(JSON.parse(joinDeploymentVars(shuffled).text!)).toEqual(d);
  });

  it("an empty or unset part var is no part (the test environment's)", () => {
    const d = encoded(2);
    const j = joinDeploymentVars({ DEPLOYMENT: d, DEPLOYMENT_FOR_LIFE_1: "", DEPLOYMENT_FOR_LIFE_2: undefined, DEPLOYMENT_FOR_LIFE_3: null });
    expect(j.problems).toEqual([]);
    expect(JSON.parse(j.text!)).toEqual(d);
  });

  it("no DEPLOYMENT is refused in the same words as before, parts or not", () => {
    const vars = splitDeploymentVars(encoded(60));
    for (const none of [undefined, null, ""]) {
      expect(joinDeploymentVars({ ...vars, DEPLOYMENT: none })).toEqual({ problems: ["DEPLOYMENT is not set: write it with pnpm config:from-record (Task 67)"] });
      expect(joinDeploymentVars({ DEPLOYMENT: none })).toEqual({ problems: ["DEPLOYMENT is not set: write it with pnpm config:from-record (Task 67)"] });
    }
  });

  it("a part missing, extra, out of place or disagreeing on the count is a problem by name, and nothing is joined", () => {
    const vars = splitDeploymentVars(encoded(60));
    const n = partNames(vars).length;
    expect(n).toBeGreaterThanOrEqual(3);
    // the last part gone, a middle one, the first: DEPLOYMENT says how many there are
    for (const i of [n, 2, 1]) expect(joinDeploymentVars(without(vars, `DEPLOYMENT_FOR_LIFE_${i}`))).toEqual({ problems: [`DEPLOYMENT_FOR_LIFE_${i} is missing: DEPLOYMENT says there are ${n}`] });
    // every part gone: each is missing by name (never DEPLOYMENT read whole, without a for-life list)
    expect(joinDeploymentVars({ DEPLOYMENT: vars.DEPLOYMENT }).problems).toEqual(Array.from({ length: n }, (_, i) => `DEPLOYMENT_FOR_LIFE_${i + 1} is missing: DEPLOYMENT says there are ${n}`));
    // one more than it says
    expect(joinDeploymentVars({ ...vars, [`DEPLOYMENT_FOR_LIFE_${n + 1}`]: { part: n + 1, of: n, values: [] } }).problems).toEqual([`DEPLOYMENT_FOR_LIFE_${n + 1} is set, but DEPLOYMENT says there are ${n}`]);
    // two parts swapped
    expect(joinDeploymentVars({ ...vars, DEPLOYMENT_FOR_LIFE_1: vars.DEPLOYMENT_FOR_LIFE_2, DEPLOYMENT_FOR_LIFE_2: vars.DEPLOYMENT_FOR_LIFE_1 }).problems).toEqual([
      `DEPLOYMENT_FOR_LIFE_1 says it is part 2 of ${n}, not part 1`,
      `DEPLOYMENT_FOR_LIFE_2 says it is part 1 of ${n}, not part 2`,
    ]);
    // a part that names another count
    expect(joinDeploymentVars({ ...vars, DEPLOYMENT_FOR_LIFE_2: { ...(vars.DEPLOYMENT_FOR_LIFE_2 as Json), of: n + 1 } }).problems).toEqual([`DEPLOYMENT_FOR_LIFE_2 says there are ${n + 1} parts, DEPLOYMENT says ${n}`]);
    // every problem leaves no text: readConfig then has no deployment
    expect(joinDeploymentVars(without(vars, "DEPLOYMENT_FOR_LIFE_2")).text).toBeUndefined();
  });

  it("vars of two printouts never join, even when both have as many parts (the R13 review's Medium): another deployment's DEPLOYMENT, or any one of its parts, is refused by its id", () => {
    const a = splitDeploymentVars(encoded(60));
    const b = splitDeploymentVars(encoded(60, `0x${"12".repeat(20)}`));
    const n = partNames(a).length;
    expect(partNames(b).length).toBe(n);
    expect((a.DEPLOYMENT as Json & { forLifeParts: { id: string } }).forLifeParts.id).not.toBe((b.DEPLOYMENT as Json & { forLifeParts: { id: string } }).forLifeParts.id);
    // A's DEPLOYMENT with B's parts: every part is another deployment's
    expect(joinDeploymentVars({ ...b, DEPLOYMENT: a.DEPLOYMENT })).toEqual({ problems: partNames(b).map((p) => `${p} is a part of another deployment than DEPLOYMENT's (its id differs): ${AGAIN}`) });
    // A's vars with one of B's parts left behind
    expect(joinDeploymentVars({ ...a, DEPLOYMENT_FOR_LIFE_2: b.DEPLOYMENT_FOR_LIFE_2 })).toEqual({ problems: [`DEPLOYMENT_FOR_LIFE_2 is a part of another deployment than DEPLOYMENT's (its id differs): ${AGAIN}`] });
    // and readConfig has no config from either
    expect(readConfig({ ...BASE, ...b, DEPLOYMENT: a.DEPLOYMENT }).config).toBeUndefined();
    expect(readConfig({ ...BASE, ...a, DEPLOYMENT_FOR_LIFE_2: b.DEPLOYMENT_FOR_LIFE_2 }).config).toBeUndefined();
  });

  it("an entry edited, dropped or added in any var fails the digest of what was joined, the id copied along or not", () => {
    const vars = splitDeploymentVars(encoded(60));
    const n = partNames(vars).length;
    const p2 = vars.DEPLOYMENT_FOR_LIFE_2 as Json & { values: Json[] };
    const wrong = [`the deployment joined from DEPLOYMENT and its ${n} for-life parts is not the one they were printed from (its digest differs from forLifeParts.id): ${AGAIN}`];
    // one value's address changed
    expect(joinDeploymentVars({ ...vars, DEPLOYMENT_FOR_LIFE_2: { ...p2, values: [{ ...p2.values[0], address: `0x${"99".repeat(20)}` }, ...p2.values.slice(1)] } })).toEqual({ problems: wrong });
    // one entry dropped, one added
    expect(joinDeploymentVars({ ...vars, DEPLOYMENT_FOR_LIFE_2: { ...p2, values: p2.values.slice(1) } }).problems).toEqual(wrong);
    expect(joinDeploymentVars({ ...vars, DEPLOYMENT_FOR_LIFE_2: { ...p2, values: [...p2.values, p2.values[0]] } }).problems).toEqual(wrong);
    // DEPLOYMENT's own fields are under the digest too (its keeper, an address)
    expect(joinDeploymentVars({ ...vars, DEPLOYMENT: { ...(vars.DEPLOYMENT as Json), keeper: `0x${"77".repeat(20)}` } }).problems).toEqual(wrong);
    // the list cut to its first part, that part rewritten to say it is the only one: DEPLOYMENT still says how many
    expect(joinDeploymentVars({ DEPLOYMENT: vars.DEPLOYMENT, DEPLOYMENT_FOR_LIFE_1: { ...(vars.DEPLOYMENT_FOR_LIFE_1 as Json), of: 1 } }).problems[0]).toBe(`DEPLOYMENT_FOR_LIFE_2 is missing: DEPLOYMENT says there are ${n}`);
    // and DEPLOYMENT rewritten to agree with it: the digest of the shortened list isn't the one named
    const cut = { DEPLOYMENT: { ...(vars.DEPLOYMENT as Json), forLifeParts: { ...((vars.DEPLOYMENT as Json).forLifeParts as Json), of: 1 } }, DEPLOYMENT_FOR_LIFE_1: { ...(vars.DEPLOYMENT_FOR_LIFE_1 as Json), of: 1 } };
    expect(joinDeploymentVars(cut).problems).toEqual([`the deployment joined from DEPLOYMENT and its 1 for-life part is not the one they were printed from (its digest differs from forLifeParts.id): ${AGAIN}`]);
  });

  it("a part that is no part is refused: not an object, no numbers, a list that is no list, a key it doesn't know, or bad JSON", () => {
    const vars = splitDeploymentVars(encoded(60));
    const p1 = vars.DEPLOYMENT_FOR_LIFE_1 as Json;
    const bad = (v: unknown) => joinDeploymentVars({ ...vars, DEPLOYMENT_FOR_LIFE_1: v }).problems;
    expect(bad("{not json")).toEqual(["DEPLOYMENT_FOR_LIFE_1 is not a JSON object"]);
    expect(bad([1, 2])).toEqual(["DEPLOYMENT_FOR_LIFE_1 is not a JSON object"]);
    expect(bad(7)).toEqual(["DEPLOYMENT_FOR_LIFE_1 is not a JSON object"]);
    expect(bad({ ...p1, part: "1" })).toEqual(["DEPLOYMENT_FOR_LIFE_1 doesn't say which part of how many it is (part, of)"]);
    expect(bad({ ...p1, of: 0 })).toEqual(["DEPLOYMENT_FOR_LIFE_1 doesn't say which part of how many it is (part, of)"]);
    expect(bad({ ...p1, of: 1.5 })).toEqual(["DEPLOYMENT_FOR_LIFE_1 doesn't say which part of how many it is (part, of)"]);
    expect(bad({ ...p1, values: "all of them" })).toEqual(["DEPLOYMENT_FOR_LIFE_1's values is not a list"]);
    expect(bad({ ...p1, extra: [] })).toEqual(['DEPLOYMENT_FOR_LIFE_1 has a key that is no part of a for-life list: "extra"']);
    // a part with no id, or another's
    const { id: _id, ...noId } = p1;
    expect(bad(noId)).toEqual([`DEPLOYMENT_FOR_LIFE_1 is a part of another deployment than DEPLOYMENT's (its id differs): ${AGAIN}`]);
  });

  it("DEPLOYMENT must say how its for-life list comes: its own list and parts too, parts it doesn't name, or a forLifeParts that is no { of, id }, are each refused", () => {
    const d = encoded(60);
    const vars = splitDeploymentVars(d);
    const core = vars.DEPLOYMENT as Json;
    const n = partNames(vars).length;
    expect(joinDeploymentVars({ ...vars, DEPLOYMENT: d }).problems).toEqual(["DEPLOYMENT has its own for-life list, and DEPLOYMENT_FOR_LIFE_1 is set too: one or the other"]);
    expect(joinDeploymentVars({ DEPLOYMENT: { ...d, forLifeParts: core.forLifeParts } }).problems).toEqual(["DEPLOYMENT has its own for-life list, and says it is in parts (forLifeParts) too: one or the other"]);
    expect(joinDeploymentVars({ ...vars, DEPLOYMENT: "{not json" }).problems).toEqual(["DEPLOYMENT is not a JSON object, so its DEPLOYMENT_FOR_LIFE parts can't be joined to it"]);
    expect(joinDeploymentVars({ ...vars, DEPLOYMENT: [1] }).problems).toEqual(["DEPLOYMENT is not a JSON object, so its DEPLOYMENT_FOR_LIFE parts can't be joined to it"]);
    // parts set, and a DEPLOYMENT that doesn't name them (an older printout's, or one typed by hand)
    const { forLifeParts: _gone, ...unnamed } = core;
    expect(joinDeploymentVars({ ...vars, DEPLOYMENT: unnamed }).problems).toEqual([`DEPLOYMENT_FOR_LIFE_1 is set, but DEPLOYMENT doesn't say how many parts its for-life list is in (forLifeParts): ${AGAIN}`]);
    const notParts = [`DEPLOYMENT's forLifeParts is not { of, id } (a count of parts and the deployment's digest): ${AGAIN}`];
    for (const bad of [null, 3, "3", [], { of: n }, { of: "3", id: (core.forLifeParts as Json).id }, { of: 0, id: (core.forLifeParts as Json).id }, { of: n, id: "0x12" }, { of: n, id: `0x${"AB".repeat(32)}` }, { ...(core.forLifeParts as Json), more: 1 }]) {
      expect(joinDeploymentVars({ ...vars, DEPLOYMENT: { ...core, forLifeParts: bad } }).problems, JSON.stringify(bad)).toEqual(notParts);
    }
    // more parts than the Worker reads is refused, never cut short
    expect(joinDeploymentVars({ ...vars, DEPLOYMENT: { ...core, forLifeParts: { ...(core.forLifeParts as Json), of: MAX_FOR_LIFE_PARTS + 1 } } }).problems).toEqual([`DEPLOYMENT says its for-life list is in ${MAX_FOR_LIFE_PARTS + 1} parts, above the ${MAX_FOR_LIFE_PARTS} the keeper reads`]);
    // as text too: a DEPLOYMENT string that names parts is in parts
    expect(joinDeploymentVars({ DEPLOYMENT: JSON.stringify(core) }).problems[0]).toBe(`DEPLOYMENT_FOR_LIFE_1 is missing: DEPLOYMENT says there are ${n}`);
  });

  it("a split refuses what it can't carry whole: one entry above a var, the deployment's own part above one, a for-life list with a key it doesn't know or with nothing to move out", () => {
    const d = encoded(60) as Json & { forLife: { values: Json[]; code: Json[]; pools: Json[] } };
    const huge = { ...d, forLife: { ...d.forLife, values: [{ ...d.forLife.values[0], fn: "x".repeat(VAR_TARGET_BYTES) }, ...d.forLife.values] } };
    expect(() => splitDeploymentVars(huge)).toThrow(/one entry of the for-life list \(values\) is \d+ bytes, above a Worker var's 4500; nothing split/);
    expect(() => splitDeploymentVars({ ...d, padding: "x".repeat(VAR_TARGET_BYTES) })).toThrow(/the deployment without its for-life list is \d+ bytes, above a Worker var's 4500; nothing split/);
    // a deployment above the limit with no for-life list to move out
    expect(() => splitDeploymentVars({ padding: "x".repeat(VAR_TARGET_BYTES) })).toThrow(/has no for-life list to split/);
    // a fourth list would vanish in the join: refused at the split (the review's Low 3)
    expect(() => splitDeploymentVars({ ...d, forLife: { ...d.forLife, proxies: [] } })).toThrow(/the for-life list has a key the split doesn't carry \(proxies\); nothing split/);
    // lists all empty and the whole just above a var (4,509 bytes): moving an empty list out frees nothing, so it is
    // refused, never printed as a DEPLOYMENT with no for-life list at all (the review's Nit 5)
    const empty = { padding: "x".repeat(VAR_TARGET_BYTES - 50), forLife: { values: [], code: [], pools: [] } };
    expect(varBytes(empty)).toBeGreaterThan(VAR_TARGET_BYTES);
    expect(() => splitDeploymentVars(empty)).toThrow(/nothing split/);
    expect(() => splitDeploymentVars({ ...d, forLifeParts: { of: 1, id: "0x" } })).toThrow(/already has a forLifeParts key/);
  });

  it("bytes are counted as UTF-8 of the compact JSON, as Cloudflare measures a var", () => {
    expect(varBytes({ a: 1 })).toBe(7);
    expect(varBytes("é")).toBe(4);
    expect(VAR_TARGET_BYTES).toBeLessThan(VAR_MAX_BYTES);
    expect(VAR_MAX_BYTES).toBe(5_000);
  });
});

describe("readConfig joins the parts", () => {
  it("the split vars read as the whole deployment", () => {
    const d = encoded(60);
    const whole = readConfig({ ...BASE, DEPLOYMENT: d });
    const split = readConfig({ ...BASE, ...splitDeploymentVars(d) });
    expect(whole.problems).toEqual([]);
    expect(split.problems).toEqual([]);
    expect(split.config).toEqual(whole.config);
    expect(split.config!.deployment.forLife.values).toHaveLength(60);
    expect(split.config!.deployment).not.toHaveProperty("forLifeParts");
  });

  it("a missing part leaves no config: the keeper is not ready, by name", () => {
    const vars = splitDeploymentVars(encoded(60));
    const n = partNames(vars).length;
    const r = readConfig({ ...BASE, ...without(vars, `DEPLOYMENT_FOR_LIFE_${n}`) });
    expect(r.config).toBeUndefined();
    expect(r.problems).toEqual([`DEPLOYMENT_FOR_LIFE_${n} is missing: DEPLOYMENT says there are ${n}`]);
  });

  it("parts gone altogether leave no config either: DEPLOYMENT names them, so each is missing", () => {
    const vars = splitDeploymentVars(encoded(60));
    const r = readConfig({ ...BASE, DEPLOYMENT: vars.DEPLOYMENT });
    expect(r.config).toBeUndefined();
    expect(r.problems[0]).toMatch(/^DEPLOYMENT_FOR_LIFE_1 is missing/);
  });
});
