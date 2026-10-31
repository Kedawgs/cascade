import type { Due } from "./alerts.ts";
import type { Config } from "./config.ts";
import { utc } from "./rules/context.ts";
import { RUNBOOK } from "./runbook.ts";

// The emails (spec 7): plain text and simple HTML with the same content. They carry explorer links and hashes
// only, never a link to sign anything, and say so in the footer. A link to anything but the explorers is
// defanged (hxxp…), so an odd value in a log can't become a link. Every header field is one line of printable
// text (headerValue), so nothing a node, a log or an error message put in a subject can add a header
// (Bcc:, a second recipient), and no control character reaches a body either (bodyText).

export interface Email {
  subject: string;
  text: string;
  html: string;
}

/** Line breaks of every kind: CRLF, CR, LF, VT, FF, the C1 NEL and the Unicode line and paragraph separators. */
const BREAKS = /\r\n?|[\n\u000b\u000c\u0085\u{2028}\u{2029}]/gu;
/** The other C0 controls (TAB aside), DEL and the C1 controls. */
const CONTROLS = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;

/** A header value (a subject, an address): every line break and tab becomes a space, every other control
 * character (DEL and the C1 range included) is dropped, spaces are collapsed. A header can't be split by what
 * a chain, a node or a user put in a log or an error message. */
export const headerValue = (s: string): string => s.replace(BREAKS, " ").replace(/\t/g, " ").replace(CONTROLS, "").replace(/ {2,}/g, " ").trim();

/** Body text: the same controls dropped, but a line break kept, as LF (CRLF, CR, VT, FF and the Unicode
 * separators become LF; TAB stays). */
export const bodyText = (s: string): string => s.replace(/\r\n?|[\u000b\u000c\u{2028}\u{2029}]/gu, "\n").replace(CONTROLS, "");

const FOOTER = "Act from your own tools, never from a link in this email.";
const LINKABLE = new Set(["basescan.org", "evm.taostats.io", "taostats.io", "ccip.chain.link"]);
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/g;

/** The text with every URL not on an explorer (or not https) defanged. */
const safeText = (s: string) =>
  s.replace(URL_RE, (u) => {
    try {
      const url = new URL(u);
      if (url.protocol === "https:" && LINKABLE.has(url.hostname)) return u;
    } catch {
      // not a URL after all: defang it anyway
    }
    return u.replace(/^http/, "hxxp");
  });

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A line of safe text as HTML: escaped, with the explorer links made links. */
const htmlLine = (s: string) => escape(s).replace(/https:\/\/[^\s<>"']+/g, (u) => `<a href="${u}">${u}</a>`);

/** Paragraphs (separated by blank lines) as text and HTML. */
function compose(subject: string, paragraphs: string[]): Email {
  const parts = [...paragraphs, FOOTER].map((p) => safeText(bodyText(p)));
  return {
    subject: safeText(headerValue(subject)),
    text: parts.join("\n\n"),
    html: `<div style="font-family:sans-serif;font-size:14px">${parts.map((p) => `<p>${p.split("\n").map(htmlLine).join("<br>")}</p>`).join("")}</div>`,
  };
}

export interface AlertItem {
  due: Due;
  /** the alert's id, for `pnpm alerts:ack` */
  alertId?: number;
  /** the active hold this alert raised, if any */
  hold?: { publicId: string; summary: string } | null;
}

const ack = (id: number | undefined) => `To acknowledge (stops the re-sends): pnpm alerts:ack -- --env <env> ${id ?? "<alert id>"}`;

/** `[CASCADE CRITICAL] …`: what happened, the facts, what to do, the hold and how to acknowledge. */
export function renderCritical(item: AlertItem): Email {
  const d = item.due;
  const hold = item.hold
    ? `The hold is on (${item.hold.publicId}: ${item.hold.summary}); the keeper pays nothing out while it is. Once you have checked, clear it with: pnpm hold:clear -- --env <env> --id ${item.hold.publicId} --note "what you checked"`
    : "This alert raised no hold.";
  const resend = d.reason === "resend" ? [`Sent again: not acknowledged (send ${d.notifyCount + 1}, opened ${utc(d.openedAt)}).`] : [];
  return compose(`[CASCADE CRITICAL] ${d.subject}`, [`What happened: ${d.subject}.`, d.body, `What to do: ${d.runbook}`, hold, ...resend, ack(item.alertId)]);
}

/** `[Cascade warning] {n} new: {first}`: every new warning in one email. */
export function renderWarnings(items: readonly AlertItem[]): Email {
  const first = items[0]?.due.subject ?? "";
  return compose(
    `[Cascade warning] ${items.length} new: ${first}`,
    items.map((i) => `${i.due.subject}\n${i.due.body}\nWhat to do: ${i.due.runbook}\n${ack(i.alertId)}`),
  );
}

/** `[Cascade resolved] …`: a critical condition that cleared. */
export const renderResolved = (d: Due): Email => compose(`[Cascade resolved] ${d.subject}`, [`Cleared: ${d.subject}.`, `It was opened ${utc(d.openedAt)}.`, d.body]);

export interface DigestContent {
  date: string;
  /** "OK", "{n} warnings" or "CRITICAL open" */
  status: string;
  sections: { title: string; lines: string[] }[];
}

/** `[Cascade daily] {date}: {status}`. */
export const renderDigest = (d: DigestContent): Email => compose(`[Cascade daily] ${d.date}: ${d.status}`, d.sections.map((s) => `${s.title}\n${s.lines.join("\n")}`));

/** The one email sent when the database itself is failing: from memory only, at minute 0 (spec 1). */
export function renderDbFailing(error: string, nowS: number): Email {
  return compose("[CASCADE CRITICAL] The monitor can't write its database", [
    `What happened: the tick at ${utc(nowS)} couldn't commit to D1.`,
    `error: ${error}`,
    `What to do: ${RUNBOOK["monitor.db_failing"]({})}`,
    "No alert email goes out until the database works again; this one is sent at most once an hour.",
  ]);
}

/** An email to send, with an id to report it by. */
export type Outgoing = Email & { id: number };

/** Sends each email to the recipients (ALERT_TO) from ALERT_FROM, or writes it to the log in `log` mode
 * (the binding is never called then). Every header field (the recipients, the sender, the subject) is passed
 * through headerValue here too, whatever rendered it: the send is the last line of defence against header
 * injection. A send that throws (an E_* code) marks that email failed and the rest still go. */
export async function sendAll(env: { EMAIL?: SendEmail }, cfg: Pick<Config, "alerts">, messages: readonly Outgoing[]): Promise<{ sent: number[]; failed: { id: number; code: string }[] }> {
  const sent: number[] = [];
  const failed: { id: number; code: string }[] = [];
  const to = cfg.alerts.to.map(headerValue);
  const from = headerValue(cfg.alerts.from);
  for (const m of messages) {
    const subject = headerValue(m.subject);
    if (cfg.alerts.mode === "log") {
      console.log(`email (log mode) to ${to.join(", ") || "(no one)"}: ${subject}\n${m.text}`);
      sent.push(m.id);
      continue;
    }
    try {
      if (!env.EMAIL) throw Object.assign(new Error("no EMAIL binding"), { code: "E_NO_BINDING" });
      await env.EMAIL.send({ to, from: { email: from, name: "Cascade monitor" }, subject, text: m.text, html: m.html });
      sent.push(m.id);
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      failed.push({ id: m.id, code: typeof code === "string" ? code : e instanceof Error ? e.message.slice(0, 80) : "unknown" });
    }
  }
  return { sent, failed };
}
