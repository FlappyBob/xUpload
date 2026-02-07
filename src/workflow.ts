/**
 * Lightweight workflow trace logger for scan/match/fill flows.
 * Keeps console logs structured and correlated by workflow id.
 */

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
  if (data === undefined) {
    console.log(`[xUpload][WF:${workflowId}] ${step}`);
    return;
  }
  console.log(`[xUpload][WF:${workflowId}] ${step}`, data);
}

export function logWorkflowError(workflowId: string, step: string, error: unknown): void {
  console.error(`[xUpload][WF:${workflowId}] ${step}`, error);
}
