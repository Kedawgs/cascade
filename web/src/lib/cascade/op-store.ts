import type { Address } from "viem";
import type { FlowStore } from "./flows";
import type { OpLog, Operation } from "./oplog";

/** A flow's progress kept in its operation log entry. A withdrawal has one call ("request").
 * If the entry disappears while the flow runs (removed from another tab), it is put back before
 * anything is read or written, so a transaction signed after that is still recorded. */
export function opStore(log: OpLog, account: Address, id: string): FlowStore {
  let last = log.get(account, id) as Operation;
  const op = (): Operation => {
    const o = log.get(account, id);
    if (o) return (last = o);
    log.put(last);
    return last;
  };
  const update = (patch: Partial<Operation>) => {
    op();
    log.update(account, id, patch);
    last = log.get(account, id) as Operation;
  };
  return {
    hashes: () => {
      const o = op();
      return o.kind === "withdrawal" ? { request: o.hash } : { ...o.hashes };
    },
    setHash: (k, h) => {
      const o = op();
      update(o.kind === "withdrawal" ? { hash: h } : ({ hashes: { ...o.hashes, [k]: h } } as Partial<Operation>));
    },
    setState: (state, error) => update({ state, error }),
    callsId: () => {
      const o = op();
      return o.kind === "withdrawal" ? undefined : o.callsId;
    },
    setCallsId: (callsId) => update({ callsId } as Partial<Operation>),
    mode: () => op().mode,
    setMode: (mode) => update({ mode }),
  };
}
