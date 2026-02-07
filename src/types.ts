// Messages between content script ↔ background ↔ popup

export interface MatchRequest {
  type: "MATCH_REQUEST";
  context: string;
  accept?: string;
  pageUrl?: string;
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
