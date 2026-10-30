import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scrubSecrets } from "../src/keeper/failures.ts";
import { printError, printLine } from "../src/output.ts";

const opsDir = fileURLToPath(new URL("..", import.meta.url));

afterEach(() => vi.restoreAllMocks());

describe("every line the CLI prints has any URL's secrets stripped", () => {
  it("printLine and printError scrub what they print", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    printLine("reading https://lb.drpc.org/ogrpc?network=base&dkey=SECRETKEY123");
    printError("failed: https://base-mainnet.g.alchemy.com/v2/ALCHEMYKEY9");
    expect(out).toHaveBeenCalledWith("reading https://…drpc.org/…");
    expect(err).toHaveBeenCalledWith("failed: https://…alchemy.com/…");
  });

  it("keeps what carries no secret: the sign page's local address, a bare domain", () => {
    expect(scrubSecrets("Open http://127.0.0.1:53211/ in the browser where MetaMask is.")).toBe("Open http://127.0.0.1:53211/ in the browser where MetaMask is.");
    expect(scrubSecrets("see https://basescan.org/ and http://127.0.0.1:8545")).toBe("see https://basescan.org/ and http://127.0.0.1:8545");
  });

  it("a crash's message is scrubbed too (the real CLI, which reads nothing before it fails here)", () => {
    // an OPS_DEPLOYMENT that isn't a plain name fails `status` before any record, key or RPC is touched
    let stderr = "";
    let status = 0;
    try {
      execFileSync(process.execPath, ["src/cli.ts", "status"], {
        cwd: opsDir,
        env: { ...process.env, OPS_DEPLOYMENT: "https://rpc.example.com/v2/APIKEY456" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      stderr = String((e as { stderr: Buffer }).stderr);
      status = (e as { status: number }).status;
    }
    expect(status).toBe(1);
    expect(stderr).toContain("is not a plain name");
    expect(stderr).toContain("example.com");
    expect(stderr).not.toContain("APIKEY456");
  });
});
