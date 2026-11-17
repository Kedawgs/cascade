import { type Address, getAddress, isAddress } from "viem";
import { base } from "viem/chains";

/** Cascade's Reown (WalletConnect) project id: a public identifier, which ships in the site's JavaScript and travels in
 * every pairing. Tracked here so a build needs no env file to offer WalletConnect (the founder's, 2026-11-16; a test
 * holds it to this value). */
export const WALLETCONNECT_PROJECT_ID = "b09a19083568478e654f0378e2f4997f";

/** A Reown project id: 32 hex characters, lower case, nothing else. */
const PROJECT_ID = /^[0-9a-f]{32}$/;

export interface WalletConnectEnv {
  NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?: string | undefined;
}

/** The project id a build pairs with, or null: WalletConnect off (no option shown, no connector made, none of its code
 * loaded). The tracked id unless NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is set, which then decides alone: another id for
 * that build, or off when it is empty. Anything that isn't shaped like an id counts as off, so a typo can never make an
 * option that half works. scripts/csp-headers.mjs applies the same rule to the policy (a test holds the two together). */
export function walletConnectProjectId(env: WalletConnectEnv, tracked: string = WALLETCONNECT_PROJECT_ID): string | null {
  const id = env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? tracked;
  return PROJECT_ID.test(id) ? id : null;
}

/** This build's id (Next inlines the variable only where it is written out by name; scripts/csp-headers.mjs reads the
 * name and the value back from the exported scripts). */
export const walletConnectId = walletConnectProjectId({
  NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,
});

/** The connector's id in wagmi (wagmi's own for its WalletConnect connector, which ours wraps). */
export const WALLETCONNECT_ID = "walletConnect";

/** The one host WalletConnect needs: its relay, a WebSocket both sides of a pairing meet on (every message end-to-end
 * encrypted with the pairing's key, which the relay never sees). The policy allows exactly this when the option is on
 * (scripts/csp-headers.mjs; tests hold it to the installed packages' own constant and to the policy). */
export const WALLETCONNECT_RELAY = "wss://relay.walletconnect.org";

/** The option in the wallet list. */
export const WALLETCONNECT_OPTION = { name: "WalletConnect", note: "Phone and hardware wallets: scan a QR code" } as const;

/** What a wallet shows of the site when it is asked to connect: the name, the address, the site's own icon. */
export const WALLETCONNECT_METADATA = {
  name: "Cascade",
  description: "Stake TAO from Base with USDC.",
  url: "https://cascadefi.xyz",
  icons: ["https://cascadefi.xyz/icon.svg"],
};

/** What the site shows of the wallet at the other end of a session, from the wallet's own word (its peer metadata):
 * untrusted text, so its name is cut to plain characters and a short length, and its icon kept only as a string for
 * walletIcon to judge (ConnectWallet.tsx: an inlined image or nothing, never an address to fetch). */
export interface WalletPeer {
  name?: string;
  icon?: string;
}

const PEER_NAME_MAX = 40;

/** A session's peer metadata as the site may show it: nothing for anything that isn't an object. */
export function walletPeer(metadata: unknown): WalletPeer | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const m = metadata as { name?: unknown; icons?: unknown };
  // letters, digits, marks, punctuation, symbols and single spaces: no control or formatting characters (a
  // right-to-left override, a zero-width joiner), which could make one name read as another; cut by whole characters,
  // so the cut never leaves half of one
  const plain = typeof m.name === "string" ? m.name.slice(0, 400).replace(/[^\p{L}\p{N}\p{M}\p{P}\p{S} ]/gu, " ").replace(/ +/g, " ").trim() : "";
  const name = Array.from(plain).slice(0, PEER_NAME_MAX).join("").trim();
  const icon = Array.isArray(m.icons) ? m.icons.find((i): i is string => typeof i === "string") : undefined;
  return { ...(name ? { name } : {}), ...(icon ? { icon } : {}) };
}

/** How the pill names a wallet connected through WalletConnect: the wallet's own name with how it is connected, or
 * WalletConnect alone when the wallet gave none. */
export function walletConnectLabel(peer: WalletPeer | undefined): string {
  return peer?.name && peer.name.toLowerCase() !== "walletconnect" ? `${peer.name} (WalletConnect)` : "WalletConnect";
}

/** A pairing address as the site shows it (the QR code, the copy button, the link that opens a wallet): only a
 * WalletConnect v2 URI as the provider writes one (`wc:`, the 64-hex topic, `@2?`, then its parameters with no space or
 * control character) and of a sane length, else nothing. */
