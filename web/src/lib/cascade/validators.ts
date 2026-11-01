import { shortAddress } from "../format";

/** Validators the page names, keyed by hotkey (32 bytes, lowercase hex) with the SS58 form taostats links by. */
export const VALIDATORS: readonly { hotkey: string; ss58: string; name: string }[] = [
  {
    // the live deployment's stake hotkey (deployments.json, v3-launch hotkeySs58): the 32 key bytes inside
    // that SS58 address
    hotkey: "0x56a9aee6291bd03ab6d36d4d13e2bebae7cd403518066c72fba1b417d6ddd748",
    ss58: "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u",
    name: "tao.bot",
  },
  {
    hotkey: "0x40c47b6a294686fe9612b5d78dd369f4c77fa3bbf96a4286ede97410ba2e3209",
    ss58: "5DXdHixxtCvoa6GHKs2Jgrdzc61882Ftx1zN2sYFQuwgL1S1",
    name: "Yuma",
  },
];

/** hotkey hex (lowercase) to name */
export const VALIDATOR_NAMES: Record<string, string> = Object.fromEntries(VALIDATORS.map((v) => [v.hotkey, v.name]));

const find = (hotkey: string) => VALIDATORS.find((v) => v.hotkey === hotkey.toLowerCase());

/** The validator's name, else its shortened hotkey. */
export function validatorName(hotkey: string): string {
  return find(hotkey)?.name ?? shortAddress(hotkey);
}

/** The SS58 address of a listed validator (what its taostats page is under); undefined for any other. */
export function validatorSs58(hotkey: string): string | undefined {
  return find(hotkey)?.ss58;
}
