import { readFileSync } from "node:fs";
import { type Abi, type AbiParameter, parseUnits } from "viem";

// The sources test/v32-plan.test.ts reads v3.2's launch values from, never retyped: the spec's Appendix B, the
// contracts' test fixtures (DefaultParams.sol's withLaunchValues, AdapterGas.t.sol's gas models), the contracts'
// constants, the build's link graph (LibraryLinks.sol) and the build itself (contracts/out, read only).

const text = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

export const SPEC = "docs/superpowers/specs/2026-10-31-cascade-v3.2-design.md";
export const specText = () => text(SPEC);

// ---- Appendix B ----

interface Row {
  /** The parameter cell, backticks removed. */
  cell: string;
  /** The launch-value cell, whole. */
  value: string;
  names: string[];
  values: string[];
  /** Whether the row names several parameters, split on " / " alike in both cells. */
  combined: boolean;
}

/** An amount as Appendix B writes one: digits, with thousands commas or none, then any decimals. */
const AMOUNT = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
/** Every amount in a text: digits that are not part of a word ("0x34D1f7DC…" holds none). */
const AMOUNTS = new RegExp(String.raw`(?<![\w.,])(?:${AMOUNT})(?!\w)`, "g");
/** One value of the "a + b" shape (the batch limits), which holds two amounts and is still one value. */
const PAIR = /^\d+ \+ \d+$/;
/** A "(…)" note after a value, with at most one level of parentheses inside. */
const NOTE = String.raw`\((?:[^()]|\([^()]*\))*\)`;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The table of Appendix B in `spec`: each row's parameter names and launch values, split on " / " where both cells
 * split alike. */
function appendixRowsOf(spec: string): Row[] {
  const start = spec.indexOf("## Appendix B");
  const end = spec.indexOf("\n## ", start + 1);
  if (start < 0 || end < 0) throw new Error("the spec has no Appendix B");
  const rows: Row[] = [];
  for (const line of spec.slice(start, end).split("\n")) {
    if (!line.startsWith("| ") || line.startsWith("| Parameter") || line.startsWith("|---")) continue;
    const cells = line.split(" | ").map((c) => c.replace(/^\| /, "").trim());
    const cell = cells[0].replaceAll("`", "");
    const value = cells[1];
    const names = cell.split(" / ").map((n) => n.trim());
    const values = value.split(" / ").map((v) => v.trim());
    const combined = names.length > 1 && names.length === values.length;
    rows.push(combined ? { cell, value, names, values, combined } : { cell, value, names: [cell], values: [value], combined });
  }
  return rows;
}

/** The amount `value` is, exactly, as its digits (commas dropped): the amount (after a "$" when `dollar`), its unit, an
 * optional "each" (after a unit), then an optional "(…)" note or "= …" gloss, and nothing else. A unit-less value
 * takes no trailing word, so "1 TAO" is refused where a plain number is read. */
export function amountOf(value: string, unit: string, o: { dollar?: boolean } = {}): string {
  const u = unit ? String.raw`\s*${escape(unit)}(?:\s+each)?` : "";
  const m = value.match(new RegExp(String.raw`^${o.dollar ? "\\$" : ""}(${AMOUNT})${u}(?:\s+${NOTE}|\s+=\s+.+)?$`));
  if (!m) {
    throw new Error(
      `Appendix B's "${value}" is not exactly ${o.dollar ? "a dollar amount" : `an amount in ${unit || "plain numbers"}`} (then at most "each", a "(…)" note or an "= …" gloss)`,
    );
  }
  return m[1].replaceAll(",", "");
}

