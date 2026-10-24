#!/usr/bin/env bash
# Live simulation of one inbound delivery (Base -> Bittensor) against the real Bittensor EVM node.
#
# The fork tests run ForeverMoney's real AlphaVault code over a mock staking precompile, because the
# forked EVM has no precompile at 0x...0805. This script is the only check of the real path before
# money moves: it runs `CcipBittensorAdapter.ccipReceive` as a plain `eth_call` on the live node, with
# state overrides that
#   - place the adapter's runtime code (real constructor arguments) at an unused address,
#   - place test/fork/Sink.sol at another as the recipient (it reverts unless msg.value == amount),
#   - give the adapter AMOUNT of ForeverMoney's bridged TAO (one storage slot on the token),
#   - replace the CCIP Router's code with a small stand-in (below).
# The real AlphaVault.withdrawLiquid then burns the tokens, unstakes through the real staking
# precompile and pays native TAO to the adapter, which forwards it to the sink. Nothing is broadcast
# and no key with funds is used.
#
# The adapter's reserve: Bittensor EVM reports an account's balance net of the 500-rao existential
# deposit, so an adapter with no native balance sees the credit 500 rao short and reverts
# ConversionShort. The deployment funds 1e12 wei with `fundReserve()` before the first delivery. The
# node ignores balance overrides, so the script funds it the same way: the Router stand-in calls
# `adapter.fundReserve{value: msg.value}()` and then forwards the `ccipReceive` calldata to the
# adapter, which therefore still sees msg.sender == Router. The eth_call is sent from FUNDER with
# value RESERVE.
#
# Run from contracts/:   bash script/simulate_inbound.sh
# Env (all optional):
#   BITTENSOR_RPC   Bittensor EVM RPC (default https://lite.chain.opentensor.ai)
#   REMOTE_ADAPTER  the Base adapter's address, the only accepted CCIP sender (default 0x1111...1111)
#   AMOUNT          bridged TAO to deliver, in wei; whole rao and at least the staking floor (default 1e18)
#   GAS_BASE, GAS_PER_ENTRY  the Bittensor adapter's gas model toward Base (default 120000 / 29900,
#                   the deployment values); they only change the bytecode's immutables
#   RESERVE         the adapter's native reserve in wei (default 1e12, the deployment value; 0 shows the
#                   ConversionShort failure of an unfunded adapter)
#   FUNDER          any address holding at least RESERVE, used as the eth_call's sender (default: the
#                   Router's wrapped-native contract, which holds the CCIP fees paid in TAO)
#
# Needs forge, cast and anvil on PATH. About 12 requests to BITTENSOR_RPC (the public endpoints
# allow about 128 a minute).
set -euo pipefail

BITTENSOR_RPC="${BITTENSOR_RPC:-https://lite.chain.opentensor.ai}"
REMOTE_ADAPTER="${REMOTE_ADAPTER:-0x1111111111111111111111111111111111111111}"
AMOUNT="${AMOUNT:-1000000000000000000}"
GAS_BASE="${GAS_BASE:-120000}"
GAS_PER_ENTRY="${GAS_PER_ENTRY:-29900}"
RESERVE="${RESERVE:-1000000000000}"

# Live addresses on Bittensor EVM (chain 964); the same values as test/fork/ForkBase.sol.
BIT_ROUTER=0xD941fBEcD2b971d0F54b4C34286C95faB52B60B8
BIT_TAO=0xC5b6C1632d34901239396F5E1BDe54B342900256
BIT_POOL=0xB66b9c085ab711ECC373aaF6dc959a4A6B42BE2e
ALPHA_VAULT=0x11837459896D96F821a8D88eC93a3C8D152033D4
STAKING=0x0000000000000000000000000000000000000805
BASE_SELECTOR=15971525489660198786
FRONT_DOOR=0x00000000000000000000000000000000000000fd # stands in for the Base front door (payload sender)
ALICE=0x00000000000000000000000000000000000a11ce      # the one depositor in the batch

ANVIL_PORT=8546
LOCAL_RPC="http://127.0.0.1:${ANVIL_PORT}"
MNEMONIC="test test test test test test test test test test test junk" # anvil's default accounts

