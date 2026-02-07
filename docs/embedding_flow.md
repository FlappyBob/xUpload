# File Retrieval and Embedding Flow

Complete explanation of how xUpload retrieves files from user-selected folders and converts them into searchable embedding vectors.

---

## 📁 Phase 1: Folder Selection & File Retrieval

### 1.1 User Selects Folder (Popup)

**File:** [`src/popup.ts:40-58`](../src/popup.ts#L40-L58)

```typescript
scanBtn.addEventListener("click", async () => {
  // Browser shows folder picker dialog
  const dirHandle = await (window as any).showDirectoryPicker({ mode: "read" });
  await buildIndex(dirHandle, false, workflowId);
});
```

**What happens:**
- User clicks "Select folder" button in popup
- Browser shows native **File System Access API** picker
- User grants read permission to a folder
- Extension receives a `FileSystemDirectoryHandle`

### 1.2 Recursive File Collection

**File:** [`src/popup.ts:328-343`](../src/popup.ts#L328-L343)

```typescript
async function collectFiles(
  dirHandle: FileSystemDirectoryHandle,
  basePath: string
): Promise<FileEntry[]> {
  const result: FileEntry[] = [];

  // Iterate through directory entries
  for await (const entry of (dirHandle as any).values()) {
    const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;

    if (entry.kind === "file") {
      result.push({ fileHandle: entry, path: entryPath });
    } else if (entry.kind === "directory" && !entry.name.startsWith(".")) {
      // Recursively scan subdirectories (except hidden folders)
      const sub = await collectFiles(entry, entryPath);
      result.push(...sub);
    }
  }
  return result;
}
```

**What happens:**
- Walks through directory tree recursively
- Skips hidden folders (starting with `.`)
- Collects all file handles with their relative paths
- Returns array of `{ fileHandle, path }` objects

**Example output:**
```javascript
[
  { fileHandle: ..., path: "Resume0709.pdf" },
  { fileHandle: ..., path: "documents/passport.jpg" },
  { fileHandle: ..., path: "tax/W2_2024.pdf" }
]
```

### 1.3 Save Directory Handle for Later Access

**File:** [`src/popup.ts:147`](../src/popup.ts#L147)

```typescript
await saveDirectoryHandle(dirHandle);
```

**File:** [`src/vectordb.ts:156-164`](../src/vectordb.ts#L156-L164)

```typescript
export async function saveDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, "readwrite");
    // Store the handle in IndexedDB for later file access
    tx.objectStore(HANDLE_STORE).put(handle, "main");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
```

**What happens:**
- Directory handle is persisted to **IndexedDB**
- This allows reading files later without re-selecting the folder
- Handle expires when browser restarts or permissions are revoked

---

## 📝 Phase 2: Text Extraction from Files

### 2.1 Read File and Extract Text

**File:** [`src/popup.ts:168-206`](../src/popup.ts#L168-L206)

```typescript
for (let i = 0; i < entries.length; i++) {
  const { fileHandle, path } = entries[i];

  try {
    // Get File object from handle
    const file = await fileHandle.getFile();

    // Extract searchable text content
    const text = await extractText(file, path);

    docs.push({
      path,
      name: file.name,
      type: file.type || guessType(file.name),
      size: file.size,
      lastModified: file.lastModified,
      text,  // ← This goes to embedding
    });
  } catch {
    unreadable++;
  }
}
```

### 2.2 Text Extraction Logic

**File:** [`src/embeddings.ts:109-151`](../src/embeddings.ts#L109-L151)

```typescript
export async function extractText(file: File, filePath?: string): Promise<string> {
  const name = file.name.replace(/[._-]/g, " ");
  const ext = file.name.split(".").pop()?.toLowerCase() || "";

  // Include path as keywords (e.g. "resume/cv.pdf" → "resume cv pdf")
  const pathKeywords = filePath
    ? filePath.replace(/[/\\._-]/g, " ")
    : name;

  // 📄 Text files: read full content
  if (isTextFile(ext)) {
    const text = await file.text();
    return `${pathKeywords} ${text.slice(0, 2000)}`;
  }

  // 📕 PDFs: extract text using regex
  if (ext === "pdf") {
    const text = await extractPdfText(file);
    if (text.length > 10) {
      return `${pathKeywords} ${text.slice(0, 2000)}`;
    }
    return `${pathKeywords} pdf document`;
  }

  // 🖼️ Images: use path + descriptors
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(ext)) {
    return `${pathKeywords} image photo picture`;
  }

  // 📊 Office documents: use path + type keywords
  if (["doc", "docx"].includes(ext)) return `${pathKeywords} document word`;
  if (["xls", "xlsx"].includes(ext)) return `${pathKeywords} spreadsheet excel`;
  if (["ppt", "pptx"].includes(ext)) return `${pathKeywords} presentation slides`;

  return pathKeywords;
}
```

**Example outputs:**

| File | Extracted Text |
|------|----------------|
| `resume/Resume0709.pdf` | `resume Resume0709 pdf John Doe Software Engineer 5 years experience...` |
| `photos/passport.jpg` | `photos passport jpg image photo picture` |
| `tax/W2_2024.pdf` | `tax W2 2024 pdf wages employer identification...` |
| `notes.txt` | `notes txt This is my personal note about...` |

**Key points:**
- **Path keywords** are always included (helps with semantic matching)
- **Text files**: Full content extracted (up to 2000 chars)
- **PDFs**: Regex-based extraction from raw bytes (no external lib needed)
- **Images**: Filename + generic descriptors (MVP approach)
- **Office docs**: Filename + type keywords

---

## 🧮 Phase 3: Convert Text to Embedding Vectors

xUpload supports **two embedding methods**:

### Method 1: TF-IDF (Always Available, No API Key)

**File:** [`src/popup.ts:236-276`](../src/popup.ts#L236-L276)

#### Step 3.1: Build Vocabulary

```typescript
// Tokenize all documents
const allTokens = allDocs.map((d) => tokenize(d.text));

// Build shared vocabulary from all files
buildVocabulary(allTokens);
```

**File:** [`src/embeddings.ts:52-70`](../src/embeddings.ts#L52-L70)

```typescript
export function buildVocabulary(docs: string[][]): void {
  const df: Map<string, number> = new Map();  // Document frequency
  const N = docs.length;

  // Count how many documents contain each term
  for (const doc of docs) {
    const seen = new Set(doc);
    for (const term of seen) {
      df.set(term, (df.get(term) || 0) + 1);
    }
  }

  // Assign index to each unique term
  vocabulary = new Map();
  idfValues = new Map();
  let idx = 0;
  for (const [term, count] of df) {
    vocabulary.set(term, idx++);
    // Calculate IDF: log((N + 1) / (df + 1)) + 1
    idfValues.set(term, Math.log((N + 1) / (count + 1)) + 1);
  }
}
```

**Example vocabulary:**
```javascript
{
  "resume": { index: 0, idf: 2.5 },
  "software": { index: 1, idf: 3.1 },
  "engineer": { index: 2, idf: 2.8 },
  "passport": { index: 3, idf: 4.2 },
  // ... 5000+ more terms
}
```

#### Step 3.2: Vectorize Each Document

**File:** [`src/embeddings.ts:76-105`](../src/embeddings.ts#L76-L105)

```typescript
export function vectorize(tokens: string[]): number[] {
  const dim = vocabulary.size;  // e.g., 5000 dimensions
  const vec = new Array<number>(dim).fill(0);

  // 1. Calculate term frequency (TF)
  const tf: Map<string, number> = new Map();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) || 0) + 1);
  }
  const maxTf = Math.max(...tf.values(), 1);

  // 2. Calculate TF-IDF for each term
  for (const [term, count] of tf) {
    const idx = vocabulary.get(term);
    if (idx !== undefined) {
      // TF-IDF = (TF / max_TF) * IDF
      vec[idx] = (count / maxTf) * (idfValues.get(term) || 1);
    }
  }

  // 3. L2 normalization (for cosine similarity)
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }

  return vec;
}
```

**Example vector:**
```javascript
// 5000-dimensional sparse vector (most values are 0)
[
  0,      // term 0
  0.42,   // term 1 (software) - high TF-IDF
  0.31,   // term 2 (engineer)
  0,      // term 3
  0.18,   // term 4 (experience)
  // ... 4995 more dimensions
]
```

**TF-IDF Formula:**
```
TF-IDF(term, doc) = (count_in_doc / max_count) * log((total_docs + 1) / (docs_with_term + 1))
```

**Why it works:**
- Common words (low IDF) get lower scores
- Rare words (high IDF) get higher scores
- Normalized vectors enable cosine similarity search

---

### Method 2: Gemini API Embeddings (768-dim Dense Vectors)

**When enabled:** User provides Gemini API key and selects "fast" or "vlm" mode

**File:** [`src/background.ts:518-541`](../src/background.ts#L518-L541)

```typescript
if (config.apiKey && config.mode !== "tfidf") {
  // Call Gemini API to get dense embeddings
  const texts = files.map((f) => f.text.slice(0, 2000));
  const vectors = await batchEmbed(texts, config.apiKey, 10);
  denseVectors = vectors;
}
```

**File:** [`src/apiEmbeddings.ts:34-57`](../src/apiEmbeddings.ts#L34-L57)

```typescript
export async function batchEmbed(
  texts: string[],
  apiKey: string,
  batchSize = 10,
): Promise<number[][]> {
  const results: number[][] = [];

  // Process in batches to respect rate limits
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    // Send parallel requests for batch
    const embeddings = await Promise.all(
      batch.map((t) => getEmbedding(t, apiKey))
    );

    results.push(...embeddings);

    // Delay between batches (rate limiting)
    if (i + batchSize < texts.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return results;
}
```

**File:** [`src/apiEmbeddings.ts:12-28`](../src/apiEmbeddings.ts#L12-L28)

```typescript
export async function getEmbedding(text: string, apiKey: string): Promise<number[]> {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: { parts: [{ text: text.slice(0, 8000) }] },
      }),
    }
  );

  const data = await resp.json();
  return data.embedding.values as number[];  // 768 dimensions
}
```

**Example Gemini vector:**
```javascript
// 768-dimensional dense vector (all values non-zero)
[
  0.0234,
  -0.0891,
  0.1456,
  0.0023,
  -0.0567,
  // ... 763 more dimensions
]
```

**Comparison:**

| Feature | TF-IDF | Gemini API |
|---------|--------|------------|
| **Dimensions** | 5000+ (sparse) | 768 (dense) |
| **Cost** | Free | Free tier: 1500 req/min |
| **Quality** | Keyword matching | Semantic understanding |
| **Speed** | Instant (local) | ~100ms per file |
| **Example** | "passport" matches "passport.jpg" | "ID document" matches "passport.jpg" |

---

## 💾 Phase 4: Store in Vector Database

**File:** [`src/popup.ts:249-267`](../src/popup.ts#L249-L267)

```typescript
for (let i = 0; i < docs.length; i++) {
  const d = docs[i];
  const vec = vectorize(allTokens[i]);  // TF-IDF vector

  const record: VectorRecord = {
    id: d.path,                  // Unique identifier
    name: d.name,                // "Resume0709.pdf"
    path: d.path,                // "resume/Resume0709.pdf"
    type: d.type,                // "application/pdf"
    size: d.size,                // 102400 bytes
    lastModified: d.lastModified,
    vector: vec,                 // TF-IDF embedding
    denseVector: denseVectors[i], // Gemini embedding (optional)
    textPreview: d.text.slice(0, 500),
  };

  await upsert(record);  // Save to IndexedDB
}
```

**File:** [`src/vectordb.ts:59-67`](../src/vectordb.ts#L59-L67)

```typescript
export async function upsert(record: VectorRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);  // IndexedDB storage
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
```

**IndexedDB Structure:**

```
Database: xupload_vectors
  ObjectStore: files
    Key: "resume/Resume0709.pdf"
    Value: {
      id: "resume/Resume0709.pdf",
      name: "Resume0709.pdf",
      path: "resume/Resume0709.pdf",
      type: "application/pdf",
      size: 102400,
      lastModified: 1707340800000,
      vector: [0, 0.42, 0.31, ...],      // 5000-dim TF-IDF
      denseVector: [0.023, -0.089, ...], // 768-dim Gemini (optional)
      textPreview: "resume Resume0709 pdf John Doe..."
    }
```

---

## 🔍 Phase 5: Later Retrieval for Matching

### 5.1 User Hovers Over File Input

**File:** [`src/content.ts:522-596`](../src/content.ts#L522-L596)

```typescript
async function fetchRecommendations(target: UploadTarget): Promise<MatchResultItem[]> {
  // Extract context: "Please upload your resume"
  const context = target.context;

  // Send to background for matching
  const msg: MatchRequest = {
    type: "MATCH_REQUEST",
    context: context,
    accept: target.accept,  // e.g., ".pdf,.doc"
    pageUrl: window.location.href,
  };

  const resp: MatchResponse = await chrome.runtime.sendMessage(msg);
  return resp.results;
}
```

### 5.2 TF-IDF Search

**File:** [`src/background.ts:186-221`](../src/background.ts#L186-L221)

```typescript
// 1. Vectorize query text
const queryTokens = tokenize(req.context);  // ["please", "upload", "resume"]
const queryVec = vectorize(queryTokens);    // [0, 0, 0.5, 0.3, ...]

// 2. Search vector database
const tfidfResults = await search(queryVec, 15, req.accept);
```

**File:** [`src/vectordb.ts:125-153`](../src/vectordb.ts#L125-L153)

```typescript
export async function search(
  queryVector: number[],
  topN: number = 5,
  acceptFilter?: string
): Promise<SearchResult[]> {
  const all = await getAll();  // Load all vectors from IndexedDB

  // Calculate cosine similarity with each file
  return all
    .map((record) => ({
      record,
      score: cosine(queryVector, record.vector)  // ← Similarity calculation
    }))
    .sort((a, b) => b.score - a.score)  // Sort by score descending
    .slice(0, topN)                     // Top N results
    .filter((r) => r.score > 0);        // Remove zero scores
}
```

**File:** [`src/vectordb.ts:109-118`](../src/vectordb.ts#L109-L118)

```typescript
function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;

  // Dot product
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;

  // Cosine similarity: dot(a,b) / (||a|| * ||b||)
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

**Cosine Similarity:**
```
cos(a, b) = (a · b) / (||a|| × ||b||)

Range: 0.0 to 1.0
- 0.0 = completely different
- 1.0 = identical vectors
```

**Example search:**
```javascript
Query: "Please upload your resume"
Query vector: [0, 0.5, 0.3, 0.2, ...]

Results:
1. resume/Resume0709.pdf - 0.87 (87% match)
2. cv/CV_2024.pdf       - 0.82 (82% match)
3. docs/profile.docx    - 0.45 (45% match)
```

### 5.3 Gemini Dense Search (Optional)

**File:** [`src/background.ts:413-425`](../src/background.ts#L413-L425)

```typescript
if (config.apiKey && config.mode !== "tfidf") {
  // Get query embedding from Gemini
  const queryVec = await getEmbedding(queryText, config.apiKey);

  // Search using dense vectors
  const results = await denseSearch(queryVec, 5, req.accept);
}
```

**File:** [`src/vectordb.ts:329-360`](../src/vectordb.ts#L329-L360)

```typescript
export async function denseSearch(
  queryVector: number[],
  topN: number = 5,
  acceptFilter?: string
): Promise<SearchResult[]> {
  const all = await getAll();

  // Only use records with Gemini embeddings
  let candidates = all.filter((r) => r.denseVector && r.denseVector.length > 0);

  return candidates
    .map((record) => ({
      record,
      score: cosine(queryVector, record.denseVector!)  // 768-dim comparison
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}
```

---

## 🎯 Complete Flow Diagram

```
┌──────────────────────────────────────────────────────────────┐
│ 1. USER ACTION                                               │
│    Click "Select folder" → Browser shows picker             │
└────────────────────┬─────────────────────────────────────────┘
                     ↓
┌──────────────────────────────────────────────────────────────┐
│ 2. FILE COLLECTION                                           │
│    • Walk directory tree recursively                         │
│    • Collect FileSystemFileHandle for each file              │
│    • Result: [{fileHandle, path}, ...]                       │
└────────────────────┬─────────────────────────────────────────┘
                     ↓
┌──────────────────────────────────────────────────────────────┐
│ 3. TEXT EXTRACTION                                           │
│    For each file:                                            │
│    • Read file: fileHandle.getFile()                         │
│    • Extract text based on type:                             │
│      - PDFs: Regex extraction from bytes                     │
│      - Text files: file.text()                               │
│      - Images: filename + "image photo"                      │
│      - Office: filename + type keywords                      │
│    • Result: "resume Resume0709 pdf John Doe engineer..."    │
└────────────────────┬─────────────────────────────────────────┘
                     ↓
┌──────────────────────────────────────────────────────────────┐
│ 4A. TF-IDF EMBEDDING (Always)                                │
│    • Tokenize all texts: ["resume", "engineer", ...]         │
│    • Build vocabulary: Map each unique term to index         │
│    • Calculate IDF: log((N+1)/(df+1))                        │
│    • Vectorize: TF/maxTF * IDF → normalize                   │
│    • Result: 5000-dim sparse vector [0, 0.42, 0.31, ...]     │
└────────────────────┬─────────────────────────────────────────┘
                     ↓
┌──────────────────────────────────────────────────────────────┐
│ 4B. GEMINI EMBEDDING (If API key provided)                   │
│    • Send text to Gemini text-embedding-004                  │
│    • Batch requests (10 at a time, 200ms delay)              │
│    • Result: 768-dim dense vector [0.023, -0.089, ...]       │
└────────────────────┬─────────────────────────────────────────┘
                     ↓
┌──────────────────────────────────────────────────────────────┐
│ 5. STORAGE (IndexedDB)                                       │
│    For each file:                                            │
│    • Store VectorRecord {                                    │
│        id, name, path, type, size, lastModified,             │
│        vector: [TF-IDF],                                     │
│        denseVector: [Gemini],  // optional                   │
│        textPreview: "first 500 chars..."                     │
│      }                                                        │
│    • Also store:                                             │
│      - Directory handle (for later file access)              │
│      - Vocabulary (for query vectorization)                  │
└────────────────────┬─────────────────────────────────────────┘
                     ↓
┌──────────────────────────────────────────────────────────────┐
│ 6. LATER: MATCHING (When user hovers upload zone)           │
│    • Extract page context: "Please upload resume"            │
│    • Vectorize query using same vocabulary                   │
│    • Calculate cosine similarity with all stored vectors     │
│    • Return top 5 matches sorted by score                    │
│    • Display in popup with similarity %                      │
└──────────────────────────────────────────────────────────────┘
```

---

## 🔑 Key Technical Insights

### 1. **Why Store Vectors Instead of Just File Paths?**
- **Fast search**: Vector similarity is O(n) scan, but n is small (<1000 files typically)
- **Semantic matching**: "resume" query matches "CV.pdf" even without exact keyword
- **No network**: Everything runs locally in browser

### 2. **Why TF-IDF + Gemini Hybrid?**
- **TF-IDF**: Free, instant, works offline, good for keyword matching
- **Gemini**: Better semantic understanding ("ID document" → passport), but costs API calls
- **Best of both**: Use TF-IDF as fallback, Gemini for enhanced matching

### 3. **Why Sparse vs Dense Vectors?**
- **TF-IDF sparse**: Most dimensions are 0 (only terms that appear in doc)
- **Gemini dense**: All 768 dimensions have values (learned semantic representation)
- **Storage**: Both are efficient with IndexedDB's binary serialization

### 4. **Why Cosine Similarity?**
- **Scale-invariant**: Document length doesn't affect similarity
- **Efficient**: Single O(n) scan through vocabulary dimensions
- **Interpretable**: 0.0 (unrelated) to 1.0 (identical)

### 5. **Limitations & Trade-offs**
- **PDF extraction**: Regex-based, doesn't handle all PDF formats (no external libs)
- **Image content**: Only uses filename/path (no vision embeddings in MVP)
- **File access**: Requires periodic re-authorization (browser security)
- **Scale**: TF-IDF vocabulary grows with corpus (5000-10000 terms typical)

---

## 📊 Performance Characteristics

| Operation | Time Complexity | Typical Time |
|-----------|----------------|--------------|
| File collection | O(files in folder) | 100ms - 1s |
| Text extraction | O(file size) | 10-100ms per file |
| TF-IDF vectorization | O(terms in doc × vocab size) | <1ms per file |
| Gemini embedding | API latency | ~100ms per file |
| IndexedDB storage | O(1) per record | <1ms per file |
| Vector search | O(num files × vector dim) | 10-50ms for 1000 files |

**Total indexing time:**
- 100 files, TF-IDF only: ~5-10 seconds
- 100 files, with Gemini: ~20-30 seconds (limited by API rate)

**Search latency:**
- TF-IDF: <50ms
- Gemini: ~150ms (includes API call for query embedding)

---

## 🛠️ Code References

| Component | File | Purpose |
|-----------|------|---------|
| Folder picker | [`popup.ts:40-58`](../src/popup.ts#L40-L58) | File System Access API |
| File collection | [`popup.ts:328-343`](../src/popup.ts#L328-L343) | Recursive directory scan |
| Text extraction | [`embeddings.ts:109-151`](../src/embeddings.ts#L109-L151) | PDF, text, image processing |
| TF-IDF vocabulary | [`embeddings.ts:52-70`](../src/embeddings.ts#L52-L70) | Build term → index map |
| TF-IDF vectorization | [`embeddings.ts:76-105`](../src/embeddings.ts#L76-L105) | Text → sparse vector |
| Gemini embedding | [`apiEmbeddings.ts:12-28`](../src/apiEmbeddings.ts#L12-L28) | Text → dense vector |
| Vector storage | [`vectordb.ts:59-67`](../src/vectordb.ts#L59-L67) | IndexedDB persistence |
| Cosine search | [`vectordb.ts:109-153`](../src/vectordb.ts#L109-L153) | Similarity matching |

---

## 🎓 Further Reading

- [TF-IDF Explanation](https://en.wikipedia.org/wiki/Tf%E2%80%93idf)
- [Cosine Similarity](https://en.wikipedia.org/wiki/Cosine_similarity)
- [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API)
- [Gemini Embedding Model](https://ai.google.dev/gemini-api/docs/embeddings)
- [IndexedDB Guide](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
