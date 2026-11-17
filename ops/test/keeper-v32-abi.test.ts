import { readFileSync } from "node:fs";
import { type Abi, type AbiEvent, type AbiFunction, decodeErrorResult, encodeErrorResult, keccak256, toEventSelector, toFunctionSignature, toHex } from "viem";
import { describe, expect, it } from "vitest";
import {
  ADAPTER,
  ADAPTER_ERRORS,
  BASE_ADAPTER,
  BIT_ADAPTER,
  CLAIM_SOURCE,
  DOOR,
  DOOR_ERRORS,
  DOOR_LENS,
  ERRORS_V32,
  KEEPER_CALLS_V32,
  ONRAMP,
  ORACLE,
  PARK_CALLS,
  PARK_EVENTS,
  PARK_JOBS,
  PARK_READS,
  POOL,
  ROOT_STAKE_UNLOCK_INTERVAL_KEY,
  STAKER,
  SYSTEM_NUMBER_KEY,
  STAKING,
  STORAGE_QUERY,
  VAULT_ABI_V32 as CORE_VAULT_ABI,
  VAULT_KEPT,
  VAULT_LENS,
} from "../src/keeper/core/abi.ts";
import { POOL_ABI } from "../src/cardinality.ts";
import { doorLensAbi, frontDoorAbiV32, gettersNamed, shapeOf, VAULT_ABI_V32, vaultLensAbi } from "../src/v32/abi.ts";
import { routeOf } from "../src/v32/lens.ts";

// The ABI sync (ruling A3, plan Task 50): the keeper core bundles the published vault ABI and its own fragments for the
// rest; each fragment is held here to the build, through Task 43a's helpers: each getter on the contract that serves it
// (the vault or its lens, the door or its lens: routeOf), with the same types (shapeOf); each call and event the
// keeper sends or decodes as the contracts declare it.

