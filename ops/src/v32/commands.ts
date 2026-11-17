import type { Args } from "../args.ts";
import { isRailFn } from "./classes.ts";
import { railCancelCommand, railExecuteCommand, railScheduleCommand } from "./rails.ts";
import { cancelPayoutsCommand, type FileOpts, pendingCommand, type RecordV32, type SchedulerCtx, scheduleCommand } from "./scheduler.ts";

/** Which command `pnpm ops schedule | pending | execute | cancel | cancel-payouts` runs (cli.ts hands each of them
 * here, so the routing is tested: test/v32-scheduler.test.ts). A change to the bridges goes through the rail check of
 * both chains (rails.ts railScheduleCommand, Task 47b); so does every execute (an activation's is judged right after it
 * runs: railExecuteCommand) and every cancel (warned, never refused: railCancelCommand), Task 47b's fix round. The rest
 * is Task 47's (scheduler.ts). Reads only; all but pending write a call file for the sign page. */
export async function schedulerFileCommand(a: Args, ctx: SchedulerCtx, rec: RecordV32, files: FileOpts): Promise<{ ok: boolean; lines: string[] }> {
  const oneSided = a.oneSided !== undefined ? { oneSided: a.oneSided } : {};
  switch (a.cmd) {
    case "pending":
      return pendingCommand(ctx, rec, files);
    case "schedule":
      if (a.contract === "both" || isRailFn(a.fn) || a.oneSided !== undefined) {
        return railScheduleCommand(ctx, rec, { ...files, contract: a.contract as string, fn: a.fn as string, args: a.fnArgs ?? [], ...oneSided });
      }
      return scheduleCommand(ctx, rec, { ...files, contract: a.contract as string, fn: a.fn as string, args: a.fnArgs ?? [] });
    case "execute":
      return railExecuteCommand(ctx, rec, { ...files, id: a.id as string, ...(a.on ? { on: a.on } : {}), ...oneSided });
    case "cancel":
      return railCancelCommand(ctx, rec, { ...files, id: a.id as string, as: a.as as "owner" | "guardian" });
    case "cancel-payouts":
      return cancelPayoutsCommand(ctx, rec, { ...files, key: a.id as string });
    default:
      throw new Error(`${a.cmd} is not a scheduler command`);
  }
}
