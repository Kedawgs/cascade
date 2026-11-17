import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import type { Io } from "../../scripts/io.ts";
import { decryptKey, encryptKey, type Keystore } from "../../scripts/keystore.ts";
import { newKey, putKey } from "../../scripts/new-key.ts";

// pnpm keeper:new-key (the founder's 2026-11-07 decision): the key is made in memory, written only as a
// password-protected keystore on the PC, and, with --put-secret and the environment typed out, piped over stdin
// straight into `wrangler secret put KEEPER_PRIVATE_KEY` from this folder. Only the address is printed. Tests use a fake
// wrangler (here, and on the PATH for the run as a script) and keys made for the test; the keystores' scrypt is
// lowered in the function tests so they run fast.

const FAST = { n: 1024, r: 8, p: 1 };
const PASSWORD = "correct horse battery staple";

function fakeIo(answers: { hidden?: string[]; line?: string[]; wrangler?: number } = {}) {
  const hidden = [...(answers.hidden ?? [PASSWORD, PASSWORD])];
  const line = [...(answers.line ?? [])];
  const said: string[] = [];
  const asked: string[] = [];
  const ran: { args: string[]; value: string }[] = [];
  const io: Io = {
    hidden: async (p) => {
      asked.push(p);
      return hidden.shift() ?? "";
    },
    line: async (p) => {
      asked.push(p);
      return line.shift() ?? "";
    },
    say: (l) => said.push(l),
    wrangler: async (args, value) => {
      ran.push({ args, value });
      return answers.wrangler ?? 0;
    },
  };
  return { io, said, asked, ran };
}

const dir = () => mkdtempSync(join(tmpdir(), "keeper-new-key-"));
const keyIn = (said: string[], ran: { value: string }[]) => [...said, ...ran.map((r) => r.value)].join("\n");

describe("the keystore", () => {
  it("opens the Web3 Secret Storage format's published scrypt test vector (what geth and cast read)", () => {
    const vector: Keystore = {
      version: 3,
      id: "3198bc9c-6672-5ab3-d995-4942343ae5b6",
      address: "008aeeda4d805471df9b2a5b0f38a0c3bcba786b",
      crypto: {
        cipher: "aes-128-ctr",
        cipherparams: { iv: "83dbcc02d8ccb40e466191a123791e0e" },
        ciphertext: "d172bf743a674da9cdad04534d56926ef8358534d458fffccd4e6ad2fbde479c",
        kdf: "scrypt",
        kdfparams: { dklen: 32, n: 262144, r: 1, p: 8, salt: "ab0c7876052600dd703518d6fc3fe8984592145b591fc8fb5c6d43190334ba19" },
        mac: "2103ac29920d71da29f15d75b4a16dbe95cfd7ff8faea1056c33131d846e3097",
      },
    };
    expect(decryptKey(vector, "testpassword")).toBe("0x7a28b5ba57c53603b0b07b56bba752f7784bf506fa95edc395f5cf6c7514fe9d");
    expect(() => decryptKey(vector, "wrong")).toThrow("wrong password (the keystore's MAC doesn't match)");
  });

  it("seals and opens a key, geth's cost by default, with its address beside it", () => {
    const key = `0x${"42".repeat(32)}` as Hex;
    const ks = encryptKey(key, PASSWORD, FAST);
    expect(ks).toMatchObject({ version: 3, address: privateKeyToAccount(key).address.slice(2).toLowerCase(), crypto: { kdf: "scrypt", cipher: "aes-128-ctr" } });
    expect(JSON.stringify(ks)).not.toContain("42".repeat(32));
    expect(decryptKey(ks, PASSWORD)).toBe(key);
  });
});

