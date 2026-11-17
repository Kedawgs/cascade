import { FM_TAO } from "./cascade/config";
import { rejected } from "./cascade/flows";

// "See your TAO in your wallet" (the founder's request, 2026-11-05; Task 59b): TAO a user claims or cancels back on
// Base is ForeverMoney's TAO, an ERC-20 a wallet doesn't show until it is added. "Add to wallet" asks the wallet to
// add it (EIP-747, wallet_watchAsset), from the site's config (config.ts FM_TAO), never a second copy of the address.
// It serves v3-launch and v3.2 alike: both pay out the same token.

export const ADD_TO_WALLET = "Add to wallet";
/** The line beside the button where TAO is claimed: the Stake page's card and an unstake's receipt (Task 59b review, M4). */
export const SEE_YOUR_TAO = "See your TAO in your wallet.";
/** How to add the token by hand: the chain, the address, the symbol and the decimals. */
export const FM_TAO_BY_HAND = `on Base: address ${FM_TAO.address}, symbol ${FM_TAO.symbol}, ${FM_TAO.decimals} decimals`;
export const WATCH_ADDED = "Added to your wallet.";
export const WATCH_DECLINED = "You declined in your wallet, so nothing was added.";

/** The EIP-747 request for ForeverMoney's TAO. */
export const fmTaoWatchAsset = () => ({ type: "ERC20" as const, options: { address: FM_TAO.address, symbol: FM_TAO.symbol, decimals: FM_TAO.decimals } });
export type WatchAsset = ReturnType<typeof fmTaoWatchAsset>;

/** What adding the token needs of the wallet; wagmi gives it in the app (AddToWallet.tsx), fakes in tests. */
export interface WatchPort {
  connected(): boolean;
  /** Puts the wallet on Base: a wallet adds a token on the chain it is on. */
  toBase(): Promise<void>;
  /** wallet_watchAsset: true once the user added it. */
  watch(asset: WatchAsset): Promise<boolean>;
}

/** Added; declined by the user; a wallet that can't add it from here (no EIP-747, or it couldn't go to Base), so it is
 * added by hand; or no wallet connected. */
export type WatchResult = "added" | "declined" | "by-hand" | "no-wallet";

/** Asks the connected wallet to add ForeverMoney's TAO on Base. Never throws: every answer is one of WatchResult. */
export async function addFmTaoToWallet(port: WatchPort): Promise<WatchResult> {
  if (!port.connected()) return "no-wallet";
  try {
    await port.toBase();
  } catch (e) {
    return rejected(e) ? "declined" : "by-hand";
  }
  try {
    return (await port.watch(fmTaoWatchAsset())) ? "added" : "declined";
  } catch (e) {
    return rejected(e) ? "declined" : "by-hand";
  }
}

/** What the button says came of it. */
export function watchResultText(r: WatchResult): string {
  if (r === "added") return WATCH_ADDED;
  if (r === "declined") return WATCH_DECLINED;
  if (r === "no-wallet") return `Connect your wallet first, or add it by hand ${FM_TAO_BY_HAND}.`;
  return `Your wallet can't add it from here. Add it by hand ${FM_TAO_BY_HAND}.`;
}
