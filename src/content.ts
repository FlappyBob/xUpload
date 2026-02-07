import type {
  MatchRequest,
  MatchRequestEnhanced,
  MatchResponse,
  MatchResultItem,
  XUploadConfig,
} from "./types";
import {
  createWorkflowId,
  logWorkflowError,
  logWorkflowStep,
} from "./workflow";

/* ================================================================== */
/*  Constants                                                          */
/* ================================================================== */

const ZONE_CLASS = "xupload-zone";
const PANEL_CLASS = "xupload-panel";
const BADGE_CLASS = "xupload-badge";

/* ================================================================== */
/*  Module state                                                       */
/* ================================================================== */

const markedZones = new WeakSet<Element>();
const resultCache = new WeakMap<HTMLElement, MatchResultItem[]>();

let dirHandle: FileSystemDirectoryHandle | null = null;
let activePanel: HTMLElement | null = null;
let activeTarget: UploadTarget | null = null;
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

/* ================================================================== */
/*  Types                                                              */
/* ================================================================== */

interface UploadTarget {
  zone: HTMLElement;
  fileInput: HTMLInputElement;
  context: string;
  accept?: string;
}

/* ================================================================== */
/*  DETECTION — find upload zones                                      */
/* ================================================================== */

/**
 * For every <input type="file"> on the page, find the enclosing "upload zone"
 * (the visual container the user sees). Deduplicate so each zone is returned
 * only once even if it contains multiple file inputs.
 */
function findUploadZones(): UploadTarget[] {
  const results: UploadTarget[] = [];
  const usedZones = new Set<Element>();

  document
    .querySelectorAll<HTMLInputElement>('input[type="file"]')
    .forEach((input) => {
      if (markedZones.has(input)) return;

      const zone = resolveZone(input);
      if (!zone || usedZones.has(zone) || markedZones.has(zone)) return;
      usedZones.add(zone);

      results.push({
        zone,
        fileInput: input,
        context: extractZoneContext(input, zone),
        accept: input.accept || undefined,
      });
    });

  return results;
}

/**
 * Walk up from the file input to find the best "upload zone" container.
 *
 * Priority:
 *  1. Ancestor with upload/drop/attach-themed class name
 *  2. Form-field container (label, fieldset, form-group)
 *  3. Nearest ancestor with reasonable visual dimensions
 *  4. Fallback: parentElement
 */
function resolveZone(input: HTMLInputElement): HTMLElement | null {
  // 1. Upload-themed container
  const themed = input.closest<HTMLElement>(
    [
      '[class*="upload"]',
      '[class*="Upload"]',
      '[class*="drop"]',
      '[class*="Drop"]',
      '[class*="attach"]',
      '[class*="Attach"]',
      '[class*="file-input"]',
      '[class*="file-picker"]',
    ].join(","),
  );
  if (themed && isReasonableZone(themed)) return themed;

  // 2. Form-field container
  const field = input.closest<HTMLElement>(
    'label, fieldset, [class*="form-group"], [class*="field"], [class*="input-group"]',
  );
  if (field && isReasonableZone(field)) return field;

  // 3. Walk up to find a visually reasonable container
  let el: HTMLElement | null = input.parentElement;
  for (let i = 0; i < 5 && el && el !== document.body; i++) {
    if (isReasonableZone(el)) return el;
    el = el.parentElement;
  }

  // 4. Fallback
  return input.parentElement;
}

function isReasonableZone(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return (
    rect.width > 40 &&
    rect.height > 30 &&
    rect.width < window.innerWidth * 0.9
  );
}

/* ================================================================== */
/*  CONTEXT EXTRACTION                                                 */
/* ================================================================== */

function extractZoneContext(
  input: HTMLInputElement,
  zone: HTMLElement,
): string {
  const parts: string[] = [];

  // Labels pointing at the input
  if (input.id) {
    const label = document.querySelector(`label[for="${input.id}"]`);
    if (label) parts.push(label.textContent || "");
  }
  const parentLabel = input.closest("label");
  if (parentLabel) parts.push(parentLabel.textContent || "");

  // Input attributes
  if (input.placeholder) parts.push(input.placeholder);
  if (input.title) parts.push(input.title);
  const ariaLabel = input.getAttribute("aria-label");
  if (ariaLabel) parts.push(ariaLabel);

  // Zone text (the container around the upload field — labels, hints, etc.)
  parts.push((zone.textContent || "").slice(0, 500));

  return parts.join(" ").trim();
}

