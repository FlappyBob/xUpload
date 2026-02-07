# xUpload — Feb 7 Improvements Changelog

## What We Built (This Sprint)

### 1. Persistent Index Storage
**Problem:** File index disappeared after closing browser — users had to re-scan every time.

**Solution:** Migrated vocabulary storage from `chrome.storage.local` to IndexedDB, which persists reliably across browser restarts. Added automatic migration from old storage format.

**Impact:** Scan once, use forever. No more re-scanning after closing Chrome.

---

### 2. Incremental File Scanning
**Problem:** Full re-scan of entire folder every time — slow and wasteful.

**Solution:** Implemented change detection by comparing `size + lastModified` of each file against the stored index. Only new/modified files are re-read and re-vectorized. Deleted files are automatically cleaned up.

**Impact:** Re-scans are near-instant when files haven't changed. Only changed files get re-processed.

---

### 3. Auto-Rescan Scheduling
**Problem:** Users had to manually trigger scans to keep the index up to date.

**Solution:** Added `chrome.alarms` based periodic re-scanning (configurable: 5min / 10min / 30min / 1hr). Runs on browser startup and on a timer. Shows a red badge "!" on the extension icon when folder permission expires.

**Impact:** Index stays fresh automatically without user intervention.

---

### 4. Upload History Tracking
**Problem:** No memory of what files were uploaded to which websites.

**Solution:** Every file upload via xUpload is tracked in IndexedDB with: file ID, website hostname, page URL, page title, context text, and timestamp. Indexed by website for fast lookup.

