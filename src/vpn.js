import { spawn } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(__dirname, "..", "config.json");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(
          new Error(
            `${command} not found. Install it and ensure it is on your PATH (e.g. brew install openvpn).`
          )
        );
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      } else {
        const err = new Error(
          `${command} ${args.join(" ")} failed (exit ${code}): ${stderr || stdout}`
        );
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

export async function loadConfig(configPath = DEFAULT_CONFIG) {
  if (!existsSync(configPath)) {
    throw new Error(
      `Config not found at ${configPath}. Copy config.example.json to config.json and edit it.`
    );
  }
  const raw = await readFile(configPath, "utf8");
  return JSON.parse(raw);
}

async function macosConnect(serviceName) {
  await run("scutil", ["--nc", "start", serviceName]);
}

async function macosDisconnect(serviceName) {
  await run("scutil", ["--nc", "stop", serviceName]);
}

async function macosStatus(serviceName) {
  const { stdout } = await run("scutil", ["--nc", "status", serviceName]);
  const connected = /Connected/i.test(stdout);
  return { connected, detail: stdout };
}

async function wireguardConnect(configPath) {
  await run("wg-quick", ["up", configPath], { shell: false });
}

async function wireguardDisconnect(configPath) {
  await run("wg-quick", ["down", configPath], { shell: false });
}

async function wireguardStatus(configPath) {
  const iface = path.basename(configPath, ".conf");
  try {
    const { stdout } = await run("wg", ["show", iface]);
    return { connected: stdout.length > 0, detail: stdout };
  } catch {
    return { connected: false, detail: "interface not active" };
  }
}

const OPENVPN_CANDIDATES = [
  "/opt/homebrew/opt/openvpn/sbin/openvpn",
  "/usr/local/opt/openvpn/sbin/openvpn",
];

function resolveOpenvpnBinary(config) {
  const configured = config.openvpn?.binary ?? process.env.OPENVPN_BINARY;
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(`OpenVPN binary not found at ${configured}`);
    }
    return configured;
  }
  for (const candidate of OPENVPN_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return "openvpn";
}

function resolveOpenvpnConfigPath(config, overridePath) {
  const configPath = path.resolve(
    overridePath ?? config.openvpn?.configPath ?? "./client.ovpn"
  );
  if (!existsSync(configPath)) {
    throw new Error(
      `OpenVPN config not found: ${configPath}\n` +
        "Download a .ovpn file from your VPN provider and save it there, " +
        "or set openvpn.configPath in config.json."
    );
  }
  return configPath;
}

function resolveOpenvpnAuthFile(config) {
  const authFile = config.openvpn?.authFile ?? "./auth.txt";
  const absPath = path.resolve(authFile);
  if (existsSync(absPath)) {
    return absPath;
  }

  const user = process.env.OPENVPN_USER ?? config.openvpn?.username;
  const pass = process.env.OPENVPN_PASS ?? config.openvpn?.password;
  if (user && pass) {
    return absPath;
  }

  throw new Error(
    `OpenVPN auth file not found: ${absPath}\n` +
      "Fix one of the following:\n" +
      "  1. Create auth.txt (username on line 1, password on line 2)\n" +
      "  2. Copy auth.txt.example to auth.txt and edit it\n" +
      "  3. Set OPENVPN_USER and OPENVPN_PASS environment variables"
  );
}

export async function ensureOpenvpnAuth(config) {
  if (resolveProvider(config) !== "openvpn") {
    return null;
  }
  const authFile = resolveOpenvpnAuthFile(config);
  if (existsSync(authFile)) {
    return authFile;
  }

  const user = process.env.OPENVPN_USER ?? config.openvpn?.username;
  const pass = process.env.OPENVPN_PASS ?? config.openvpn?.password;
  if (!user || !pass) {
    throw new Error(`OpenVPN credentials missing for ${authFile}`);
  }

  await writeFile(authFile, `${user}\n${pass}\n`, { mode: 0o600 });
  return authFile;
}

export function ensureConnectApp(config) {
  resolveConnectApp(config);
}

const OPENVPN_CLOUD_HINT =
  "OpenVPN Cloud profiles require the OpenVPN Connect app (provider: \"connect\"), " +
  "or disable SSO in your Cloud admin panel for community openvpn.";

