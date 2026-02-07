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

export type XUploadMode = "tfidf" | "fast" | "vlm";

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
