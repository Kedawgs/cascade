import type { FlowV1 } from "../flow";

/** A healthy v3-launch flow document at unix second 1_800_000_000 (both chains read 60 s before). */
export const GENERATED_AT = 1_800_000_000;
export const TAO_BOT = "0x56a9aee6291bd03ab6d36d4d13e2bebae7cd403518066c72fba1b417d6ddd748";
export const YUMA = "0x40c47b6a294686fe9612b5d78dd369f4c77fa3bbf96a4286ede97410ba2e3209";

const e18 = (n: number) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString();
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

export function goodFlow(): FlowV1 {
  const chain = { block: "1000", time: GENERATED_AT - 60, stale: false };
  return {
    v: 1,
    deployment: "v3-launch",
    generatedAt: GENERATED_AT,
    chains: { base: { ...chain }, bittensor: { ...chain } },
    swap: {
      taoWethPoolTao: e18(2000), // x2 x $200 = $800,000
      wethUsdcPoolUsdc: "3000000000000", // 3,000,000 USDC -> $6,000,000
      twapUsdcPerTao: "200000000", // $200
      spotUsdcPerTao: "200600000", // 0.3% apart
      buyQuote1000Tao: e18(4.965), // 4.965 TAO for $1,000 at $200 -> 0.7% cost
      sellQuote: { taoIn: e18(5), usdcOut: "993000000" }, // 0.7% cost
    },
    backing: {
      alphaBacking: e18(999),
      wTaoSupply: e18(1000),
      lockPoolFmTao: e18(1000),
      fmTaoSupplyBase: e18(1000),
      ratioPpm: 999_000,
    },
    bridgeIn: { roomLeft: e18(80), capacity: e18(100), perHour: e18(10), enabled: true, supported: true, inFlight: 2 },
    bridgeOut: { roomLeft: e18(90), capacity: e18(100), perHour: e18(10), enabled: true, supported: true, inFlight: 0 },
    batch: { nextSendAt: GENERATED_AT + 600 },
    vault: { totalAssets: e18(1234.5), price: e18(1.05), pendingPayouts: e18(3), nextPayoutAt: GENERATED_AT + 3600, paused: false },
    validator: { hotkey: TAO_BOT, ourStake: "1234500000000", takeBps: 1800, backups: [YUMA] },
    frontDoor: { paused: false },
    notices: [],
    addresses: {
      vault: A(1), frontDoor: A(2), staker: A(3), taoWethPool: A(4), wethUsdcPool: A(5),
      alphaVault: A(6), lockPool: A(7), baseTokenPool: A(8), wTao: A(9), fmTaoBase: A(10),
    },
  };
}
