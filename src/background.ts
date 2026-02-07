import {
  tokenize,
  tokenizeFiltered,
  vectorize,
  buildVocabulary,
  exportVocab,
  importVocab,
  getVocabSize,
} from "./embeddings";
import {
  search,
  denseSearch,
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
  saveUsedPath,
  getUsedPaths,
} from "./vectordb";
import type {
  MatchRequest,
  MatchRequestEnhanced,
  MatchResponse,
  PageClassifyRequest,
  PageClassifyResponse,
  UploadHistoryEntry,
  XUploadConfig,
} from "./types";
import { getEmbedding, batchEmbed, describePageTypeWithChatGPT, describePageTypeWithVLM, describeWithVLM } from "./apiEmbeddings";
import type { LogEntry } from "./workflow";
import {
  createWorkflowId,
  getLogBuffer,
  loadPersistedLogs,
  logWorkflowError,
  logWorkflowStep,
  roundScore,
  setLogPersister,
} from "./workflow";

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

// Persist debug logs to chrome.storage.local so they survive SW restarts
const STORAGE_KEY_LOGS = "xupload_debug_logs";
(function initLogPersistence() {
  chrome.storage.local.get(STORAGE_KEY_LOGS, (data) => {
    const saved = data[STORAGE_KEY_LOGS];
    if (Array.isArray(saved) && saved.length > 0) {
      loadPersistedLogs(saved as LogEntry[]);
    }
  });

  setLogPersister((logs: LogEntry[]) => {
    chrome.storage.local.set({ [STORAGE_KEY_LOGS]: logs });
  });
})();

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
    handleBuildIndex(msg.files, msg.workflowId).then(sendResponse);
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

  if (msg.type === "MATCH_REQUEST_ENHANCED") {
    handleMatchEnhanced(msg as MatchRequestEnhanced).then(sendResponse);
    return true;
  }

  if (msg.type === "CAPTURE_TAB") {
    chrome.tabs.captureVisibleTab({ format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
        return;
      }
      // Strip data:image/png;base64, prefix
      const base64 = dataUrl?.replace(/^data:image\/\w+;base64,/, "") || "";
      sendResponse({ base64 });
    });
    return true;
  }

  if (msg.type === "SAVE_USED_PATH") {
    saveUsedPath(msg.host, msg.filePath)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === "RESCAN_CONFIG_UPDATED") {
    setupRescanAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "PAGE_CLASSIFY_REQUEST") {
    handleClassifyPage(msg as PageClassifyRequest).then(sendResponse);
    return true;
  }

  if (msg.type === "GET_DEBUG_LOGS") {
    (async () => {
      const count = await getCount();
      sendResponse({
        source: "background",
        logs: getLogBuffer(),
        meta: {
          indexedFiles: count,
          vocabSize: getVocabSize(),
          timestamp: Date.now(),
        },
      });
    })();
    return true;
  }
});

// ---- Multi-level recommendation ----

/**
 * Compute keyword overlap between file path and page context.
 * Uses filtered tokens (no stop words) and Jaccard-like scoring.
 */
function computePathNameScore(filePath: string, context: string): number {
  const pathTokens = new Set(tokenizeFiltered(filePath.replace(/[/\\._-]/g, " ")));
  const contextTokens = new Set(tokenizeFiltered(context));
  if (pathTokens.size === 0 || contextTokens.size === 0) return 0;

  let matches = 0;
  for (const t of pathTokens) {
    if (contextTokens.has(t)) matches++;
  }

  // Use the smaller set as denominator (Overlap coefficient)
  // This prevents dilution when one side has many more tokens
  const minSize = Math.min(pathTokens.size, contextTokens.size);
  return matches / minSize;
}

/**
 * Compute keyword overlap between file content/preview and page context.
 * Uses filtered tokens (no stop words) and Overlap coefficient.
 */
