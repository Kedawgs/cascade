import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ADD_TO_WALLET,
  addFmTaoToWallet,
  FM_TAO_BY_HAND,
  fmTaoWatchAsset,
  WATCH_ADDED,
  WATCH_DECLINED,
  type WatchPort,
  watchResultText,
} from "./add-to-wallet";
import { FM_TAO, TOKENS } from "./cascade/config";

// Task 59b, the founder's request (2026-11-05): a user who receives TAO on Base holds ForeverMoney's TAO, which a
// wallet doesn't show until it is added; "Add to wallet" (EIP-747 wallet_watchAsset) adds it, from the config the
// contracts are deployed with, never a second copy typed by hand.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** Every source file of the site under `dir` (tests and fixtures left out). */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__fixtures__" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const rejection = () => Object.assign(new Error("User rejected the request."), { code: 4001 });
const noMethod = () => Object.assign(new Error("The method wallet_watchAsset does not exist / is not available."), { code: -32601 });

describe("Add to wallet: ForeverMoney's TAO on Base (Task 59b)", () => {
  it("asks the wallet to watch the deployment's bridged token: the address, symbol and decimals the contracts are deployed with", () => {
    expect(fmTaoWatchAsset()).toEqual({ type: "ERC20", options: { address: TOKENS.tao, symbol: "TAO", decimals: 18 } });
    expect(FM_TAO).toEqual({ address: TOKENS.tao, symbol: "TAO", decimals: 18 });
    // the deploy passes LIVE.base.TOKEN to the front door, its adapter, the staker and the oracle (ops/src/plan.ts),
    // and ops verify reads each back against it: the button's token is that one
    const live = read("../../../ops/src/config.ts").match(/base: \{[^}]*?TOKEN: "(0x[0-9a-fA-F]{40})"/);
    expect(live?.[1]).toBe(fmTaoWatchAsset().options.address);
    // every front door, v3-launch's (its frozen build) and v3.2's, refuses an asset without 18 decimals
    for (const src of ["../../../ops/builds/preaudit/src/CascadeFrontDoor.sol", "../../../contracts/src/CascadeFrontDoor.sol"]) {
      expect(read(src), src).toMatch(/decimals\(\) != 18\) revert UnsupportedDecimals\(\);/);
    }
  });

  it("types the address in one place: config.ts's TOKENS, the one wiring.ts holds to the front door's asset() before anything is sent", () => {
    const root = fileURLToPath(new URL(".", import.meta.url)).replace(/lib[\\/]$/, "");
    const typed = sources(root).filter((f) => readFileSync(f, "utf8").toLowerCase().includes(TOKENS.tao.toLowerCase().slice(2)));
    expect(typed.map((f) => f.slice(root.length).replace(/\\/g, "/"))).toEqual(["lib/cascade/config.ts"]);
    const wiring = read("./cascade/wiring.ts");
    expect(wiring).toContain('link(d.frontDoor, FRONT_DOOR, "asset", TOKENS.tao)');
    expect(wiring).toContain('link(d.frontDoor, FRONT_DOOR_V32, "asset", TOKENS.tao)');
    expect(read("./cascade/config.ts")).toMatch(/export const FM_TAO = \{ address: TOKENS\.tao, /);
  });

  it("puts the wallet on Base first (a wallet adds a token on the chain it is on), then adds it", async () => {
    const steps: string[] = [];
    const port = (answer: () => Promise<boolean>): WatchPort => ({
      connected: () => true,
      toBase: async () => void steps.push("base"),
      watch: async (asset) => {
        steps.push(`watch ${asset.type} ${asset.options.address} ${asset.options.symbol} ${asset.options.decimals}`);
        return answer();
      },
    });
    expect(await addFmTaoToWallet(port(async () => true))).toBe("added");
    expect(steps).toEqual(["base", `watch ERC20 ${TOKENS.tao} TAO 18`]);
    expect(await addFmTaoToWallet(port(async () => false))).toBe("declined");
    expect(
      await addFmTaoToWallet(
        port(async () => {
          throw rejection();
        }),
      ),
    ).toBe("declined");
    expect(watchResultText("added")).toBe(WATCH_ADDED);
    expect(watchResultText("declined")).toBe(WATCH_DECLINED);
  });

  it("a wallet without EIP-747, or one that can't go to Base, is told how to add it by hand, with the address", async () => {
    const port = (o: Partial<WatchPort>): WatchPort => ({ connected: () => true, toBase: async () => undefined, watch: async () => true, ...o });
    expect(
      await addFmTaoToWallet(
        port({
          watch: async () => {
            throw noMethod();
          },
        }),
      ),
    ).toBe("by-hand");
    expect(
      await addFmTaoToWallet(
        port({
          toBase: async () => {
            throw new Error("Chain not configured");
          },
        }),
      ),
    ).toBe("by-hand");
    // declining the switch to Base is declining
    expect(
      await addFmTaoToWallet(
        port({
          toBase: async () => {
            throw rejection();
          },
        }),
      ),
    ).toBe("declined");
    // no wallet connected: nothing is asked of any
    let asked = false;
    expect(
      await addFmTaoToWallet(
        port({
          connected: () => false,
          watch: async () => {
            asked = true;
            return true;
          },
        }),
      ),
    ).toBe("no-wallet");
    expect(asked).toBe(false);
    expect(FM_TAO_BY_HAND).toBe(`on Base: address ${TOKENS.tao}, symbol TAO, 18 decimals`);
    expect(watchResultText("by-hand")).toBe(`Your wallet can't add it from here. Add it by hand ${FM_TAO_BY_HAND}.`);
    expect(watchResultText("no-wallet")).toBe(`Connect your wallet first, or add it by hand ${FM_TAO_BY_HAND}.`);
    expect(ADD_TO_WALLET).toBe("Add to wallet");
  });
});
