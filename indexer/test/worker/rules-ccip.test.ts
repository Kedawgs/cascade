import { env } from "cloudflare:workers";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { StoredLog } from "../../src/logs.ts";
import { arrivals, arrivalStatements, messageStatements, messagesFrom, stateStatements } from "../../src/messages.ts";
import { ccipFailure, ccipForeignSend, ccipUndelivered } from "../../src/rules/ccip.ts";
import { logQuery, type RuleCtx } from "../../src/rules/context.ts";
import { RUNBOOK } from "../../src/runbook.ts";
import { loadTickState, type MessageRow } from "../../src/store.ts";
import { D, h } from "./bridge-fixtures.ts";
import { wipe } from "./d1-count.ts";
import { ruleCtx, slog } from "./rule-ctx.ts";

const db = env.DB;
const SENT_AT = 1_800_000_000;
const STRANGER = "0x00000000000000000000000000000000000000e6" as Hex;

const sent = (o: { sender: Hex; recipient: Hex; messageId: Hex; chain?: "base" | "bittensor"; block?: bigint }): StoredLog =>
  slog({
    contract: (o.chain ?? "base") === "base" ? "baseAdapter" : "bitAdapter",
    chain: o.chain ?? "base",
    event: "Sent",
    block: o.block ?? 37_000_100n,
    txHash: h(`tx ${o.messageId}`),
    topic1: o.messageId,
    args: { messageId: o.messageId, destChain: "964", sender: o.sender, recipient: o.recipient, amount: "5", fee: "1", gasLimit: "1" },
  });
const delivered = (messageId: Hex, chain: "base" | "bittensor" = "bittensor"): StoredLog =>
  slog({
    contract: chain === "base" ? "baseAdapter" : "bitAdapter",
    chain,
    event: "Delivered",
    block: 6_900_200n,
    txHash: h(`dst ${messageId}`),
    topic1: messageId,
    args: { messageId, sourceChain: "8453", sender: D.frontDoor, recipient: D.vault, amount: "5" },
  });

const message = (o: Partial<MessageRow> = {}): MessageRow => ({
  messageId: h("m1"),
  direction: "base>bittensor",
  sender: D.frontDoor,
  recipient: D.vault,
  amount: "5",
  srcTx: h("src"),
  srcBlock: 37_000_100n,
  srcTime: SENT_AT,
  state: "UNTOUCHED",
  stateAt: null,
  dstTx: null,
  dstBlock: null,
  ...o,
});

/** A tick with Bittensor settled `after` seconds past the message's source time. */
function tick(o: { messages?: MessageRow[]; logs?: StoredLog[]; states?: Record<Hex, string>; after?: number }): RuleCtx {
  const base = ruleCtx();
  return ruleCtx({
    messages: o.messages ?? [],
    logs: logQuery(o.logs ?? []),
    snap: { ...base.snap, messageStates: o.states ?? {} },
    settled: { base: { block: 10n ** 9n, time: SENT_AT + (o.after ?? 60) }, bittensor: { block: 10n ** 9n, time: SENT_AT + (o.after ?? 60) } },
  });
}

describe("messages", () => {
  it("makes a message of each adapter Sent from the front door or the vault, and none of a stranger's", () => {
    const fromFd = sent({ sender: D.frontDoor, recipient: D.vault, messageId: h("m1") });
    const fromVault = sent({ sender: D.vault, recipient: D.frontDoor, messageId: h("m2"), chain: "bittensor", block: 6_900_100n });
    const stranger = sent({ sender: STRANGER, recipient: D.vault, messageId: h("m3") });
    const rows = messagesFrom([fromFd, fromVault, stranger], D, (chain) => (chain === "base" ? SENT_AT : SENT_AT + 12), SENT_AT + 99);
    expect(rows).toEqual([
      message({ messageId: h("m1"), srcTx: fromFd.txHash }),
      message({ messageId: h("m2"), direction: "bittensor>base", sender: D.vault, recipient: D.frontDoor, srcTx: fromVault.txHash, srcBlock: 6_900_100n, srcTime: SENT_AT + 12 }),
    ]);
    // a block time not known yet: the tick's time stands in
    expect(messagesFrom([fromFd], D, () => undefined, SENT_AT + 99)[0].srcTime).toBe(SENT_AT + 99);
  });

  it("are stored, marked arrived by the destination's Delivered, given the OffRamp's state, and loaded while pending", async () => {
    await wipe(db);
    const m1 = message();
    const m2 = message({ messageId: h("m2"), srcTx: h("src2") });
    await db.batch(messageStatements(db, [m1, m2]));
    // stored again (a re-read): nothing changes
    await db.batch(messageStatements(db, [{ ...m1, amount: "999" }]));
    await db.batch([...arrivalStatements(db, arrivals([delivered(h("m1"))])), ...stateStatements(db, { [h("m2")]: "FAILURE" }, SENT_AT + 300)]);
    const s = await loadTickState(db, SENT_AT + 400);
    expect(s.pendingMessages.map((m) => [m.messageId, m.state, m.stateAt, m.amount])).toEqual([[h("m2"), "FAILURE", SENT_AT + 300, "5"]]);
  });
});

