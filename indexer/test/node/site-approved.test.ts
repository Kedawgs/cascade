import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approvedLists, main, readOut, renderApproved } from "../../scripts/site-approved.ts";

const A = "0x8A825738D0287D0959957A0f6ec18bA1276d209d";
const B = "0x44CeaCE0b097D9d5eF01e08b12029Ad2762cbDC6";

function fixtureOut(): string {
  const dir = mkdtempSync(join(tmpdir(), "cascade-out-"));
  mkdirSync(join(dir, "_next", "static", "chunks"), { recursive: true });
  mkdirSync(join(dir, "stake"));
  writeFileSync(join(dir, "index.html"), `<script>a="${A}"</script><a href="https://basescan.org/x">x</a>`);
  writeFileSync(join(dir, "stake", "index.html"), `<script>b="${B}"</script>`);
  writeFileSync(join(dir, "_next", "static", "chunks", "main.js"), `x="${A.toLowerCase()}";u="https://mainnet.base.org";h="0x${"ab".repeat(32)}"`);
  writeFileSync(join(dir, "_next", "static", "chunks", "skip.css"), `u="https://not-scanned.example.com"`);
  return dir;
}

describe("pnpm site:approved", () => {
  it("lists every address and https host in the export's HTML and JavaScript, lowercased, deduplicated and sorted", () => {
    const lists = approvedLists(readOut(fixtureOut()));
    expect(lists.addresses).toEqual([B.toLowerCase(), A.toLowerCase()].sort());
    expect(lists.hosts).toEqual(["basescan.org", "mainnet.base.org"]);
    expect(lists.largest.bytes).toBeGreaterThan(0);
  });

  it("writes src/site-approved.ts with the lists and the build date", async () => {
    const dir = fixtureOut();
    const target = join(dir, "site-approved.ts");
    const lines: string[] = [];
    expect(await main([dir], { target, print: (l) => lines.push(l), today: () => "2027-01-15" })).toBe(0);
    const text = readFileSync(target, "utf8");
    expect(text).toContain("built 2027-01-15");
    expect(text).toContain(`"${A.toLowerCase()}"`);
    expect(text).toContain('"mainnet.base.org"');
    expect(text).toBe(renderApproved(approvedLists(readOut(dir)), "2027-01-15"));
    expect(lines.join("\n")).toContain("largest file");
    expect(await main([], { target, print: () => undefined, today: () => "x" })).toBe(2);
  });

  it("adds hosts approved by hand (--extra-hosts), named as such in the file so a review in git sees them", async () => {
    const dir = fixtureOut();
    const target = join(dir, "site-approved.ts");
    const print = () => undefined;
    expect(await main([dir, "--extra-hosts", "Static.CloudflareInsights.com,mainnet.base.org"], { target, print, today: () => "2027-01-15" })).toBe(0);
    const text = readFileSync(target, "utf8");
    expect(text).toContain("// Added by hand (--extra-hosts): static.cloudflareinsights.com, mainnet.base.org");
    expect(text).toContain('APPROVED_HOSTS: readonly string[] = [\n  "basescan.org",\n  "mainnet.base.org",\n  "static.cloudflareinsights.com",\n];');
    // a host must be a host: no scheme, path or wildcard
    expect(await main([dir, "--extra-hosts", "https://x.example/y"], { target, print, today: () => "x" })).toBe(2);
    expect(await main([dir, "--extra-hosts", "*.example.com"], { target, print, today: () => "x" })).toBe(2);
    expect(await main([dir, "--extra-hosts"], { target, print, today: () => "x" })).toBe(2);
  });
});
