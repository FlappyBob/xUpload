/**
 * Local vector database backed by IndexedDB.
 * Stores file embeddings + metadata. File content is read on-demand
 * via a persisted FileSystemDirectoryHandle.
 */

export interface VectorRecord {
  id: string;              // unique key (file path)
  name: string;
  path: string;
  type: string;
  size: number;
  lastModified: number;
  vector: number[];        // TF-IDF embedding vector
  denseVector?: number[];  // Gemini embedding (768-dim, optional)
  textPreview: string;     // first N chars of extracted text
}

import type { VocabSnapshot } from "./embeddings";
import type { UploadHistoryEntry } from "./types";

const DB_NAME = "xupload_vectors";
const DB_VERSION = 5;
const STORE_NAME = "files";
const HANDLE_STORE = "dir_handles";
const VOCAB_STORE = "vocabulary";
const HISTORY_STORE = "upload_history";
const CONFIG_STORE = "config";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      db.createObjectStore(STORE_NAME, { keyPath: "id" });
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE);
      }
      if (!db.objectStoreNames.contains(VOCAB_STORE)) {
        db.createObjectStore(VOCAB_STORE);
      }
      if (!db.objectStoreNames.contains(HISTORY_STORE)) {
        const historyStore = db.createObjectStore(HISTORY_STORE, { keyPath: "id", autoIncrement: true });
        historyStore.createIndex("websiteHost", "websiteHost", { unique: false });
        historyStore.createIndex("timestamp", "timestamp", { unique: false });
      }
      if (!db.objectStoreNames.contains(CONFIG_STORE)) {
        db.createObjectStore(CONFIG_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function upsert(record: VectorRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAll(): Promise<VectorRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getById(id: string): Promise<VectorRecord | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result ?? undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function getCount(): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function clearAll(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface SearchResult {
  record: VectorRecord;
  score: number;
}

export async function search(
  queryVector: number[],
  topN: number = 5,
  acceptFilter?: string
): Promise<SearchResult[]> {
  const all = await getAll();
  let candidates = all;

  if (acceptFilter) {
    const accepts = acceptFilter.split(",").map((s) => s.trim().toLowerCase());
    const filtered = all.filter((r) => {
      const ext = "." + r.name.split(".").pop()?.toLowerCase();
      const mime = r.type.toLowerCase();
      return accepts.some(
        (a) =>
          a === ext ||
          a === mime ||
          (a.endsWith("/*") && mime.startsWith(a.replace("/*", "/")))
      );
    });
    if (filtered.length > 0) candidates = filtered;
  }

  return candidates
    .map((record) => ({ record, score: cosine(queryVector, record.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .filter((r) => r.score > 0);
}

/** Save the directory handle for on-demand file reading. */
export async function saveDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, "readwrite");
    tx.objectStore(HANDLE_STORE).put(handle, "main");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Retrieve the persisted directory handle. */
export async function getDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, "readonly");
    const req = tx.objectStore(HANDLE_STORE).get("main");
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Read file content on-demand using the stored directory handle.
 * Navigates the handle tree using the file's relative path.
 */
export async function getFileData(id: string): Promise<{
  name: string;
  type: string;
  lastModified: number;
  base64: string;
} | null> {
  const record = await getById(id);
  if (!record) {
    console.error("[xUpload] getFileData: record not found for id:", id);
    return null;
  }

  const dirHandle = await getDirectoryHandle();
  if (!dirHandle) {
    console.error("[xUpload] getFileData: no directory handle stored");
    return null;
  }

  try {
    // Check permission on the handle
    const perm = await (dirHandle as any).queryPermission({ mode: "read" });
    console.log("[xUpload] Directory handle permission:", perm);
    if (perm !== "granted") {
      // Try requesting permission (only works with user gesture)
      const requested = await (dirHandle as any).requestPermission({ mode: "read" });
      console.log("[xUpload] Permission after request:", requested);
      if (requested !== "granted") {
        console.error("[xUpload] Permission denied for directory handle");
        return null;
      }
    }

    // Navigate to the file through the directory tree
    const parts = record.path.split("/");
    console.log("[xUpload] Navigating path parts:", parts);
    let currentDir: FileSystemDirectoryHandle = dirHandle;
    for (let i = 0; i < parts.length - 1; i++) {
      currentDir = await currentDir.getDirectoryHandle(parts[i]);
    }
    const fileHandle = await currentDir.getFileHandle(parts[parts.length - 1]);
    const file = await fileHandle.getFile();

    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }

    return {
      name: record.name,
      type: record.type,
      lastModified: record.lastModified,
      base64: btoa(binary),
    };
  } catch (err) {
    console.error("[xUpload] Failed to read file on-demand:", err);
    return null;
  }
}

// ---- Vocabulary persistence (IndexedDB) ----

export async function saveVocab(vocab: VocabSnapshot): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VOCAB_STORE, "readwrite");
    tx.objectStore(VOCAB_STORE).put(vocab, "main");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getVocab(): Promise<VocabSnapshot | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VOCAB_STORE, "readonly");
    const req = tx.objectStore(VOCAB_STORE).get("main");
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

// ---- Upload history ----

export async function addUploadHistory(entry: Omit<UploadHistoryEntry, "id">): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE, "readwrite");
    tx.objectStore(HISTORY_STORE).add(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getHistoryByHost(websiteHost: string, limit: number = 50): Promise<UploadHistoryEntry[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE, "readonly");
    const index = tx.objectStore(HISTORY_STORE).index("websiteHost");
    const req = index.getAll(websiteHost, limit);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---- Delete record by ID ----

export async function deleteById(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- Config persistence ----

export interface RescanConfig {
  autoRescanEnabled: boolean;
  rescanIntervalMin: number;
  lastScanTimestamp: number;
}

export async function getRescanConfig(): Promise<RescanConfig> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONFIG_STORE, "readonly");
    const req = tx.objectStore(CONFIG_STORE).get("rescan");
    req.onsuccess = () => resolve(req.result ?? { autoRescanEnabled: true, rescanIntervalMin: 30, lastScanTimestamp: 0 });
    req.onerror = () => reject(req.error);
  });
}

