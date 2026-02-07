// Messages between content script ↔ background ↔ popup

export interface MatchRequest {
  type: "MATCH_REQUEST";
  context: string;
  accept?: string;
  pageUrl?: string;
  workflowId?: string;
}

export interface MatchResultItem {
  id: string;
  name: string;
  path: string;
  type: string;
  score: number;
  historyCount?: number;
}

export interface MatchResponse {
  type: "MATCH_RESPONSE";
  results: MatchResultItem[];
  workflowId?: string;
}

export interface UploadHistoryEntry {
  id?: number;
  fileId: string;
  fileName: string;
  fileType: string;
  websiteHost: string;
  pageUrl: string;
  pageTitle: string;
  uploadContext: string;
  timestamp: number;
}

// ---- Config ----

export type XUploadMode = "tfidf" | "fast" | "vlm" | "vlm_gpt";

export interface XUploadConfig {
  apiKey: string;
  mode: XUploadMode;
}

// ---- Enhanced match request (for fast/vlm modes) ----

export interface MatchRequestEnhanced {
  type: "MATCH_REQUEST_ENHANCED";
  context: string;
  accept?: string;
  pageUrl?: string;
  workflowId?: string;
  mode: XUploadMode;
  boundingRect?: { top: number; left: number; width: number; height: number };
  screenshotBase64?: string;  // populated by content script for VLM mode
}

// ---- Page classification (VLM) ----

export interface PageClassifyRequest {
  type: "PAGE_CLASSIFY_REQUEST";
  context: string;
  pageUrl?: string;
  title?: string;
  windowId?: number;
  workflowId?: string;
  screenshotBase64?: string;
  mode?: XUploadMode;
}

export interface PageClassifyResponse {
  type: "PAGE_CLASSIFY_RESPONSE";
  ok: boolean;
  workflowId?: string;
  label?: string;
  error?: string;
}
