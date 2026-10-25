import { type Address, getContractAddress, type Hex, parseAbi } from "viem";
import { LIVE, PRECOMPILE, SETTINGS, WALLET } from "./config.ts";
import type { PlannedStep } from "./types.ts";

export interface Plan {
  baseNonce: number;
  bitNonce: number;
  addresses: { baseAdapter: Address; frontDoor: Address; bitAdapter: Address; vault: Address };
  steps: PlannedStep[];
}

export const CONFIG_ABI = {
  fundReserve: parseAbi(["function fundReserve() payable"]),
  transfer: parseAbi(["function transfer(bytes32 data) payable"]),
  setKeeper: parseAbi(["function setKeeper(address newKeeper)"]),
  setPayoutDelay: parseAbi(["function setPayoutDelay(uint64 delay)"]),
};

const at = (nonce: number) => getContractAddress({ from: WALLET, nonce: BigInt(nonce) });

/** The deployment from the wallet's current nonces: Base first, so the vault names a front door that
 * already has code (spec, deployment order). `vaultColdkey` is addressMapping(predicted vault). */
export function buildPlan(baseNonce: number, bitNonce: number, vaultColdkey: Hex): Plan {
  const addresses = { baseAdapter: at(baseNonce), frontDoor: at(baseNonce + 1), bitAdapter: at(bitNonce), vault: at(bitNonce + 1) };
  const base = LIVE.base;
  const bit = LIVE.bittensor;
  const steps: PlannedStep[] = [
    {
      id: "baseAdapter",
      kind: "create",
      chain: "base",
      nonce: baseNonce,
      label: "deploy the Base bridge adapter",
      contract: "src/adapters/CcipBaseAdapter.sol:CcipBaseAdapter",
      args: [
        {
          router: base.ROUTER,
          token: base.TOKEN,
          localChainId: BigInt(base.CHAIN_ID),
          remoteChainId: BigInt(bit.CHAIN_ID),
          remoteSelector: bit.SELECTOR,
          remoteAdapter: addresses.bitAdapter,
          gasBase: SETTINGS.baseGas.base,
          gasPerEntry: SETTINGS.baseGas.perEntry,
        },
        SETTINGS.minSendAmount,
      ],
    },
    {
      id: "frontDoor",
      kind: "create",
      chain: "base",
      nonce: baseNonce + 1,
      label: "deploy the front door",
      contract: "src/CascadeFrontDoor.sol:CascadeFrontDoor",
      args: [
        base.TOKEN,
        addresses.baseAdapter,
        BigInt(bit.CHAIN_ID),
        addresses.vault,
        WALLET,
        WALLET,
        BigInt(SETTINGS.batchInterval),
        SETTINGS.minDeposit,
        SETTINGS.depositCap,
        SETTINGS.redeemRequestFee,
      ],
    },
    {
      id: "bitAdapter",
      kind: "create",
      chain: "bittensor",
      nonce: bitNonce,
      label: "deploy the Bittensor bridge adapter",
      contract: "src/adapters/CcipBittensorAdapter.sol:CcipBittensorAdapter",
      args: [
        {
          router: bit.ROUTER,
          token: bit.TOKEN,
          localChainId: BigInt(bit.CHAIN_ID),
          remoteChainId: BigInt(base.CHAIN_ID),
          remoteSelector: base.SELECTOR,
          remoteAdapter: addresses.baseAdapter,
          gasBase: SETTINGS.bitGas.base,
          gasPerEntry: SETTINGS.bitGas.perEntry,
        },
        LIVE.ALPHA_VAULT,
      ],
    },
    {
      id: "vault",
      kind: "create",
      chain: "bittensor",
      nonce: bitNonce + 1,
      label: "deploy the vault",
      contract: "src/CascadeVault.sol:CascadeVault",
      args: [
        vaultColdkey,
        SETTINGS.hotkey,
        addresses.bitAdapter,
        WALLET,
        WALLET,
        SETTINGS.minDirectDeposit,
        BigInt(base.CHAIN_ID),
        addresses.frontDoor,
      ],
    },
    {
      id: "adapterReserve",
      kind: "call",
      chain: "bittensor",
      nonce: bitNonce + 2,
      label: "fund the Bittensor adapter's reserve",
      to: addresses.bitAdapter,
      abi: CONFIG_ABI.fundReserve,
      functionName: "fundReserve",
      args: [],
      value: SETTINGS.adapterReserve,
    },
    {
      id: "vaultReserve",
      kind: "call",
      chain: "bittensor",
      nonce: bitNonce + 3,
      label: "fund the vault's reserve through the transfer precompile",
      to: PRECOMPILE.balanceTransfer,
      abi: CONFIG_ABI.transfer,
      functionName: "transfer",
      args: [vaultColdkey],
      value: SETTINGS.vaultReserve,
    },
    {
      id: "setKeeper",
      kind: "call",
      chain: "bittensor",
      nonce: bitNonce + 4,
      label: "make the test wallet the vault's keeper",
      to: addresses.vault,
      abi: CONFIG_ABI.setKeeper,
      functionName: "setKeeper",
      args: [WALLET],
    },
    {
      id: "setPayoutDelay",
      kind: "call",
      chain: "bittensor",
      nonce: bitNonce + 5,
      label: "set the payout delay to 1 hour",
      to: addresses.vault,
      abi: CONFIG_ABI.setPayoutDelay,
      functionName: "setPayoutDelay",
      args: [BigInt(SETTINGS.payoutDelay)],
    },
  ];
  return { baseNonce, bitNonce, addresses, steps };
}