export async function saveRescanConfig(config: RescanConfig): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONFIG_STORE, "readwrite");
    tx.objectStore(CONFIG_STORE).put(config, "rescan");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- Dense vector search (for Gemini embeddings) ----

export async function denseSearch(
  queryVector: number[],
  topN: number = 5,
  acceptFilter?: string
): Promise<SearchResult[]> {
  const all = await getAll();
  // Only consider records that have dense vectors
  let candidates = all.filter((r) => r.denseVector && r.denseVector.length > 0);

  if (candidates.length === 0) return [];

  if (acceptFilter) {
    const accepts = acceptFilter.split(",").map((s) => s.trim().toLowerCase());
    const filtered = candidates.filter((r) => {
      const ext = "." + r.name.split(".").pop()?.toLowerCase();
      const mime = r.type.toLowerCase();
      return accepts.some(
        (a) =>
          a === ext ||
          a === mime ||
          (a.endsWith("/*") && mime.startsWith(a.replace("/*", "/")))
      );
    });
    if (filtered.length > 0) candidates = filtered;
  }

  return candidates
    .map((record) => ({ record, score: cosine(queryVector, record.denseVector!) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .filter((r) => r.score > 0);
}

// ---- Persistent path memory ----

interface PathMemoryStore {
  [websiteHost: string]: string[];
}

export async function saveUsedPath(host: string, filePath: string): Promise<void> {
  const db = await openDB();
  const memory: PathMemoryStore = await new Promise((resolve, reject) => {
    const tx = db.transaction(CONFIG_STORE, "readonly");
    const req = tx.objectStore(CONFIG_STORE).get("pathMemory");
    req.onsuccess = () => resolve(req.result ?? {});
    req.onerror = () => reject(req.error);
  });

  const paths = memory[host] || [];
  // Remove if already exists, then prepend
  const idx = paths.indexOf(filePath);
  if (idx !== -1) paths.splice(idx, 1);
  paths.unshift(filePath);
  // Keep max 20
  if (paths.length > 20) paths.length = 20;
  memory[host] = paths;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONFIG_STORE, "readwrite");
    tx.objectStore(CONFIG_STORE).put(memory, "pathMemory");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getUsedPaths(host: string): Promise<string[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONFIG_STORE, "readonly");
    const req = tx.objectStore(CONFIG_STORE).get("pathMemory");
    req.onsuccess = () => {
      const memory: PathMemoryStore = req.result ?? {};
      resolve(memory[host] || []);
    };
    req.onerror = () => reject(req.error);
  });
}