/** Appendix B's readers over `spec`. The module's own readers below read the real spec. */
export function appendixReaders(spec: string) {
  const rows = appendixRowsOf(spec);

  /** The launch value Appendix B gives `name`: a row's whole parameter cell, or one of its " / " parts. A name in a
   * row of its own wins over the same name inside a combined row (`treasury`). A combined row is read only when each
   * of its parts holds one value (no ";", no second amount but an "a + b" pair's), so its parts line up with its
   * names. */
  function appendixB(name: string): string {
    const own = rows.find((r) => r.cell === name);
    if (own) return own.value;
    const hits = rows.filter((r) => r.names.includes(name));
    if (hits.length !== 1) throw new Error(`Appendix B names "${name}" ${hits.length} times`);
    const r = hits[0];
    const unread = r.values.filter((v) => v.includes(";") || (!PAIR.test(v) && (v.match(AMOUNTS)?.length ?? 0) > 1));
    if (unread.length) {
      throw new Error(`Appendix B's row "${r.cell}" may not line up with its names: ${unread.map((v) => `"${v}"`).join(", ")} holds ";" or a second amount`);
    }
    return r.values[r.names.indexOf(name)];
  }

  return {
    appendixB,
    /** "40 TAO", "0.015 TAO", "50 TAO each", "0.01 TAO (…)" as wei. */
    abTao: (name: string) => parseUnits(amountOf(appendixB(name), "TAO"), 18),
    /** "0.0001 ETH" as wei. */
    abEth: (name: string) => parseUnits(amountOf(appendixB(name), "ETH"), 18),
    /** "1 h", "24 h" as seconds. */
    abHours: (name: string) => BigInt(amountOf(appendixB(name), "h")) * 3_600n,
    /** "7 days" as seconds. */
    abDays: (name: string) => BigInt(amountOf(appendixB(name), "days")) * 86_400n,
    /** "1%", "0.15%", "10%" as bps; a plain number ("2,000", "0") is bps already. */
    abBps(name: string): bigint {
      const value = appendixB(name);
      return /^[\d.]+%/.test(value) ? parseUnits(amountOf(value, "%"), 2) : BigInt(amountOf(value, ""));
    },
    /** "8453", "400,000", "10", "0", "1,000,000 rao = …" as a whole number (in `unit` when given). */
    abInt: (name: string, unit = "") => BigInt(amountOf(appendixB(name), unit)),
    /** "$0.05" as USDC units. */
    abUsdc: (name: string) => parseUnits(amountOf(appendixB(name), "", { dollar: true }), 6),
    /** A cell that is one full address, in backticks or not. */
    abAddress(name: string): string {
      const m = appendixB(name).match(/^`?(0x[0-9a-fA-F]{40})`?$/);
      if (!m) throw new Error(`Appendix B's ${name} is not exactly one full address`);
      return m[1];
    },
    /** "50 + 50" as two counts. */
    abPair(name: string): [bigint, bigint] {
      const m = appendixB(name).match(/^(\d+) \+ (\d+)$/);
      if (!m) throw new Error(`Appendix B's ${name} is not "a + b"`);
      return [BigInt(m[1]), BigInt(m[2])];
    },
    /** "vault 7,200, front door 120: …" (milliseconds, Revision 28) */
    abMsPerBlock(): { vault: bigint; frontDoor: bigint } {
      const m = appendixB("msPerBlock").match(/^vault (\d{1,3}(?:,\d{3})*), front door (\d{1,3}(?:,\d{3})*)(?:: .+)?$/);
      if (!m) throw new Error("Appendix B's msPerBlock does not read 'vault N, front door M'");
      return { vault: BigInt(m[1].replaceAll(",", "")), frontDoor: BigInt(m[2].replaceAll(",", "")) };
    },
  };
}

let real: ReturnType<typeof appendixReaders> | undefined;
const ab = () => (real ??= appendixReaders(specText()));

export const appendixB = (name: string) => ab().appendixB(name);
export const abTao = (name: string) => ab().abTao(name);
export const abEth = (name: string) => ab().abEth(name);
export const abHours = (name: string) => ab().abHours(name);
export const abDays = (name: string) => ab().abDays(name);
export const abBps = (name: string) => ab().abBps(name);
export const abInt = (name: string, unit = "") => ab().abInt(name, unit);
export const abUsdc = (name: string) => ab().abUsdc(name);
export const abAddress = (name: string) => ab().abAddress(name);
export const abPair = (name: string) => ab().abPair(name);
export const abMsPerBlock = () => ab().abMsPerBlock();

// ---- §8.1's kept list ----

/** What §8.1 names as kept on each target: the vault's list ("The vault keeps only what … read from it directly (…)
 * and `extsload`; no on-chain caller reads anything else") and the front door's getters that on-chain callers read
 * ("… stay public: `asset` and `usdc` … and `oracle` …"), each name in backticks. */
