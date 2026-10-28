export type InlinePart = { text: string; href?: undefined } | { text: string; href: string };

/** `[label](https://…)` or `[label](/page/)`: the only markup an FAQ answer may carry. */
const LINK = /\[([^\]]+)\]\((https:\/\/[^\s)]+|\/[^\s)]*)\)/g;

/** Text with `[label](url)` links, as plain runs and links. Anything else stays plain text. */
export function parseInlineLinks(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ text: m[1], href: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length || parts.length === 0) parts.push({ text: text.slice(last) });
  return parts;
}
