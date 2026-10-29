import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** A path inside the indexer package, or (with `..`) inside the repository. */
export const pkg = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

/** Every file under `dir`, recursively. */
export function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

/** A JSONC file (comments and trailing commas allowed), parsed with TypeScript's own reader. */
export function readJsonc(path: string): unknown {
  const { config, error } = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
  if (error) throw new Error(`${path} is not valid JSONC: ${ts.flattenDiagnosticMessageText(error.messageText, "\n")}`);
  return config;
}
