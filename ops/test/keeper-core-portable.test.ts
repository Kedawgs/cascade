import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The keeper's portable core (design-keeper-worker.md §1): ops/src/keeper/core/ runs on the founder's PC (the hand run)
// and in the cascade-keeper Worker (Task 50b), so nothing under it may reach Node: no `node:` module, no fs or
// child_process, no `process`, no `require`, no Buffer, no file location (import.meta, __dirname). Every import stays
// inside core/ or is viem, or one of @noble/hashes' modules (pure JS, and the version viem itself depends on: the
// vault's coldkey is a blake2b, which viem lacks); the one data file it may bundle is the published vault ABI
// (contracts/abi/*.json). So the whole closure of the core is portable, not only its own files.

const CORE = fileURLToPath(new URL("../src/keeper/core/", import.meta.url));
const PUBLISHED_ABI = fileURLToPath(new URL("../../contracts/abi/", import.meta.url));

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

/** The source without its comments (a comment may say "the process" or quote a Node module). */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");

/** Every module specifier a file names: static imports and re-exports, side-effect imports, dynamic imports. */
function specifiers(src: string): string[] {
  const out: string[] = [];
  const c = code(src);
  for (const re of [/\b(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g]) {
    for (const m of c.matchAll(re)) out.push(m[1]);
  }
  return out;
}

const NODE_ONLY: [RegExp, string][] = [
  [/\bprocess\s*\.|\bprocess\s*\[|\bglobalThis\s*\.\s*process\b|\btypeof\s+process\b/, "process"],
  [/\brequire\s*\(/, "require"],
  [/\bBuffer\b/, "Buffer"],
  [/\b__dirname\b|\b__filename\b/, "__dirname"],
  [/\bimport\.meta\b/, "import.meta"],
];
const NODE_MODULES = /^(node:|fs$|fs\/|path$|os$|url$|child_process$|crypto$|util$|stream$|events$|http$|https$|net$|tls$|worker_threads$)/;

/** Why `file` (its source `src`) is not portable: each Node-only use and each import that leaves the core. */
export function portabilityProblems(file: string, src: string): string[] {
  const out: string[] = [];
  const at = relative(CORE, file);
  for (const [re, what] of NODE_ONLY) if (re.test(code(src))) out.push(`${at}: uses ${what}`);
  for (const s of specifiers(src)) {
    if (NODE_MODULES.test(s)) out.push(`${at}: imports the Node module ${s}`);
    else if (s.startsWith(".")) {
      const target = resolve(dirname(file), s);
      const inCore = target.startsWith(CORE);
      const publishedAbi = target.startsWith(PUBLISHED_ABI) && target.endsWith(".json");
      if (!inCore && !publishedAbi) out.push(`${at}: imports ${s}, outside the core`);
      if (inCore && !existsSync(target)) out.push(`${at}: imports ${s}, which does not exist`);
    } else if (s !== "viem" && !s.startsWith("viem/") && !s.startsWith("@noble/hashes/")) out.push(`${at}: imports the package ${s} (the core uses viem and @noble/hashes only)`);
  }
  return out;
}

describe("the keeper's core is portable (viem, @noble/hashes and fetch only)", () => {
  it("coreIsPortable: no file under core/ reaches Node, and every import stays inside the core or is viem", () => {
    expect(existsSync(CORE)).toBe(true);
    const files = tsFiles(CORE);
    // the pieces the design note moves there (§1), each present
    const names = files.map((f) => relative(CORE, f).split(sep).join("/"));
    for (const name of [
      "errors.ts",
      "failures.ts",
      "due.ts",
      "payouts.ts",
      "batch.ts",
      "delivery.ts",
      "rewards.ts",
      "status.ts",
      "rpc.ts",
      "logs.ts",
      "actions.ts",
      "round.ts",
      "memory.ts",
      "send.ts",
      "journal.ts",
      "abi.ts",
      "deployment.ts",
      "v32/reads.ts",
      "v32/actions.ts",
      "v32/readiness.ts",
      // Task 50a: the monitor's hold, the outside-price veto, v3.2's rails
      "hold.ts",
      "veto.ts",
      "v32/rails.ts",
    ]) {
      expect(names, name).toContain(name);
    }
    const problems = files.flatMap((f) => portabilityProblems(f, readFileSync(f, "utf8")));
    expect(problems).toEqual([]);
  });

  it("the check itself refuses each kind of Node reach (so a pass means something)", () => {
    const f = join(CORE, "example.ts");
    expect(portabilityProblems(f, `import { readFileSync } from "node:fs";`)).toEqual(["example.ts: imports the Node module node:fs"]);
    expect(portabilityProblems(f, `import { execFile } from "child_process";`)).toEqual(["example.ts: imports the Node module child_process"]);
    expect(portabilityProblems(f, `const k = process.env.KEY;`)).toEqual(["example.ts: uses process"]);
    expect(portabilityProblems(f, `import { WALLET } from "../../config.ts";`)).toEqual(["example.ts: imports ../../config.ts, outside the core"]);
    expect(portabilityProblems(f, `import type { Ctx } from "../../send.ts";`)).toEqual(["example.ts: imports ../../send.ts, outside the core"]);
    expect(portabilityProblems(f, `import { ethers } from "ethers";`)).toEqual(["example.ts: imports the package ethers (the core uses viem and @noble/hashes only)"]);
    expect(portabilityProblems(f, `import * as noble from "@noble/hashes";`)).toEqual(["example.ts: imports the package @noble/hashes (the core uses viem and @noble/hashes only)"]);
    expect(portabilityProblems(f, `const u = new URL("./x", import.meta.url);`)).toEqual(["example.ts: uses import.meta"]);
    // what is allowed: viem, @noble/hashes' modules (pure JS, viem's own dependency), the core's own files, the
    // published vault ABI, and the word in a comment
    expect(portabilityProblems(f, `import { keccak256 } from "viem";\n// for the life of the process.env\nimport { oneLine } from "./failures.ts";`)).toEqual([]);
    expect(portabilityProblems(f, `import { blake2b } from "@noble/hashes/blake2";`)).toEqual([]);
    expect(portabilityProblems(f, `import vault from "../../../../contracts/abi/CascadeVault.json" with { type: "json" };`)).toEqual([]);
  });
});
