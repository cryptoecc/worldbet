import { http, createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { seoul, gwangju, bsc, bscTestnet } from "./chain";

export const wagmiConfig = createConfig({
  chains: [bsc, bscTestnet, seoul, gwangju],
  connectors: [injected()],
  transports: {
    [bsc.id]:        http(),
    [bscTestnet.id]: http(),
    [seoul.id]:      http(),
    [gwangju.id]:    http(),
  },
});
