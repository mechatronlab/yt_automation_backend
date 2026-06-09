#!/usr/bin/env node
import { connect, disconnect, status } from "./vpn.js";

const [command] = process.argv.slice(2);

const handlers = {
  connect: async () => {
    const result = await connect();
    console.log("VPN connected:", result);
  },
  disconnect: async () => {
    const result = await disconnect();
    console.log("VPN disconnected:", result);
  },
  status: async () => {
    const result = await status();
    console.log(result.connected ? "Connected" : "Disconnected");
    if (result.detail) console.log(result.detail);
  },
};

if (!command || !handlers[command]) {
  console.error(`Usage: node src/cli.js <connect|disconnect|status>`);
  process.exit(1);
}

handlers[command]().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
