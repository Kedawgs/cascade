import { createConfig, http } from "wagmi";
import { arbitrum, base, bsc, mainnet, polygon } from "wagmi/chains";
import { baseAccount } from "wagmi/connectors/baseAccount";
import { injected } from "wagmi/connectors/injected";

export const wagmiConfig = createConfig({
  chains: [base, mainnet, arbitrum, polygon, bsc],
  connectors: [baseAccount({ appName: "Cascade" }), injected()],
  transports: {
    [base.id]: http(),
    [mainnet.id]: http(),
    [arbitrum.id]: http(),
    [polygon.id]: http(),
    [bsc.id]: http(),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
