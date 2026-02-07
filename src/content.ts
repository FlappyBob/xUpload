import type { MatchRequest, MatchResponse, MatchResultItem } from "./types";

const BUTTON_CLASS = "xupload-btn";
const PANEL_CLASS = "xupload-panel";

const processed = new WeakSet<Element>();

// Upload-related keywords for detecting custom upload buttons
const UPLOAD_KEYWORDS = /upload|browse|choose file|select file|上传|选择文件|附件|attach/i;

// Module-level directory handle for on-demand file reading
let dirHandle: FileSystemDirectoryHandle | null = null;

// ---- Detection: find all upload targets ----

interface UploadTarget {
  /** The element we attach the ⚡ button next to */
  anchor: HTMLElement;
  /** The actual <input type="file"> to fill (may be hidden) */
  fileInput: HTMLInputElement | null;
  /** Context text for matching */
  context: string;
  /** Accept filter from the input */
  accept?: string;
}

function findUploadTargets(): UploadTarget[] {
  const targets: UploadTarget[] = [];

  // 1. Standard visible <input type="file">
  document.querySelectorAll<HTMLInputElement>('input[type="file"]').forEach((input) => {
    if (processed.has(input)) return;
    // If the input is visible, use it directly
    if (isVisible(input)) {
      targets.push({
        anchor: input,
        fileInput: input,
        context: extractContext(input),
        accept: input.accept || undefined,
      });
    }
  });

  // 2. Custom upload buttons: buttons/links with upload text that trigger hidden file inputs
  const buttons = document.querySelectorAll<HTMLElement>(
    'button, a, [role="button"], label[for], .upload-btn, [class*="upload"], [class*="Upload"]'
  );
  buttons.forEach((btn) => {
    if (processed.has(btn)) return;
    const text = btn.textContent || "";
    if (!UPLOAD_KEYWORDS.test(text)) return;
    // Skip if we already processed this area
    if (btn.querySelector(`.${BUTTON_CLASS}`)) return;
    if (btn.closest(`.${PANEL_CLASS}`)) return;

    // Try to find a nearby hidden file input
    const fileInput = findNearbyFileInput(btn);

    targets.push({
      anchor: btn,
      fileInput,
      context: extractContextFromElement(btn),
      accept: fileInput?.accept || undefined,
    });
  });

  return targets;
}

function isVisible(el: HTMLElement): boolean {
  const style = getComputedStyle(el);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    el.offsetWidth > 0 &&
    el.offsetHeight > 0
  );
}

/** Look for a hidden <input type="file"> near a custom button */
function findNearbyFileInput(btn: HTMLElement): HTMLInputElement | null {
  // Check inside the button itself
  const inside = btn.querySelector<HTMLInputElement>('input[type="file"]');
  if (inside) return inside;

  // Check siblings
  const parent = btn.parentElement;
  if (parent) {
    const sibling = parent.querySelector<HTMLInputElement>('input[type="file"]');
    if (sibling) return sibling;
  }

  // Check up to 3 ancestor levels
  let ancestor: HTMLElement | null = btn;
  for (let i = 0; i < 3 && ancestor; i++) {
    ancestor = ancestor.parentElement;
    if (ancestor) {
      const found = ancestor.querySelector<HTMLInputElement>('input[type="file"]');
      if (found) return found;
    }
  }

  return null;
}

// ---- Context extraction ----

function extractContext(input: HTMLInputElement): string {
  const parts: string[] = [];

  if (input.id) {
    const label = document.querySelector(`label[for="${input.id}"]`);
    if (label) parts.push(label.textContent || "");
  }
  const parentLabel = input.closest("label");
  if (parentLabel) parts.push(parentLabel.textContent || "");

  if (input.placeholder) parts.push(input.placeholder);
  if (input.title) parts.push(input.title);
  const ariaLabel = input.getAttribute("aria-label");
  if (ariaLabel) parts.push(ariaLabel);

  // Walk up to find surrounding text
  const container =
    input.closest("[class*='upload'], [class*='Upload'], div, fieldset, section, td, li") ||
    input.parentElement;
  if (container) {
    parts.push((container.textContent || "").slice(0, 300));
  }

  return parts.join(" ").trim();
}