/* ================================================================== */
/*  ZONE MARKING — highlight & attach hover                            */
/* ================================================================== */

function markZone(target: UploadTarget) {
  markedZones.add(target.zone);
  markedZones.add(target.fileInput);

  // Highlight
  target.zone.classList.add(ZONE_CLASS);

  // Make sure zone can contain an absolutely-positioned badge
  if (getComputedStyle(target.zone).position === "static") {
    target.zone.style.position = "relative";
  }

  // Small badge
  if (!target.zone.querySelector(`.${BADGE_CLASS}`)) {
    const badge = document.createElement("span");
    badge.className = BADGE_CLASS;
    badge.textContent = "\u26A1 xUpload";
    target.zone.appendChild(badge);
  }

  // Hover handlers
  target.zone.addEventListener("mouseenter", () => onZoneEnter(target));
  target.zone.addEventListener("mouseleave", () => onZoneLeave());
}

/* ================================================================== */
/*  HOVER PANEL — show / hide logic                                    */
/* ================================================================== */

function cancelHide() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function scheduleHide(delay = 300) {
  cancelHide();
  hideTimer = setTimeout(() => {
    dismissPanel();
  }, delay);
}

function dismissPanel() {
  if (activePanel) {
    activePanel.remove();
    activePanel = null;
    activeTarget = null;
  }
}

function onZoneEnter(target: UploadTarget) {
  cancelHide();
  // Already showing for this zone — keep it
  if (activePanel && activeTarget?.zone === target.zone) return;

  // Clear any pending show-timer for a different zone
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }

  // Small delay so quick mouse-overs don't trigger the panel
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    dismissPanel();
    showHoverPanel(target);
  }, 250);
}

function onZoneLeave() {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  scheduleHide();
}

/* ================================================================== */
/*  HOVER PANEL — build & populate                                     */
/* ================================================================== */

async function showHoverPanel(target: UploadTarget) {
  const workflowId = createWorkflowId("recommend");
  logWorkflowStep(workflowId, "recommend.start", {
    contextPreview: target.context.slice(0, 140),
    accept: target.accept || "(none)",
    url: window.location.href,
  });

  // --- Build skeleton ---
  const panel = document.createElement("div");
  panel.className = PANEL_CLASS;

  // Keep visible when mouse enters the panel itself
  panel.addEventListener("mouseenter", cancelHide);
  panel.addEventListener("mouseleave", () => scheduleHide());

  // Header
  const header = document.createElement("div");
  header.className = "xupload-header";
  header.textContent = "\u26A1 Recommended files";
  panel.appendChild(header);

  // Loading indicator
  const loadingDiv = document.createElement("div");
  loadingDiv.className = "xupload-loading-msg";
  loadingDiv.textContent = "Finding best files\u2026";
  panel.appendChild(loadingDiv);

  // Footer with "Default upload" button (always present)
  const footer = createFooter(target);
  panel.appendChild(footer);

  // Position & show
  positionPanel(panel, target.zone);
  document.body.appendChild(panel);
  activePanel = panel;
  activeTarget = target;

  // --- Fetch recommendations ---
  try {
    const countResp = await chrome.runtime.sendMessage({
      type: "GET_INDEX_COUNT",
    });

    if (!countResp?.count || countResp.count === 0) {
      loadingDiv.remove();
      showInlineScan(panel, footer, target, workflowId);
      return;
    }

    // Check cache first
    const cached = resultCache.get(target.zone);
    if (cached) {
      loadingDiv.remove();
      populateResults(panel, footer, cached, target, workflowId);
      return;
    }

    const results = await fetchRecommendations(target, workflowId);
    resultCache.set(target.zone, results);
    loadingDiv.remove();
    populateResults(panel, footer, results, target, workflowId);
  } catch (err: any) {
    loadingDiv.remove();
    logWorkflowError(workflowId, "recommend.failed", err);
    const errDiv = document.createElement("div");
    errDiv.className = "xupload-empty";
    errDiv.textContent = err?.message?.includes("Extension context invalidated")
      ? "Extension was updated. Please refresh this page."
      : "Error getting recommendations.";
    panel.insertBefore(errDiv, footer);
  }
}

