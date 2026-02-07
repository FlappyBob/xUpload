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

const countEl = document.getElementById("count")!;
const scanBtn = document.getElementById("scanBtn") as HTMLButtonElement;
const rescanBtn = document.getElementById("rescanBtn") as HTMLButtonElement | null;
const progressEl = document.getElementById("progress")!;
const fileListEl = document.getElementById("fileList")!;
const lastScanEl = document.getElementById("lastScan") as HTMLElement | null;
const autoRescanCheckbox = document.getElementById("autoRescan") as HTMLInputElement | null;
const rescanIntervalSelect = document.getElementById("rescanInterval") as HTMLSelectElement | null;

// Load initial state
getCount().then((n) => (countEl.textContent = String(n)));
loadRescanConfig();
showLastScanTime();

scanBtn.addEventListener("click", async () => {
  try {
    const dirHandle = await (window as any).showDirectoryPicker({ mode: "read" });
    await buildIndex(dirHandle, false);
  } catch (err: any) {
    if (err.name !== "AbortError") {
      console.error("[xUpload] Scan error:", err);
      progressEl.textContent = "Error scanning folder";
    }
  }
});

// Rescan button: incremental scan using stored directory handle
if (rescanBtn) {
  rescanBtn.addEventListener("click", async () => {
    try {
      const dirHandle = await getDirectoryHandle();
      if (!dirHandle) {
        progressEl.textContent = "No folder selected yet. Use 'Select folder' first.";
        return;
      }
      // Check permission
      const perm = await (dirHandle as any).queryPermission({ mode: "read" });
      if (perm !== "granted") {
        const requested = await (dirHandle as any).requestPermission({ mode: "read" });
        if (requested !== "granted") {
          progressEl.textContent = "Permission denied. Please select folder again.";
          return;
        }
      }
      await buildIndex(dirHandle, true);
    } catch (err: any) {
      console.error("[xUpload] Rescan error:", err);
      progressEl.textContent = "Error during rescan. Try selecting folder again.";
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
async function buildIndex(dirHandle: FileSystemDirectoryHandle, incremental: boolean) {
  scanBtn.disabled = true;
  if (rescanBtn) rescanBtn.disabled = true;
  progressEl.textContent = "Scanning files...";

  const entries = await collectFiles(dirHandle, "");
  progressEl.textContent = `Found ${entries.length} files. Checking for changes...`;

  // Persist the directory handle
  await saveDirectoryHandle(dirHandle);

  // Get existing records for incremental comparison
  const existingRecords = incremental ? await getAll() : [];
  const existingMap = new Map(existingRecords.map((r) => [r.id, r]));
  const currentPaths = new Set<string>();

  // Phase 1: read files, skipping unchanged ones in incremental mode
  const docs: DocEntry[] = [];
  const unchangedDocs: DocEntry[] = [];
  let skipped = 0;

  for (let i = 0; i < entries.length; i++) {
    const { fileHandle, path } = entries[i];
    currentPaths.add(path);

    try {
      const file = await fileHandle.getFile();

      // In incremental mode, check if file changed
      if (incremental) {
        const existing = existingMap.get(path);
        if (
          existing &&
          existing.size === file.size &&
          existing.lastModified === file.lastModified
        ) {
          // File unchanged — reuse existing text for vocabulary rebuild
          unchangedDocs.push({
            path,
            name: file.name,
            type: file.type || guessType(file.name),
            size: file.size,
            lastModified: file.lastModified,
            text: existing.textPreview, // use stored preview
          });
          skipped++;
          continue;
        }
      }

      const text = await extractText(file);
      docs.push({
        path,
        name: file.name,
        type: file.type || guessType(file.name),
        size: file.size,
        lastModified: file.lastModified,
        text,
      });
    } catch {
      // skip unreadable
    }
    if (i % 10 === 0) {
      progressEl.textContent = `Reading files... ${i + 1}/${entries.length}${skipped > 0 ? ` (${skipped} unchanged)` : ""}`;
    }
  }

  // Detect deleted files (only in incremental mode)
  let deleted = 0;
  if (incremental) {
    for (const id of existingMap.keys()) {
      if (!currentPaths.has(id)) {
        await deleteById(id);
        deleted++;
      }
    }
  }

  if (incremental && docs.length === 0 && deleted === 0) {
    progressEl.textContent = `No changes detected. ${skipped} files up to date.`;
    scanBtn.disabled = false;
    if (rescanBtn) rescanBtn.disabled = false;
    await updateLastScanTimestamp();
    return;
  }

  progressEl.textContent = `Building vectors... (${docs.length} new/modified, ${skipped} unchanged, ${deleted} deleted)`;

  // Phase 2: build vocabulary from ALL files (new + unchanged)
  const allDocs = [...docs, ...unchangedDocs];
  const allTokens = allDocs.map((d) => tokenize(d.text));
  buildVocabulary(allTokens);

  // Phase 3: vectorize and store
  if (!incremental) {
    await clearAll();
  }

  // Store new/modified files
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
      textPreview: d.text.slice(0, 100),
    };
    await upsert(record);

    if (i % 10 === 0) {
      progressEl.textContent = `Indexing... ${i + 1}/${docs.length}`;
    }
  }

  // In incremental mode, re-vectorize unchanged files too (vocab changed)
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

  // Phase 4: save vocabulary
  const vocab = exportVocab();
  await saveVocab(vocab);
  chrome.storage.local.set({ vocab }, () => {
    chrome.runtime.sendMessage({ type: "VOCAB_UPDATED" });
  });

  await updateLastScanTimestamp();

  const total = await getCount();
  countEl.textContent = String(total);
  progressEl.textContent = incremental
    ? `Done! ${docs.length} updated, ${deleted} removed, ${total} total.`
    : `Done! ${total} files indexed.`;
  scanBtn.disabled = false;
  if (rescanBtn) rescanBtn.disabled = false;

  showFiles(allDocs);
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
  chrome.runtime.sendMessage({ type: "RESCAN_CONFIG_UPDATED" });
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