function extractContextFromElement(el: HTMLElement): string {
  const parts: string[] = [];

  parts.push(el.textContent || "");

  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) parts.push(ariaLabel);

  // Get surrounding container text (e.g. "Upload your resume to see how it matches...")
  const container =
    el.closest("[class*='upload'], [class*='Upload'], div, fieldset, section, td, li") ||
    el.parentElement;
  if (container) {
    parts.push((container.textContent || "").slice(0, 300));
  }

  return parts.join(" ").trim();
}

// ---- Button injection ----

function createButton(target: UploadTarget): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BUTTON_CLASS;
  btn.textContent = "\u26A1";
  btn.title = "xUpload: Smart file recommendation";

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleRecommend(target, btn);
  });

  return btn;
}

// ---- Folder scanning (inline, no popup needed) ----

async function collectFiles(
  handle: FileSystemDirectoryHandle,
  basePath: string
): Promise<{ fileHandle: FileSystemFileHandle; path: string }[]> {
  const result: { fileHandle: FileSystemFileHandle; path: string }[] = [];
  for await (const entry of (handle as any).values()) {
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

// ---- Inline text extraction (avoids cross-entry import) ----

const TEXT_EXTS = [
  "txt", "md", "csv", "json", "xml", "html", "htm",
  "js", "ts", "py", "java", "c", "cpp", "css",
  "log", "yaml", "yml", "toml", "ini", "rtf",
];

async function extractFileText(file: File): Promise<string> {
  const name = file.name.replace(/[._-]/g, " ");
  const ext = file.name.split(".").pop()?.toLowerCase() || "";

  if (TEXT_EXTS.includes(ext)) {
    try {
      const text = await file.text();
      return `${name} ${text.slice(0, 2000)}`;
    } catch {
      return name;
    }
  }

  if (ext === "pdf") {
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let raw = "";
      const len = Math.min(bytes.length, 500_000);
      for (let i = 0; i < len; i++) raw += String.fromCharCode(bytes[i]);

      const parts: string[] = [];
      const btEt = /BT\s([\s\S]*?)ET/g;
      let m;
      while ((m = btEt.exec(raw)) !== null) {
        const tj = /\(([^)]*)\)/g;
        let t;
        while ((t = tj.exec(m[1])) !== null) parts.push(t[1]);
      }
      const pdfText = parts.join(" ").replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
      return `${name} ${pdfText.slice(0, 2000)}`;
    } catch {
      return name;
    }
  }

  return name;
}

// ---- Folder scanning ----

