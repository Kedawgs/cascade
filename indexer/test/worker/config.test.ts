import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { toEventSelector } from "viem";
import { ConfigError, parseConfig, redact, rolesOf, scanAddresses, VAR_NAMES, watchFilters } from "../../src/config.ts";
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
    expect(cfg.site.pages).toEqual(["/", "/activity/", "/deposit/", "/faq/", "/rewards/", "/stake/", "/unstake/", "/withdraw/"]);
    expect(cfg.alerts).toEqual({ from: "monitor@cascadefi.xyz", mode: "log", to: [] });
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

  it("refuses a nonceBehindTicks that a minute apart reaches unexplainedTxGraceS (a count read too high would page before it is taken back)", () => {
    expect(DEFAULTS.nonceBehindTicks * 60).toBeLessThan(DEFAULTS.unexplainedTxGraceS);
    expect(parseConfig(withVars({ THRESHOLDS: '{"nonceBehindTicks":14}' })).thresholds.nonceBehindTicks).toBe(14);
    expect(refused(withVars({ THRESHOLDS: '{"nonceBehindTicks":15}' })).message).toContain("nonceBehindTicks");
    expect(refused(withVars({ THRESHOLDS: '{"nonceBehindTicks":5}', THRESHOLDS_SECRET: '{"unexplainedTxGraceS":300}' })).message).toContain("unexplainedTxGraceS");
    // 1 or less holds nothing: any grace goes
    expect(parseConfig(withVars({ THRESHOLDS: '{"nonceBehindTicks":1,"unexplainedTxGraceS":0}' })).thresholds.unexplainedTxGraceS).toBe(0);
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

  it("takes the second logs RPC of each chain from its var, or its secret, and refuses one on the primary's domain", () => {
    const cfg = parseConfig(vars());
    // Base: Tenderly's public gateway, then dRPC's (tried in order, the next one when one fails)
    expect(cfg.rpc.baseLogs2).toEqual(["https://base.gateway.tenderly.co", "https://base.drpc.org"]);
    expect(cfg.rpc.bittensor2).toEqual(["https://bittensor-finney.api.onfinality.io/public"]);
    const keyed = parseConfig(withVars({ BASE_LOGS_RPC_URL_2_SECRET: "https://second.example/v1/abc123", BITTENSOR_RPC_URL_2_SECRET: "https://other.example/v1/abc123" }));
    expect([keyed.rpc.baseLogs2, keyed.rpc.bittensor2]).toEqual([["https://second.example/v1/abc123"], ["https://other.example/v1/abc123"]]);
    // not an https URL, or missing
    expect(refused(withVars({ BASE_LOGS_RPC_URL_2: "http://base.drpc.org" })).message).toContain("BASE_LOGS_RPC_URL_2");
    expect(refused(withVars({ BITTENSOR_RPC_URL_2: undefined })).message).toContain("BITTENSOR_RPC_URL_2");
    // the same registrable domain as the primary isn't a second opinion (the lite node next to the archive node,
    // a keyed URL at the provider the second defaults to), and the error names neither URL
    const same = refused(withVars({ BITTENSOR_RPC_URL_2: "https://lite.chain.opentensor.ai" }));
    expect(same.message).toContain("BITTENSOR_RPC_URL_2");
    expect(same.message).not.toContain("opentensor");
    const primaryAtSecond = refused(withVars({ BASE_LOGS_RPC_URL_SECRET: "https://lb.drpc.org/ogrpc?network=base&dkey=SECRETKEY" }));
    expect(primaryAtSecond.message).toContain("BASE_LOGS_RPC_URL_2");
    expect(primaryAtSecond.message).not.toContain("SECRETKEY");
  });

  it("takes a short list of second logs RPCs, tried in order: a JSON list in the var, or in its secret", () => {
    const list = ["https://a.example/v1", "https://b.example/v1"];
    expect(parseConfig(withVars({ BASE_LOGS_RPC_URL_2: list })).rpc.baseLogs2).toEqual(list);
    expect(parseConfig(withVars({ BITTENSOR_RPC_URL_2: JSON.stringify(list) })).rpc.bittensor2).toEqual(list);
    expect(parseConfig(withVars({ BASE_LOGS_RPC_URL_2_SECRET: JSON.stringify(["https://keyed.example/v1/k1", "https://base.drpc.org"]) })).rpc.baseLogs2).toEqual([
      "https://keyed.example/v1/k1",
      "https://base.drpc.org",
    ]);
    // at least one and at most three, each https, none on the primary's domain, none twice; the error names no URL
    for (const bad of [[], ["https://a.example", "https://b.example", "https://c.example", "https://d.example"], ["https://a.example", "http://b.example/k-SECRET"], ["https://a.example", "https://a.example"], "[oops", [7]]) {
      const e = refused(withVars({ BASE_LOGS_RPC_URL_2: bad }));
      expect(e.message, JSON.stringify(bad)).toContain("BASE_LOGS_RPC_URL_2");
      expect(e.message).not.toContain("example");
      expect(e.message).not.toContain("SECRET");
    }
    const same = refused(withVars({ BASE_LOGS_RPC_URL_2: ["https://a.example", "https://other.publicnode.com/k"] }));
    expect(same.message).toContain("same domain as the primary");
    expect(same.message).not.toContain("publicnode");
  });

  it("refuses an ALERT_MODE other than send or log", () => {
    expect(refused(withVars({ ALERT_MODE: "email" })).message).toContain("ALERT_MODE");
  });

  it("needs a recipient to send, and never names one in an error", () => {
    expect(refused(withVars({ ALERT_MODE: "send" })).message).toContain("ALERT_TO");
    const e = refused(withVars({ ALERT_MODE: "send", ALERT_TO: "owner@example.com, not-an-address" }));
    expect(e.message).toContain("ALERT_TO");
    // a control character in an address (a header-injection vector) is refused, in the recipients and the sender
    for (const c of ["\u0000", "\u007f", "\u0085", "\u009f"]) {
      expect(refused(withVars({ ALERT_MODE: "send", ALERT_TO: `owner@example.com${c}` })).message).toContain("ALERT_TO");
      expect(refused(withVars({ ALERT_FROM: `monitor@cascadefi.xyz${c}` })).message).toContain("ALERT_FROM");
    }
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
    for (const origin of ["https://cascadefi.xyz/", "https://", "https:", "cascadefi.xyz", 7]) {
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

describe("ForeverMoney's contracts the scan watches (TOKENS)", () => {
  const cfg = () => parseConfig(vars());

  it("are FM-TAO and the CCIP token pool on Base, and wTAO, the lock pool and the AlphaVault on Bittensor, each roled on its chain", () => {
    const c = cfg();
    expect(c.tokens.base.tokenPool).toBe("0xf5ac6d6bd12d8b87de3c136fac9375961577e794");
    const roleOf = rolesOf(c.deployment, c.bridges, c.tokens);
    expect(roleOf("base", c.tokens.base.fmTao)).toBe("fmTao");
    expect(roleOf("base", c.tokens.base.tokenPool)).toBe("tokenPool");
    expect(roleOf("bittensor", c.tokens.bittensor.fmTao)).toBe("fmTao");
    expect(roleOf("bittensor", c.tokens.bittensor.lockPool)).toBe("tokenPool");
    expect(roleOf("bittensor", c.tokens.bittensor.alphaVault)).toBe("alphaVault");
    expect(roleOf("bittensor", c.tokens.base.tokenPool)).toBeUndefined();
    // the deployment's own contracts keep their roles; without TOKENS only they are roled
    expect(roleOf("bittensor", c.deployment.vault)).toBe("vault");
    expect(rolesOf(c.deployment, c.bridges)("base", c.tokens.base.fmTao)).toBeUndefined();
  });

  it("are read with their admin events' topics only (never a transfer), apart from the deployment's own scan", () => {
    const c = cfg();
    const w = watchFilters(c);
    expect(w.base.address).toEqual([c.tokens.base.fmTao, c.tokens.base.tokenPool]);
    expect(w.bittensor.address).toEqual([c.tokens.bittensor.fmTao, c.tokens.bittensor.lockPool, c.tokens.bittensor.alphaVault]);
    for (const chain of ["base", "bittensor"] as const) {
      expect(w[chain].topics).toContain(toEventSelector("RoleGranted(bytes32,address,address)"));
      expect(w[chain].topics).toContain(toEventSelector("OwnershipTransferRequested(address,address)"));
      expect(w[chain].topics).not.toContain(toEventSelector("Transfer(address,address,uint256)"));
      expect(w[chain].topics).not.toContain(toEventSelector("Approval(address,address,uint256)"));
      expect(scanAddresses(c)[chain].some((a) => w[chain].address.includes(a))).toBe(false);
    }
  });

  it("refuses TOKENS without the Base token pool, or a watched contract at one of the deployment's addresses", () => {
    const tokens = () => JSON.parse(JSON.stringify(vars().TOKENS)) as { base: Record<string, string>; bittensor: Record<string, string> };
    const missing = tokens();
    delete missing.base.tokenPool;
    expect(refused(withVars({ TOKENS: JSON.stringify(missing) })).message).toContain("TOKENS.base.tokenPool");
    const onTheVault = tokens();
    onTheVault.bittensor.alphaVault = deployment.vault;
    expect(refused(withVars({ TOKENS: JSON.stringify(onTheVault) })).message).toContain("TOKENS");
    const onTheFrontDoor = tokens();
    onTheFrontDoor.base.tokenPool = deployment.frontDoor;
    expect(refused(withVars({ TOKENS: JSON.stringify(onTheFrontDoor) })).message).toContain("TOKENS");
  });
});

describe("BACKING_HOLD", () => {
  it("is off in both environments as shipped; true or false (a string or a JSON boolean) switches fmtao.backing_true's hold; anything else is refused", () => {
    expect(parseConfig(vars()).backingHold).toBe(false);
    expect(parseConfig(withVars({ BACKING_HOLD: "true" })).backingHold).toBe(true);
    expect(parseConfig(withVars({ BACKING_HOLD: true })).backingHold).toBe(true);
    expect(parseConfig(withVars({ BACKING_HOLD: "false" })).backingHold).toBe(false);
    expect(parseConfig(withVars({ BACKING_HOLD: undefined })).backingHold).toBe(false);
    expect(refused(withVars({ BACKING_HOLD: "yes" })).message).toContain("BACKING_HOLD");
    expect(refused(withVars({ BACKING_HOLD: 1 })).message).toContain("BACKING_HOLD");
  });

  it("reads true and false in any case, around spaces, and still refuses anything else", () => {
    for (const on of ["TRUE", "True", " true ", "tRuE\n"]) expect(parseConfig(withVars({ BACKING_HOLD: on })).backingHold, JSON.stringify(on)).toBe(true);
    for (const off of ["FALSE", "False", " false", "  "]) expect(parseConfig(withVars({ BACKING_HOLD: off })).backingHold, JSON.stringify(off)).toBe(false);
    for (const bad of ["t", "1", "on", "yes", "true!", "tr ue", "falsey"]) {
      const e = refused(withVars({ BACKING_HOLD: bad }));
      expect(e.message, JSON.stringify(bad)).toBe('BACKING_HOLD is not "true" or "false"');
    }
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
