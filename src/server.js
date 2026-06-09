import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./vpn.js";
import { loadLogs } from "./logs.js";
import { runScanner } from "./scanner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const DEFAULT_CONFIG = path.join(__dirname, "..", "config.json");

let scanRunning = false;

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function resolveLogsPath(config) {
  return path.resolve(config.scanner?.logsFile ?? "./logs/scan-results.json");
}

async function handleRequest(req, res) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname === "/api/logs") {
    try {
      const config = await loadConfig(DEFAULT_CONFIG);
      const logsPath = await resolveLogsPath(config);
      const logs = await loadLogs(logsPath);
      sendJson(res, 200, logs);
    } catch (err) {
      sendJson(res, 500, { error: err.message ?? String(err) });
    }
    return;
  }

  if (url.pathname === "/api/scan" && req.method === "POST") {
    if (scanRunning) {
      sendJson(res, 409, { error: "Scan already running" });
      return;
    }
    scanRunning = true;
    const limit = url.searchParams.get("limit");
    runScanner({ limit: limit ? Number(limit) : undefined })
      .catch((err) => console.error("Scan failed:", err.message ?? err))
      .finally(() => {
        scanRunning = false;
      });
    sendJson(res, 202, { started: true });
    return;
  }

  if (url.pathname === "/api/status") {
    sendJson(res, 200, { scanRunning });
    return;
  }

  let filePath = path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  if (!existsSync(filePath)) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const ext = path.extname(filePath);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
  };
  const content = await readFile(filePath);
  res.writeHead(200, { "Content-Type": types[ext] ?? "application/octet-stream" });
  res.end(content);
}

export function startServer(port = 3847) {
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error(err);
      sendJson(res, 500, { error: "Internal server error" });
    });
  });

  server.listen(port, () => {
    console.log(`Dashboard: http://localhost:${port}`);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portArg = process.argv.find((a) => a.startsWith("--port="));
  const port = portArg ? Number(portArg.split("=")[1]) : 3847;
  startServer(port);
}