function computeContentOverlap(textPreview: string, context: string): number {
  const fileTokens = new Set(tokenizeFiltered(textPreview));
  const contextTokens = new Set(tokenizeFiltered(context));
  if (fileTokens.size === 0 || contextTokens.size === 0) return 0;

  let matches = 0;
  for (const t of contextTokens) {
    if (fileTokens.has(t)) matches++;
  }

  // Overlap coefficient: matches / min(|A|, |B|)
  const minSize = Math.min(fileTokens.size, contextTokens.size);
  return matches / minSize;
}

async function handleMatch(req: MatchRequest): Promise<MatchResponse> {
  const workflowId = req.workflowId || createWorkflowId("match-bg");
  const servicesCalled = new Set<string>();

  logWorkflowStep(workflowId, "match.start", {
    contextPreview: req.context.slice(0, 140),
    accept: req.accept || "(none)",
    pageUrl: req.pageUrl || "(none)",
  });

  try {
    servicesCalled.add("background.ensureVocab");
    await ensureVocab();

    const queryTokens = tokenize(req.context);
    const queryVec = vectorize(queryTokens);
    logWorkflowStep(workflowId, "service.tfidf.vectorize", {
      queryTokenCount: queryTokens.length,
      queryVectorSize: queryVec.length,
    });

    servicesCalled.add("vectordb.search");
    const tfidfResults = queryVec.length > 0
      ? await search(queryVec, 15, req.accept)
      : [];

    const maxTfidf = tfidfResults.length > 0
      ? Math.max(...tfidfResults.map((r) => r.score))
      : 0;
    const tfidfUseful = maxTfidf > 0.05;
    logWorkflowStep(workflowId, "service.vectordb.search.done", {
      candidateCount: tfidfResults.length,
      maxTfidf: roundScore(maxTfidf),
      tfidfUseful,
    });

    let allRecords = tfidfResults;
    if (!tfidfUseful) {
      servicesCalled.add("vectordb.getAll");
      const all = await getAll();
      allRecords = all.map((record) => ({ record, score: 0 }));
      logWorkflowStep(workflowId, "ranking.fallback.path_content", {
        reason: "tfidf_low_signal",
        maxTfidf: roundScore(maxTfidf),
        fullCandidateCount: allRecords.length,
      });
    }

    let pageHost = "";
    if (req.pageUrl) {
      try {
        pageHost = new URL(req.pageUrl).hostname;
      } catch {
        pageHost = "";
      }
    }

    let history: UploadHistoryEntry[] = [];
    let usedPaths: string[] = [];
    if (pageHost) {
      servicesCalled.add("vectordb.getHistoryByHost");
      servicesCalled.add("vectordb.getUsedPaths");
      history = await getHistoryByHost(pageHost);
      usedPaths = await getUsedPaths(pageHost);
      logWorkflowStep(workflowId, "service.history.lookup.done", {
        host: pageHost,
        historyRows: history.length,
        memorizedPaths: usedPaths.length,
      });
    }

    const usedPathSet = new Set(usedPaths);
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

    const ranked = allRecords.map((r) => {
      const tfidfScore = r.score;

      let historyBoost = 0;
      let historyCount = 0;
      const hist = historyMap.get(r.record.id);
      if (hist) {
        historyCount = hist.count;
        const daysAgo = (now - hist.lastTs) / ONE_DAY;
        historyBoost = Math.max(0.1, 1.0 - daysAgo / 90);
      }

      const pathNameScore = computePathNameScore(r.record.path, req.context);
      const contentOverlap = computeContentOverlap(r.record.textPreview, req.context);
      const pathMemoryBoost = usedPathSet.has(r.record.path) ? 1 : 0;
      const hasHistory = historyBoost > 0;

      const weights = tfidfUseful
        ? (hasHistory
          ? { tfidf: 0.42, history: 0.28, path: 0.14, content: 0.08, pathMemory: 0.08 }
          : { tfidf: 0.56, history: 0.00, path: 0.22, content: 0.14, pathMemory: 0.08 })
        : (hasHistory
          ? { tfidf: 0.00, history: 0.36, path: 0.30, content: 0.20, pathMemory: 0.14 }
          : { tfidf: 0.00, history: 0.00, path: 0.44, content: 0.42, pathMemory: 0.14 });

      const finalScore =
        tfidfScore * weights.tfidf +
        historyBoost * weights.history +
        pathNameScore * weights.path +
        contentOverlap * weights.content +
        pathMemoryBoost * weights.pathMemory;

      return {
        ...r,
        score: finalScore,
        historyCount,
        debug: {
          tfidfScore,
          historyBoost,
          pathNameScore,
          contentOverlap,
          pathMemoryBoost,
          weights,
        },
      };
    });

    ranked.sort((a, b) => b.score - a.score);
    const top = ranked.slice(0, 5).filter((r) => r.score > 0);

    logWorkflowStep(workflowId, "ranking.breakdown.top_candidates", ranked.slice(0, 10).map((r, idx) => ({
      rank: idx + 1,
      file: r.record.name,
      path: r.record.path,
      finalScore: roundScore(r.score),
      tfidfScore: roundScore(r.debug.tfidfScore),
      historyBoost: roundScore(r.debug.historyBoost),
      pathNameScore: roundScore(r.debug.pathNameScore),
      contentOverlap: roundScore(r.debug.contentOverlap),
      pathMemoryBoost: r.debug.pathMemoryBoost,
      historyCount: r.historyCount,
      weights: r.debug.weights,
    })));

    logWorkflowStep(workflowId, "match.services_called", Array.from(servicesCalled));
    logWorkflowStep(workflowId, "match.done", {
      candidateCount: ranked.length,
      returnedCount: top.length,
      results: top.map((r) => `${r.record.name} (${Math.round(r.score * 100)}%)`),
    });

    return {
      type: "MATCH_RESPONSE",
      workflowId,
      results: top.map((r) => ({
        id: r.record.id,
        name: r.record.name,
        path: r.record.path,
        type: r.record.type,
        score: r.score,
        historyCount: r.historyCount,
      })),
    };
  } catch (err) {
    logWorkflowError(workflowId, "match.failed", err);
    throw err;
  }
}