function createFooter(target: UploadTarget): HTMLElement {
  const footer = document.createElement("div");
  footer.className = "xupload-panel-footer";

  const defaultBtn = document.createElement("button");
  defaultBtn.type = "button";
  defaultBtn.className = "xupload-default-btn";
  defaultBtn.textContent = "\uD83D\uDCC2 Use default upload";
  defaultBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dismissPanel();
    target.fileInput.click();
  });
  footer.appendChild(defaultBtn);

  return footer;
}

function populateResults(
  panel: HTMLElement,
  footer: HTMLElement,
  results: MatchResultItem[],
  target: UploadTarget,
  workflowId: string,
) {
  if (!results.length) {
    const empty = document.createElement("div");
    empty.className = "xupload-empty";
    empty.textContent = "No matching files found.";
    panel.insertBefore(empty, footer);
    return;
  }

  // Update header
  const header = panel.querySelector(".xupload-header");
  if (header)
    header.textContent = `\u26A1 ${results.length} file${results.length > 1 ? "s" : ""} recommended`;

  const list = document.createElement("ul");
  for (const r of results) {
    const li = document.createElement("li");
    li.className = "xupload-item";

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
      li.classList.add("xupload-item-loading");

      logWorkflowStep(workflowId, "recommend.file.click", {
        fileId: r.id,
        fileName: r.name,
        score: Math.round(r.score * 100),
      });

      const file = await getFile(r.id, workflowId);
      li.classList.remove("xupload-item-loading");
      scoreSpan.textContent = `${pct}%`;

      if (!file) {
        scoreSpan.textContent = "Error";
        scoreSpan.style.color = "#ea4335";
        logWorkflowStep(workflowId, "recommend.file.read_failed", {
          fileId: r.id,
        });

        // Show inline error message
        const errorDiv = document.createElement("div");
        errorDiv.className = "xupload-permission-error";
        errorDiv.textContent = "⚠️ Permission expired. Please click the ⚡ xUpload icon and click 'Rescan folder' to re-authorize.";
        errorDiv.style.cssText = "padding: 8px; margin: 8px 0; background: #fef7e0; border-radius: 4px; font-size: 12px; color: #856404;";

        panel.insertBefore(errorDiv, footer);
        return;
      }

      // Switch to preview (standalone panel, hover panel dismissed)
      dismissPanel();
      showPreview(target, file, r, workflowId);
    });

    list.appendChild(li);
  }

  panel.insertBefore(list, footer);
}

/* ================================================================== */
/*  INLINE SCAN — shown when no index exists                           */
/* ================================================================== */

function showInlineScan(
  panel: HTMLElement,
  footer: HTMLElement,
  target: UploadTarget,
  workflowId: string,
) {
  const statusDiv = document.createElement("div");
  statusDiv.className = "xupload-empty";
  statusDiv.textContent = "No files indexed yet.";
  panel.insertBefore(statusDiv, footer);

  const scanBtn = document.createElement("button");
  scanBtn.type = "button";
  scanBtn.className = "xupload-scan-btn";
  scanBtn.textContent = "Select folder to scan";
  scanBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    scanBtn.disabled = true;
    scanBtn.textContent = "Scanning\u2026";

    const scanWorkflowId = createWorkflowId("scan-inline");
    logWorkflowStep(workflowId, "recommend.inline_scan.requested", {
      scanWorkflowId,
    });

    const ok = await scanFolder(statusDiv, scanWorkflowId);
    if (ok) {
      // Re-fetch and rebuild
      statusDiv.remove();
      scanBtn.remove();
      const loadingDiv = document.createElement("div");
      loadingDiv.className = "xupload-loading-msg";
      loadingDiv.textContent = "Finding best files\u2026";
      panel.insertBefore(loadingDiv, footer);

      try {
        const results = await fetchRecommendations(target, workflowId);
        resultCache.set(target.zone, results);
        loadingDiv.remove();
        populateResults(panel, footer, results, target, workflowId);
      } catch {
        loadingDiv.remove();
      }
    } else {
      scanBtn.disabled = false;
      scanBtn.textContent = "Select folder to scan";
      statusDiv.textContent = "Scan cancelled. Try again.";
    }
  });

  panel.insertBefore(scanBtn, footer);
}

