// Loaded only when a QR code is drawn (WalletConnectDialog.tsx imports it dynamically).
import encodeQR from "qr";

/** The light margin around a QR code, in modules: the standard asks for four. */
const QUIET = 4;

/** A QR code as the site draws it: a square of `size` modules (its margin included), and its dark modules as one SVG
 * path of unit-high bars. */
export interface QrPath {
  size: number;
  d: string;
}

/** `text` as a QR code, made in the browser: an inline SVG path, so nothing is fetched, no image address is involved
 * (the policy's img-src doesn't come into it) and no inline style is needed. Medium error correction: the code is on a
 * screen, undamaged, and a lower level keeps the modules large enough to scan from a phone. */
export function qrPath(text: string): QrPath {
  const rows = encodeQR(text, "raw", { ecc: "medium", border: QUIET });
  let d = "";
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let end = x;
      while (end + 1 < row.length && row[end + 1]) end++;
      const width = end - x + 1;
      d += `M${x} ${y}h${width}v1h-${width}z`;
      x = end;
    }
  });
  return { size: rows.length, d };
}
