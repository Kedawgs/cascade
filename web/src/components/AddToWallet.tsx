"use client";

import { useState } from "react";
import { base } from "viem/chains";
import { useConfig } from "wagmi";
import { getConnection, switchChain, watchAsset } from "wagmi/actions";
import { ADD_TO_WALLET, addFmTaoToWallet, type WatchPort, type WatchResult, watchResultText } from "@/lib/add-to-wallet";

/** "Add to wallet": asks the connected wallet to show ForeverMoney's TAO on Base (EIP-747), on Base, and says what
 * came of it; a wallet that can't is told how to add it by hand. On the Stake page's card and in the FAQ. */
export function AddToWallet({ className = "pill pill-ghost pill-sm", noteClassName = "small" }: { className?: string; noteClassName?: string }) {
  const config = useConfig();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WatchResult | null>(null);

  const port: WatchPort = {
    connected: () => getConnection(config).status === "connected",
    /** The wallet's own chain decides, as use-flows.ts's switchToBase reads it. */
    async toBase() {
      const { connector, chainId } = getConnection(config);
      const current = connector ? await connector.getChainId().catch(() => chainId) : chainId;
      if (current !== base.id) await switchChain(config, { chainId: base.id });
    },
    watch: (asset) => watchAsset(config, asset),
  };

  return (
    <>
      <button
        type="button"
        className={className}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setResult(null);
          void addFmTaoToWallet(port)
            .then(setResult)
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Confirm in your wallet…" : ADD_TO_WALLET}
      </button>
      {result && (
        <p role="status" className={noteClassName}>
          {watchResultText(result)}
        </p>
      )}
    </>
  );
}
