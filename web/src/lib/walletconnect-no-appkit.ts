// What `@reown/appkit/core` resolves to in this site's bundle (next.config.ts, turbopack.resolveAlias).
//
// WalletConnect's provider has one import of Reown AppKit (its own QR window, with the wallet SDKs, fonts and remote
// wallet list that come with it), which it runs only when asked for that window (`showQrModal: true`). The site never
// asks (walletconnect-inner.ts: showQrModal is false, and the site draws its own dialog), and AppKit isn't installed
// (pnpm-workspace.yaml removes it from the provider's dependencies). Should the provider reach for it anyway, it gets
// this file, which is part of the site's own script: nothing is fetched from anywhere, and the call fails with a plain
// message, which the provider turns into a failed connection.
export const NO_APPKIT = "Cascade draws its own WalletConnect dialog: Reown AppKit is not part of this site.";

export function createAppKit(): never {
  throw new Error(NO_APPKIT);
}