/* ================================================================== */
/*  PANEL POSITIONING                                                  */
/* ================================================================== */

function positionPanel(panel: HTMLElement, zone: HTMLElement) {
  const rect = zone.getBoundingClientRect();
  panel.style.position = "fixed";
  panel.style.zIndex = "2147483647";

  // Horizontal: align to zone left, clamp to viewport
  const left = Math.max(4, Math.min(rect.left, window.innerWidth - 380));
  panel.style.left = `${left}px`;

  // Temporarily place off-screen to measure actual height
  panel.style.top = "-9999px";
  panel.style.maxHeight = `${window.innerHeight - 16}px`;
  panel.style.overflowY = "auto";

  // Use requestAnimationFrame so the browser has laid out the panel
  requestAnimationFrame(() => {
    const panelHeight = panel.getBoundingClientRect().height;
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;

    let top: number;
    if (spaceBelow >= panelHeight) {
      // Enough room below
      top = rect.bottom + 6;
    } else if (spaceAbove >= panelHeight) {
      // Flip above the zone
      top = rect.top - panelHeight - 6;
    } else {
      // Not enough room either way — pin to top/bottom with padding
      if (spaceBelow >= spaceAbove) {
        top = window.innerHeight - panelHeight - 8;
      } else {
        top = 8;
      }
    }

    panel.style.top = `${Math.max(8, top)}px`;
  });
}

/* ================================================================== */
/*  FETCH RECOMMENDATIONS                                              */
/* ================================================================== */

async function getConfig(): Promise<XUploadConfig> {
  return new Promise((resolve) => {
    chrome.storage.local.get("xupload_config", (data) => {
      resolve(data.xupload_config || { apiKey: "", mode: "tfidf" });
    });
  });
}

async function fetchRecommendations(
  target: UploadTarget,
  workflowId: string,
): Promise<MatchResultItem[]> {
  const config = await getConfig();
  logWorkflowStep(workflowId, "recommend.config.loaded", {
    mode: config.mode,
    hasApiKey: !!config.apiKey,
  });

  // Enhanced matching (fast / vlm)
  if (config.apiKey && config.mode !== "tfidf") {
    let screenshotBase64: string | undefined;

    if (config.mode === "vlm") {
      try {
        const rect = target.zone.getBoundingClientRect();
        const captureResp = await chrome.runtime.sendMessage({
          type: "CAPTURE_TAB",
        });
        if (captureResp?.base64) {
          screenshotBase64 = await cropScreenshot(captureResp.base64, {
            top: Math.max(0, rect.top - 150),
            left: Math.max(0, rect.left - 100),
            width: Math.min(800, window.innerWidth - rect.left + 200),
            height: Math.min(600, 400),
          });
        }
      } catch (err) {
        logWorkflowError(
          workflowId,
          "service.background.CAPTURE_TAB.failed",
          err,
        );
      }
    }

    const msg: MatchRequestEnhanced = {
      type: "MATCH_REQUEST_ENHANCED",
      context: target.context,
      accept: target.accept,
      pageUrl: window.location.href,
      workflowId,
      mode: config.mode,
      screenshotBase64,
    };

    const resp: MatchResponse = await chrome.runtime.sendMessage(msg);
    logWorkflowStep(
      workflowId,
      "service.background.MATCH_REQUEST_ENHANCED.done",
      {
        responseWorkflowId: resp?.workflowId,
        resultCount: resp?.results?.length || 0,
      },
    );
    return resp?.results || [];
  }

  // TF-IDF fallback
  const msg: MatchRequest = {
    type: "MATCH_REQUEST",
    context: target.context,
    accept: target.accept,
    pageUrl: window.location.href,
    workflowId,
  };

  const resp: MatchResponse = await chrome.runtime.sendMessage(msg);
  logWorkflowStep(workflowId, "service.background.MATCH_REQUEST.done", {
    responseWorkflowId: resp?.workflowId,
    resultCount: resp?.results?.length || 0,
  });
  return resp?.results || [];
}

