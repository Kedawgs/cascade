import { DEPLOYMENT } from "./config";
import { createLiveCascadeData, notConfiguredData } from "./live";
import type { CascadeData } from "./types";

export type * from "./types";
export { NotConfiguredError } from "./live";

/** The one place that decides where Cascade's data comes from: the live chains, or nothing at all
 * when `web/.env.local` names no deployment (`pnpm ops web-config --live` writes it). */
export function createCascadeData(): CascadeData {
  return DEPLOYMENT ? createLiveCascadeData(DEPLOYMENT) : notConfiguredData();
}