describe("ccip.failure", () => {
  it("finds a FAILURE with no destination Delivered, with its ccip.chain.link page", () => {
    const [f] = ccipFailure.run(tick({ messages: [message()], states: { [h("m1")]: "FAILURE" } }));
    expect(f).toMatchObject({ rule: "ccip.failure", key: `ccip.failure:${h("m1")}` });
    expect(f.facts.ccip).toBe(`https://ccip.chain.link/msg/${h("m1")}`);
    expect(f.facts.direction).toBe("Base → Bittensor");
    // the state stored on an earlier tick counts when this tick's reading has none
    expect(ccipFailure.run(tick({ messages: [message({ state: "FAILURE" })] })).map((f) => f.rule)).toEqual(["ccip.failure"]);
  });

  it("is resolved by a destination Delivered even while the OffRamp still says UNTOUCHED or FAILURE", () => {
    expect(ccipFailure.run(tick({ messages: [message()], logs: [delivered(h("m1"))], states: { [h("m1")]: "FAILURE" } }))).toEqual([]);
    expect(ccipUndelivered.run(tick({ messages: [message()], logs: [delivered(h("m1"))], states: { [h("m1")]: "UNTOUCHED" }, after: 7200 }))).toEqual([]);
    expect(ccipFailure.run(tick({ messages: [message({ dstTx: h("dst"), dstBlock: 1n, state: "FAILURE" })] }))).toEqual([]);
  });

  it("names the forged-twin case in its runbook line: a failed honest batch may be the only sign", () => {
    expect(RUNBOOK["ccip.failure"]({})).toContain("DuplicateBatch");
  });
});

describe("ccip.undelivered", () => {
  it("waits 60 minutes of the destination's settled time after the source block", () => {
    expect(ccipUndelivered.run(tick({ messages: [message()], after: 59 * 60 }))).toEqual([]);
    const [f] = ccipUndelivered.run(tick({ messages: [message()], after: 61 * 60 }));
    expect(f).toMatchObject({ rule: "ccip.undelivered", key: `ccip.undelivered:${h("m1")}` });
    // SUCCESS on the OffRamp is arrived too
    expect(ccipUndelivered.run(tick({ messages: [message()], after: 61 * 60, states: { [h("m1")]: "SUCCESS" } }))).toEqual([]);
    // a FAILURE is ccip.failure's, not this one's
    expect(ccipUndelivered.run(tick({ messages: [message()], after: 61 * 60, states: { [h("m1")]: "FAILURE" } }))).toEqual([]);
  });
});

describe("ccip.foreign_send", () => {
  it("finds a stranger's Sent through our adapter to a Cascade contract, once; not one elsewhere", () => {
    const toVault = sent({ sender: STRANGER, recipient: D.vault, messageId: h("x1") });
    const [f] = ccipForeignSend.run(ruleCtx({ logs: logQuery([toVault]) }));
    expect(f).toMatchObject({ rule: "ccip.foreign_send", key: `ccip.foreign_send:${toVault.uid}` });
    expect(f.facts.sender).toBe(STRANGER);
    const elsewhere = sent({ sender: STRANGER, recipient: STRANGER, messageId: h("x2") });
    expect(ccipForeignSend.run(ruleCtx({ logs: logQuery([elsewhere]) }))).toEqual([]);
    // stored on an earlier tick: not again
    expect(ccipForeignSend.run(ruleCtx({ logs: logQuery([toVault]), newUids: new Set() }))).toEqual([]);
  });
});