async function readLogTail(logFile, lines = 20) {
  if (!existsSync(logFile)) return "";
  const content = await readFile(logFile, "utf8");
  return content.trim().split("\n").slice(-lines).join("\n");
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForOpenvpnReady(config, logFile, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const logTail = await readLogTail(logFile, 30);
    if (/Initialization Sequence Completed/i.test(logTail)) {
      return true;
    }
    if (/AUTH_FAILED/i.test(logTail)) {
      throw new Error(`OpenVPN authentication failed.\n${logTail}\n\n${OPENVPN_CLOUD_HINT}`);
    }
    const pidFile = path.resolve(config.openvpn?.pidFile ?? "./.openvpn.pid");
    if (existsSync(pidFile)) {
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      if (!isProcessAlive(pid)) {
        throw new Error(
          `OpenVPN exited before connecting. See ${logFile}:\n${logTail || "(empty)"}`
        );
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const logTail = await readLogTail(logFile);
  throw new Error(`OpenVPN connection timed out after ${timeoutMs}ms.\n${logTail}`);
}

async function openvpnConnect(config, configPath, options = {}) {
  const openvpnBin = resolveOpenvpnBinary(config);
  const pidFile = path.resolve(config.openvpn?.pidFile ?? "./.openvpn.pid");
  const logFile = path.resolve(config.openvpn?.logFile ?? "./openvpn.log");
  const authFile = await ensureOpenvpnAuth(config);
  if (existsSync(pidFile)) {
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    if (isProcessAlive(pid)) {
      throw new Error(`OpenVPN already running (pid ${pid})`);
    }
    await unlink(pidFile).catch(() => {});
  }

  const args = [
    "--config",
    configPath,
    "--writepid",
    pidFile,
    "--log",
    logFile,
    "--verb",
    "3",
    "--daemon",
    "--auth-user-pass",
    authFile,
  ];

  const child = spawn(openvpnBin, args, { stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        const detail = stderr.trim() || "no error output";
        reject(new Error(`openvpn failed to start (exit ${code}): ${detail}`));
      }
    });
  });

  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!existsSync(pidFile)) continue;
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    if (isProcessAlive(pid)) {
      if (options.waitForReady !== false) {
        const timeoutMs = options.connectTimeoutMs ?? config.scanner?.connectTimeoutMs ?? 90_000;
        await waitForOpenvpnReady(config, logFile, timeoutMs);
      }
      return { pid, logFile };
    }
  }

  const logTail = await readLogTail(logFile);
  if (/AUTH_FAILED/i.test(logTail)) {
    throw new Error(
      `OpenVPN authentication failed.\n${logTail}\n\n${OPENVPN_CLOUD_HINT}`
    );
  }
  throw new Error(
    `OpenVPN exited before staying connected. See ${logFile}:\n${logTail || "(empty)"}\n\n${OPENVPN_CLOUD_HINT}`
  );
}

async function openvpnDisconnect(config) {
  const pidFile = path.resolve(config.openvpn?.pidFile ?? "./.openvpn.pid");
  if (!existsSync(pidFile)) {
    return { alreadyDisconnected: true };
  }

  const pid = Number((await readFile(pidFile, "utf8")).trim());
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }

  await unlink(pidFile).catch(() => {});
  return { disconnected: true, pid };
}

async function openvpnStatus(config) {
  const pidFile = path.resolve(config.openvpn?.pidFile ?? "./.openvpn.pid");
  if (!existsSync(pidFile)) {
    return { connected: false, detail: "not running" };
  }
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  if (isProcessAlive(pid)) {
    return { connected: true, detail: `pid ${pid}` };
  }
  return { connected: false, detail: "stale pid file" };
}

const DEFAULT_CONNECT_APP =
  "/Applications/OpenVPN Connect/OpenVPN Connect.app/Contents/MacOS/OpenVPN Connect";

function resolveConnectApp(config) {
  const appPath = config.connect?.appPath ?? DEFAULT_CONNECT_APP;
  if (!existsSync(appPath)) {
    throw new Error(
      `OpenVPN Connect not found at ${appPath}. Install from https://openvpn.net/client/`
    );
  }
  return appPath;
}

async function connectListProfiles(appPath) {
  const { stdout } = await run(appPath, ["--list-profiles"]);
  return JSON.parse(stdout);
}

async function connectAppImport(config, profilePath, profileName) {
  const absPath = path.resolve(profilePath ?? config.connect?.profilePath ?? "");
  if (!absPath || !existsSync(absPath)) {
    throw new Error(`Profile not found: ${absPath || "(empty path)"}`);
  }
  const appPath = resolveConnectApp(config);
  const name = profileName ?? config.connect?.profileName;
  const args = [`--import-profile=${absPath}`];
  if (name) {
    args.push(`--name=${name}`);
  }
  await run(appPath, args);
  return { absPath, profileName: name };
}

async function connectResolveProfileId(config, profileName) {
  if (!profileName && config.connect?.profileId) {
    return String(config.connect.profileId);
  }
  const profiles = await connectListProfiles(resolveConnectApp(config));
  const name = profileName ?? config.connect?.profileName;
  if (name) {
    const match = profiles.find((p) => p.name === name);
    if (match) return String(match.id);
    throw new Error(`No Connect profile named "${name}". Run: npm run status`);
  }
  if (profiles.length === 1) {
    return String(profiles[0].id);
  }
  throw new Error(
    `Multiple profiles found. Set connect.profileId in config.json:\n${JSON.stringify(profiles, null, 2)}`
  );
}