export function specKept(): { vault: string[]; frontDoor: string[] } {
  const s = specText().replace(/\s+/g, " ");
  const vault = s.match(/The vault keeps only what [^(]*read from it directly \((.*?); no on-chain caller reads anything else/);
  const door = s.match(/The front door's getters that on-chain callers read stay public: (.*?)\./);
  if (!vault || !door) throw new Error("the spec's §8.1 no longer names the kept getters as this reader expects");
  const ticked = (t: string) => [...t.matchAll(/`(\w+)`/g)].map((m) => m[1]);
  return { vault: ticked(vault[1]), frontDoor: ticked(door[1]) };
}

// ---- Solidity sources ----

const UNITS: Record<string, bigint> = { seconds: 1n, minutes: 60n, hours: 3_600n, days: 86_400n, weeks: 604_800n, wei: 1n, gwei: 10n ** 9n, ether: 10n ** 18n };

/** A Solidity number literal (underscores, a decimal point, an exponent, a time or ether unit) exactly; undefined
 * for any other expression. */
export function solNumber(expr: string): bigint | undefined {
  const m = expr.trim().match(/^(\d[\d_]*)(?:\.(\d[\d_]*))?(?:e(\d+))?(?:\s+(seconds|minutes|hours|days|weeks|wei|gwei|ether))?$/);
  if (!m) return undefined;
  const whole = m[1].replaceAll("_", "");
  const frac = (m[2] ?? "").replaceAll("_", "");
  const exp = BigInt(m[3] ?? "0");
  const digits = BigInt(whole + frac);
  const shift = exp - BigInt(frac.length);
  if (shift < 0n) {
    const d = 10n ** -shift;
    if (digits % d !== 0n) return undefined;
    return (digits / d) * UNITS[m[4] ?? "wei"];
  }
  return digits * 10n ** shift * UNITS[m[4] ?? "wei"];
}

/** A constant's value in a contracts/ source: `<type> [visibility] constant NAME = <literal>;`. */
export function solConstant(path: string, name: string): bigint {
  const m = text(path).match(new RegExp(`\\b(?:u?int\\d*)\\s+(?:public\\s+|internal\\s+|private\\s+)?constant\\s+${name}\\s*=\\s*([^;]+);`));
  const v = m ? solNumber(m[1]) : undefined;
  if (v === undefined) throw new Error(`${path} has no number constant ${name}`);
  return v;
}

/** The `p.field = expr;` assignments of the function whose header matches `header` in DefaultParams.sol. */
function assignments(src: string, header: RegExp): Record<string, string> {
  const m = src.match(header);
  if (!m || m.index === undefined) throw new Error(`DefaultParams.sol has no ${header}`);
  const open = src.indexOf("{", m.index + m[0].length - 1);
  const close = src.indexOf("\n}", open);
  const out: Record<string, string> = {};
  for (const a of src.slice(open + 1, close).matchAll(/p\.(\w+)\s*=\s*([^;]+);/g)) out[a[1]] = a[2].trim();
  return out;
}

export type FixtureValues = Record<string, bigint | string>;

/** The launch values the contracts' tests build (contracts/test/utils/DefaultParams.sol): each Params' fixture
 * defaults with withLaunchValues over them, a literal as its number and a named constant as its value; anything
 * else (a party, a fixture address) as its source text. */
export function defaultParamsLaunchValues(): { vault: FixtureValues; frontDoor: FixtureValues; staker: FixtureValues } {
  const path = "contracts/test/utils/DefaultParams.sol";
  const src = text(path);
  const value = (expr: string): bigint | string => {
    const n = solNumber(expr);
    if (n !== undefined) return n;
    if (/^[A-Z][A-Z0-9_]*$/.test(expr)) {
      try {
        return solConstant(path, expr);
      } catch {
        return expr;
      }
    }
    return expr;
  };
  const values = (a: Record<string, string>) => Object.fromEntries(Object.entries(a).map(([k, e]) => [k, value(e)]));
  return {
    vault: values({
      ...assignments(src, /function defaultVaultParams\(/),
      ...assignments(src, /function withLaunchValues\(CascadeVault\.Params memory p\)/),
    }),
    frontDoor: values({
      ...assignments(src, /function defaultFrontDoorParams\(/),
      ...assignments(src, /function withLaunchValues\(CascadeFrontDoor\.Params memory p\)/),
    }),
    staker: values(assignments(src, /function defaultStakerParams\(/)),
  };
}

/** An enum member's index in a source: `enum Name { A, B }`. */
export function solEnumIndex(path: string, enumName: string, member: string): number {
  const m = text(path).match(new RegExp(`enum\\s+${enumName}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`${path} has no enum ${enumName}`);
  const i = m[1].split(",").map((s) => s.trim()).indexOf(member);
  if (i < 0) throw new Error(`${enumName} has no ${member}`);
  return i;
}

// ---- the build's link graph and artifacts ----

/** The libraries each linking artifact's runtime code links, from contracts/test/utils/generated/LibraryLinks.sol
 * (generated from the build): its function per linking artifact (cascadeVault, cascadePayoutLib, …), by contract. */
export function libraryLinks(): Record<string, string[]> {
  const src = text("contracts/test/utils/generated/LibraryLinks.sol");
  const out: Record<string, string[]> = {};
  for (const f of src.matchAll(/\/\/\/ (\w+)'s runtime code links ([^.]+)\.\s*\n\s*function (\w+)\(\)[^{]*\{([\s\S]*?)\n {4}\}/g)) {
    out[f[1]] = [...f[4].matchAll(/links\[\d+\]\.name = "(\w+)";/g)].map((n) => n[1]);
  }
  return out;
}

export interface RawArtifact {
  abi: Abi;
  bytecode: { object: string; linkReferences: Record<string, Record<string, { start: number; length: number }[]>> };
  metadata: { settings: { compilationTarget: Record<string, string> } };
}

/** A contract's artifact in contracts/out (built from this commit; read only, never rebuilt). */
export const artifact = (name: string): RawArtifact => JSON.parse(text(`contracts/out/${name}.sol/${name}.json`)) as RawArtifact;

/** The constructor's inputs, or none. */
export const constructorInputs = (a: RawArtifact): readonly AbiParameter[] =>
  (a.abi.find((i) => i.type === "constructor") as { inputs: readonly AbiParameter[] } | undefined)?.inputs ?? [];

/** Every leaf of the constructor's inputs as a dotted path (a tuple's components inside it; an array a leaf). */
export function constructorLeaves(a: RawArtifact): string[] {
  const walk = (ps: readonly AbiParameter[], prefix: string): string[] =>
    ps.flatMap((p) => {
      const path = `${prefix}${p.name}`;
      return p.type === "tuple" ? walk((p as { components: readonly AbiParameter[] }).components, `${path}.`) : [path];
    });
  return walk(constructorInputs(a), "");
}
