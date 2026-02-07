import {
  extractText,
  tokenize,
  buildVocabulary,
  vectorize,
  exportVocab,
} from "./embeddings";
import { upsert, clearAll, getCount, saveDirectoryHandle, type VectorRecord } from "./vectordb";

const countEl = document.getElementById("count")!;
const scanBtn = document.getElementById("scanBtn") as HTMLButtonElement;
const progressEl = document.getElementById("progress")!;
const fileListEl = document.getElementById("fileList")!;

getCount().then((n) => (countEl.textContent = String(n)));

scanBtn.addEventListener("click", async () => {
  try {
    const dirHandle = await (window as any).showDirectoryPicker({ mode: "read" });
    await buildIndex(dirHandle);
  } catch (err: any) {
    if (err.name !== "AbortError") {
      console.error("[xUpload] Scan error:", err);
      progressEl.textContent = "Error scanning folder";
    }
  }
});

interface DocEntry {
  path: string;
  name: string;
  type: string;
  size: number;
  lastModified: number;
  text: string;
}

async function buildIndex(dirHandle: FileSystemDirectoryHandle) {
  scanBtn.disabled = true;
  progressEl.textContent = "Scanning files...";

  const entries = await collectFiles(dirHandle, "");
  progressEl.textContent = `Found ${entries.length} files. Reading...`;

  // Persist the directory handle for on-demand file reading later
  await saveDirectoryHandle(dirHandle);

  // Phase 1: read all files + extract text
  const docs: DocEntry[] = [];

  for (let i = 0; i < entries.length; i++) {
    const { fileHandle, path } = entries[i];
    try {
      const file = await fileHandle.getFile();
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
      progressEl.textContent = `Reading files... ${i + 1}/${entries.length}`;
    }
  }

  progressEl.textContent = "Building vectors...";

  // Phase 2: build vocabulary
  const allTokens = docs.map((d) => tokenize(d.text));
  buildVocabulary(allTokens);

  // Phase 3: vectorize + store in IndexedDB (with blob)
  await clearAll();

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

  // Phase 4: save vocabulary
  const vocab = exportVocab();
  chrome.storage.local.set({ vocab }, () => {
    chrome.runtime.sendMessage({ type: "VOCAB_UPDATED" });
  });

  const total = await getCount();
  countEl.textContent = String(total);
  progressEl.textContent = `Done! ${total} files indexed.`;
  scanBtn.disabled = false;

  showFiles(docs);
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