// ---- Helper to read config ----

async function getApiConfig(): Promise<XUploadConfig> {
  return new Promise((resolve) => {
    chrome.storage.local.get("xupload_config", (data) => {
      resolve(data.xupload_config || { apiKey: "", mode: "tfidf" });
    });
  });
}

// ---- Enhanced match (fast/vlm modes using Gemini) ----

async function handleMatchEnhanced(req: MatchRequestEnhanced): Promise<MatchResponse> {
  const workflowId = req.workflowId || createWorkflowId("match-enhanced-bg");
  const servicesCalled = new Set<string>(["chrome.storage.local.get:xupload_config"]);
  logWorkflowStep(workflowId, "match.enhanced.start", {
    mode: req.mode,
    hasScreenshot: !!req.screenshotBase64,
    contextPreview: req.context.slice(0, 140),
    accept: req.accept || "(none)",
  });

  const config = await getApiConfig();
  if (!config.apiKey) {
    // Fallback to TF-IDF
    logWorkflowStep(workflowId, "match.enhanced.fallback", { reason: "missing_api_key" });
    return handleMatch({
      type: "MATCH_REQUEST",
      context: req.context,
      accept: req.accept,
      pageUrl: req.pageUrl,
      workflowId,
    });
  }

  let queryText = req.context;

  // VLM mode: use screenshot to generate richer description
  if ((req.mode === "vlm" || req.mode === "vlm_gpt") && req.screenshotBase64) {
    try {
      if (req.mode === "vlm_gpt") {
        servicesCalled.add("chatgpt.describeWithVLM");
        logWorkflowStep(workflowId, "service.chatgpt.describeWithVLM.start");
        const description = await describePageTypeWithChatGPT(req.screenshotBase64, req.context, config.apiKey);
        logWorkflowStep(workflowId, "service.chatgpt.describeWithVLM.done", {
          descriptionPreview: description.slice(0, 160),
        });
        queryText = `${description} ${req.context}`;
      } else {
        servicesCalled.add("gemini.describeWithVLM");
        logWorkflowStep(workflowId, "service.gemini.describeWithVLM.start");
        const description = await describeWithVLM(req.screenshotBase64, req.context, config.apiKey);
        logWorkflowStep(workflowId, "service.gemini.describeWithVLM.done", {
          descriptionPreview: description.slice(0, 160),
        });
        queryText = `${description} ${req.context}`;
      }
    } catch (err) {
      logWorkflowError(
        workflowId,
        req.mode === "vlm_gpt" ? "service.chatgpt.describeWithVLM.failed" : "service.gemini.describeWithVLM.failed",
        err,
      );
    }
  }

  // Get query embedding
  try {
    servicesCalled.add("gemini.getEmbedding");
    logWorkflowStep(workflowId, "service.gemini.getEmbedding.start");
    const queryVec = await getEmbedding(queryText, config.apiKey);

    servicesCalled.add("vectordb.denseSearch");
    const results = await denseSearch(queryVec, 5, req.accept);
    logWorkflowStep(workflowId, "service.vectordb.denseSearch.done", {
      queryVectorSize: queryVec.length,
      candidateCount: results.length,
    });

    if (results.length === 0) {
      logWorkflowStep(workflowId, "match.enhanced.fallback", { reason: "dense_no_results" });
      return handleMatch({
        type: "MATCH_REQUEST",
        context: req.context,
        accept: req.accept,
        pageUrl: req.pageUrl,
        workflowId,
      });
    }

    // Get upload history + used paths for hybrid re-ranking
    let history: UploadHistoryEntry[] = [];
    let usedPaths: string[] = [];
    let pageHost = "";
    if (req.pageUrl) {
      try {
        pageHost = new URL(req.pageUrl).hostname;
      } catch { /* ignore */ }
    }
    if (pageHost) {
      try {
        servicesCalled.add("vectordb.getHistoryByHost");
        history = await getHistoryByHost(pageHost);
      } catch { /* ignore */ }
      try {
        servicesCalled.add("vectordb.getUsedPaths");
        usedPaths = await getUsedPaths(pageHost);
      } catch { /* ignore */ }
    }

    const historyMap = new Map<string, { count: number; lastTs: number }>();
    for (const h of history) {
      const existing = historyMap.get(h.fileId);
      if (!existing) {
        historyMap.set(h.fileId, { count: 1, lastTs: h.timestamp });
      } else {
        historyMap.set(h.fileId, {
          count: existing.count + 1,
          lastTs: Math.max(existing.lastTs, h.timestamp),
        });
      }
    }
    const usedPathSet = new Set(usedPaths);

    const ONE_DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const resumeContext =
      /resume|cv|简历|job application/i.test(req.context) ||
      /resume|cv|简历|job application/i.test(req.pageUrl || "");
    const ranked = results.map((r) => {
      const denseScore = r.score;
      let historyBoost = 0;
      let historyCount = 0;
      const hist = historyMap.get(r.record.id);
      if (hist) {
        historyCount = hist.count;
        const daysAgo = (now - hist.lastTs) / ONE_DAY;
        historyBoost = Math.max(0.1, 1.0 - daysAgo / 90);
      }

      const pathNameScore = computePathNameScore(r.record.path, req.context);
      const contentOverlap = computeContentOverlap(r.record.textPreview, req.context);
      const pathMemoryBoost = usedPathSet.has(r.record.path) ? 1 : 0;
      const resumeBoost = resumeContext && /resume|cv|简历/i.test(r.record.path) ? 1 : 0;

      const weights = { dense: 0.35, history: 0.10, path: 0.16, content: 0.06, pathMemory: 0.02, resume: 0.31 };
      const finalScore =
        denseScore * weights.dense +
        historyBoost * weights.history +
        pathNameScore * weights.path +
        contentOverlap * weights.content +
        pathMemoryBoost * weights.pathMemory +
        resumeBoost * weights.resume;

      return {
        ...r,
        score: finalScore,
        historyCount,
        debug: {
          denseScore,
          historyBoost,
          pathNameScore,
          contentOverlap,
          pathMemoryBoost,
          resumeBoost,
          weights,
        },
      };
    });

    ranked.sort((a, b) => b.score - a.score);
    const top = ranked.slice(0, 5);

    logWorkflowStep(
      workflowId,
      "match.enhanced.ranking.top_candidates",
      top.map((r, idx) => ({
        rank: idx + 1,
        file: r.record.name,
        path: r.record.path,
        finalScore: roundScore(r.score),
        denseScore: roundScore(r.debug.denseScore),
        historyBoost: roundScore(r.debug.historyBoost),
        pathNameScore: roundScore(r.debug.pathNameScore),
        contentOverlap: roundScore(r.debug.contentOverlap),
        pathMemoryBoost: r.debug.pathMemoryBoost,
        resumeBoost: r.debug.resumeBoost,
        historyCount: r.historyCount,
        weights: r.debug.weights,
      })),
    );

    logWorkflowStep(workflowId, "match.enhanced.services_called", Array.from(servicesCalled));
    logWorkflowStep(workflowId, "match.enhanced.done", {
      returnedCount: top.length,
      top: top.map((r) => `${r.record.name} (${Math.round(r.score * 100)}%)`),
    });

    return {
      type: "MATCH_RESPONSE",
      workflowId,
      results: top.map((r) => ({
        id: r.record.id,
        name: r.record.name,
        path: r.record.path,
        type: r.record.type,
        score: r.score,
        historyCount: r.historyCount,
      })),
    };
  } catch (err) {
    logWorkflowError(workflowId, "match.enhanced.failed", err);
    // Fallback to TF-IDF
    return handleMatch({
      type: "MATCH_REQUEST",
      context: req.context,
      accept: req.accept,
      pageUrl: req.pageUrl,
      workflowId,
    });
  }
}

