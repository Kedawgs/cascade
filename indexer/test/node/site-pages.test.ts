import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pkg, readJsonc } from "./files.ts";

interface Wrangler {
  env?: Record<string, { vars?: Record<string, unknown> }>;
}

/** The site's routes, as its static export serves them (trailingSlash: `/faq/`): every folder under
 * web/src/app holding a page.tsx. A route group `(name)` adds no segment; a dynamic `[x]` segment can't be
 * listed, so it fails the test rather than be left out. */
function appRoutes(dir: string, at: string[] = []): string[] {
  const here = existsSync(join(dir, "page.tsx")) ? [at.length ? `/${at.join("/")}/` : "/"] : [];
  const below = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .flatMap((e) => {
      if (e.name.includes("[")) throw new Error(`a dynamic route (${e.name}): SITE_PAGES can't list its pages`);
      return appRoutes(join(dir, e.name), /^\(.*\)$/.test(e.name) ? at : [...at, e.name]);
    });
  return [...here, ...below];
}

describe("SITE_PAGES", () => {
  const env = (readJsonc(pkg("wrangler.jsonc")) as Wrangler).env ?? {};
  const routes = appRoutes(pkg("../web/src/app")).sort();

  it("finds the site's 8 pages in web/src/app", () => {
    expect(routes).toEqual(["/", "/activity/", "/deposit/", "/faq/", "/rewards/", "/stake/", "/unstake/", "/withdraw/"]);
  });

  it("lists every page of the site, in production and in test, so the site check reads every page a user can open", () => {
    for (const name of ["production", "test"]) expect([...((env[name]?.vars?.SITE_PAGES as string[]) ?? [])].sort(), name).toEqual(routes);
  });

  it("fits a site-check run's fetches (every page, then SITE_FILES_PER_RUN scripts) in Workers Free's 50 subrequests", () => {
    for (const name of ["production", "test"]) {
      const vars = env[name]?.vars ?? {};
      expect((vars.SITE_PAGES as string[]).length + Number(vars.SITE_FILES_PER_RUN), name).toBeLessThanOrEqual(50);
    }
  });
});
