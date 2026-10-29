import { type Address, getAddress } from "viem";
import type { Roles } from "../src/roles.ts";

/** Obvious placeholders for a launch plan's roles in tests: never real accounts. */
const at = (n: string): Address => getAddress(`0x${n.padStart(40, "0")}`);

export const ROLES: Roles = {
  owner: { base: at("a0b1"), bittensor: at("a0b2") },
  guardian: { base: at("b0b1"), bittensor: at("b0b2") },
  keeper: at("c0c1"),
  treasury: at("d0d1"),
};

/** The same placeholders as the environment variables a launch reads them from. */
export const ROLES_ENV = {
  OPS_LAUNCH_OWNER_BASE: ROLES.owner.base,
  OPS_LAUNCH_OWNER_BITTENSOR: ROLES.owner.bittensor,
  OPS_LAUNCH_GUARDIAN_BASE: ROLES.guardian.base,
  OPS_LAUNCH_GUARDIAN_BITTENSOR: ROLES.guardian.bittensor,
  OPS_LAUNCH_KEEPER: ROLES.keeper,
  OPS_LAUNCH_TREASURY: ROLES.treasury,
};
