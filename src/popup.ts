import {
  extractText,
  tokenize,
  buildVocabulary,
  vectorize,
  exportVocab,
} from "./embeddings";
import {
  upsert,
  clearAll,
  getCount,
  getAll,
  deleteById,
  saveDirectoryHandle,
  getDirectoryHandle,
  saveVocab,
  getRescanConfig,
  saveRescanConfig,
  type VectorRecord,
} from "./vectordb";
import { createWorkflowId, logWorkflowError, logWorkflowStep } from "./workflow";

const countEl = document.getElementById("count")!;
const scanBtn = document.getElementById("scanBtn") as HTMLButtonElement;
const rescanBtn = document.getElementById("rescanBtn") as HTMLButtonElement | null;
const progressEl = document.getElementById("progress")!;
const fileListEl = document.getElementById("fileList")!;
const lastScanEl = document.getElementById("lastScan") as HTMLElement | null;
const autoRescanCheckbox = document.getElementById("autoRescan") as HTMLInputElement | null;
const rescanIntervalSelect = document.getElementById("rescanInterval") as HTMLSelectElement | null;
const apiKeyInput = document.getElementById("apiKey") as HTMLInputElement | null;
const matchModeSelect = document.getElementById("matchMode") as HTMLSelectElement | null;

// Load initial state
getCount().then((n) => (countEl.textContent = String(n)));
loadRescanConfig();
loadApiConfig();
showLastScanTime();

scanBtn.addEventListener("click", async () => {
  const workflowId = createWorkflowId("scan-popup");
  logWorkflowStep(workflowId, "scan.popup.click");
  try {
    logWorkflowStep(workflowId, "service.filesystem.showDirectoryPicker.start");
    const dirHandle = await (window as any).showDirectoryPicker({ mode: "read" });
    logWorkflowStep(workflowId, "service.filesystem.showDirectoryPicker.done");
    await buildIndex(dirHandle, false, workflowId);
  } catch (err: any) {
    if (err.name !== "AbortError") {
      logWorkflowError(workflowId, "scan.popup.failed", err);
      progressEl.textContent = "Error scanning folder";
      scanBtn.disabled = false;
      if (rescanBtn) rescanBtn.disabled = false;
    } else {
      logWorkflowStep(workflowId, "scan.popup.cancelled");
    }
  }
});

// Rescan button: incremental scan using stored directory handle
if (rescanBtn) {
  rescanBtn.addEventListener("click", async () => {
    const workflowId = createWorkflowId("rescan-popup");
    logWorkflowStep(workflowId, "rescan.popup.click");
    try {
      logWorkflowStep(workflowId, "service.vectordb.getDirectoryHandle.start");
      const dirHandle = await getDirectoryHandle();
      if (!dirHandle) {
        logWorkflowStep(workflowId, "rescan.popup.no_directory_handle");
        progressEl.textContent = "No folder selected yet. Use 'Select folder' first.";
        return;
      }
      // Check permission
      const perm = await (dirHandle as any).queryPermission({ mode: "read" });
      logWorkflowStep(workflowId, "service.filesystem.queryPermission.done", { permission: perm });
      if (perm !== "granted") {
        const requested = await (dirHandle as any).requestPermission({ mode: "read" });
        logWorkflowStep(workflowId, "service.filesystem.requestPermission.done", { permission: requested });
        if (requested !== "granted") {
          progressEl.textContent = "Permission denied. Please select folder again.";
          return;
        }
      }
      await buildIndex(dirHandle, true, workflowId);
    } catch (err: any) {
      logWorkflowError(workflowId, "rescan.popup.failed", err);
      progressEl.textContent = "Error during rescan. Try selecting folder again.";
      scanBtn.disabled = false;
      if (rescanBtn) rescanBtn.disabled = false;
    }
  });
}

// Auto-rescan config
if (autoRescanCheckbox) {
  autoRescanCheckbox.addEventListener("change", saveCurrentRescanConfig);
}
if (rescanIntervalSelect) {
  rescanIntervalSelect.addEventListener("change", saveCurrentRescanConfig);
}

interface DocEntry {
  path: string;
  name: string;
  type: string;
  size: number;
  lastModified: number;
  text: string;
}

/**
 * Build or incrementally update the file index.
 * @param incremental - if true, only process new/modified files
 */