const built = (name: string): Abi => (JSON.parse(readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`, import.meta.url), "utf8")) as { abi: Abi }).abi;
const fns = (abi: Abi) => abi.filter((i): i is AbiFunction => i.type === "function");
/** An event as a decoder reads it: its name, and each input's type, whether it is indexed, and its name. */
const toEventSignature = (e: AbiEvent) => `${e.name}(${e.inputs.map((i) => `${i.type}${i.indexed ? " indexed" : ""} ${i.name}`).join(", ")})`;
const events = (abi: Abi) => abi.filter((i): i is AbiEvent => i.type === "event");
const errorSigs = (abi: Abi) => abi.filter((i) => i.type === "error").map((e) => `${e.name}(${(e as { inputs: readonly { type: string }[] }).inputs.map((x) => x.type).join(",")})`);
const sameShape = (fragment: AbiFunction, on: Abi, where: string) => {
  const g = gettersNamed(on, fragment.name);
  expect(g.length, `${where} has a getter ${fragment.name}`).toBe(1);
  expect(shapeOf(fragment), `${where}.${fragment.name}`).toBe(shapeOf(g[0]));
};

describe("the keeper's v3.2 ABIs are the contracts' (ABI sync, ruling A3)", () => {
  it("the vault's is the published file, contracts/abi/CascadeVault.json, which Task 43a holds to a fresh merge", () => {
    expect(CORE_VAULT_ABI).toEqual(VAULT_ABI_V32);
  });

  it("every vault getter the keeper reads is where the published ABI and the lens put it, with the same types", () => {
    for (const f of fns(VAULT_LENS)) {
      expect(routeOf(VAULT_ABI_V32, vaultLensAbi(), f.name, "vault"), f.name).toBe("lens");
      sameShape(f, vaultLensAbi(), "CascadeVaultLens");
    }
    for (const f of fns(VAULT_KEPT)) {
      expect(routeOf(VAULT_ABI_V32, vaultLensAbi(), f.name, "vault"), f.name).toBe("contract");
      sameShape(f, VAULT_ABI_V32, "CascadeVault");
    }
  });

  it("every front door getter the keeper reads is the door's own, or its lens's, with the same types; its events are the door's", () => {
    for (const f of fns(DOOR)) {
      expect(routeOf(frontDoorAbiV32(), doorLensAbi(), f.name, "front door"), f.name).toBe("contract");
      sameShape(f, frontDoorAbiV32(), "CascadeFrontDoor");
    }
    for (const f of fns(DOOR_LENS)) {
      expect(routeOf(frontDoorAbiV32(), doorLensAbi(), f.name, "front door"), f.name).toBe("lens");
      sameShape(f, doorLensAbi(), "CascadeDoorLens");
    }
    const door = events(frontDoorAbiV32()).map((e) => toEventSignature(e));
    for (const e of events(DOOR)) expect(door, e.name).toContain(toEventSignature(e));
  });

  it("the adapters', the staker's and the oracle's fragments are their builds'", () => {
    for (const adapter of ["CcipBittensorAdapter", "CcipBaseAdapter"]) {
      for (const f of fns(ADAPTER)) expect(fns(built(adapter)).map((x) => toFunctionSignature(x)), `${adapter}.${f.name}`).toContain(toFunctionSignature(f));
      for (const f of fns(ADAPTER).filter((x) => x.stateMutability === "view")) sameShape(f, built(adapter), adapter);
      expect(events(built(adapter)).map((e) => toEventSignature(e))).toContain(toEventSignature(events(ADAPTER)[0]));
    }
    for (const f of fns(BIT_ADAPTER)) sameShape(f, built("CcipBittensorAdapter"), "CcipBittensorAdapter");
    for (const f of fns(BASE_ADAPTER)) sameShape(f, built("CcipBaseAdapter"), "CcipBaseAdapter");
    for (const f of fns(STAKER)) sameShape(f, built("CascadeStaker"), "CascadeStaker");
    for (const f of fns(ORACLE)) sameShape(f, built("CascadeTwapOracle"), "CascadeTwapOracle");
  });

  it("the keeper's calls: closeBatch(uint64,uint256) payable on the door; stakeIdle, a payable processPayouts and setIdleBuffer(uint256) on the vault", () => {
    const want = (abi: Abi, f: AbiFunction) => {
      const g = fns(abi).find((x) => x.name === f.name);
      expect(g, f.name).toBeDefined();
      expect([toFunctionSignature(g as AbiFunction), g?.stateMutability]).toEqual([toFunctionSignature(f), f.stateMutability]);
    };
    const calls = fns(KEEPER_CALLS_V32);
    want(frontDoorAbiV32(), calls.find((f) => f.name === "closeBatch") as AbiFunction);
    // Task 50a: deliver(user, keeperMinOut) on the door, and the delivery reads (the door's getters, its events, the oracle's depth)
    want(frontDoorAbiV32(), calls.find((f) => f.name === "deliver") as AbiFunction);
    for (const name of ["deliveryOf", "maxDeliverySlippageBps", "minPoolLiquidity"]) expect(fns(DOOR).map((f) => f.name), name).toContain(name);
    for (const name of ["PayoutReceived", "Delivered", "Claimed", "DeliverySet"]) expect(events(DOOR).map((e) => e.name), name).toContain(name);
    expect(fns(ORACLE).map((f) => f.name)).toContain("meanLiquidity");
    // the founder's migration exception (T50a fix round): deliverParked on the Bittensor adapter, as built
    want(built("CcipBittensorAdapter"), fns(PARK_CALLS)[0]);
    // and what the send path reads of the park before it lets one through (re-review A): parked(key), remoteChainId()
    for (const f of fns(PARK_READS)) sameShape(f, built("CcipBittensorAdapter"), "CcipBittensorAdapter");
    for (const name of ["stakeIdle", "processPayouts", "setIdleBuffer"]) want(VAULT_ABI_V32, calls.find((f) => f.name === name) as AbiFunction);
    expect(toFunctionSignature(calls.find((f) => f.name === "setIdleBuffer") as AbiFunction)).toBe("setIdleBuffer(uint256)");
    // Task 51: claimRewards(bytes32) per hotkey and adoptStake() on the vault, as built
    for (const name of ["claimRewards", "adoptStake"]) want(VAULT_ABI_V32, calls.find((f) => f.name === name) as AbiFunction);
    expect(calls.filter((f) => ["claimRewards", "adoptStake"].includes(f.name)).map((f) => toFunctionSignature(f))).toEqual(["claimRewards(bytes32)", "adoptStake()"]);
    // and what the claim job reads of the lens: the list itself, the surplus, the last adoption (each routed and shaped
    // by the VAULT_LENS loop above)
    for (const name of ["hotkeys", "hotkeyCount", "stakeHotkey", "lastClaimAt", "surplusStakeRao", "lastAdoptAt", "claimGasRequired"]) expect(fns(VAULT_LENS).map((f) => f.name), name).toContain(name);
    // Task 53: the hotkey watch's calls (addHotkey(bytes32), removeHotkey(bytes32,bool) on the vault, as built) and reads
    // (missingStakeRao, unlistedStakeRao: routed and shaped by the VAULT_LENS loop above)
    for (const name of ["addHotkey", "removeHotkey"]) want(VAULT_ABI_V32, calls.find((f) => f.name === name) as AbiFunction);
    expect(calls.filter((f) => ["addHotkey", "removeHotkey"].includes(f.name)).map((f) => toFunctionSignature(f))).toEqual(["addHotkey(bytes32)", "removeHotkey(bytes32,bool)"]);
    for (const name of ["missingStakeRao", "unlistedStakeRao"]) expect(fns(VAULT_LENS).map((f) => f.name), name).toContain(name);
  });

  it("the root hold's storage key is the monitor's (Task 53: RootStakeUnlockInterval through the storage-query precompile), and the precompile is the one ops reads", () => {
    const indexer = readFileSync(new URL("../../indexer/src/subtensor.ts", import.meta.url), "utf8");
    expect(indexer).toContain(`export const ROOT_STAKE_UNLOCK_INTERVAL_KEY = "${ROOT_STAKE_UNLOCK_INTERVAL_KEY}" as Hex;`);
    expect(indexer).toContain(`export const STORAGE_QUERY = "${STORAGE_QUERY}" as Hex;`);
  });

  it("the precompile's proof key is System.Number's, twox128 of each name (Task 53's fix round, the review's Important 6), as the root hold's is", async () => {
    const { twox128 } = await import("../../indexer/test/worker/xxhash.ts");
    expect(SYSTEM_NUMBER_KEY).toBe(`0x${twox128("System")}${twox128("Number")}`);
    expect(ROOT_STAKE_UNLOCK_INTERVAL_KEY).toBe(`0x${twox128("SubtensorModule")}${twox128("RootStakeUnlockInterval")}`);
  });

  it("the park job's calls, events and errors are the Bittensor adapter's, and the OnRamp's send event is the fork harness's (Task 52)", () => {
    const adapter = built("CcipBittensorAdapter");
    const want = (f: AbiFunction) => {
      const g = fns(adapter).find((x) => x.name === f.name);
      expect(g, f.name).toBeDefined();
      expect([toFunctionSignature(g as AbiFunction), g?.stateMutability]).toEqual([toFunctionSignature(f), f.stateMutability]);
    };
    for (const f of fns(PARK_JOBS)) want(f);
    expect(fns(PARK_JOBS).map((f) => `${toFunctionSignature(f)} ${f.stateMutability}`)).toEqual([
      "refundParked(address,address,bytes) payable",
      "quoteRefund(address,address,bytes) view",
      "dropParked(address,address,bytes) nonpayable",
    ]);
    const evs = events(adapter).map((e) => toEventSignature(e));
    for (const e of events(PARK_EVENTS)) expect(evs, e.name).toContain(toEventSignature(e));
    const errs = errorSigs(adapter);
    for (const e of errorSigs(ADAPTER_ERRORS)) expect(errs, e).toContain(e);
    for (const e of errorSigs(ADAPTER_ERRORS)) expect(errorSigs(ERRORS_V32), e).toContain(e);
    // CCIPMessageSent: the signature the fork harness reads the deployed OnRamp 2.0.0's logs with
    const fork = readFileSync(new URL("../../contracts/test/fork/ForkBase.sol", import.meta.url), "utf8");
    const literal = /CCIP_MESSAGE_SENT = keccak256\(\s*"([^"]+)"\s*\)/.exec(fork)?.[1];
    expect(literal).toBe("CCIPMessageSent(uint64,address,bytes32,address,uint256,bytes,(address,uint32,uint32,uint256,bytes)[],bytes[])");
    const sent = events(ONRAMP)[0];
    expect(toEventSelector(sent)).toBe(keccak256(toHex(literal as string)));
    // its data starts (address feeToken, uint256 amount, bytes encodedMessage, ...): the first three are indexed
    expect(sent.inputs.map((i) => [i.name, i.indexed === true])).toEqual([
      ["destChainSelector", true],
      ["sender", true],
      ["messageId", true],
      ["feeToken", false],
      ["tokenAmountBeforeTokenPoolFees", false],
      ["encodedMessage", false],
      ["receipts", false],
      ["verifierBlobs", false],
    ]);
  });

  it("the staking precompile's views the keeper reads are IStaking's, the claim source among them (Task 51: one fragment, CLAIM_SOURCE)", () => {
    const istaking = built("IStaking");
    const sig = (f: AbiFunction) => `${toFunctionSignature(f)} returns (${f.outputs.map((o) => o.type).join(",")})`;
    // (the for-life flag, getRejectStakingHotkeyGrowth, is not in the vault's interface: it is held to verify.ts's below)
    for (const f of [...fns(STAKING).filter((x) => x.name !== "getRejectStakingHotkeyGrowth"), CLAIM_SOURCE]) expect(fns(istaking).map((x) => sig(x)), f.name).toContain(sig(f));
    expect(sig(CLAIM_SOURCE)).toBe("getUnclaimedRootTaoByHotkey(bytes32,bytes32) returns (uint256)");
    expect(fns(STAKING)).toContainEqual(CLAIM_SOURCE);
    expect(sig(fns(STAKING).find((f) => f.name === "getStake") as AbiFunction)).toBe("getStake(bytes32,bytes32,uint256) returns (uint256)");
  });

  it("every error a keeper send can meet is named: the published vault ABI's and every one of the door's", () => {
    const door = errorSigs(frontDoorAbiV32());
    for (const e of errorSigs(DOOR_ERRORS)) expect(door, e).toContain(e);
    const all = new Set(errorSigs(ERRORS_V32));
    for (const e of door) expect(all.has(e), e).toBe(true);
  });

  it("the carried ABI changes are the keeper's: the bounce's reason, BatchClosed's 7 fields, the chunk's charges, the cancel, the constants, AboveBridgeCap, maxMessageValue", () => {
    const ev = (name: string) => events(VAULT_ABI_V32).find((e) => e.name === name) as AbiEvent;
    expect(toEventSignature(ev("DepositBounced"))).toBe("DepositBounced(bytes32 indexed key, address indexed user, uint256 assets, uint8 reason)");
    expect(ev("PayoutChunkSent").inputs.map((i) => i.name)).toEqual(["key", "chunk", "taken", "gross", "net", "fee", "charged", "unstakeCost"]);
    expect(toEventSignature(ev("PayoutBatchCancelled"))).toBe("PayoutBatchCancelled(bytes32 indexed key, uint256 reminted, uint32 bouncesCarried)");
    const closed = events(DOOR).find((e) => e.name === "BatchClosed") as AbiEvent;
    expect(closed.inputs.map((i) => i.name)).toEqual(["id", "totalDeposits", "nDeposits", "nRedeems", "fee", "potUsed", "potCarried"]);
    for (const c of ["FALLBACK_MIN_STAKE_RAO", "FALLBACK_MIN_REMAIN_RAO", "MIN_CLAIM_GAS"]) expect(fns(VAULT_LENS).map((f) => f.name), c).toContain(c);
    expect(errorSigs(ERRORS_V32)).toContain("AboveBridgeCap()");
    expect(errorSigs(ERRORS_V32)).toEqual(expect.arrayContaining(["BadValue()", "FeeTooHigh()", "UnstakeShort()", "StakeMissing()", "NothingToCancel()", "NotScheduled()", "WrongBatch(uint64)", "BatchTooSmall()", "ThinPool(uint8,uint128)"]));
    expect(fns(ADAPTER).map((f) => f.name)).toContain("maxMessageValue");
  });

  it("R11: the cancel cooldown's refusal, CancelTooSoon(uint256), is named and decoded by position, its view and constant listed, as contracts/src declares them (with or without a build)", () => {
    const src = (file: string) => readFileSync(new URL(`../../contracts/src/${file}`, import.meta.url), "utf8").replace(/\/\/[^\n]*/g, "");
    expect(src("CascadeErrors.sol")).toMatch(/error CancelTooSoon\(uint256 \w+\);/);
    expect(src("CascadeFrontDoor.sol")).toMatch(/function cancelableAt\(address user\) (external|public) view returns \(uint256\)/);
    expect(src("CascadeFrontDoor.sol")).toMatch(/uint64 public constant CANCEL_COOLDOWN = 5 minutes;/);
    expect(errorSigs(DOOR_ERRORS)).toContain("CancelTooSoon(uint256)");
    expect(errorSigs(ERRORS_V32)).toContain("CancelTooSoon(uint256)");
    const data = encodeErrorResult({ abi: ERRORS_V32, errorName: "CancelTooSoon", args: [1_900_000_300n] });
    expect(decodeErrorResult({ abi: ERRORS_V32, data })).toMatchObject({ errorName: "CancelTooSoon", args: [1_900_000_300n] });
    const view = fns(DOOR).find((f) => f.name === "cancelableAt");
    expect(view && `${toFunctionSignature(view)} ${view.stateMutability} ${view.outputs.map((o) => o.type)}`).toBe("cancelableAt(address) view uint256");
    const constant = fns(DOOR).find((f) => f.name === "CANCEL_COOLDOWN");
    expect(constant && `${toFunctionSignature(constant)} ${constant.stateMutability} ${constant.outputs.map((o) => o.type)}`).toBe("CANCEL_COOLDOWN() view uint64");
  });

  it("the for-life reads of what is not Cascade's: a pool's fee() and slot0() and the staking precompile's flag, as ops reads them (T50 review I2)", () => {
    const sig = (abi: Abi, name: string) => {
      const f = fns(abi).find((x) => x.name === name) as AbiFunction;
      return `${toFunctionSignature(f)} returns (${f.outputs.map((o) => o.type).join(",")})`;
    };
    expect(sig(POOL, "slot0")).toBe(sig(POOL_ABI, "slot0"));
    expect(fns(POOL).find((f) => f.name === "slot0")?.outputs[3].name).toBe("observationCardinality");
    const verify = readFileSync(new URL("../src/v32/verify.ts", import.meta.url), "utf8");
    expect(verify).toContain(`"function fee() view returns (uint24)"`);
    expect(sig(POOL, "fee")).toBe("fee() returns (uint24)");
    expect(verify).toContain(`"function getRejectStakingHotkeyGrowth(bytes32 coldkey) view returns (bool)"`);
    expect(sig(STAKING, "getRejectStakingHotkeyGrowth")).toBe("getRejectStakingHotkeyGrowth(bytes32) returns (bool)");
  });
});