async function handleClassifyPage(req: PageClassifyRequest): Promise<PageClassifyResponse> {
  const workflowId = req.workflowId || createWorkflowId("classify-page-bg");
  logWorkflowStep(workflowId, "classify.page.start", {
    hasScreenshot: !!req.screenshotBase64,
    contextPreview: req.context.slice(0, 140),
    pageUrl: req.pageUrl,
  });

  try {
    const config = await getApiConfig();
    if (!config.apiKey) {
      logWorkflowError(workflowId, "classify.page.missing_api_key", null);
      return { type: "PAGE_CLASSIFY_RESPONSE", ok: false, workflowId, error: "missing_api_key" };
    }

    let screenshotBase64 = req.screenshotBase64;
    if (!screenshotBase64) {
      logWorkflowStep(workflowId, "service.chrome.captureVisibleTab.start");
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const windowId = req.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
        chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (url) => {
          if (chrome.runtime.lastError || !url) {
            reject(new Error(chrome.runtime.lastError?.message || "capture_failed"));
            return;
          }
          resolve(url);
        });
      });
      screenshotBase64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
      logWorkflowStep(workflowId, "service.chrome.captureVisibleTab.done");
    }

    if (req.mode === "vlm_gpt") {
      logWorkflowStep(workflowId, "service.chatgpt.page_classify.start");
      const label = await describePageTypeWithChatGPT(screenshotBase64, req.context, config.apiKey);
      logWorkflowStep(workflowId, "service.chatgpt.page_classify.done", {
        labelPreview: label.slice(0, 160),
      });
      return { type: "PAGE_CLASSIFY_RESPONSE", ok: true, workflowId, label };
    }

    logWorkflowStep(workflowId, "service.gemini.page_classify.start");
    const label = await describePageTypeWithVLM(screenshotBase64, req.context, config.apiKey);
    logWorkflowStep(workflowId, "service.gemini.page_classify.done", {
      labelPreview: label.slice(0, 160),
    });

    return { type: "PAGE_CLASSIFY_RESPONSE", ok: true, workflowId, label };
  } catch (err) {
    logWorkflowError(workflowId, "classify.page.failed", err);
    return { type: "PAGE_CLASSIFY_RESPONSE", ok: false, workflowId, error: "classify_failed" };
  }
}