async function scanFolder(statusEl?: HTMLElement): Promise<boolean> {
  try {
    dirHandle = await (window as any).showDirectoryPicker({ mode: "read" });
  } catch (err: any) {
    if (err.name === "AbortError") return false;
    console.error("[xUpload] Folder picker error:", err);
    return false;
  }
  if (!dirHandle) return false;

  if (statusEl) statusEl.textContent = "Scanning files...";

  const entries = await collectFiles(dirHandle, "");
  if (statusEl) statusEl.textContent = `Found ${entries.length} files. Reading...`;

  const files: { path: string; name: string; type: string; size: number; lastModified: number; text: string }[] = [];

  for (let i = 0; i < entries.length; i++) {
    const { fileHandle, path } = entries[i];
    try {
      const file = await fileHandle.getFile();
      const text = await extractFileText(file);
      files.push({
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
    if (i % 10 === 0 && statusEl) {
      statusEl.textContent = `Reading files... ${i + 1}/${entries.length}`;
    }
  }

  if (statusEl) statusEl.textContent = "Building index...";

  const resp = await chrome.runtime.sendMessage({ type: "BUILD_INDEX", files });
  console.log("[xUpload] Index built:", resp);

  if (statusEl) statusEl.textContent = `Done! ${resp?.count || files.length} files indexed.`;
  return true;
}

// ---- Recommendation flow ----

async function handleRecommend(target: UploadTarget, btn: HTMLButtonElement) {
  document.querySelectorAll(`.${PANEL_CLASS}`).forEach((el) => el.remove());

  console.log("[xUpload] ⚡ clicked! Context:", target.context.slice(0, 100));

  try {
    // Check if we have an index
    const countResp = await chrome.runtime.sendMessage({ type: "GET_INDEX_COUNT" });

    if (!countResp?.count || countResp.count === 0) {
      // No index — show scan prompt
      showScanPanel(btn, target);
      return;
    }

    // We have an index — proceed with matching
    await doMatch(btn, target);
  } catch (err: any) {
    console.error("[xUpload] Error:", err);
    const msg = err?.message?.includes("Extension context invalidated")
      ? "Extension was updated. Please refresh this page."
      : "Error getting recommendations.";
    showPanel(btn, target, [], msg);
  }
}

function showScanPanel(anchor: HTMLElement, target: UploadTarget) {
  const panel = document.createElement("div");
  panel.className = PANEL_CLASS;

  const header = document.createElement("div");
  header.className = "xupload-header";
  header.textContent = "\u26A1 xUpload";
  panel.appendChild(header);

  const statusDiv = document.createElement("div");
  statusDiv.className = "xupload-empty";
  statusDiv.textContent = "No files indexed yet.";
  panel.appendChild(statusDiv);

  const scanBtn = document.createElement("button");
  scanBtn.type = "button";
  scanBtn.className = "xupload-scan-btn";
  scanBtn.textContent = "Select folder to scan";
  scanBtn.style.cssText = "display:block;width:100%;margin-top:8px;padding:8px 12px;background:#4285f4;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;";
  scanBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    scanBtn.disabled = true;
    scanBtn.textContent = "Scanning...";

    const ok = await scanFolder(statusDiv);
    if (ok) {
      panel.remove();
      // Now do the match
      await doMatch(anchor, target);
    } else {
      scanBtn.disabled = false;
      scanBtn.textContent = "Select folder to scan";
      statusDiv.textContent = "Scan cancelled. Try again.";
    }
  });
  panel.appendChild(scanBtn);

  // Close on outside click
  const closeHandler = (e: MouseEvent) => {
    if (!panel.contains(e.target as Node)) {
      panel.remove();
      document.removeEventListener("click", closeHandler);
    }
  };
  setTimeout(() => document.addEventListener("click", closeHandler), 0);

  const rect = anchor.getBoundingClientRect();
  panel.style.position = "fixed";
  panel.style.top = `${rect.bottom + 4}px`;
  panel.style.left = `${rect.left}px`;
  document.body.appendChild(panel);
}

async function doMatch(anchor: HTMLElement, target: UploadTarget) {
  const msg: MatchRequest = {
    type: "MATCH_REQUEST",
    context: target.context,
    accept: target.accept,
    pageUrl: window.location.href,
  };

  const resp: MatchResponse = await chrome.runtime.sendMessage(msg);
  console.log("[xUpload] Response:", resp);

  if (!resp?.results?.length) {
    showPanel(anchor, target, [], "No matching files found.");
    return;
  }

  console.log("[xUpload] Showing", resp.results.length, "results");
  showPanel(anchor, target, resp.results);
}

// ---- Recommendation panel ----

function showPanel(
  anchor: HTMLElement,
  target: UploadTarget,
  results: MatchResultItem[],
  emptyMsg?: string
) {
  const panel = document.createElement("div");
  panel.className = PANEL_CLASS;

  // Header
  const header = document.createElement("div");
  header.className = "xupload-header";
  header.textContent = results.length > 0
    ? `\u26A1 ${results.length} files recommended`
    : "\u26A1 xUpload";
  panel.appendChild(header);

  if (results.length === 0) {
    const div = document.createElement("div");
    div.className = "xupload-empty";
    div.textContent = emptyMsg || "No results";
    panel.appendChild(div);
  } else {
    const list = document.createElement("ul");
    for (const r of results) {
      const li = document.createElement("li");
      li.className = "xupload-item";

      // File icon based on type
      const icon = document.createElement("span");
      icon.className = "xupload-icon";
      icon.textContent = getFileIcon(r.type, r.name);

      const info = document.createElement("div");
      info.className = "xupload-info";

      const nameSpan = document.createElement("span");
      nameSpan.className = "xupload-name";
      nameSpan.textContent = r.name;

      const pathSpan = document.createElement("span");
      pathSpan.className = "xupload-path";
      pathSpan.textContent = r.path;

      info.appendChild(nameSpan);
      info.appendChild(pathSpan);

      // Show history badge if file was previously uploaded to this site
      if (r.historyCount && r.historyCount > 0) {
        const badge = document.createElement("span");
        badge.className = "xupload-history-badge";
        badge.textContent = `Used ${r.historyCount}x here`;
        info.appendChild(badge);
      }

      const scoreSpan = document.createElement("span");
      scoreSpan.className = "xupload-score";
      const pct = Math.round(r.score * 100);
      scoreSpan.textContent = `${pct}%`;

      li.appendChild(icon);
      li.appendChild(info);
      li.appendChild(scoreSpan);
      li.title = `Click to select: ${r.name}`;

      li.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        scoreSpan.textContent = "...";
        li.classList.add("xupload-loading");

        // Read the file for preview
        const file = await getFile(r.id);
        li.classList.remove("xupload-loading");
        scoreSpan.textContent = `${pct}%`;

        if (!file) {
          scoreSpan.textContent = "Error";
          scoreSpan.style.color = "#ea4335";
          return;
        }

        // Show preview — on confirm, fill the input
        panel.remove();
        showPreview(anchor, target, file, r);
      });

      list.appendChild(li);
    }
    panel.appendChild(list);
  }

  // Close on outside click
  const closeHandler = (e: MouseEvent) => {
    if (!panel.contains(e.target as Node)) {
      panel.remove();
      document.removeEventListener("click", closeHandler);
    }
  };
  setTimeout(() => document.addEventListener("click", closeHandler), 0);

  // Position: append to body with absolute positioning near the anchor
  const rect = anchor.getBoundingClientRect();
  panel.style.position = "fixed";
  panel.style.top = `${rect.bottom + 4}px`;
  panel.style.left = `${rect.left}px`;
  document.body.appendChild(panel);
}