**Impact:** Enables history-based recommendations (see #6) and future analytics.

---

### 5. Fixed Lightning Button Positioning
**Problem:** The lightning bolt button overlapped or misaligned when pages had multiple file inputs or complex layouts.

**Solution:** Changed from `insertAdjacentElement` (DOM-relative) to fixed-position overlay on `document.body` with scroll/resize listeners for dynamic repositioning. Orphaned buttons are cleaned up automatically.

**Impact:** Buttons now appear correctly next to any file input, regardless of page layout complexity.

---

### 6. Multi-Level Recommendation Algorithm
**Problem:** Single-tier TF-IDF matching didn't leverage usage patterns or file organization.

**Solution:** Implemented a 3-signal weighted ranking system:

| Signal | Weight (with history) | Weight (no history) | Description |
|--------|----------------------|---------------------|-------------|
| TF-IDF content match | 50% | 75% | Semantic match between page context and file content |
| Upload history boost | 35% | — | Recency-weighted: files previously uploaded to this website rank higher (decays over 90 days) |
| Path/filename match | 15% | 25% | Token overlap between file path/name and upload context (e.g., "resume" folder on job sites) |

**Impact:** Recommendations get smarter over time. Frequently-used files on specific sites rise to the top.

---

### 7. "Used X times" Badge
**Problem:** Users couldn't tell which files they'd used before on a given site.

**Solution:** Added a green badge ("Used 3x here") in the recommendation panel for files with upload history on the current website.

**Impact:** Quick visual indicator helps users pick the right file faster.

---

### 8. Improved Popup UI
**Problem:** Popup only had a scan button with no status or configuration.

**Solution:** Added:
- "Last scanned: Xm ago" timestamp
- "Rescan" button for quick incremental updates (separate from full "Select folder")
- Auto-rescan toggle with interval selector
- Scan progress showing new/modified/unchanged/deleted counts

**Impact:** Users have full visibility and control over their file index.

---

## Architecture Changes

```
IndexedDB "xupload_vectors" v5
├── files          — VectorRecord (file embeddings + metadata)
├── dir_handles    — FileSystemDirectoryHandle persistence
├── vocabulary     — TF-IDF vocab snapshot (NEW)
├── upload_history — UploadHistoryEntry with websiteHost index (NEW)
└── config         — RescanConfig (auto-rescan settings) (NEW)
```

## Files Changed
| File | Changes |
|------|---------|
| `src/vectordb.ts` | +3 new stores, vocab/history/config CRUD, deleteById |
| `src/background.ts` | Multi-level ranking, history lookup, alarm scheduling |
| `src/content.ts` | Fixed positioning, upload tracking, history badge, pageUrl |
| `src/popup.ts` | Incremental scan, rescan config UI, last scan time |
| `src/types.ts` | UploadHistoryEntry, pageUrl, historyCount |
| `src/content.css` | Button positioning fix, history badge style |
| `popup.html` | Rescan button, config section, last scan display |
| `manifest.dist.json` | Added `alarms` permission |

---

## Sprint 2: Matching Quality & File Access Fixes

### 9. Seamless File Access (No More Folder Picker Popup)
**Problem:** Every time the user clicked a recommendation, the browser showed a folder picker dialog — because the in-memory `dirHandle` was lost on page navigation/refresh.

**Solution:** Added a 3-tier file access strategy in `getFile()`:
1. **In-memory handle** (fastest) — used when the user just scanned in the same tab
2. **Background service worker** — sends `GET_FILE` message to background, which reads from the IndexedDB-persisted `FileSystemDirectoryHandle`. This is the common path.
3. **Folder picker** (last resort) — only shown if both above fail (e.g. permissions expired)

**Impact:** Files load instantly without any dialog popup in the normal case.

---

### 10. Stop Word Filtering for Better Matching
**Problem:** Page context like "If you would like to add or update materials in your application..." generates tokens where 80%+ are stop words (`if`, `you`, `would`, `like`, `to`, `or`...). These meaningless tokens dilute the match score to ~1%.

**Solution:** Added a stop word list (80+ common English words) and a `tokenizeFiltered()` function that removes them before scoring. TF-IDF vocabulary building still uses all tokens (stop words have naturally low IDF), but the direct keyword matching functions now operate on meaningful words only.

**Example:** "If you would like to upload your Resume/CV for this application" → filtered to `["upload", "resume", "cv", "application"]`

---

### 11. Overlap Coefficient Scoring (Replacing Ratio-Based Scoring)
**Problem:** Previous scoring used `matches / total_tokens_in_one_side`. If the page context had 80 tokens and only 3 matched, score = 3/80 = 3.75%. The large denominator killed the signal.

**Solution:** Switched to **Overlap Coefficient**: `matches / min(|A|, |B|)`. This normalizes by the *smaller* set, so a file with 5 meaningful path tokens matching 3 context tokens scores 3/5 = 60% instead of 3/80 = 3.75%.

**Formula comparison:**
```
Old: "personal" matched in path → 1/80 context tokens = 1.25%
New: "personal" matched in path → 1/min(5 path tokens, 12 filtered context tokens) = 1/5 = 20%
```

---

### 12. Enhanced File Content Extraction
**Problem:** Images were indexed with filename only. PDFs with compressed streams returned empty text. Path structure (which carries semantic meaning like `resume/`, `tax_documents/`) was ignored.

**Solution:**
- **Path keywords**: Full file path is now tokenized and included (e.g. `personal_files/resume/cv.pdf` → `personal files resume cv pdf`)
- **Images**: Added type descriptors (`image photo picture`)
- **Office docs**: Added type descriptors (`document word`, `spreadsheet excel`, `presentation slides`)
- **PDF fallback**: When regex extraction fails, path keywords + `pdf document` are used instead of just filename
- **textPreview**: Increased from 100 → 500 characters for richer content matching

---

### 13. Duplicate Button Fix
**Problem:** Pages with both a visible `<input type="file">` and a nearby "Upload" submit button got TWO lightning buttons.

**Solution:** Custom upload button detection now skips elements whose nearby file input is already handled by the standard detection path.

---

## Scoring Architecture (Current)

```
Page Context → tokenizeFiltered() → meaningful keywords
                                         ↓
                    ┌────────────────────────────────────┐
                    │         Multi-Signal Scoring        │
                    ├────────────────────────────────────┤
                    │  Signal 1: TF-IDF cosine similarity │
                    │  Signal 2: Upload history boost     │
                    │  Signal 3: Path/name overlap coeff  │
                    │  Signal 4: Content overlap coeff    │
                    └────────────────────────────────────┘
                                         ↓
              TF-IDF useful (>5%)?
             /                    \
           YES                     NO (fallback mode)
     ┌──────────────┐      ┌──────────────────────┐
     │ TF-IDF  0.45 │      │ History    0.40       │
     │ History 0.30 │      │ Path/Name  0.35       │
     │ Path    0.15 │      │ Content    0.25       │
     │ Content 0.10 │      │ (or 50/50 w/o hist)   │
     └──────────────┘      └──────────────────────┘
```

## What's Next
- Webpage screenshot capture for richer context
- NL file descriptions via LLM
- Agentic recommendation (website + file description matching)
- Element-wise webpage analysis