async function waitForConnectReady(config, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const route = await connectAppStatus();
    if (route.connected) {
      return route;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`OpenVPN Connect did not establish a tunnel within ${timeoutMs}ms`);
}

async function connectAppConnectProfile(config, profilePath, profileName) {
  await connectAppImport(config, profilePath, profileName);
  const appPath = resolveConnectApp(config);
  const profileId = await connectResolveProfileId(config, profileName);
  await run(appPath, [`--connect-shortcut=${profileId}`]);
  const timeoutMs = config.scanner?.connectTimeoutMs ?? 90_000;
  await waitForConnectReady(config, timeoutMs);
  return { profileId, profileName };
}

async function connectAppConnect(config, options = {}) {
  if (options.openvpnConfigPath) {
    const profileName =
      options.profileName ?? path.basename(options.openvpnConfigPath, ".ovpn");
    return connectAppConnectProfile(config, options.openvpnConfigPath, profileName);
  }
  await connectAppImport(config);
  const appPath = resolveConnectApp(config);
  const profileId = await connectResolveProfileId(config);
  await run(appPath, [`--connect-shortcut=${profileId}`]);
  return { profileId };
}

async function connectAppDisconnectProfile(config, profileId) {
  const appPath = resolveConnectApp(config);
  await run(appPath, [`--disconnect-shortcut=${profileId}`]);
  return { profileId };
}

async function connectAppDisconnect(config, options = {}) {
  if (options.profileId) {
    return connectAppDisconnectProfile(config, options.profileId);
  }
  const appPath = resolveConnectApp(config);
  const profileId = await connectResolveProfileId(config);
  await run(appPath, [`--disconnect-shortcut=${profileId}`]);
  return { profileId };
}

async function connectAppStatus() {
  try {
    const { stdout } = await run("netstat", ["-rn"]);
    const connected = /^default\b.*\butun/m.test(stdout);
    return {
      connected,
      detail: connected ? "default route via utun" : "no VPN default route",
    };
  } catch {
    return { connected: false, detail: "could not detect VPN route" };
  }
}

function resolveProvider(config) {
  const provider = config.provider ?? "macos";
  if (provider === "macos" && process.platform !== "darwin") {
    throw new Error('provider "macos" is only supported on macOS');
  }
  if (provider === "connect" && process.platform !== "darwin") {
    throw new Error('provider "connect" is only supported on macOS with OpenVPN Connect');
  }
  return provider;
}

export async function connect(options = {}) {
  const config = options.config ?? (await loadConfig(options.configPath));
  const provider = resolveProvider(config);

  switch (provider) {
    case "macos": {
      const name = config.serviceName;
      if (!name) throw new Error('config.serviceName is required for macos provider');
      await macosConnect(name);
      return { provider, serviceName: name, connected: true };
    }
    case "wireguard": {
      const cfg = config.wireguard?.configPath;
      if (!cfg) throw new Error('config.wireguard.configPath is required');
      await wireguardConnect(cfg);
      return { provider, configPath: cfg, connected: true };
    }
    case "openvpn": {
      const cfg = resolveOpenvpnConfigPath(config, options.openvpnConfigPath);
      await openvpnConnect(config, cfg, options);
      return { provider, configPath: cfg, connected: true };
    }
    case "connect": {
      const result = await connectAppConnect(config, options);
      return { provider, ...result, connected: true };
    }
    default:
      throw new Error(
        `Unknown provider: ${provider}. Use macos, wireguard, openvpn, or connect.`
      );
  }
}

export async function disconnect(options = {}) {
  const config = options.config ?? (await loadConfig(options.configPath));
  const provider = resolveProvider(config);

  switch (provider) {
    case "macos": {
      const name = config.serviceName;
      if (!name) throw new Error('config.serviceName is required for macos provider');
      await macosDisconnect(name);
      return { provider, serviceName: name, connected: false };
    }
    case "wireguard": {
      const cfg = config.wireguard?.configPath;
      if (!cfg) throw new Error('config.wireguard.configPath is required');
      await wireguardDisconnect(cfg);
      return { provider, configPath: cfg, connected: false };
    }
    case "openvpn": {
      const result = await openvpnDisconnect(config);
      return { provider, connected: false, ...result };
    }
    case "connect": {
      const result = await connectAppDisconnect(config, options);
      return { provider, connected: false, ...result };
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export async function status(options = {}) {
  const config = options.config ?? (await loadConfig(options.configPath));
  const provider = resolveProvider(config);

  switch (provider) {
    case "macos":
      return { provider, ...(await macosStatus(config.serviceName)) };
    case "wireguard":
      return {
        provider,
        ...(await wireguardStatus(config.wireguard.configPath)),
      };
    case "openvpn":
      return { provider, ...(await openvpnStatus(config)) };
    case "connect": {
      const appPath = resolveConnectApp(config);
      const profiles = await connectListProfiles(appPath);
      const route = await connectAppStatus();
      return { provider, profiles, ...route };
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