/** Crop a base64 PNG screenshot to a specific region */
async function cropScreenshot(
  base64: string,
  region: { top: number; left: number; width: number; height: number },
): Promise<string> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = `data:image/png;base64,${base64}`;
  });

  const dpr = window.devicePixelRatio || 1;
  const cropX = region.left * dpr;
  const cropY = region.top * dpr;
  const cropW = region.width * dpr;
  const cropH = region.height * dpr;

  const canvas = document.createElement("canvas");
  canvas.width = cropW;
  canvas.height = cropH;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

  return canvas.toDataURL("image/png").replace(/^data:image\/\w+;base64,/, "");
}

/* ================================================================== */
/*  FILE PREVIEW (standalone panel)                                    */
/* ================================================================== */

const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"];
const TEXT_EXTS = [
  "txt", "md", "csv", "json", "xml", "html", "htm",
  "js", "ts", "py", "java", "c", "cpp", "css",
  "log", "yaml", "yml", "toml", "ini", "rtf",
];

function getFileIcon(type: string, name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (ext === "pdf" || type === "application/pdf") return "\uD83D\uDCC4";
  if (["doc", "docx"].includes(ext)) return "\uD83D\uDCC3";
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext))
    return "\uD83D\uDDBC\uFE0F";
  if (["xls", "xlsx", "csv"].includes(ext)) return "\uD83D\uDCCA";
  return "\uD83D\uDCC1";
}

function getFileExt(name: string): string {
  return name.split(".").pop()?.toLowerCase() || "";
}

function showPreview(
  target: UploadTarget,
  file: File,
  result: MatchResultItem,
  workflowId: string,
) {
  // Remove any existing panel
  document.querySelectorAll(`.${PANEL_CLASS}`).forEach((el) => el.remove());
  activePanel = null;
  activeTarget = null;

  const panel = document.createElement("div");
  panel.className = PANEL_CLASS + " xupload-preview";

  // Header
  const header = document.createElement("div");
  header.className = "xupload-header";
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
    const img = document.createElement("img");
    img.src = blobUrl;
    img.className = "xupload-preview-img";
    img.alt = file.name;
    previewArea.appendChild(img);
  } else if (ext === "pdf") {
    const embed = document.createElement("embed");
    embed.src = blobUrl;
    embed.type = "application/pdf";
    embed.className = "xupload-preview-pdf";
    previewArea.appendChild(embed);
  } else if (TEXT_EXTS.includes(ext)) {
    const pre = document.createElement("pre");
    pre.className = "xupload-preview-text";
    file.text().then((text) => {
      pre.textContent = text.slice(0, 5000);
      if (text.length > 5000) pre.textContent += "\n\n... (truncated)";
    });
    previewArea.appendChild(pre);
  } else {
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
    // Re-show results as a standalone panel (click-outside-to-close)
    showStandaloneResults(target, workflowId);
  });

  const useBtn = document.createElement("button");
  useBtn.type = "button";
  useBtn.className = "xupload-preview-btn xupload-preview-use";
  useBtn.textContent = "Use this file";
  useBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    useBtn.disabled = true;
    useBtn.textContent = "Filling\u2026";
    logWorkflowStep(workflowId, "recommend.fill.start", {
      fileId: result.id,
      fileName: result.name,
      path: result.path,
    });

    const success = fillFileWithObj(target, file);
    URL.revokeObjectURL(blobUrl);

    if (success) {
      logWorkflowStep(workflowId, "recommend.fill.done", {
        method: "setFileInput_or_drop",
      });
      useBtn.textContent = "\u2713 Done";
      useBtn.classList.add("xupload-preview-done");
      setTimeout(() => panel.remove(), 600);

      // Track history (fire-and-forget)
      try {
        chrome.runtime.sendMessage(
          {
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
          },
          () => void chrome.runtime.lastError,
        );
        chrome.runtime.sendMessage(
          {
            type: "SAVE_USED_PATH",
            host: new URL(window.location.href).hostname,
            filePath: result.path,
          },
          () => void chrome.runtime.lastError,
        );
        logWorkflowStep(workflowId, "recommend.memory.saved", {
          host: new URL(window.location.href).hostname,
          filePath: result.path,
        });
      } catch {
        /* non-critical */
      }

      // Invalidate cache so next hover picks up history changes
      resultCache.delete(target.zone);
    } else {
      logWorkflowStep(workflowId, "recommend.fill.failed");
      useBtn.textContent = "Error";
      useBtn.disabled = false;
    }
  });

  actions.appendChild(backBtn);
  actions.appendChild(useBtn);
  panel.appendChild(actions);

  // Click-outside to close
  const closeHandler = (ev: MouseEvent) => {
    if (!panel.contains(ev.target as Node)) {
      URL.revokeObjectURL(blobUrl);
      panel.remove();
      document.removeEventListener("click", closeHandler);
    }
  };
  setTimeout(() => document.addEventListener("click", closeHandler), 0);

  // Position
  positionPanel(panel, target.zone);
  document.body.appendChild(panel);
}