async function buildIndex(
  dirHandle: FileSystemDirectoryHandle,
  incremental: boolean,
  workflowId: string = createWorkflowId(incremental ? "rescan-popup" : "scan-popup")
) {
  const servicesCalled = new Set<string>([
    "filesystem.collectFiles",
    "vectordb.saveDirectoryHandle",
    "embeddings.extractText",
    "embeddings.tokenize",
    "embeddings.buildVocabulary",
    "embeddings.vectorize",
    "vectordb.upsert",
    "vectordb.saveVocab",
    "chrome.storage.local.set:vocab",
    "chrome.runtime.sendMessage:VOCAB_UPDATED",
    "vectordb.getCount",
  ]);

  logWorkflowStep(workflowId, "scan.popup.start", { incremental });

  scanBtn.disabled = true;
  if (rescanBtn) rescanBtn.disabled = true;
  progressEl.textContent = "Scanning files...";

  try {
    const entries = await collectFiles(dirHandle, "");
    progressEl.textContent = `Found ${entries.length} files. Checking for changes...`;
    logWorkflowStep(workflowId, "service.filesystem.collectFiles.done", {
      discoveredFiles: entries.length,
    });

    await saveDirectoryHandle(dirHandle);
    logWorkflowStep(workflowId, "service.vectordb.saveDirectoryHandle.done");

    const existingRecords = incremental ? await getAll() : [];
    const existingMap = new Map(existingRecords.map((r) => [r.id, r]));
    const currentPaths = new Set<string>();
    if (incremental) {
      servicesCalled.add("vectordb.getAll");
      servicesCalled.add("vectordb.deleteById");
    }

    const docs: DocEntry[] = [];
    const unchangedDocs: DocEntry[] = [];
    let skipped = 0;
    let unreadable = 0;

    for (let i = 0; i < entries.length; i++) {
      const { fileHandle, path } = entries[i];
      currentPaths.add(path);

      try {
        const file = await fileHandle.getFile();

        if (incremental) {
          const existing = existingMap.get(path);
          if (
            existing &&
            existing.size === file.size &&
            existing.lastModified === file.lastModified
          ) {
            unchangedDocs.push({
              path,
              name: file.name,
              type: file.type || guessType(file.name),
              size: file.size,
              lastModified: file.lastModified,
              text: existing.textPreview,
            });
            skipped++;
            continue;
          }
        }

        const text = await extractText(file, path);
        docs.push({
          path,
          name: file.name,
          type: file.type || guessType(file.name),
          size: file.size,
          lastModified: file.lastModified,
          text,
        });
      } catch {
        unreadable++;
      }

      if (i % 10 === 0) {
        progressEl.textContent = `Reading files... ${i + 1}/${entries.length}${skipped > 0 ? ` (${skipped} unchanged)` : ""}`;
      }
    }

    logWorkflowStep(workflowId, "scan.phase.read.done", {
      discovered: entries.length,
      toProcess: docs.length,
      unchanged: skipped,
      unreadable,
    });

    let deleted = 0;
    if (incremental) {
      for (const id of existingMap.keys()) {
        if (!currentPaths.has(id)) {
          await deleteById(id);
          deleted++;
        }
      }
      logWorkflowStep(workflowId, "scan.phase.deleted.done", { deleted });
    }

    if (incremental && docs.length === 0 && deleted === 0) {
      progressEl.textContent = `No changes detected. ${skipped} files up to date.`;
      await updateLastScanTimestamp();
      logWorkflowStep(workflowId, "scan.popup.no_changes", { unchanged: skipped });
      logWorkflowStep(workflowId, "scan.popup.services_called", Array.from(servicesCalled));
      return;
    }

    progressEl.textContent = `Building vectors... (${docs.length} new/modified, ${skipped} unchanged, ${deleted} deleted)`;

    const allDocs = [...docs, ...unchangedDocs];
    const allTokens = allDocs.map((d) => tokenize(d.text));
    buildVocabulary(allTokens);
    logWorkflowStep(workflowId, "scan.phase.vocab.done", {
      vocabDocs: allDocs.length,
    });

    if (!incremental) {
      await clearAll();
      servicesCalled.add("vectordb.clearAll");
      logWorkflowStep(workflowId, "service.vectordb.clearAll.done");
    }

    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      const vec = vectorize(allTokens[i]);
      const record: VectorRecord = {
        id: d.path,
        name: d.name,
        path: d.path,
        type: d.type,
        size: d.size,
        lastModified: d.lastModified,
        vector: vec,
        textPreview: d.text.slice(0, 500),
      };
      await upsert(record);

      if (i % 10 === 0) {
        progressEl.textContent = `Indexing... ${i + 1}/${docs.length}`;
      }
    }

    if (incremental && unchangedDocs.length > 0) {
      progressEl.textContent = "Updating vectors for unchanged files...";
      for (let i = 0; i < unchangedDocs.length; i++) {
        const d = unchangedDocs[i];
        const tokenIdx = docs.length + i;
        const vec = vectorize(allTokens[tokenIdx]);
        const existing = existingMap.get(d.path)!;
        await upsert({ ...existing, vector: vec });
      }
    }

    logWorkflowStep(workflowId, "scan.phase.index.done", {
      updated: docs.length,
      revectorized: unchangedDocs.length,
    });

    const vocab = exportVocab();
    await saveVocab(vocab);
    chrome.storage.local.set({ vocab }, () => {
      chrome.runtime.sendMessage({ type: "VOCAB_UPDATED" }, () => { void chrome.runtime.lastError; });
    });
    logWorkflowStep(workflowId, "scan.phase.persist.done", {
      vocabTerms: vocab.terms.length,
    });

    await updateLastScanTimestamp();

    const total = await getCount();
    countEl.textContent = String(total);
    progressEl.textContent = incremental
      ? `Done! ${docs.length} updated, ${deleted} removed, ${total} total.`
      : `Done! ${total} files indexed.`;

    showFiles(allDocs);

    logWorkflowStep(workflowId, "scan.popup.services_called", Array.from(servicesCalled));
    logWorkflowStep(workflowId, "scan.popup.done", {
      totalIndexed: total,
      updated: docs.length,
      unchanged: skipped,
      deleted,
      unreadable,
    });
  } catch (err) {
    logWorkflowError(workflowId, "scan.popup.failed", err);
    progressEl.textContent = incremental
      ? "Error during rescan. Try selecting folder again."
      : "Error scanning folder";
  } finally {
    scanBtn.disabled = false;
    if (rescanBtn) rescanBtn.disabled = false;
  }
}

