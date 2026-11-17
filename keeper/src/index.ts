import type { KeeperEnv } from "./config.ts";
import { control } from "./control.ts";
import { cronRun } from "./run.ts";

// cascade-keeper (design-keeper-worker.md): a cron each minute runs one round of the keeper's core under the
// deployment's lease; the control routes serve the PC's hand runs, the kill switch and the status.

export { KeeperCoordinator } from "./coordinator.ts";

export default {
  async scheduled(_controller, env) {
    await cronRun(env);
  },
  async fetch(req, env) {
    return control(req, env);
  },
} satisfies ExportedHandler<KeeperEnv>;
