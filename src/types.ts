// Messages between content script ↔ background ↔ popup

export interface MatchRequest {
  type: "MATCH_REQUEST";
  context: string;
  accept?: string;
}

export interface MatchResultItem {
  id: string;
  name: string;
  path: string;
  type: string;
  score: number;
}

export interface MatchResponse {
  type: "MATCH_RESPONSE";
  results: MatchResultItem[];
}