function getFileIcon(type: string, name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (ext === "pdf" || type === "application/pdf") return "\uD83D\uDCC4";
  if (["doc", "docx"].includes(ext)) return "\uD83D\uDCC3";
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "\uD83D\uDDBC\uFE0F";
  if (["xls", "xlsx", "csv"].includes(ext)) return "\uD83D\uDCCA";
  return "\uD83D\uDCC1";
}

// ---- File preview ----

const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"];

function getFileExt(name: string): string {
  return name.split(".").pop()?.toLowerCase() || "";
}

/** Read a file (with folder re-selection fallback) */
async function getFile(fileId: string): Promise<File | null> {
  let file = await readFileFromHandle(fileId);
  if (!file) {
    try {
      dirHandle = await (window as any).showDirectoryPicker({ mode: "read" });
      if (dirHandle) file = await readFileFromHandle(fileId);
    } catch (err: any) {
      if (err.name !== "AbortError") console.error("[xUpload] Folder picker error:", err);
    }
  }
  return file;
}

function showPreview(
  anchor: HTMLElement,
  target: UploadTarget,
  file: File,
  result: MatchResultItem
) {
  document.querySelectorAll(`.${PANEL_CLASS}`).forEach((el) => el.remove());

  const panel = document.createElement("div");
  panel.className = PANEL_CLASS + " xupload-preview";

  // Header with file name
  const header = document.createElement("div");
  header.className = "xupload-header";
  header.innerHTML = "";
  const headerIcon = document.createElement("span");
  headerIcon.textContent = getFileIcon(result.type, result.name);
  headerIcon.style.marginRight = "6px";
  const headerText = document.createElement("span");
  headerText.textContent = result.name;
  header.appendChild(headerIcon);
  header.appendChild(headerText);
  panel.appendChild(header);

  // Preview content area
  const previewArea = document.createElement("div");
  previewArea.className = "xupload-preview-content";
  panel.appendChild(previewArea);

  const ext = getFileExt(file.name);
  const blobUrl = URL.createObjectURL(file);

  if (IMAGE_EXTS.includes(ext)) {
    // Image preview
    const img = document.createElement("img");
    img.src = blobUrl;
    img.className = "xupload-preview-img";
    img.alt = file.name;
    previewArea.appendChild(img);
  } else if (ext === "pdf") {
    // PDF preview
    const embed = document.createElement("embed");
    embed.src = blobUrl;
    embed.type = "application/pdf";
    embed.className = "xupload-preview-pdf";
    previewArea.appendChild(embed);
  } else if (TEXT_EXTS.includes(ext)) {
    // Text preview
    const pre = document.createElement("pre");
    pre.className = "xupload-preview-text";
    file.text().then((text) => {
      pre.textContent = text.slice(0, 5000);
      if (text.length > 5000) pre.textContent += "\n\n... (truncated)";
    });
    previewArea.appendChild(pre);
  } else {
    // Unknown type — show basic info
    const info = document.createElement("div");
    info.className = "xupload-preview-info";
    info.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    previewArea.appendChild(info);
  }

  // Action buttons
  const actions = document.createElement("div");
  actions.className = "xupload-preview-actions";

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "xupload-preview-btn xupload-preview-back";
  backBtn.textContent = "Back";
  backBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    URL.revokeObjectURL(blobUrl);
    panel.remove();
    // Re-show the recommendation list
    doMatch(anchor, target);
  });

  const useBtn = document.createElement("button");
  useBtn.type = "button";
  useBtn.className = "xupload-preview-btn xupload-preview-use";
  useBtn.textContent = "Use this file";
  useBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    useBtn.disabled = true;
    useBtn.textContent = "Filling...";

    const success = await fillFileWithObj(target, file);
    URL.revokeObjectURL(blobUrl);

    if (success) {
      useBtn.textContent = "\u2713 Done";
      useBtn.classList.add("xupload-preview-done");
      setTimeout(() => panel.remove(), 600);

      // Track upload history
      try {
        chrome.runtime.sendMessage({
          type: "TRACK_UPLOAD",
          entry: {
            fileId: result.id,
            fileName: result.name,
            fileType: result.type,
            websiteHost: new URL(window.location.href).hostname,
            pageUrl: window.location.href,
            pageTitle: document.title,
            uploadContext: target.context.slice(0, 200),
            timestamp: Date.now(),
          },
        });
      } catch { /* non-critical */ }
    } else {
      useBtn.textContent = "Error";
      useBtn.disabled = false;
    }
  });

  actions.appendChild(backBtn);
  actions.appendChild(useBtn);
  panel.appendChild(actions);

  // Close on outside click
  const closeHandler = (e: MouseEvent) => {
    if (!panel.contains(e.target as Node)) {
      URL.revokeObjectURL(blobUrl);
      panel.remove();
      document.removeEventListener("click", closeHandler);
    }
  };
  setTimeout(() => document.addEventListener("click", closeHandler), 0);

  // Position
  const rect = anchor.getBoundingClientRect();
  panel.style.position = "fixed";
  panel.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 500)}px`;
  panel.style.left = `${rect.left}px`;
  document.body.appendChild(panel);
}

/** Fill file input with an already-loaded File object */
function fillFileWithObj(target: UploadTarget, file: File): boolean {
  try {
    if (target.fileInput) {
      setFileInput(target.fileInput, file);
      return true;
    }
    const fileInput = findNearbyFileInput(target.anchor);
    if (fileInput) {
      setFileInput(fileInput, file);
      return true;
    }
    // Simulate drop
    const dropTarget = target.anchor.closest("[class*='upload'], [class*='Upload'], [class*='drop']") || target.anchor;
    const dt = new DataTransfer();
    dt.items.add(file);
    dropTarget.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    return true;
  } catch (err) {
    console.error("[xUpload] Fill error:", err);
    return false;
  }
}

// ---- File fill ----

/** Read a file from the in-memory directory handle by its relative path */
async function readFileFromHandle(filePath: string): Promise<File | null> {
  if (!dirHandle) return null;

  try {
    const parts = filePath.split("/");
    let currentDir: FileSystemDirectoryHandle = dirHandle;
    for (let i = 0; i < parts.length - 1; i++) {
      currentDir = await currentDir.getDirectoryHandle(parts[i]);
    }
    const fileHandle = await currentDir.getFileHandle(parts[parts.length - 1]);
    return await fileHandle.getFile();
  } catch (err) {
    console.error("[xUpload] Failed to read file from handle:", err);
    return null;
  }
}

function setFileInput(input: HTMLInputElement, file: File) {
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function fillFile(target: UploadTarget, fileId: string, fileName: string, fileType: string): Promise<boolean> {
  try {
    // Strategy A: Read from in-memory directory handle (preferred)
    let file = await readFileFromHandle(fileId);

    // Strategy B: No handle — ask user to re-select the folder
    if (!file) {
      console.log("[xUpload] No handle, asking user to select folder");
      try {
        dirHandle = await (window as any).showDirectoryPicker({ mode: "read" });
        if (dirHandle) {
          file = await readFileFromHandle(fileId);
        }
      } catch (err: any) {
        if (err.name !== "AbortError") {
          console.error("[xUpload] Folder picker error:", err);
        }
      }
    }

    if (!file) {
      console.error("[xUpload] Could not read file:", fileId);
      return false;
    }

    // Fill the file input
    if (target.fileInput) {
      setFileInput(target.fileInput, file);
      return true;
    }

    const fileInput = findNearbyFileInput(target.anchor);
    if (fileInput) {
      setFileInput(fileInput, file);
      return true;
    }

    // Simulate drop event
    const dropTarget = target.anchor.closest("[class*='upload'], [class*='Upload'], [class*='drop']") || target.anchor;
    const dtObj = new DataTransfer();
    dtObj.items.add(file);
    const dropEvent = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: dtObj,
    });
    dropTarget.dispatchEvent(dropEvent);
    return true;
  } catch (err) {
    console.error("[xUpload] Fill error:", err);
    return false;
  }
}

// ---- Scan and inject ----

/** Map from button to its target for repositioning */
const buttonTargets = new Map<HTMLButtonElement, UploadTarget>();

function positionButton(btn: HTMLButtonElement, anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  // Skip if anchor is not visible / has no dimensions
  if (rect.width === 0 && rect.height === 0) return;
  btn.style.position = "fixed";
  btn.style.top = `${rect.top + (rect.height - 28) / 2}px`;
  btn.style.left = `${rect.right + 4}px`;
}

function repositionAllButtons() {
  for (const [btn, target] of buttonTargets) {
    if (!document.body.contains(target.anchor)) {
      btn.remove();
      buttonTargets.delete(btn);
      continue;
    }
    positionButton(btn, target.anchor);
  }
}

function scanAndInject() {
  const targets = findUploadTargets();
  for (const target of targets) {
    if (processed.has(target.anchor)) continue;
    processed.add(target.anchor);

    const btn = createButton(target);
    btn.style.zIndex = "2147483646";
    document.body.appendChild(btn);
    positionButton(btn, target.anchor);
    buttonTargets.set(btn, target);
  }
}

scanAndInject();

const observer = new MutationObserver(() => scanAndInject());
observer.observe(document.body, { childList: true, subtree: true });

// Reposition buttons on scroll/resize
window.addEventListener("scroll", repositionAllButtons, { passive: true });
window.addEventListener("resize", repositionAllButtons, { passive: true });
