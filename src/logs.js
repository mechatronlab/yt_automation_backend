import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export async function loadLogs(logsPath) {
  if (!existsSync(logsPath)) {
    return {
      startedAt: null,
      finishedAt: null,
      status: "idle",
      total: 0,
      completed: 0,
      entries: [],
    };
  }
  const raw = await readFile(logsPath, "utf8");
  return JSON.parse(raw);
}

export async function saveLogs(logsPath, data) {
  await mkdir(path.dirname(logsPath), { recursive: true });
  await writeFile(logsPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function createRunState(servers) {
  return {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    total: servers.length,
    completed: 0,
    success: 0,
    failed: 0,
    entries: [],
  };
}

export function appendEntry(state, entry) {
  state.entries.push(entry);
  state.completed = state.entries.length;
  if (entry.status === "success") state.success += 1;
  if (entry.status === "error") state.failed += 1;
}

export function finishRun(state, status = "completed") {
  state.status = status;
  state.finishedAt = new Date().toISOString();
}
