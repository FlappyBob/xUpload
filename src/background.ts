import {
  tokenize,
  vectorize,
  buildVocabulary,
  exportVocab,
  importVocab,
  getVocabSize,
} from "./embeddings";
import {
  search,
  getCount,
  getFileData,
  upsert,
  clearAll,
  saveVocab,
  getVocab,
  addUploadHistory,
  getHistoryByHost,
  getAll,
  deleteById,
  getDirectoryHandle,
  getRescanConfig,
  saveRescanConfig,
} from "./vectordb";
import type { MatchRequest, MatchResponse, UploadHistoryEntry } from "./types";

async function ensureVocab(): Promise<void> {
  if (getVocabSize() > 0) return;

  // Try IndexedDB first
  const vocabFromIDB = await getVocab();
  if (vocabFromIDB) {
    importVocab(vocabFromIDB);
    console.log("[xUpload] Vocab loaded from IndexedDB:", getVocabSize(), "terms");
    return;
  }

  // Fallback to chrome.storage.local (migration path)
  return new Promise((resolve) => {
    chrome.storage.local.get("vocab", (data) => {
      if (data.vocab) {
        importVocab(data.vocab);
        console.log("[xUpload] Vocab loaded from chrome.storage:", getVocabSize(), "terms");
        // Migrate to IndexedDB
        saveVocab(data.vocab).catch(() => {});
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
    (async () => {
      const vocab = await getVocab();
      if (vocab) {
        importVocab(vocab);
        console.log("[xUpload] Vocab reloaded from IndexedDB:", getVocabSize(), "terms");
      } else {
        // Fallback to chrome.storage
        chrome.storage.local.get("vocab", (data) => {
          if (data.vocab) {
            importVocab(data.vocab);
            console.log("[xUpload] Vocab reloaded from chrome.storage:", getVocabSize(), "terms");
          }
        });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "TRACK_UPLOAD") {
    const entry = msg.entry as Omit<UploadHistoryEntry, "id">;
    addUploadHistory(entry).then(() => {
      sendResponse({ ok: true });
    }).catch((err) => {
      console.error("[xUpload] Failed to track upload:", err);
      sendResponse({ ok: false });
    });
    return true;
  }

  if (msg.type === "RESCAN_CONFIG_UPDATED") {
    setupRescanAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ---- Multi-level recommendation ----

function computePathNameScore(filePath: string, context: string): number {
  const pathTokens = tokenize(filePath.replace(/[/\\._-]/g, " "));
  const contextTokens = new Set(tokenize(context));
  if (pathTokens.length === 0 || contextTokens.size === 0) return 0;

  let matches = 0;
  for (const t of pathTokens) {
    if (contextTokens.has(t)) matches++;
  }
  return matches / pathTokens.length;
}

async function handleMatch(req: MatchRequest): Promise<MatchResponse> {
  await ensureVocab();

  console.log("[xUpload] MATCH context:", req.context.slice(0, 100));

  const queryTokens = tokenize(req.context);
  const queryVec = vectorize(queryTokens);

  if (queryVec.length === 0) {
    console.warn("[xUpload] Empty vector — vocab size:", getVocabSize());
    return { type: "MATCH_RESPONSE", results: [] };
  }

  // Get more results for re-ranking
  const results = await search(queryVec, 15, req.accept);

  // Get upload history for the current website
  let history: UploadHistoryEntry[] = [];
  if (req.pageUrl) {
    try {
      const host = new URL(req.pageUrl).hostname;
      history = await getHistoryByHost(host);
    } catch { /* ignore invalid URL */ }
  }

  // Build a map of fileId -> most recent upload timestamp for this host
  const historyMap = new Map<string, { count: number; lastTs: number }>();
  for (const h of history) {
    const existing = historyMap.get(h.fileId);
    if (!existing) {
      historyMap.set(h.fileId, { count: 1, lastTs: h.timestamp });
    } else {
      existing.count++;
      existing.lastTs = Math.max(existing.lastTs, h.timestamp);
    }
  }

  const ONE_DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();

  // Re-rank with multi-level scoring
  const ranked = results.map((r) => {
    const tfidfScore = r.score;

    // History-based boost (recency-weighted)
    let historyBoost = 0;
    let historyCount = 0;
    const hist = historyMap.get(r.record.id);
    if (hist) {
      historyCount = hist.count;
      const daysAgo = (now - hist.lastTs) / ONE_DAY;
      historyBoost = Math.max(0.1, 1.0 - daysAgo / 90);
    }

    // Path/filename matching
    const pathNameScore = computePathNameScore(r.record.path, req.context);

    // Weighted combination
    const hasHistory = historyBoost > 0;
    const finalScore = hasHistory
      ? tfidfScore * 0.5 + historyBoost * 0.35 + pathNameScore * 0.15
      : tfidfScore * 0.75 + pathNameScore * 0.25;

    return { ...r, score: finalScore, historyCount };
  });

  ranked.sort((a, b) => b.score - a.score);
  const top = ranked.slice(0, 5).filter((r) => r.score > 0);

  console.log("[xUpload] Results:", top.map(r => `${r.record.name} (${Math.round(r.score * 100)}%)`));

  return {
    type: "MATCH_RESPONSE",
    results: top.map((r) => ({
      id: r.record.id,
      name: r.record.name,
      path: r.record.path,
      type: r.record.type,
      score: r.score,
      historyCount: r.historyCount,
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
  await saveVocab(vocab);
  // Also save to chrome.storage for backward compat
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

// ---- Auto-rescan with chrome.alarms ----

const ALARM_NAME = "xupload-rescan";

async function setupRescanAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
  const config = await getRescanConfig();
  if (config.autoRescanEnabled && config.rescanIntervalMin > 0) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: config.rescanIntervalMin });
    console.log(`[xUpload] Rescan alarm set: every ${config.rescanIntervalMin} min`);
  } else {
    console.log("[xUpload] Auto-rescan disabled");
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  console.log("[xUpload] Auto-rescan alarm fired");

  const dirHandle = await getDirectoryHandle();
  if (!dirHandle) {
    console.log("[xUpload] No directory handle, skipping auto-rescan");
    return;
  }

  try {
    const perm = await (dirHandle as any).queryPermission({ mode: "read" });
    if (perm !== "granted") {
      console.log("[xUpload] Directory permission not granted, skipping auto-rescan");
      // Set badge to indicate rescan needed
      chrome.action.setBadgeText({ text: "!" });
      chrome.action.setBadgeBackgroundColor({ color: "#ea4335" });
      return;
    }

    // Clear any existing badge
    chrome.action.setBadgeText({ text: "" });

    // Note: Background service worker cannot do a full incremental rescan
    // because it can't read files via the File System Access API directly.
    // The directory handle works in background but with limitations.
    // For now, we notify any open popup/content to trigger rescan.
    console.log("[xUpload] Auto-rescan: directory handle valid, notifying tabs");
  } catch (err) {
    console.error("[xUpload] Auto-rescan error:", err);
  }
});

// Setup alarm on extension startup
chrome.runtime.onStartup.addListener(() => {
  console.log("[xUpload] Extension started");
  ensureVocab();
  setupRescanAlarm();
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("[xUpload] Extension installed/updated");
  setupRescanAlarm();
});

// Initial alarm setup
setupRescanAlarm();
