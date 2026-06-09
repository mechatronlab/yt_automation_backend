import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, disconnect, loadConfig, ensureOpenvpnAuth, ensureConnectApp } from "./vpn.js";
import {
  appendEntry,
  createRunState,
  finishRun,
  loadLogs,
  saveLogs,
} from "./logs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(__dirname, "..", "config.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseServerName(filename) {
  return filename.replace(/^NCVPN-/, "").replace(/\.ovpn$/, "");
}

async function listServerConfigs(serverListDir) {
  const absDir = path.resolve(serverListDir);
  const files = await readdir(absDir);
  return files
    .filter((f) => f.endsWith(".ovpn"))
    .sort((a, b) => a.localeCompare(b))
    .map((filename) => ({
      filename,
      name: parseServerName(filename),
      configPath: path.join(absDir, filename),
    }));
}

async function fetchIpInfo(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return {
      ok: response.ok,
      status: response.status,
      body,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function processServer(config, server, index, total) {
  const startedAt = new Date().toISOString();
  const entry = {
    index: index + 1,
    total,
    server: server.name,
    filename: server.filename,
    configPath: server.configPath,
    startedAt,
    finishedAt: null,
    status: "pending",
    connect: null,
    ipCheck: null,
    error: null,
  };

  let activeProfileId = null;

  console.log(`\n[${index + 1}/${total}] ${server.name}`);
  console.log(`  Config: ${server.filename}`);

  try {
    console.log("  Connecting...");
    const connectResult = await connect({
      config,
      openvpnConfigPath: server.configPath,
      profileName: server.filename.replace(/\.ovpn$/, ""),
    });
    activeProfileId = connectResult.profileId ?? null;
    entry.connect = connectResult;
    console.log("  Connected.");

    const checkUrl = config.scanner?.checkUrl ?? "http://ip-api.com/json";
    const requestTimeoutMs = config.scanner?.requestTimeoutMs ?? 15_000;
    console.log(`  Requesting ${checkUrl}`);
    const ipCheck = await fetchIpInfo(checkUrl, requestTimeoutMs);
    entry.ipCheck = ipCheck;
    console.log("  Response:", JSON.stringify(ipCheck.body, null, 2));

    entry.status = ipCheck.ok ? "success" : "error";
    if (!ipCheck.ok) {
      entry.error = `HTTP ${ipCheck.status}`;
    }
  } catch (err) {
    entry.status = "error";
    entry.error = err.message ?? String(err);
    console.error(`  Error: ${entry.error}`);
  } finally {
    try {
      console.log("  Disconnecting...");
      await disconnect({
        config,
        profileId: activeProfileId ?? undefined,
      });
      console.log("  Disconnected.");
    } catch (err) {
      console.error(`  Disconnect error: ${err.message ?? err}`);
      if (!entry.error) {
        entry.error = `Disconnect failed: ${err.message ?? err}`;
      }
    }
    entry.finishedAt = new Date().toISOString();
  }

  return entry;
}

export async function runScanner(options = {}) {
  const configPath = options.configPath ?? DEFAULT_CONFIG;
  const config = options.config ?? (await loadConfig(configPath));
  const serverListDir =
    options.serverListDir ?? config.serverListDir ?? "./serverListTCP";
  const logsPath =
    options.logsPath ??
    path.resolve(config.scanner?.logsFile ?? "./logs/scan-results.json");

  const servers = await listServerConfigs(serverListDir);
  if (servers.length === 0) {
    throw new Error(`No .ovpn files found in ${path.resolve(serverListDir)}`);
  }

  const limit = options.limit ?? config.scanner?.limit ?? servers.length;
  const selected = servers.slice(0, limit);
  const delayMs = config.scanner?.delayBetweenServersMs ?? 2000;

  if ((config.provider ?? "openvpn") === "openvpn") {
    await ensureOpenvpnAuth(config);
  } else if (config.provider === "connect") {
    ensureConnectApp(config);
  }

  let state = createRunState(selected);
  await saveLogs(logsPath, state);

  console.log(`Scanning ${selected.length} servers from ${path.resolve(serverListDir)}`);
  console.log(`Logs: ${logsPath}`);

  for (let i = 0; i < selected.length; i++) {
    const entry = await processServer(config, selected[i], i, selected.length);
    appendEntry(state, entry);
    await saveLogs(logsPath, state);

    if (i < selected.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  finishRun(state);
  await saveLogs(logsPath, state);
  console.log(`\nDone. ${state.success} succeeded, ${state.failed} failed.`);
  return state;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;

  runScanner({ limit }).catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
