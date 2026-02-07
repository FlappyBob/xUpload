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

## What's Next
- Webpage screenshot capture for richer context
- NL file descriptions via LLM
- Agentic recommendation (website + file description matching)
- Element-wise webpage analysis
