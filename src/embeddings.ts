/**
 * Text embedding: tokenization, TF-IDF vectorization, and file content extraction.
 * Builds a shared vocabulary from all indexed documents, then produces
 * fixed-dimension dense vectors for cosine similarity search.
 */

// ---- Tokenizer ----

export function tokenize(text: string): string[] {
  const normalized = text.toLowerCase().trim();
  const tokens: string[] = [];

  const words = normalized.match(/[a-z0-9]+/g) || [];
  tokens.push(...words);

  const cjk = normalized.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || [];
  tokens.push(...cjk);

  // CJK bigrams
  for (let i = 0; i < cjk.length - 1; i++) {
    tokens.push(cjk[i] + cjk[i + 1]);
  }

  return tokens;
}

// ---- Vocabulary & IDF (module-level state) ----

let vocabulary: Map<string, number> = new Map();
let idfValues: Map<string, number> = new Map();

export function buildVocabulary(docs: string[][]): void {
  const df: Map<string, number> = new Map();
  const N = docs.length;

  for (const doc of docs) {
    const seen = new Set(doc);
    for (const term of seen) {
      df.set(term, (df.get(term) || 0) + 1);
    }
  }

  vocabulary = new Map();
  idfValues = new Map();
  let idx = 0;
  for (const [term, count] of df) {
    vocabulary.set(term, idx++);
    idfValues.set(term, Math.log((N + 1) / (count + 1)) + 1);
  }
}

export function getVocabSize(): number {
  return vocabulary.size;
}

/** Convert tokens to a dense TF-IDF vector (L2 normalized) */
export function vectorize(tokens: string[]): number[] {
  const dim = vocabulary.size;
  if (dim === 0) return [];

  const vec = new Array<number>(dim).fill(0);

  const tf: Map<string, number> = new Map();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) || 0) + 1);
  }
  const maxTf = Math.max(...tf.values(), 1);

  for (const [term, count] of tf) {
    const idx = vocabulary.get(term);
    if (idx !== undefined) {
      vec[idx] = (count / maxTf) * (idfValues.get(term) || 1);
    }
  }

  // L2 normalize
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }

  return vec;
}

// ---- File content extraction ----

export async function extractText(file: File): Promise<string> {
  const name = file.name.replace(/[._-]/g, " ");
  const ext = file.name.split(".").pop()?.toLowerCase() || "";

  if (isTextFile(ext)) {
    try {
      const text = await file.text();
      return `${name} ${text.slice(0, 2000)}`;
    } catch {
      return name;
    }
  }

  if (ext === "pdf") {
    try {
      const text = await extractPdfText(file);
      return `${name} ${text.slice(0, 2000)}`;
    } catch {
      return name;
    }
  }

  // Images / binary: filename only
  return name;
}

function isTextFile(ext: string): boolean {
  return [
    "txt", "md", "csv", "json", "xml", "html", "htm",
    "js", "ts", "py", "java", "c", "cpp", "css",
    "log", "yaml", "yml", "toml", "ini", "rtf",
  ].includes(ext);
}

/** Basic PDF text extraction from raw bytes (no external libs) */
async function extractPdfText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let raw = "";
  const len = Math.min(bytes.length, 500_000);
  for (let i = 0; i < len; i++) {
    raw += String.fromCharCode(bytes[i]);
  }

  const parts: string[] = [];
  const btEt = /BT\s([\s\S]*?)ET/g;
  let m;
  while ((m = btEt.exec(raw)) !== null) {
    const tj = /\(([^)]*)\)/g;
    let t;
    while ((t = tj.exec(m[1])) !== null) {
      parts.push(t[1]);
    }
  }

  return parts.join(" ").replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
}

// ---- Vocab serialization (for persistence across sessions) ----

export interface VocabSnapshot {
  terms: string[];
  idf: number[];
}

export function exportVocab(): VocabSnapshot {
  const terms = new Array<string>(vocabulary.size);
  const idf = new Array<number>(vocabulary.size);
  for (const [term, idx] of vocabulary) {
    terms[idx] = term;
    idf[idx] = idfValues.get(term) || 1;
  }
  return { terms, idf };
}

export function importVocab(snapshot: VocabSnapshot): void {
  vocabulary = new Map();
  idfValues = new Map();
  for (let i = 0; i < snapshot.terms.length; i++) {
    vocabulary.set(snapshot.terms[i], i);
    idfValues.set(snapshot.terms[i], snapshot.idf[i]);
  }
}
