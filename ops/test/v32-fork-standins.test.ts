import { type Address, bytesToHex, concat, encodeAbiParameters, encodeFunctionData, getAddress, type Hex, hexToBytes, keccak256, pad, parseAbi, parseAbiParameters, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import {
  ADDRESS_MAPPING_PROGRAM,
  aliasSlot,
  assemble,
  HOTKEYS_SLOT,
  mappingEntry,
  rejectSlot,
  replaySlots,
  STAKING_IMPL,
  STORAGE_QUERY_PROGRAM,
  stakeSlot,
  stakingProgram,
} from "../src/v32/fork-standins.ts";
import { addressMapping } from "../src/v32/plan.ts";

// A small EVM for the opcodes the stand-ins use, to run them here (the rehearsal runs them on anvil): a 256-bit stack,
// byte memory, a storage map, calldata, and DELEGATECALL handed to a stub with this storage.
const M = (1n << 256n) - 1n;
type Storage = Map<string, bigint>;
type Outcome = { kind: "return" | "revert" | "stop"; data: Hex };
const key = (n: bigint) => n.toString(16);

function run(code: Hex, o: { calldata: Hex; storage: Storage; caller: Address; delegate?: (calldata: Hex, storage: Storage) => { ok: boolean; data: Hex } }): Outcome {
  const c = hexToBytes(code);
  const cd = hexToBytes(o.calldata);
  const st: bigint[] = [];
  let mem = new Uint8Array(0);
  let ret: Uint8Array = new Uint8Array(0);
  const pop = () => {
    const v = st.pop();
    if (v === undefined) throw new Error("stack underflow");
    return v;
  };
  const grow = (end: number) => {
    if (end > mem.length) {
      const m = new Uint8Array(Math.ceil(end / 32) * 32);
      m.set(mem);
      mem = m;
    }
  };
  const word = (b: Uint8Array, at: number) => {
    let v = 0n;
    for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(b[at + i] ?? 0);
    return v;
  };
  const dests = new Set<number>();
  for (let i = 0; i < c.length; i++) {
    if (c[i] === 0x5b) dests.add(i);
    if (c[i] >= 0x60 && c[i] <= 0x7f) i += c[i] - 0x5f;
  }
  for (let pc = 0, steps = 0; ; steps++) {
    if (steps > 10_000) throw new Error("too many steps");
    const op = c[pc] ?? 0;
    pc++;
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      let v = 0n;
      for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(c[pc + i]);
      st.push(v);
      pc += n;
      continue;
    }
    if (op >= 0x80 && op <= 0x8f) {
      st.push(st[st.length - 1 - (op - 0x80)]);
      continue;
    }
    if (op >= 0x90 && op <= 0x9f) {
      const n = op - 0x8f;
      const t = st.length - 1;
      [st[t], st[t - n]] = [st[t - n], st[t]];
      continue;
    }
    switch (op) {
      case 0x00:
        return { kind: "stop", data: "0x" };
      case 0x01:
        st.push((pop() + pop()) & M);
        break;
      case 0x03: {
        const a = pop();
        st.push((a - pop()) & M);
        break;
      }
      case 0x10: {
        const a = pop();
        st.push(a < pop() ? 1n : 0n);
        break;
      }
      case 0x11: {
        const a = pop();
        st.push(a > pop() ? 1n : 0n);
        break;
      }
      case 0x14:
        st.push(pop() === pop() ? 1n : 0n);
        break;
      case 0x15:
        st.push(pop() === 0n ? 1n : 0n);
        break;
      case 0x1c: {
        const shift = pop();
        st.push(pop() >> shift);
        break;
      }
      case 0x20: {
        const at = Number(pop());
        const n = Number(pop());
        grow(at + n);
        st.push(BigInt(keccak256(mem.slice(at, at + n))));
        break;
      }
      case 0x33:
        st.push(BigInt(o.caller));
        break;
      case 0x35:
        st.push(word(cd, Number(pop())));
        break;
      case 0x36:
        st.push(BigInt(cd.length));
        break;
      case 0x37: {
        const to = Number(pop());
        const from = Number(pop());
        const n = Number(pop());
        grow(to + n);
        for (let i = 0; i < n; i++) mem[to + i] = cd[from + i] ?? 0;
        break;
      }
      case 0x3d:
        st.push(BigInt(ret.length));
        break;
      case 0x3e: {
        const to = Number(pop());
        const from = Number(pop());
        const n = Number(pop());
        grow(to + n);
        mem.set(ret.slice(from, from + n), to);
        break;
      }
      case 0x50:
        pop();
        break;
      case 0x52: {
        const at = Number(pop());
        const v = pop();
        grow(at + 32);
        mem.set(hexToBytes(pad(`0x${v.toString(16)}` as Hex, { size: 32 })), at);
        break;
      }
      case 0x54:
        st.push(o.storage.get(key(pop())) ?? 0n);
        break;
      case 0x55: {
        const k = pop();
        o.storage.set(key(k), pop());
        break;
      }
      case 0x56: {
        const to = Number(pop());
        if (!dests.has(to)) throw new Error(`a jump to ${to}, no JUMPDEST`);
        pc = to;
        break;
      }
      case 0x57: {
        const to = Number(pop());
        if (pop() !== 0n) {
          if (!dests.has(to)) throw new Error(`a jump to ${to}, no JUMPDEST`);
          pc = to;
        }
        break;
      }
      case 0x5a:
        st.push(1_000_000n);
        break;
      case 0x5b:
        break;
      case 0xf3:
      case 0xfd: {
        const at = Number(pop());
        const n = Number(pop());
        grow(at + n);
        return { kind: op === 0xf3 ? "return" : "revert", data: bytesToHex(mem.slice(at, at + n)) };
      }
      case 0xf4: {
        pop();
        const to = pop();
        const inAt = Number(pop());
        const inN = Number(pop());
        pop();
        pop();
        expect(getAddress(`0x${to.toString(16).padStart(40, "0")}`)).toBe(getAddress(STAKING_IMPL));
        grow(inAt + inN);
        const r = o.delegate?.(bytesToHex(mem.slice(inAt, inAt + inN)), o.storage) ?? { ok: false, data: "0x" };
        ret = new Uint8Array(hexToBytes(r.data));
        st.push(r.ok ? 1n : 0n);
        break;
      }
      default:
        throw new Error(`opcode 0x${op.toString(16)} not in the test EVM`);
    }
  }
}

