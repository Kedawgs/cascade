import type { Clients } from "./chain";
import { DEPLOYMENT } from "./config";
import { createLiveCascadeData, notConfiguredData } from "./live";
import type { CascadeData } from "./types";

export type * from "./types";
export { NotConfiguredError } from "./live";

/** The one place that decides where Cascade's data comes from: the live chains, or nothing at all
 * when `web/.env.local` names no deployment (`pnpm ops web-config --live` writes it). `clients`: the connections to
 * read on, when not the browser's own (the build's snapshot reads on more patient ones: snapshot.ts). */
export function createCascadeData(clients?: Clients): CascadeData {
  return DEPLOYMENT ? createLiveCascadeData(DEPLOYMENT, clients ? { clients } : {}) : notConfiguredData();
}