interface FileEntry {
  fileHandle: FileSystemFileHandle;
  path: string;
}

async function collectFiles(
  dirHandle: FileSystemDirectoryHandle,
  basePath: string
): Promise<FileEntry[]> {
  const result: FileEntry[] = [];
  for await (const entry of (dirHandle as any).values()) {
    const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (entry.kind === "file") {
      result.push({ fileHandle: entry, path: entryPath });
    } else if (entry.kind === "directory" && !entry.name.startsWith(".")) {
      const sub = await collectFiles(entry, entryPath);
      result.push(...sub);
    }
  }
  return result;
}

function guessType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    pdf: "application/pdf",
    jpg: "image/jpeg", jpeg: "image/jpeg",
    png: "image/png", gif: "image/gif", webp: "image/webp",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    txt: "text/plain", csv: "text/csv",
  };
  return map[ext] || "application/octet-stream";
}

function showFiles(docs: { path: string; lastModified: number }[]) {
  fileListEl.innerHTML = "";
  const sorted = [...docs].sort((a, b) => b.lastModified - a.lastModified);
  for (const f of sorted.slice(0, 50)) {
    const div = document.createElement("div");
    div.textContent = f.path;
    fileListEl.appendChild(div);
  }
  if (docs.length > 50) {
    const div = document.createElement("div");
    div.textContent = `... and ${docs.length - 50} more`;
    fileListEl.appendChild(div);
  }
}

// ---- Rescan config ----

async function loadRescanConfig() {
  const config = await getRescanConfig();
  if (autoRescanCheckbox) autoRescanCheckbox.checked = config.autoRescanEnabled;
  if (rescanIntervalSelect) rescanIntervalSelect.value = String(config.rescanIntervalMin);
}

async function saveCurrentRescanConfig() {
  const config = await getRescanConfig();
  config.autoRescanEnabled = autoRescanCheckbox?.checked ?? true;
  config.rescanIntervalMin = parseInt(rescanIntervalSelect?.value ?? "30", 10);
  await saveRescanConfig(config);
  chrome.runtime.sendMessage({ type: "RESCAN_CONFIG_UPDATED" }, () => { void chrome.runtime.lastError; });
}

async function updateLastScanTimestamp() {
  const config = await getRescanConfig();
  config.lastScanTimestamp = Date.now();
  await saveRescanConfig(config);
  showLastScanTime();
}

async function showLastScanTime() {
  if (!lastScanEl) return;
  const config = await getRescanConfig();
  if (config.lastScanTimestamp === 0) {
    lastScanEl.textContent = "Never scanned";
    return;
  }
  const ago = Date.now() - config.lastScanTimestamp;
  const mins = Math.floor(ago / 60_000);
  if (mins < 1) lastScanEl.textContent = "Last scan: just now";
  else if (mins < 60) lastScanEl.textContent = `Last scan: ${mins}m ago`;
  else lastScanEl.textContent = `Last scan: ${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

// ---- API config ----

function loadApiConfig() {
  chrome.storage.local.get("xupload_config", (data) => {
    const cfg = data.xupload_config || { apiKey: "", mode: "tfidf" };
    if (apiKeyInput) apiKeyInput.value = cfg.apiKey || "";
    if (matchModeSelect) matchModeSelect.value = cfg.mode || "tfidf";
  });
}

function saveApiConfig() {
  const cfg = {
    apiKey: apiKeyInput?.value || "",
    mode: matchModeSelect?.value || "tfidf",
  };
  chrome.storage.local.set({ xupload_config: cfg });
}

if (apiKeyInput) apiKeyInput.addEventListener("change", saveApiConfig);
if (matchModeSelect) matchModeSelect.addEventListener("change", saveApiConfig);
