import { unlink, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { disconnect, loadConfig } from "../src/vpn.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const EMPTY_LOGS = {
  startedAt: null,
  finishedAt: null,
  status: "idle",
  total: 0,
  completed: 0,
  success: 0,
  failed: 0,
  entries: [],
};

async function removeIfExists(filePath) {
  if (existsSync(filePath)) {
    await unlink(filePath);
    console.log(`Removed ${filePath}`);
  }
}

async function clean() {
  try {
    await disconnect();
    console.log("VPN disconnected.");
  } catch {
    console.log("VPN already disconnected.");
  }

  await removeIfExists(path.join(ROOT, ".openvpn.pid"));
  await removeIfExists(path.join(ROOT, "openvpn.log"));

  const config = await loadConfig(path.join(ROOT, "config.json"));
  const logsPath = path.resolve(config.scanner?.logsFile ?? "./logs/scan-results.json");
  await mkdir(path.dirname(logsPath), { recursive: true });
  await writeFile(logsPath, `${JSON.stringify(EMPTY_LOGS, null, 2)}\n`, "utf8");
  console.log(`Reset ${logsPath}`);
  console.log("Clean complete.");
}

clean().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