/**
 * Re-show the cached recommendation list as a standalone (click-outside-to-close)
 * panel. Used when the user clicks "Back" in the preview.
 */
function showStandaloneResults(target: UploadTarget, workflowId: string) {
  const cached = resultCache.get(target.zone);
  if (!cached) {
    // No cache — just let the user hover again
    return;
  }

  const panel = document.createElement("div");
  panel.className = PANEL_CLASS;

  const header = document.createElement("div");
  header.className = "xupload-header";
  header.textContent = `\u26A1 ${cached.length} file${cached.length > 1 ? "s" : ""} recommended`;
  panel.appendChild(header);

  const footer = createFooter(target);
  panel.appendChild(footer);

  populateResults(panel, footer, cached, target, workflowId);

  positionPanel(panel, target.zone);
  document.body.appendChild(panel);

  // Click-outside to close
  const closeHandler = (ev: MouseEvent) => {
    if (!panel.contains(ev.target as Node)) {
      panel.remove();
      document.removeEventListener("click", closeHandler);
    }
  };
  setTimeout(() => document.addEventListener("click", closeHandler), 0);
}

/* ================================================================== */
/*  FILE OPERATIONS                                                    */
/* ================================================================== */

/** Read a file: try local handle → background handle. */
async function getFile(
  fileId: string,
  workflowId: string,
): Promise<File | null> {
  logWorkflowStep(workflowId, "service.content.readFileFromHandle.start", {
    fileId,
  });

  // Strategy 1: in-memory directory handle (fastest)
  let file = await readFileFromHandle(fileId);
  if (file) {
    logWorkflowStep(workflowId, "service.content.readFileFromHandle.done", {
      source: "in_memory_handle",
    });
    return file;
  }

  // Strategy 2: background handle via IndexedDB
  try {
    logWorkflowStep(workflowId, "service.background.GET_FILE.start", {
      fileId,
    });
    const resp = await chrome.runtime.sendMessage({
      type: "GET_FILE",
      id: fileId,
    });
    if (resp && !resp.error && resp.base64) {
      const binary = atob(resp.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++)
        bytes[i] = binary.charCodeAt(i);
      logWorkflowStep(workflowId, "service.background.GET_FILE.done", {
        source: "background_handle",
      });
      return new File([bytes], resp.name, {
        type: resp.type,
        lastModified: resp.lastModified,
      });
    }
    logWorkflowStep(
      workflowId,
      "service.background.GET_FILE.empty",
      resp?.error || "no_data",
    );
  } catch (err) {
    logWorkflowError(workflowId, "service.background.GET_FILE.failed", err);
  }

  // Strategy 3: Re-authorize folder access (we're in a user-gesture context
  // from the click on the recommended file, so showDirectoryPicker() is allowed)
  logWorkflowStep(workflowId, "service.content.reauthorize.start");
  try {
    dirHandle = await (window as any).showDirectoryPicker({ mode: "read" });
    if (dirHandle) {
      const retryFile = await readFileFromHandle(fileId);
      if (retryFile) {
        logWorkflowStep(workflowId, "service.content.reauthorize.done", {
          source: "reauthorized_handle",
        });
        return retryFile;
      }
    }
  } catch (reErr: any) {
    if (reErr.name !== "AbortError") {
      logWorkflowError(
        workflowId,
        "service.content.reauthorize.failed",
        reErr,
      );
    }
  }

  logWorkflowStep(workflowId, "service.content.read_file.failed", {
    reason: "missing_or_expired_directory_permission",
    action: "user_cancelled_or_wrong_folder",
  });
  return null;
}

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

function fillFileWithObj(target: UploadTarget, file: File): boolean {
  try {
    setFileInput(target.fileInput, file);
    return true;
  } catch {
    // Fallback: simulate drop on the zone
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      target.zone.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        }),
      );
      return true;
    } catch (err) {
      console.error("[xUpload] Fill error:", err);
      return false;
    }
  }
}

