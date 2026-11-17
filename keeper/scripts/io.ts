import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";

// What the keeper's scripts ask and run: a password asked for without echo, a typed confirmation, and `wrangler secret
// put` from this folder with the value on its stdin (never in an argument, a file or the clipboard).

export const KEEPER_DIR = fileURLToPath(new URL("..", import.meta.url));

export interface Io {
  /** Asks without showing what is typed */
  hidden(prompt: string): Promise<string>;
  /** Asks, showing what is typed */
  line(prompt: string): Promise<string>;
  /** A line for the person (stdout carries only what the script reports) */
  say(line: string): void;
  /** `wrangler <args>` from the keeper folder, `value` on its stdin: its exit code */
  wrangler(args: string[], value: string): Promise<number>;
}

let lines: Interface | undefined;
let queued: string[] = [];
let waiting: ((l: string) => void)[] = [];
/** The next line of a stdin that isn't a terminal (a pipe: the tests) */
function nextLine(): Promise<string> {
  if (!lines) {
    lines = createInterface({ input: process.stdin, terminal: false });
    lines.on("line", (l) => {
      const w = waiting.shift();
      if (w) w(l);
      else queued.push(l);
    });
    lines.on("close", () => {
      for (const w of waiting) w("");
      waiting = [];
    });
  }
  const q = queued.shift();
  if (q !== undefined) return Promise.resolve(q);
  return new Promise((r) => waiting.push(r));
}

export function closeIo() {
  lines?.close();
  lines = undefined;
  queued = [];
}

export const consoleIo: Io = {
  async hidden(prompt) {
    process.stderr.write(prompt);
    const stdin = process.stdin;
    if (!stdin.isTTY) return nextLine();
    return new Promise((resolve, reject) => {
      let s = "";
      const done = () => {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off("data", on);
        process.stderr.write("\n");
      };
      const on = (chunk: string) => {
        for (const c of chunk) {
          if (c === "\r" || c === "\n") {
            done();
            resolve(s);
            return;
          }
          if (c === "\u0003") {
            done();
            reject(new Error("cancelled"));
            return;
          }
          if (c === "\u007f" || c === "\b") s = s.slice(0, -1);
          else s += c;
        }
      };
      stdin.setRawMode(true);
      stdin.setEncoding("utf8");
      stdin.resume();
      stdin.on("data", on);
    });
  },
  async line(prompt) {
    process.stderr.write(prompt);
    return nextLine();
  },
  say: (line) => console.log(line),
  wrangler(args, value) {
    return new Promise((resolve) => {
      const win = process.platform === "win32";
      // the value goes on stdin only; the arguments are fixed words (a secret's name and the environment)
      const child = spawn(win ? "wrangler.cmd" : "wrangler", args, { cwd: KEEPER_DIR, stdio: ["pipe", "inherit", "inherit"], shell: win, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
      child.on("error", () => resolve(127));
      child.on("close", (code) => resolve(code ?? 1));
      child.stdin.end(value);
    });
  },
};

/** `--name value` from argv (`valued`: the flags that take a value), `--flag`, and the rest */
export function argsOf(argv: string[], valued: string[]) {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued.includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      values[a] = v;
      i++;
    } else if (a.startsWith("--")) flags.add(a);
    else positional.push(a);
  }
  return { value: (name: string): string | undefined => values[name], flag: (name: string) => flags.has(name), flags, positional };
}

export const ENVS = ["test", "production"] as const;
export type KeeperEnvName = (typeof ENVS)[number];

/** The confirmation every secret put needs: the environment's name typed out. */
export async function confirmed(io: Io, env: KeeperEnvName, what: string): Promise<boolean> {
  const typed = (await io.line(`To put ${what} into cascade-keeper-${env}, type ${env}: `)).trim();
  if (typed === env) return true;
  io.say(`Not put: you typed "${typed.slice(0, 40)}", not ${env}.`);
  return false;
}

/** Whether this module is the script node was asked to run */
export function isMain(url: string): boolean {
  const ran = process.argv[1] ? resolve(process.argv[1]) : "";
  const me = fileURLToPath(url);
  return process.platform === "win32" ? ran.toLowerCase() === me.toLowerCase() : ran === me;
}
