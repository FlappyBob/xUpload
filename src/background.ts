import {
  tokenize,
  vectorize,
  buildVocabulary,
  exportVocab,
  importVocab,
  getVocabSize,
} from "./embeddings";
import { search, getCount, getFileData, upsert, clearAll } from "./vectordb";
import type { MatchRequest, MatchResponse } from "./types";

async function ensureVocab(): Promise<void> {
  if (getVocabSize() > 0) return;
  return new Promise((resolve) => {
    chrome.storage.local.get("vocab", (data) => {
      if (data.vocab) {
        importVocab(data.vocab);
        console.log("[xUpload] Vocab loaded:", getVocabSize(), "terms");
      } else {
        console.warn("[xUpload] No vocab found.");
      }
      resolve();
    });
  });
}

ensureVocab();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "MATCH_REQUEST") {
    handleMatch(msg as MatchRequest).then(sendResponse);
    return true;
  }

  if (msg.type === "GET_FILE") {
    handleGetFile(msg.id as string).then(sendResponse);
    return true;
  }

  if (msg.type === "GET_INDEX_COUNT") {
    getCount().then((count) => sendResponse({ count }));
    return true;
  }

  if (msg.type === "BUILD_INDEX") {
    handleBuildIndex(msg.files).then(sendResponse);
    return true;
  }

  if (msg.type === "VOCAB_UPDATED") {
    chrome.storage.local.get("vocab", (data) => {
      if (data.vocab) {
        importVocab(data.vocab);
        console.log("[xUpload] Vocab reloaded:", getVocabSize(), "terms");
      }
      sendResponse({ ok: true });
    });
    return true;
  }
});

async function handleMatch(req: MatchRequest): Promise<MatchResponse> {
  await ensureVocab();

  console.log("[xUpload] MATCH context:", req.context.slice(0, 100));

  const queryTokens = tokenize(req.context);
  const queryVec = vectorize(queryTokens);

  if (queryVec.length === 0) {
    console.warn("[xUpload] Empty vector — vocab size:", getVocabSize());
    return { type: "MATCH_RESPONSE", results: [] };
  }

  const results = await search(queryVec, 5, req.accept);
  console.log("[xUpload] Results:", results.map(r => `${r.record.name} (${Math.round(r.score * 100)}%)`));

  return {
    type: "MATCH_RESPONSE",
    results: results.map((r) => ({
      id: r.record.id,
      name: r.record.name,
      path: r.record.path,
      type: r.record.type,
      score: r.score,
    })),
  };
}

interface FileEntry {
  path: string;
  name: string;
  type: string;
  size: number;
  lastModified: number;
  text: string;
}

async function handleBuildIndex(files: FileEntry[]) {
  console.log("[xUpload] BUILD_INDEX:", files.length, "files");

  const allTokens = files.map((f) => tokenize(f.text));
  buildVocabulary(allTokens);

  await clearAll();

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const vec = vectorize(allTokens[i]);
    await upsert({
      id: f.path,
      name: f.name,
      path: f.path,
      type: f.type,
      size: f.size,
      lastModified: f.lastModified,
      vector: vec,
      textPreview: f.text.slice(0, 100),
    });
  }

  const vocab = exportVocab();
  await new Promise<void>((resolve) => {
    chrome.storage.local.set({ vocab }, resolve);
  });

  const count = await getCount();
  console.log("[xUpload] Index built:", count, "files");
  return { ok: true, count };
}

async function handleGetFile(id: string) {
  console.log("[xUpload] GET_FILE:", id);

  const data = await getFileData(id);
  if (!data) {
    return { error: "Cannot read file. Please re-scan the folder from the xUpload popup." };
  }

  console.log("[xUpload] Sending:", data.name);
  return data;
}
