import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";

export type ChainName = "base" | "bittensor";

export interface ChainTarget {
  name: ChainName;
  rpcUrl: string;
  chainId: number;
  legacy: boolean;
}

export type Env = Record<string, string | undefined>;

/** Live addresses, copied from contracts/test/fork/ForkBase.sol:58-70. */
export const LIVE = {
  base: {
    CHAIN_ID: 8453,
    SELECTOR: 15971525489660198786n,
    ROUTER: "0x881e3A65B4d4a04dD529061dd0071cf975F58bCD",
    ONRAMP: "0xF75bf16b03aaE98677926F0987F195A2153996B9",
    OFFRAMP: "0x16E577f1724AE2598F9b43a52C19E6f67eE13808",
    TOKEN: "0xf3081494B87e8D5fb7960f066E931D1D0e6E3d67",
    POOL: "0xF5AC6D6Bd12d8b87dE3c136FAc9375961577e794",
  },
  bittensor: {
    CHAIN_ID: 964,
    SELECTOR: 2135107236357186872n,
    ROUTER: "0xD941fBEcD2b971d0F54b4C34286C95faB52B60B8",
    ONRAMP: "0x5aA05e14ac7FaF23F1757d46429E6CA7e3FC1274",
    OFFRAMP: "0xF9410A08FD57e629c66E1f37a5Ae8f0a757d9AD9",
    TOKEN: "0xC5b6C1632d34901239396F5E1BDe54B342900256",
    POOL: "0xB66b9c085ab711ECC373aaF6dc959a4A6B42BE2e",
  },
  ALPHA_VAULT: "0x11837459896D96F821a8D88eC93a3C8D152033D4",
} as const satisfies {
  base: Record<string, Address | number | bigint>;
  bittensor: Record<string, Address | number | bigint>;
  ALPHA_VAULT: Address;
};

/** Bittensor's precompiles. */
export const PRECOMPILE = {
  balanceTransfer: "0x0000000000000000000000000000000000000800",
  staking: "0x0000000000000000000000000000000000000805",
  addressMapping: "0x000000000000000000000000000000000000080C",
} as const satisfies Record<string, Address>;

/** The throwaway test wallet: deployer, owner, guardian and keeper for the test run. */
export const WALLET: Address = "0x770932787DD3bcE64f14E31f4746bCe22E214fFF";
/** Its Bittensor twin (SS58, prefix 42), where TAO top-ups go. */
export const WALLET_SS58 = "5FxSW9dM8DbAWUFtADJPX5Wb7DctrJHadkJ3TB1GpBGvxQH2";

/** Test settings from the spec's table. */
export const SETTINGS = {
  baseGas: { base: 540_000n, perEntry: 26_450n },
  minSendAmount: 10n ** 16n,
  bitGas: { base: 120_000n, perEntry: 29_900n },
  batchInterval: 600,
  minDeposit: 10n ** 16n,
  depositCap: 15n * 10n ** 16n,
  redeemRequestFee: 10n ** 14n,
  hotkey: "0x58aef7b1efb44806fe14c6c58d0c1eb634a59fd2513f0ced6f2d10e0569af40d" as Hex,
  minDirectDeposit: 10n ** 16n,
  payoutDelay: 3600,
  adapterReserve: 10n ** 12n,
  vaultReserve: 15n * 10n ** 11n,
} as const;

export function targets(env: Env): { live: Record<ChainName, ChainTarget>; rehearsal: Record<ChainName, ChainTarget> } {
  return {
    live: {
      base: { name: "base", rpcUrl: env.OPS_BASE_RPC ?? "https://mainnet.base.org", chainId: 8453, legacy: false },
      bittensor: {
        name: "bittensor",
        rpcUrl: env.OPS_BITTENSOR_RPC ?? "https://lite.chain.opentensor.ai",
        chainId: 964,
        legacy: true,
      },
    },
    rehearsal: {
      base: { name: "base", rpcUrl: "http://127.0.0.1:8545", chainId: 31337, legacy: false },
      bittensor: { name: "bittensor", rpcUrl: "http://127.0.0.1:8547", chainId: 31338, legacy: true },
    },
  };
}

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export function paths(env: Env) {
  const home = env.USERPROFILE ?? env.HOME ?? homedir();
  return {
    keystore: env.OPS_KEYSTORE ?? join(home, ".foundry", "keystores", "9ffde5b1-4193-4175-9eb3-a26f9d027214"),
    passwordFile: env.OPS_PASSWORD_FILE ?? join(home, ".foundry", "cascade-test.pw"),
    foundryBin: env.OPS_FOUNDRY_BIN ?? join(home, ".foundry", "bin"),
    contractsDir: join(repoRoot, "contracts"),
    deploymentsDir: join(repoRoot, "ops", "deployments"),
  };
}

export type Paths = ReturnType<typeof paths>;