function setFileInput(input: HTMLInputElement, file: File) {
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/* ================================================================== */
/*  FOLDER SCANNING                                                    */
/* ================================================================== */

async function collectFiles(
  handle: FileSystemDirectoryHandle,
  basePath: string,
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
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    txt: "text/plain",
    csv: "text/csv",
  };
  return map[ext] || "application/octet-stream";
}

async function extractFileText(
  file: File,
  filePath?: string,
): Promise<string> {
  const name = file.name.replace(/[._-]/g, " ");
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  const pathKeywords = filePath ? filePath.replace(/[/\\._-]/g, " ") : name;

  if (TEXT_EXTS.includes(ext)) {
    try {
      const text = await file.text();
      return `${pathKeywords} ${text.slice(0, 2000)}`;
    } catch {
      return pathKeywords;
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
      const pdfText = parts
        .join(" ")
        .replace(/\\n/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (pdfText.length > 10) {
        return `${pathKeywords} ${pdfText.slice(0, 2000)}`;
      }
      return `${pathKeywords} pdf document`;
    } catch {
      return `${pathKeywords} pdf document`;
    }
  }

  if (
    ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "tiff", "heic"].includes(ext)
  ) {
    return `${pathKeywords} image photo picture`;
  }
  if (["doc", "docx"].includes(ext)) return `${pathKeywords} document word`;
  if (["xls", "xlsx"].includes(ext))
    return `${pathKeywords} spreadsheet excel`;
  if (["ppt", "pptx"].includes(ext))
    return `${pathKeywords} presentation slides`;

  return pathKeywords;
}

async function scanFolder(
  statusEl?: HTMLElement,
  workflowId: string = createWorkflowId("scan-inline"),
): Promise<boolean> {
  logWorkflowStep(workflowId, "scan.inline.start");
  try {
    logWorkflowStep(workflowId, "service.filesystem.showDirectoryPicker.start");
    dirHandle = await (window as any).showDirectoryPicker({ mode: "read" });
    logWorkflowStep(workflowId, "service.filesystem.showDirectoryPicker.done");
  } catch (err: any) {
    if (err.name === "AbortError") return false;
    logWorkflowError(workflowId, "scan.inline.showDirectoryPicker.failed", err);
    return false;
  }
  if (!dirHandle) return false;

  if (statusEl) statusEl.textContent = "Scanning files\u2026";

  const entries = await collectFiles(dirHandle, "");
  logWorkflowStep(workflowId, "service.filesystem.collectFiles.done", {
    discoveredFiles: entries.length,
  });
  if (statusEl)
    statusEl.textContent = `Found ${entries.length} files. Reading\u2026`;

  const files: {
    path: string;
    name: string;
    type: string;
    size: number;
    lastModified: number;
    text: string;
  }[] = [];
  let unreadable = 0;

  for (let i = 0; i < entries.length; i++) {
    const { fileHandle, path } = entries[i];
    try {
      const file = await fileHandle.getFile();
      const text = await extractFileText(file, path);
      files.push({
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
    if (i % 10 === 0 && statusEl) {
      statusEl.textContent = `Reading files\u2026 ${i + 1}/${entries.length}`;
    }
  }

  if (statusEl) statusEl.textContent = "Building index\u2026";
  logWorkflowStep(workflowId, "scan.inline.read.done", {
    processedFiles: files.length,
    unreadable,
  });

  const resp = await chrome.runtime.sendMessage({
    type: "BUILD_INDEX",
    files,
    workflowId,
  });
  logWorkflowStep(workflowId, "service.background.BUILD_INDEX.done", resp);

  if (statusEl)
    statusEl.textContent = `Done! ${resp?.count || files.length} files indexed.`;
  logWorkflowStep(workflowId, "scan.inline.done", {
    indexedFiles: resp?.count || files.length,
  });
  return true;
}

/* ================================================================== */
/*  INITIALIZATION                                                     */
/* ================================================================== */

function scanAndMark() {
  const zones = findUploadZones();
  for (const target of zones) {
    markZone(target);
  }
}

// Run once immediately
scanAndMark();

// Re-scan when DOM changes
new MutationObserver(() => scanAndMark()).observe(document.body, {
  childList: true,
  subtree: true,
});