WORK="$(mktemp -d)"
ANVIL_PID=""
cleanup() {
  if [ -n "$ANVIL_PID" ]; then kill "$ANVIL_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

say() { printf '\n== %s\n' "$*"; }
fail() {
  printf '\nSIMULATION FAILED: %s\n' "$*" >&2
  exit 1
}
first_word() { awk '{print $1}'; }
# less_than A B: true when decimal A < decimal B (any size, no leading zeros).
less_than() { [ "${#1}" -lt "${#2}" ] || { [ "${#1}" -eq "${#2}" ] && [[ "$1" < "$2" ]]; }; }

cd "$(dirname "$0")/.."
[ "$AMOUNT" != "0" ] || fail "AMOUNT must be positive: a delivery of 0 converts nothing"

say "0. Live node"
BLOCK="$(cast block-number --rpc-url "$BITTENSOR_RPC")"
FLOOR_RAO="$(cast call "$STAKING" "getDefaultMinStake()(uint256)" --block "$BLOCK" --rpc-url "$BITTENSOR_RPC" | first_word)"
echo "rpc $BITTENSOR_RPC, block $BLOCK (every remote read below is pinned to it)"
echo "staking floor (getDefaultMinStake): $FLOOR_RAO rao = $(cast to-unit "$((FLOOR_RAO * 1000000000))" ether) TAO"
echo "amount $AMOUNT wei = $(cast to-unit "$AMOUNT" ether) TAO; remote adapter $REMOTE_ADAPTER"

say "1. Deploy the adapter and the sink on a local anvil, read their runtime code"
# A plain local chain, not a fork: the constructors read no chain state, so the runtime code is the same,
# and a fork's start-up alone (anvil reads every dev account from the node) can exhaust the rate limit.
anvil --chain-id 964 --port "$ANVIL_PORT" >"$WORK/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 60); do
  if cast chain-id --rpc-url "$LOCAL_RPC" >/dev/null 2>&1; then break; fi
  sleep 1
done
cast chain-id --rpc-url "$LOCAL_RPC" >/dev/null 2>&1 || {
  cat "$WORK/anvil.log"
  fail "anvil did not start"
}
echo "anvil pid $ANVIL_PID on $LOCAL_RPC"

CONFIG="($BIT_ROUTER,$BIT_TAO,964,8453,$BASE_SELECTOR,$REMOTE_ADAPTER,$GAS_BASE,$GAS_PER_ENTRY)"
echo "CcipBittensorAdapter($CONFIG, $ALPHA_VAULT)"
forge create src/adapters/CcipBittensorAdapter.sol:CcipBittensorAdapter --rpc-url "$LOCAL_RPC" \
  --mnemonic "$MNEMONIC" --mnemonic-index 0 --broadcast \
  --constructor-args "$CONFIG" "$ALPHA_VAULT" >"$WORK/adapter.txt" 2>&1 || {
  cat "$WORK/adapter.txt"
  fail "forge create adapter"
}
LOCAL_ADAPTER="$(sed -n 's/^Deployed to: *\(0x[0-9a-fA-F]\{40\}\).*/\1/p' "$WORK/adapter.txt")"
forge create test/fork/Sink.sol:Sink --rpc-url "$LOCAL_RPC" \
  --mnemonic "$MNEMONIC" --mnemonic-index 0 --broadcast >"$WORK/sink.txt" 2>&1 || {
  cat "$WORK/sink.txt"
  fail "forge create sink"
}
LOCAL_SINK="$(sed -n 's/^Deployed to: *\(0x[0-9a-fA-F]\{40\}\).*/\1/p' "$WORK/sink.txt")"
[ -n "$LOCAL_ADAPTER" ] && [ -n "$LOCAL_SINK" ] || {
  cat "$WORK/adapter.txt" "$WORK/sink.txt"
  fail "could not read the deployed addresses"
}
CODE="$(cast code "$LOCAL_ADAPTER" --rpc-url "$LOCAL_RPC")"
SINK_CODE="$(cast code "$LOCAL_SINK" --rpc-url "$LOCAL_RPC")"
[ "${#CODE}" -gt 2 ] && [ "${#SINK_CODE}" -gt 2 ] || fail "empty runtime code"
echo "runtime code: adapter $(((${#CODE} - 2) / 2)) bytes, sink $(((${#SINK_CODE} - 2) / 2)) bytes"
echo "adapter immutables: router $(cast call "$LOCAL_ADAPTER" "router()(address)" --rpc-url "$LOCAL_RPC"), remoteAdapter $(cast call "$LOCAL_ADAPTER" "remoteAdapter()(address)" --rpc-url "$LOCAL_RPC"), alphaVault $(cast call "$LOCAL_ADAPTER" "alphaVault()(address)" --rpc-url "$LOCAL_RPC")"
kill "$ANVIL_PID" 2>/dev/null || true
wait "$ANVIL_PID" 2>/dev/null || true
ANVIL_PID=""
echo "anvil stopped"

say "2. Live state for the overrides"
# Addresses derived from a hash, so nothing on the live chain uses them. anvil's own deployment addresses
# are not safe there: people use anvil's public keys on mainnets, and a balance already sitting at the
# adapter's address would stand in for its reserve.
ADAPTER="0x$(cast keccak "cascade simulate_inbound adapter" | cut -c27-66)"
SINK="0x$(cast keccak "cascade simulate_inbound sink" | cut -c27-66)"
for a in "$ADAPTER" "$SINK"; do
  [ "$(cast balance "$a" --block "$BLOCK" --rpc-url "$BITTENSOR_RPC")" = "0" ] || fail "$a holds native TAO on the live chain"
  [ "$(cast code "$a" --block "$BLOCK" --rpc-url "$BITTENSOR_RPC")" = "0x" ] || fail "$a has code on the live chain"
done
echo "adapter at $ADAPTER, sink at $SINK (no balance and no code on the live chain)"
POOL_BAL="$(cast call "$BIT_TAO" "balanceOf(address)(uint256)" "$BIT_POOL" --block "$BLOCK" --rpc-url "$BITTENSOR_RPC" | first_word)"
[ "$POOL_BAL" != "0" ] || fail "the pool holds no bridged TAO, so the slot search cannot tell slots apart"
echo "pool $BIT_POOL holds $POOL_BAL wei"
SLOT_INDEX=""
for s in 0 1 2 3 4 5; do
  RAW="$(cast storage "$BIT_TAO" "$(cast index address "$BIT_POOL" "$s")" --block "$BLOCK" --rpc-url "$BITTENSOR_RPC")"
  VALUE="$(cast to-dec "$RAW")"
  echo "mapping slot $s: $VALUE"
  if [ "$VALUE" = "$POOL_BAL" ]; then
    SLOT_INDEX=$s
    break
  fi
done
[ -n "$SLOT_INDEX" ] || fail "no mapping slot in 0..5 holds the pool's balance; the token's storage layout changed"
SLOT="$(cast index address "$ADAPTER" "$SLOT_INDEX")"
echo "balances mapping at slot $SLOT_INDEX; the adapter's balance slot is $SLOT"

say "3. ccipReceive from the Router, as an eth_call on the live node"
FUNDER="${FUNDER:-$(cast call "$BIT_ROUTER" "getWrappedNative()(address)" --block "$BLOCK" --rpc-url "$BITTENSOR_RPC")}"
FUNDER_BAL="$(cast balance "$FUNDER" --block "$BLOCK" --rpc-url "$BITTENSOR_RPC")"
echo "reserve $RESERVE wei through fundReserve(), sent by $FUNDER (holds $FUNDER_BAL wei)"
less_than "$FUNDER_BAL" "$RESERVE" && fail "FUNDER holds less than RESERVE"
# The Router stand-in, 110 bytes of EVM code (check it with `cast disassemble`):
#   mstore(0, fundReserve selector); ok := call(gas, adapter, callvalue, 0, 4, 0, 0); if !ok goto fail
#   calldatacopy(0, 0, calldatasize); ok := call(gas, adapter, 0, 0, calldatasize, 0, 0)
#   returndatacopy(0, 0, returndatasize); if ok return(0, returndatasize) else revert(0, returndatasize)
PUSH_ADAPTER="73$(printf '%s' "${ADAPTER#0x}" | tr 'A-F' 'a-f')"
FUND_SEL="$(cast sig "fundReserve()")"
STAND_IN="0x 63${FUND_SEL#0x} 60e0 1b 6000 52"                 # mstore(0, selector << 224)
STAND_IN+="6000 6000 6004 6000 34 ${PUSH_ADAPTER} 5a f1"       # call fundReserve{value: callvalue}
STAND_IN+="15 6058 57"                                         # if it failed, jump to fail
STAND_IN+="36 6000 6000 37"                                    # calldatacopy(0, 0, calldatasize)
STAND_IN+="6000 6000 36 6000 6000 ${PUSH_ADAPTER} 5a f1"       # call the adapter with that calldata
STAND_IN+="6063 57"                                            # if it succeeded, jump to ok
STAND_IN+="5b 3d 6000 6000 3e 3d 6000 fd"                      # fail (0x58): revert with the return data
STAND_IN+="5b 3d 6000 6000 3e 3d 6000 f3"                      # ok (0x63): return the return data
STAND_IN="${STAND_IN// /}"
BATCH="$(cast abi-encode "f(uint8,uint64,(address,uint256)[],(address,uint256)[])" 1 1 "[($ALICE,$AMOUNT)]" "[]")"
PAYLOAD="$(cast abi-encode "f(address,address,bytes)" "$SINK" "$FRONT_DOOR" "$BATCH")"
SENDER="$(cast abi-encode "f(address)" "$REMOTE_ADAPTER")"
MESSAGE_ID="$(cast keccak "cascade simulate_inbound")"
echo "message: id $MESSAGE_ID, source $BASE_SELECTOR, sender abi.encode($REMOTE_ADAPTER), token [($BIT_TAO, $AMOUNT)]"
echo "payload: abi.encode(sink $SINK, front door $FRONT_DOOR, BATCH(1, [($ALICE, $AMOUNT)], []))"
# --override-state-diff patches one slot and keeps the token's other storage (its total supply, which the
# burn needs); --override-state would replace the token's whole storage.
set +e
OUT="$(cast call --from "$FUNDER" --value "$RESERVE" "$BIT_ROUTER" \
  "ccipReceive((bytes32,uint64,bytes,bytes,(address,uint256)[]))" \
  "($MESSAGE_ID,$BASE_SELECTOR,$SENDER,$PAYLOAD,[($BIT_TAO,$AMOUNT)])" \
  --override-code "$BIT_ROUTER:$STAND_IN,$ADAPTER:$CODE,$SINK:$SINK_CODE" \
  --override-state-diff "$BIT_TAO:$SLOT:$AMOUNT" \
  --block "$BLOCK" --rpc-url "$BITTENSOR_RPC" 2>&1)"
STATUS=$?
set -e
echo "result: $OUT"

say "4. Verdict"
if [ "$STATUS" -eq 0 ]; then
  echo "SIMULATION OK: real AlphaVault.withdrawLiquid ran through the real staking precompile and the sink received $AMOUNT wei"
  exit 0
fi
# Name the revert: the adapter's own errors, the sink's, ForeverMoney's (docs/forevermoney-probe.md), OZ ERC-20's.
DATA="$(printf '%s' "$OUT" | grep -o '0x[0-9a-fA-F]\{8,\}' | tail -n 1 || true)"
if [ -n "$DATA" ]; then
  for sig in "NotRouter()" "WrongSource()" "WrongSender()" "WrongToken()" "TooManyTokens()" "NotRaoAligned()" \
    "BelowConversionFloor(uint256,uint256)" "ConversionShort()" "UnexpectedValue()" "SafeERC20FailedOperation(address)" \
    "ValueMismatch()" "Reverting()" \
    "IsHalted()" "ZeroAmount()" "NotWholeRao()" "InsufficientBalance(uint256,uint256)" "Insolvent()" "Slippage()" \
    "NativeTransferFailed()" "ERC20InsufficientBalance(address,uint256,uint256)"; do
    if [ "$(cast sig "$sig")" = "${DATA:0:10}" ]; then
      echo "revert: $sig $(cast decode-error --sig "$sig" "$DATA" 2>/dev/null | tr '\n' ' ')"
      break
    fi
  done
fi
fail "ccipReceive reverted (see the result above)"
