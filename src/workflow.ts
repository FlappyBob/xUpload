/**
 * Lightweight workflow trace logger for scan/match/fill flows.
 * Keeps console logs structured and correlated by workflow id.
 * Includes an in-memory buffer for exporting debug logs.
 */

export interface LogEntry {
  ts: number;
  level: "info" | "error";
  workflowId: string;
  step: string;
  data?: unknown;
}

const MAX_LOG_ENTRIES = 500;
const logBuffer: LogEntry[] = [];
type LogPersister = (logs: LogEntry[]) => void;
let persister: LogPersister | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function pushLog(entry: LogEntry) {
  if (logBuffer.length >= MAX_LOG_ENTRIES) {
    logBuffer.shift();
  }
  logBuffer.push(entry);
  schedulePersist();
}

function schedulePersist() {
  if (!persister) return;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    persister?.(logBuffer.slice());
  }, 1000);
}

export function setLogPersister(fn: LogPersister): void {
  persister = fn;
}

export function loadPersistedLogs(logs: LogEntry[]): void {
  logBuffer.length = 0;
  for (const entry of logs.slice(-MAX_LOG_ENTRIES)) {
    logBuffer.push(entry);
  }
}

export function getLogBuffer(): LogEntry[] {
  return logBuffer.slice();
}

export function createWorkflowId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}`;
}

export function roundScore(value: number, digits: number = 4): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

export function logWorkflowStep(workflowId: string, step: string, data?: unknown): void {
  pushLog({ ts: Date.now(), level: "info", workflowId, step, data });
  if (data === undefined) {
    console.log(`[xUpload][WF:${workflowId}] ${step}`);
    return;
  }
  console.log(`[xUpload][WF:${workflowId}] ${step}`, data);
}

export function logWorkflowError(workflowId: string, step: string, error: unknown): void {
  const serialized = error instanceof Error
    ? { message: error.message, stack: error.stack }
    : error;
  pushLog({ ts: Date.now(), level: "error", workflowId, step, data: serialized });
  console.error(`[xUpload][WF:${workflowId}] ${step}`, error);
}
