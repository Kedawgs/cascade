// A verbatim copy of the monitor's two direction tables: indexer/src/scheduler.ts, lines 209 to 247, on branch
// v3.2-monitor at 41f4772 (Task 55; directionOf reads them, and admin.item_loosens rules by directionOf). The ops test
// test/v32-scheduler.test.ts holds ops's own direction table (v32/scheduler.ts DIRECTIONS) to this copy, and to the
// monitor's file itself once the tracks merge and this checkout holds it. Copied as text (its backticks and ${ escaped, so the string is the text), never imported: ops never
// loads indexer code. Refresh it from that file when the monitor's tables change.

export const MONITOR_DIRECTIONS_SOURCE = `
const VAULT_DIRECTIONS: Readonly<Record<string, Field<BitState>[]>> = {
  setOutflowLimits: [
    { label: "maxDailyOutflowBps", param: "bps", unit: "bps", dir: "up", now: (s) => s.maxDailyOutflowBps },
    { label: "minDailyOutflow", param: "minDaily", unit: "wei", dir: "up", now: (s) => s.minDailyOutflow },
    { label: "globalOutflowBps", param: "globalBps", unit: "bps", dir: "up", now: (s) => s.globalOutflowBps },
  ],
  setMessageLimits: [
    { label: "maxEntryValue", param: "maxEntryValue_", unit: "wei", dir: "up", now: (s) => s.maxEntryValue },
    { label: "maxMessageValue", param: "maxMessageValue_", unit: "wei", dir: "up", now: (s) => s.maxMessageValue },
    { label: "minChunk", param: "minChunk_", dir: "down", now: (s) => s.minChunk },
  ],
  setFeeLimits: [
    { label: "maxFeeBps", param: "bps", unit: "bps", dir: "up", now: (s) => s.maxFeeBps },
    { label: "maxFeeAbs", param: "abs_", unit: "wei", dir: "up", now: (s) => s.maxFeeAbs },
  ],
  setPayoutDelay: [{ label: "payoutDelay", param: "delay", unit: "s", dir: "down", now: (s) => s.payoutDelay }],
  setRewardCut: [
    { label: "treasury", param: "treasury_", dir: "change", now: (s) => s.treasury },
    { label: "rewardCutBps", param: "bps", unit: "bps", dir: "up", now: (s) => s.rewardCutBps },
  ],
  setRewardVesting: [{ label: "rewardVesting", param: "period", unit: "s", dir: "down", now: (s) => s.rewardVesting }],
  setMaxTotalAssets: [{ label: "maxTotalAssets", param: "amount", unit: "wei", dir: "up", now: (s) => s.maxTotalAssets }],
  setIdleBuffer: [{ label: "idleBufferBps", param: "bps", unit: "bps", dir: "down", now: (s) => s.idleBufferBps }],
};

const DOOR_DIRECTIONS: Readonly<Record<string, Field<BaseState>[]>> = {
  setMaxDeliverySlippage: [{ label: "maxDeliverySlippageBps", param: "bps", unit: "bps", dir: "up", now: (s) => s.maxDeliverySlippageBps }],
  setBatchInterval: [{ label: "batchInterval", param: "interval", unit: "s", dir: "down", now: (s) => s.batchInterval }],
  setMaxBatchValue: [{ label: "maxBatchValue", param: "value", unit: "wei", dir: "up", now: (s) => s.maxBatchValue }],
  setMinPoolLiquidity: [
    {
      label: (a) => \`minPoolLiquidity(\${a.index})\`,
      param: "value",
      dir: "down",
      now: (s, a) => (a.index === "0" ? s.minPoolLiquidity?.taoWeth : a.index === "1" ? s.minPoolLiquidity?.wethUsdc : undefined),
    },
  ],
};

`;

/** One direction setter's fields as the monitor lists them: the limit (its label; a pool's floor as
 * "minPoolLiquidity(index)"), the argument that sets it, and which way loosens it. */
export interface MonitorField {
  name: string;
  param: string;
  dir: string;
}


/** The monitor's VAULT_DIRECTIONS and DOOR_DIRECTIONS, read from its source text: each setter's fields in order. */
export function monitorDirections(src: string): { vault: Record<string, MonitorField[]>; frontDoor: Record<string, MonitorField[]> } {
  const table = (name: string): Record<string, MonitorField[]> => {
    const start = src.indexOf(`const ${name}`);
    if (start < 0) throw new Error(`no ${name} in the monitor's source`);
    const body = src.slice(src.indexOf("> = {", start) + 5, src.indexOf("\n};", start));
    const heads = [...body.matchAll(/^ {2}(\w+): \[/gm)];
    const out: Record<string, MonitorField[]> = {};
    heads.forEach((h, i) => {
      const chunk = body.slice(h.index, heads[i + 1]?.index ?? body.length);
      const names = [...chunk.matchAll(/label: (?:"(\w+)"|\(a\) => `(\w+)\(\$\{a\.(\w+)\}\)`)/g)].map((m) => m[1] ?? `${m[2]}(${m[3]})`);
      const params = [...chunk.matchAll(/param: "(\w+)"/g)].map((m) => m[1]);
      const dirs = [...chunk.matchAll(/dir: "(\w+)"/g)].map((m) => m[1]);
      if (names.length !== params.length || params.length !== dirs.length) throw new Error(`the monitor's ${h[1]} entry doesn't read as label, param and dir triples`);
      out[h[1]] = names.map((n, j) => ({ name: n, param: params[j], dir: dirs[j] }));
    });
    return out;
  };
  return { vault: table("VAULT_DIRECTIONS"), frontDoor: table("DOOR_DIRECTIONS") };
}