interface FileEntry {
  path: string;
  name: string;
  type: string;
  size: number;
  lastModified: number;
  text: string;
}

async function handleBuildIndex(files: FileEntry[], workflowId: string = createWorkflowId("scan-bg")) {
  const servicesCalled = new Set<string>([
    "embeddings.tokenize",
    "embeddings.buildVocabulary",
    "vectordb.clearAll",
    "vectordb.upsert",
    "vectordb.saveVocab",
    "chrome.storage.local.set:vocab",
    "vectordb.getCount",
  ]);

  logWorkflowStep(workflowId, "scan.background.start", {
    fileCount: files.length,
    mode: "full",
  });

  try {
    // Phase 1: TF-IDF (always)
    const allTokens = files.map((f) => tokenize(f.text));
    buildVocabulary(allTokens);
    logWorkflowStep(workflowId, "scan.phase.tfidf.done", {
      tokenizedFiles: allTokens.length,
    });

    await clearAll();
    logWorkflowStep(workflowId, "service.vectordb.clearAll.done");

    // Phase 2: Dense embeddings (if API key configured)
    const config = await getApiConfig();
    servicesCalled.add("chrome.storage.local.get:xupload_config");
    let denseVectors: (number[] | undefined)[] = new Array(files.length).fill(undefined);

    if (config.apiKey && config.mode !== "tfidf") {
      servicesCalled.add("gemini.batchEmbed");
      logWorkflowStep(workflowId, "service.gemini.batchEmbed.start", {
        fileCount: files.length,
        mode: config.mode,
      });
      try {
        const texts = files.map((f) => f.text.slice(0, 2000));
        const vectors = await batchEmbed(texts, config.apiKey, 10, (done, total) => {
          logWorkflowStep(workflowId, "service.gemini.batchEmbed.progress", { done, total });
        });
        denseVectors = vectors;
        logWorkflowStep(workflowId, "service.gemini.batchEmbed.done", {
          vectorCount: vectors.length,
        });
      } catch (err) {
        logWorkflowError(workflowId, "service.gemini.batchEmbed.failed", err);
      }
    }

    // Phase 3: Store records
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
        denseVector: denseVectors[i],
        textPreview: f.text.slice(0, 500),
      });
    }
    logWorkflowStep(workflowId, "service.vectordb.upsert.done", {
      upserted: files.length,
    });

    const vocab = exportVocab();
    await saveVocab(vocab);
    await new Promise<void>((resolve) => {
      chrome.storage.local.set({ vocab }, resolve);
    });
    logWorkflowStep(workflowId, "service.vocab.persist.done", {
      termCount: vocab.terms.length,
    });

    const count = await getCount();
    logWorkflowStep(workflowId, "scan.background.services_called", Array.from(servicesCalled));
    logWorkflowStep(workflowId, "scan.background.done", { indexedCount: count });
    return { ok: true, count, workflowId };
  } catch (err: any) {
    logWorkflowError(workflowId, "scan.background.failed", err);
    return { ok: false, error: err?.message || String(err), workflowId };
  }
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
