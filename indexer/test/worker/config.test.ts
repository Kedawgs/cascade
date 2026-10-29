import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig, redact, rolesOf, scanAddresses, VAR_NAMES } from "../../src/config.ts";
import { DEFAULTS, lagLimitS } from "../../src/thresholds.ts";
import deployment from "../fixtures/deployment.json";

/** The test environment's vars (wrangler.jsonc's env.test, with the fixture deployment), as a plain
 * object a test can change. */
const vars = (): Record<string, unknown> => Object.fromEntries(VAR_NAMES.map((n) => [n, (env as unknown as Record<string, unknown>)[n]]));
const withVars = (over: Record<string, unknown>) => ({ ...vars(), ...over });
const refused = (e: Record<string, unknown>) => {
  try {
    parseConfig(e);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error("parseConfig accepted it");
};
/** One letter of a checksummed address in the other case: no longer its checksum. */
const unchecksummed = (a: string) => a.replace(/[a-f]/, (c) => c.toUpperCase());

describe("parseConfig", () => {
  it("parses the full test environment", () => {
    const cfg = parseConfig(vars());
    expect(cfg.deployment.id).toBe(`${deployment.frontDoor}:${deployment.vault}`.toLowerCase());
    expect(cfg.deployment.vault).toBe(deployment.vault.toLowerCase());
    expect(cfg.deployment.bittensor).toEqual({ chainId: 964, startBlock: 6_900_000n, baselineBlock: 6_900_040n });
    expect(cfg.deployment.base.startBlock).toBe(37_000_000n);
    expect(cfg.bridges).toEqual({ base: [deployment.baseAdapter.toLowerCase()], bittensor: [deployment.bitAdapter.toLowerCase()] });
    // the Workers Paid profile (wrangler.jsonc)
    expect(cfg.budgets).toEqual({ subrequests: 200, decode: 5000, scanWallS: 40, leaseS: 180, siteFilesPerRun: 20, siteMaxBytes: 2_000_000 });
    expect(cfg.baseLogWindow).toBe(100n);
    expect(cfg.rpc.bittensor).toBe("https://archive.chain.opentensor.ai");
    expect(cfg.site.pages).toEqual(["/", "/stake/"]);
    expect(cfg.alerts).toEqual({ from: "monitor@cascade.fi", mode: "log", to: [] });
    expect(cfg.priceSources).toEqual(["coingecko", "coinbase"]);
    expect(cfg.tokens.multicall3).toBe("0xca11bde05977b3631167028862be2a173976ca11");
    expect(cfg.thresholds).toEqual(DEFAULTS);
  });

  it("refuses an address that isn't checksummed, naming the field", () => {
    const bad = { ...deployment, frontDoor: unchecksummed(deployment.frontDoor) };
    expect(refused(withVars({ DEPLOYMENT: JSON.stringify(bad) })).message).toContain("DEPLOYMENT.frontDoor");
  });

  it("refuses a start block that isn't an integer", () => {
    for (const startBlock of ["6900000.5", "abc", 6_900_000.5, -1]) {
      const bad = { ...deployment, bittensor: { ...deployment.bittensor, startBlock } };
      expect(refused(withVars({ DEPLOYMENT: JSON.stringify(bad) })).message).toContain("DEPLOYMENT.bittensor.startBlock");
    }
  });

  it("refuses the committed placeholder, which isn't JSON", () => {
    expect(refused(withVars({ DEPLOYMENT: "fill in with pnpm config:from-record" })).message).toContain("DEPLOYMENT");
  });

  it("refuses an unknown key in the deployment", () => {
    expect(refused(withVars({ DEPLOYMENT: JSON.stringify({ ...deployment, keeper: deployment.vault }) })).message).toContain("DEPLOYMENT.keeper");
  });

  it("refuses two Base contracts at one address", () => {
    const bad = { ...deployment, baseAdapter: deployment.frontDoor };
    expect(refused(withVars({ DEPLOYMENT: JSON.stringify(bad) })).message).toContain("DEPLOYMENT");
  });

  it("overrides one threshold from the THRESHOLDS var", () => {
    const cfg = parseConfig(withVars({ THRESHOLDS: '{"depegBps":300}' }));
    expect(cfg.thresholds.depegBps).toBe(300);
    expect(cfg.thresholds.twapDivergenceBps).toBe(DEFAULTS.twapDivergenceBps);
  });

  it("lets the THRESHOLDS secret win over the var", () => {
    const cfg = parseConfig(withVars({ THRESHOLDS: '{"depegBps":300,"oneWalletPct":40}', THRESHOLDS_SECRET: '{"depegBps":250}' }));
    expect(cfg.thresholds.depegBps).toBe(250);
    expect(cfg.thresholds.oneWalletPct).toBe(40);
  });

  it("reads a bigint threshold from a decimal string, and a rule switched off", () => {
    const cfg = parseConfig(withVars({ THRESHOLDS: '{"keeperMinEthWei":"3000000000000000","rules":{"off":["fmtao.mint_surge"]}}' }));
    expect(cfg.thresholds.keeperMinEthWei).toBe(3n * 10n ** 15n);
    expect(cfg.thresholds.rules.off).toEqual(["fmtao.mint_surge"]);
    expect(DEFAULTS.rules.off).toEqual([]);
  });

  it("refuses an unknown threshold, a wrong type and bad JSON", () => {
    expect(refused(withVars({ THRESHOLDS: '{"nope":1}' })).message).toContain("nope");
    expect(refused(withVars({ THRESHOLDS: '{"depegBps":"300"}' })).message).toContain("depegBps");
    expect(refused(withVars({ THRESHOLDS: '{"keeperMinEthWei":1.5}' })).message).toContain("keeperMinEthWei");
    expect(refused(withVars({ THRESHOLDS_SECRET: "{depegBps:" })).message).toContain("THRESHOLDS_SECRET");
  });

  it("never echoes a THRESHOLDS secret that isn't JSON", () => {
    const e = refused(withVars({ THRESHOLDS_SECRET: '{"depegBps": 777 oops' }));
    expect(e.message).not.toContain("777");
    expect(e.message).not.toContain("oops");
  });

  it("lets a secret RPC URL override the var", () => {
    const cfg = parseConfig(withVars({ BITTENSOR_RPC_URL_SECRET: "https://keyed.example/v1/abc123" }));
    expect(cfg.rpc.bittensor).toBe("https://keyed.example/v1/abc123");
    expect(cfg.rpc.base).toBe("https://mainnet.base.org");
  });

  it("never puts a bad secret RPC URL's value in the error", () => {
    const value = "http://keyed.example/v1/sekrit-key-9f8e";
    const e = refused(withVars({ BITTENSOR_RPC_URL_SECRET: value }));
    expect(e.message).toContain("BITTENSOR_RPC_URL_SECRET");
    expect(e.message).not.toContain("sekrit");
    expect(e.message).not.toContain("keyed.example");
  });

  it("refuses an ALERT_MODE other than send or log", () => {
    expect(refused(withVars({ ALERT_MODE: "email" })).message).toContain("ALERT_MODE");
  });

  it("needs a recipient to send, and never names one in an error", () => {
    expect(refused(withVars({ ALERT_MODE: "send" })).message).toContain("ALERT_TO");
    const e = refused(withVars({ ALERT_MODE: "send", ALERT_TO: "owner@example.com, not-an-address" }));
    expect(e.message).toContain("ALERT_TO");
    expect(e.message).not.toContain("owner@example.com");
    const cfg = parseConfig(withVars({ ALERT_MODE: "send", ALERT_TO: "a@example.com, b@example.org" }));
    expect(cfg.alerts.to).toEqual(["a@example.com", "b@example.org"]);
  });

  it("refuses a lease shorter than three scans", () => {
    expect(refused(withVars({ LEASE_S: "60", SCAN_WALL_S: "40" })).message).toContain("LEASE_S");
    expect(parseConfig(withVars({ LEASE_S: "120", SCAN_WALL_S: "40" })).budgets.leaseS).toBe(120);
  });

  it("takes the bridges from BRIDGES when set", () => {
    const second = "0x89ed499783Be6bD00724Cb268224E727B26731a5";
    const cfg = parseConfig(withVars({ BRIDGES: JSON.stringify({ base: [deployment.baseAdapter, second], bittensor: [deployment.bitAdapter] }) }));
    expect(cfg.bridges.base).toEqual([deployment.baseAdapter.toLowerCase(), second.toLowerCase()]);
  });

  it("refuses an unknown price source", () => {
    expect(refused(withVars({ PRICE_SOURCES: '["coingecko","binance"]' })).message).toContain("PRICE_SOURCES");
    expect(parseConfig(withVars({ PRICE_SOURCES: "[]" })).priceSources).toEqual([]);
  });

  it("refuses a site origin with a path, or with no host at all", () => {
    for (const origin of ["https://cascade.fi/", "https://", "https:", "cascade.fi", 7]) {
      expect(refused(withVars({ SITE_ORIGIN: origin })).message).toContain("SITE_ORIGIN");
    }
  });
});

describe("every listed bridge", () => {
  const second = "0x61b3a68cCEe0e11fCCC37c3795735d3012458240";
  const third = "0x89ed499783Be6bD00724Cb268224E727B26731a5";
  const bridged = () => parseConfig(withVars({ BRIDGES: JSON.stringify({ base: [deployment.baseAdapter, third], bittensor: [deployment.bitAdapter, second] }) }));

  it("is roled as an adapter on its chain", () => {
    const cfg = bridged();
    const roleOf = rolesOf(cfg.deployment, cfg.bridges);
    expect(roleOf("base", third.toLowerCase() as `0x${string}`)).toBe("baseAdapter");
    expect(roleOf("bittensor", second.toLowerCase() as `0x${string}`)).toBe("bitAdapter");
    expect(roleOf("base", second.toLowerCase() as `0x${string}`)).toBeUndefined();
  });

  it("is scanned with the deployment's contracts", () => {
    const cfg = bridged();
    expect(scanAddresses(cfg)).toEqual({
      base: [cfg.deployment.frontDoor, cfg.deployment.baseAdapter, cfg.deployment.staker, third.toLowerCase()],
      bittensor: [cfg.deployment.vault, cfg.deployment.bitAdapter, second.toLowerCase()],
    });
    expect(scanAddresses(parseConfig(vars()))).toEqual({
      base: [cfg.deployment.frontDoor, cfg.deployment.baseAdapter, cfg.deployment.staker],
      bittensor: [cfg.deployment.vault, cfg.deployment.bitAdapter],
    });
  });

  it("can't be one of the deployment's other contracts on its chain", () => {
    expect(refused(withVars({ BRIDGES: JSON.stringify({ base: [deployment.frontDoor], bittensor: [deployment.bitAdapter] }) })).message).toContain("BRIDGES");
    expect(refused(withVars({ BRIDGES: JSON.stringify({ base: [deployment.baseAdapter], bittensor: [deployment.vault] }) })).message).toContain("BRIDGES");
  });
});

describe("rolesOf", () => {
  it("tells contracts apart by chain when they share an address (as on v3-test)", () => {
    const roleOf = rolesOf(parseConfig(vars()).deployment);
    const staker = deployment.staker.toLowerCase() as `0x${string}`;
    expect(deployment.bitAdapter).toBe(deployment.staker);
    expect(roleOf("base", staker)).toBe("staker");
    expect(roleOf("bittensor", staker)).toBe("bitAdapter");
    expect(roleOf("base", deployment.frontDoor as `0x${string}`)).toBe("frontDoor");
    expect(roleOf("bittensor", deployment.vault.toLowerCase() as `0x${string}`)).toBe("vault");
    expect(roleOf("bittensor", deployment.frontDoor.toLowerCase() as `0x${string}`)).toBeUndefined();
  });
});

describe("redact", () => {
  it("keeps only the host's registrable domain: never a subdomain, path or query, where a key can sit", () => {
    expect(redact("https://x.example/key/abc")).toBe("x.example");
    expect(redact("https://user:pw@x.example:8443/k?key=1")).toBe("x.example");
    expect(redact("https://SECRETKEY.base-mainnet.quiknode.pro/x")).toBe("quiknode.pro");
    expect(redact("https://lb.drpc.org/ogrpc?network=base&dkey=SECRETKEY")).toBe("drpc.org");
    expect(redact("https://base-rpc.publicnode.com")).toBe("publicnode.com");
    expect(redact("http://127.0.0.1:8545")).toBe("127.0.0.1");
    expect(redact("http://[::1]:8545/k")).toBe("[::1]");
    expect(redact("http://localhost:8545/k")).toBe("localhost");
    expect(redact("not a url")).toBe("(an invalid URL)");
  });
});

describe("lagLimitS", () => {
  it("is a quarter of the payout delay, at most 30 minutes", () => {
    expect(lagLimitS(DEFAULTS, 3600)).toBe(900);
    expect(lagLimitS(DEFAULTS, 86_400)).toBe(1800);
  });
});