export function pairingUri(value: unknown): string | undefined {
  return typeof value === "string" && /^wc:[0-9a-f]{64}@2\?[\x21-\x7e]{1,1000}$/.test(value) ? value : undefined;
}

/** A WalletConnect session, as much of it as the site reads. */
export interface WalletConnectSession {
  namespaces?: Record<string, { accounts?: readonly string[] } | undefined>;
  peer?: { metadata?: unknown };
}

/** The accounts a session approved on Base (`eip155:8453:0x…`, CAIP-10), each once, checksummed. None means the wallet
 * didn't approve Base: WalletConnect now sends every chain as optional (its required list is deprecated and folded into
 * the optional one, @walletconnect/sign-client engine.connect), so the site holds Base to be required here, after the
 * wallet answers. */
export function baseAccounts(session: WalletConnectSession | undefined): Address[] {
  const out: Address[] = [];
  const prefix = `eip155:${base.id}:`;
  for (const [key, ns] of Object.entries(session?.namespaces ?? {})) {
    if (key !== "eip155" && !key.startsWith("eip155:")) continue;
    for (const account of ns?.accounts ?? []) {
      if (typeof account !== "string" || !account.startsWith(prefix)) continue;
      const raw = account.slice(prefix.length);
      if (!isAddress(raw, { strict: false })) continue;
      const address = getAddress(raw);
      if (!out.includes(address)) out.push(address);
    }
  }
  return out;
}

/** The wallet answered without Base: the session is ended and the dialog says so. */
export class WalletConnectNoBaseError extends Error {
  constructor() {
    super("The wallet didn't approve Base");
    this.name = "WalletConnectNoBaseError";
  }
}

/** Why a pairing ended without a connection, for the dialog's words. */
export type PairingFailure = "declined" | "expired" | "no-base" | "unreachable";

/** A failed pairing, sorted: the wallet's user said no (wagmi's connector names that UserRejectedRequestError; wallets
 * answer 5000 to 5002 or "User rejected"), the proposal ran out (the provider's "Proposal expired", five minutes), the
 * wallet left Base out, or anything else (the relay unreachable or refusing this origin, the code not loading). */
export function pairingFailure(e: unknown): PairingFailure {
  for (let err = e as { name?: string; code?: number; message?: string; cause?: unknown } | undefined, depth = 0; err && depth < 5; err = err.cause as typeof err, depth++) {
    if (err.name === "WalletConnectNoBaseError") return "no-base";
    if (/expired/i.test(err.message ?? "")) return "expired";
    if (err.name === "UserRejectedRequestError" || err.code === 4001 || (typeof err.code === "number" && err.code >= 5000 && err.code <= 5002) || /user (rejected|denied)|rejected the request|connection request reset/i.test(err.message ?? "")) return "declined";
  }
  return "unreachable";
}

export const PAIRING_TITLE = "Connect with WalletConnect";
export const PAIRING_PREPARING = "Getting a QR code…";
export const PAIRING_SCAN = "Scan this code with your wallet's app, then approve the connection there. Choose Base if it asks for a network.";
/** The same on a phone, which can't scan its own screen. */
export const PAIRING_SCAN_PHONE = "Open your wallet's app from here, or scan this code from another device, then approve the connection there. Choose Base if it asks for a network.";
export const PAIRING_QR_LABEL = "QR code holding the connection link. If you can't scan it, use Copy link and paste it into your wallet.";
export const PAIRING_COPY = "Copy link";
export const PAIRING_COPIED = "Link copied";
export const PAIRING_COPY_FAILED = "Couldn't copy it. Select the link below and copy it by hand.";
export const PAIRING_OPEN = "Open in wallet";
export const PAIRING_LINK_NOTE = "Paste the link only into your own wallet: anyone who has it can connect a wallet to this page until it is used or expires.";

/** The dialog's sentence for a pairing that failed, and what its button says. */
export function pairingFailureCopy(f: PairingFailure): { message: string; retry: string } {
  if (f === "declined") return { message: "The wallet declined the connection. Nothing was connected.", retry: "Try again" };
  if (f === "expired") return { message: "This QR code expired before a wallet connected.", retry: "Get a new code" };
  if (f === "no-base") return { message: "That wallet connected without Base, so it was disconnected. In the wallet, add or choose the Base network, then try again.", retry: "Try again" };
  return { message: "We couldn't reach WalletConnect just now. Check your connection and try again.", retry: "Try again" };
}
