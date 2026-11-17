import { type Address, getAddress, getContractAddress, type Hex } from "viem";
import { addressMapping, buildPlanV32, type PlanV32 } from "../src/v32/plan.ts";
import { SETTINGS_V32_LAUNCH, type V32Roles } from "../src/v32/settings.ts";

// A v3.2 plan for tests: placeholder roles and fresh deployers (never real accounts), the treasury Appendix B's,
// tao.bot as the primary and Yuma as the standby (configuration in a real plan), test floors and claim gas.

const at = (n: string): Address => getAddress(`0x${n.padStart(40, "0")}`);

export const ROLES_V32: V32Roles = { owner: at("a0b1"), guardian: at("b0b1"), keeper: at("c0c1"), treasury: SETTINGS_V32_LAUNCH.treasury };
export const DEPLOYERS_V32 = { base: getAddress(`0x${"d1".repeat(20)}`), bittensor: getAddress(`0x${"d2".repeat(20)}`) };
export const TAO_BOT: Hex = "0x56a9aee6291bd03ab6d36d4d13e2bebae7cd403518066c72fba1b417d6ddd748";
export const YUMA: Hex = "0x40c47b6a294686fe9612b5d78dd369f4c77fa3bbf96a4286ede97410ba2e3209";

/** The v3.2 plan from the placeholders above. */
export const planV32 = (): PlanV32 =>
  buildPlanV32({
    deployers: DEPLOYERS_V32,
    roles: ROLES_V32,
    validators: { primary: TAO_BOT, standby: YUMA },
    vaultColdkey: addressMapping(getContractAddress({ from: DEPLOYERS_V32.bittensor, nonce: 6n })),
    poolFloors: [10n ** 20n, 10n ** 17n],
    claimGasRequired: 55_000_000n,
  });

/** A little-endian SCALE unsigned integer of `bytes` bytes, as Bittensor stores one. */
export const le = (n: bigint | number, bytes: number): Hex => {
  let x = BigInt(n);
  let out = "0x";
  for (let i = 0; i < bytes; i++) {
    out += (x & 0xffn).toString(16).padStart(2, "0");
    x >>= 8n;
  }
  return out as Hex;
};