const STAKING = parseAbi([
  "function getRejectStakingHotkeyGrowth(bytes32 coldkey) view returns (bool)",
  "function setRejectStakingHotkeyGrowth(bool enabled)",
  "function getTotalColdkeyStakeOnSubnet(bytes32 coldkey, uint256 netuid) view returns (uint256)",
  "function getStake(bytes32 hotkey, bytes32 coldkey, uint256 netuid) view returns (uint256)",
]);
const VAULT: Address = "0x1111111111111111111111111111111111111111";
const STRANGER: Address = "0x2222222222222222222222222222222222222222";
const H1 = `0x${"a1".repeat(32)}` as Hex;
const H2 = `0x${"b2".repeat(32)}` as Hex;
const H3 = `0x${"c3".repeat(32)}` as Hex;
const word = (v: bigint) => pad(`0x${v.toString(16)}` as Hex, { size: 32 });
const put = (s: Storage, slot: Hex, v: bigint | Hex) => s.set(key(BigInt(slot)), typeof v === "bigint" ? v : BigInt(v));

describe("the v3.2 stand-ins for Bittensor's precompiles on a fork (Task 61, ruling A9)", () => {
  it("assembles pushes, opcodes and labels, each label a JUMPDEST at its offset", () => {
    expect(assemble([{ push: 1 }, { push: 2 }, "ADD", { label: "x" }, { pushLabel: "x" }, "JUMP"])).toBe("0x60016002015b61000556");
    expect(assemble([{ push: 0x1234n, width: 32 }])).toBe(`0x7f${"00".repeat(30)}1234`);
    expect(() => assemble(["NOPE"])).toThrow(/no opcode NOPE/);
    expect(() => assemble([{ pushLabel: "y" }])).toThrow(/no label y/);
    expect(() => assemble([{ label: "z" }, { label: "z" }])).toThrow(/label z twice/);
    // the address mapping, byte for byte as read by hand
    expect(assemble(ADDRESS_MAPPING_PROGRAM)).toBe("0x600435806000526020600020548061001b5750600052602060 00f35b600052602060 00f3".replaceAll(" ", ""));
  });

  it("the address mapping answers the table's coldkey (blake2b of evm: and the address), else the zero-padded address", () => {
    const code = assemble(ADDRESS_MAPPING_PROGRAM);
    const storage: Storage = new Map();
    const e = mappingEntry(VAULT);
    expect(e.value).toBe(addressMapping(VAULT));
    put(storage, e.slot, e.value);
    const ask = (a: Address) => run(code, { calldata: encodeFunctionData({ abi: parseAbi(["function addressMapping(address) view returns (bytes32)"]), functionName: "addressMapping", args: [a] }), storage, caller: STRANGER });
    expect(ask(VAULT)).toEqual({ kind: "return", data: addressMapping(VAULT) });
    expect(ask(STRANGER)).toEqual({ kind: "return", data: encodeAbiParameters(parseAbiParameters("address"), [STRANGER]) });
  });

  it("the staking front books the reject flag under the caller's alias (or its padded address), answers it and the total, and runs the rest as RehearsalStaking", () => {
    const code = assemble(stakingProgram());
    const storage: Storage = new Map();
    const coldkey = addressMapping(VAULT);
    put(storage, aliasSlot(VAULT), coldkey);
    const call = (fn: string, args: unknown[], caller: Address = VAULT, delegate?: Parameters<typeof run>[1]["delegate"]) =>
      run(code, { calldata: encodeFunctionData({ abi: STAKING, functionName: fn, args } as never), storage, caller, delegate });
    // the vault's constructor sets it: under its real coldkey, through the alias
    expect(call("getRejectStakingHotkeyGrowth", [coldkey]).data).toBe(word(0n));
    expect(call("setRejectStakingHotkeyGrowth", [true]).kind).toBe("stop");
    expect(storage.get(key(BigInt(rejectSlot(coldkey))))).toBe(1n);
    expect(call("getRejectStakingHotkeyGrowth", [coldkey]).data).toBe(word(1n));
    // a caller with no alias: its zero-padded address, as RehearsalStaking's _cold
    const padded = encodeAbiParameters(parseAbiParameters("address"), [STRANGER]);
    call("setRejectStakingHotkeyGrowth", [true], STRANGER);
    expect(call("getRejectStakingHotkeyGrowth", [padded]).data).toBe(word(1n));
    call("setRejectStakingHotkeyGrowth", [false]);
    expect(call("getRejectStakingHotkeyGrowth", [coldkey]).data).toBe(word(0n));
    // the total: RehearsalStaking's _stake[h][coldkey][0] summed over the listed hotkeys, the others left out
    put(storage, stakeSlot(H1, coldkey, 0n), 5_000n);
    put(storage, stakeSlot(H2, coldkey, 0n), 7n);
    put(storage, stakeSlot(H3, coldkey, 0n), 1_000_000n);
    put(storage, stakeSlot(H1, coldkey, 1n), 9n);
    expect(call("getTotalColdkeyStakeOnSubnet", [coldkey, 0n]).data).toBe(word(0n));
    put(storage, HOTKEYS_SLOT, 2n);
    put(storage, word(BigInt(HOTKEYS_SLOT) + 1n), H1);
    put(storage, word(BigInt(HOTKEYS_SLOT) + 2n), H2);
    expect(call("getTotalColdkeyStakeOnSubnet", [coldkey, 0n]).data).toBe(word(5_007n));
    expect(call("getTotalColdkeyStakeOnSubnet", [coldkey, 1n]).data).toBe(word(9n));
    // anything else: RehearsalStaking's code with this storage, its answer or its revert passed back
    const seen: Hex[] = [];
    const answer = call("getStake", [H1, coldkey, 0n], STRANGER, (cd, s) => {
      seen.push(cd);
      return { ok: true, data: word(s.get(key(BigInt(stakeSlot(H1, coldkey, 0n)))) ?? 0n) };
    });
    expect(answer).toEqual({ kind: "return", data: word(5_000n) });
    expect(seen).toEqual([encodeFunctionData({ abi: STAKING, functionName: "getStake", args: [H1, coldkey, 0n] })]);
    const refused = run(code, { calldata: toFunctionSelector("function moveStake(bytes32,bytes32,uint256,uint256,uint256)"), storage, caller: VAULT, delegate: () => ({ ok: false, data: "0x08c379a0" }) });
    expect(refused).toEqual({ kind: "revert", data: "0x08c379a0" });
  });

  it("the storage-query replay answers each recorded key's bytes, and nothing for a key not recorded", () => {
    const code = assemble(STORAGE_QUERY_PROGRAM);
    const storage: Storage = new Map();
    const k1 = `0x658faa385070e074c85bf6b568cf055560d1f0ff648e4c86ea413fc0173d4038${"ab".repeat(48)}` as Hex;
    const k2 = `${k1.slice(0, -2)}cd` as Hex;
    const k3 = `${k1.slice(0, -2)}ef` as Hex;
    for (const [k, v] of [
      [k1, "0x2e14"],
      [k2, "0x0102030405060708"],
      [k3, "0x"],
    ] as [Hex, Hex][]) {
      for (const s of replaySlots(k, v)) put(storage, s.slot, s.value);
    }
    const ask = (k: Hex) => run(code, { calldata: k, storage, caller: STRANGER });
    expect(ask(k1)).toEqual({ kind: "return", data: "0x2e14" });
    expect(ask(k2)).toEqual({ kind: "return", data: "0x0102030405060708" });
    expect(ask(k3)).toEqual({ kind: "return", data: "0x" });
    expect(ask(`${k1.slice(0, -2)}00` as Hex)).toEqual({ kind: "return", data: "0x" });
    expect(replaySlots(k1, "0x2e14")).toEqual([
      { slot: keccak256(k1), value: word(3n) },
      { slot: word(BigInt(keccak256(k1)) + 1n), value: `0x2e14${"00".repeat(30)}` },
    ]);
    expect(() => replaySlots(k1, `0x${"00".repeat(33)}`)).toThrow(/33 bytes/);
  });

  it("keeps RehearsalStaking's layout: _stake at slot 0, coldkeyAlias at slot 1, as its source declares", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../contracts/test/rehearsal/RehearsalPrecompiles.sol", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("contract RehearsalStaking"), src.indexOf("contract RehearsalBalanceTransfer"));
    const vars = body.split("\n").filter((l) => /^\s{4}mapping\(/.test(l));
    expect(vars.map((l) => l.trim().split(" ").at(-1))).toEqual(["_stake;", "coldkeyAlias;"]);
    expect(stakeSlot(H1, H2, 0n)).toBe(keccak256(concat([word(0n), keccak256(concat([H2, keccak256(concat([H1, word(0n)]))]))])));
    expect(aliasSlot(VAULT)).toBe(keccak256(concat([encodeAbiParameters(parseAbiParameters("address"), [VAULT]), word(1n)])));
  });
});