describe("pnpm keeper:new-key", () => {
  it("makes the key, writes only its keystore, and with --put-secret and the environment typed pipes it into wrangler; it prints only the address", async () => {
    const d = dir();
    const path = join(d, "keeper.json");
    const f = fakeIo({ line: ["production"] });
    expect(await newKey(["--env", "production", "--keystore", path, "--put-secret"], f.io, { kdf: FAST })).toBe(0);
    expect(f.ran).toHaveLength(1);
    expect(f.ran[0].args).toEqual(["secret", "put", "KEEPER_PRIVATE_KEY", "--env", "production"]);
    const key = f.ran[0].value as Hex;
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
    const address = privateKeyToAccount(key).address;
    expect(decryptKey(JSON.parse(readFileSync(path, "utf8")), PASSWORD)).toBe(key);
    expect(readdirSync(d)).toEqual(["keeper.json"]);
    expect(f.said).toEqual([
      `The keeper's address: ${address}`,
      `Its keystore (password-protected): ${path}`,
      "KEEPER_PRIVATE_KEY is set on cascade-keeper-production.",
    ]);
    expect(f.said.join("\n").toLowerCase()).not.toContain(key.slice(2));
    expect(f.asked).toEqual(["Password for the keeper's keystore (at least 12 characters, not shown): ", "The same password again: ", "To put the keeper's key into cascade-keeper-production, type production: "]);
  });

  it("without --put-secret: no wrangler at all, and it says how to put it later", async () => {
    const path = join(dir(), "k.json");
    const f = fakeIo();
    expect(await newKey(["--env", "test", "--keystore", path], f.io, { kdf: FAST })).toBe(0);
    expect(f.ran).toEqual([]);
    expect(f.said.at(-1)).toBe(`Not put into a Worker secret. To put it later: pnpm keeper:put-key -- --env test --keystore ${path}`);
  });

  it("anything but the environment typed out puts nothing (the keystore is kept)", async () => {
    const path = join(dir(), "k.json");
    const f = fakeIo({ line: ["yes"] });
    expect(await newKey(["--env", "production", "--keystore", path, "--put-secret"], f.io, { kdf: FAST })).toBe(1);
    expect(f.ran).toEqual([]);
    expect(existsSync(path)).toBe(true);
    expect(f.said).toContain('Not put: you typed "yes", not production.');
  });

  it("refuses before making anything: no environment, another environment, passwords that differ or are short, a keystore already there", async () => {
    const d = dir();
    const there = join(d, "there.json");
    writeFileSync(there, "{}");
    const cases: [string[], string[], string][] = [
      [["--keystore", join(d, "a.json")], [PASSWORD, PASSWORD], "--env test or --env production is needed (the Worker's environment)"],
      [["--env", "staging", "--keystore", join(d, "a.json")], [PASSWORD, PASSWORD], "--env test or --env production is needed (the Worker's environment)"],
      [["--env", "test", "--keystore", join(d, "a.json")], [PASSWORD, "something else entirely"], "The two passwords differ: nothing made."],
      [["--env", "test", "--keystore", join(d, "a.json")], ["short", "short"], "The password is shorter than 12 characters: nothing made."],
      [["--env", "test", "--keystore", there], [PASSWORD, PASSWORD], `${there} already exists: nothing made (a keystore is never written over).`],
    ];
    for (const [argv, hidden, why] of cases) {
      const f = fakeIo({ hidden });
      expect(await newKey(argv, f.io, { kdf: FAST }), why).toBe(1);
      expect(f.said).toEqual([why]);
      expect(f.ran).toEqual([]);
    }
    expect(readdirSync(d)).toEqual(["there.json"]);
    expect(readFileSync(there, "utf8")).toBe("{}");
  });

  it("a wrangler that fails: says so and how to put it again from the keystore", async () => {
    const path = join(dir(), "k.json");
    const f = fakeIo({ line: ["test"], wrangler: 1 });
    expect(await newKey(["--env", "test", "--keystore", path, "--put-secret"], f.io, { kdf: FAST })).toBe(1);
    expect(f.said.at(-1)).toBe(`wrangler did not set KEEPER_PRIVATE_KEY (exit 1). The keystore is kept: pnpm keeper:put-key -- --env test --keystore ${path}`);
    expect(keyIn(f.said, []).toLowerCase()).not.toContain(f.ran[0].value.slice(2));
  });

  it("pnpm keeper:put-key: the keystore's key, opened with its password, into the secret (the same confirmation)", async () => {
    const key = `0x${"a7".repeat(32)}` as Hex;
    const path = join(dir(), "k.json");
    writeFileSync(path, JSON.stringify(encryptKey(key, PASSWORD, FAST)));
    const f = fakeIo({ hidden: [PASSWORD], line: ["test"] });
    expect(await putKey(["--env", "test", "--keystore", path], f.io)).toBe(0);
    expect(f.ran).toEqual([{ args: ["secret", "put", "KEEPER_PRIVATE_KEY", "--env", "test"], value: key }]);
    expect(f.said).toEqual([`The keeper's address: ${privateKeyToAccount(key).address}`, "KEEPER_PRIVATE_KEY is set on cascade-keeper-test."]);
    const wrong = fakeIo({ hidden: ["not the password"], line: ["test"] });
    expect(await putKey(["--env", "test", "--keystore", path], wrong.io)).toBe(1);
    expect(wrong.ran).toEqual([]);
    expect(wrong.said).toEqual(["The keystore didn't open: wrong password (the keystore's MAC doesn't match). Nothing put."]);
  });

  it("run as a script with a fake wrangler on the PATH: the key reaches wrangler's stdin only, never stdout, an argument or a file", () => {
    const d = dir();
    const bin = join(d, "bin");
    const out = join(d, "wrangler-got.json");
    const keystore = join(d, "keystore", "keeper.json");
    const fake = join(d, "fake-wrangler.mjs");
    writeFileSync(
      fake,
      `import { writeFileSync } from "node:fs";\nlet input = "";\nprocess.stdin.on("data", (c) => (input += c));\nprocess.stdin.on("end", () => { writeFileSync(${JSON.stringify(out)}, JSON.stringify({ args: process.argv.slice(2), stdin: input, cwd: process.cwd() })); });\n`,
    );
    spawnSync(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(bin)}); require("fs").mkdirSync(${JSON.stringify(join(d, "keystore"))})`]);
    writeFileSync(join(bin, "wrangler.cmd"), `@"${process.execPath}" "${fake}" %*\r\n`);
    writeFileSync(join(bin, "wrangler"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
    const r = spawnSync(process.execPath, ["scripts/new-key.ts", "--env", "test", "--keystore", keystore, "--put-secret"], {
      cwd: join(import.meta.dirname, "..", ".."),
      input: `${PASSWORD}\n${PASSWORD}\ntest\n`,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`, Path: `${bin}${delimiter}${process.env.Path ?? process.env.PATH ?? ""}` },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const got = JSON.parse(readFileSync(out, "utf8")) as { args: string[]; stdin: string; cwd: string };
    expect(got.args).toEqual(["secret", "put", "KEEPER_PRIVATE_KEY", "--env", "test"]);
    const key = got.stdin as Hex;
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
    expect(got.cwd.toLowerCase()).toBe(join(import.meta.dirname, "..", "..").toLowerCase().replace(/[\\/]$/, ""));
    expect(decryptKey(JSON.parse(readFileSync(keystore, "utf8")), PASSWORD)).toBe(key);
    const address = privateKeyToAccount(key).address;
    expect(r.stdout.trim().split(/\r?\n/)).toEqual([`The keeper's address: ${address}`, `Its keystore (password-protected): ${keystore}`, "KEEPER_PRIVATE_KEY is set on cascade-keeper-test."]);
    for (const text of [r.stdout, r.stderr, readFileSync(keystore, "utf8")]) expect(text.toLowerCase()).not.toContain(key.slice(2));
    expect(readdirSync(join(d, "keystore"))).toEqual(["keeper.json"]);
  });
});
