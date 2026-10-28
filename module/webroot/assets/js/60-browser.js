"use strict";

/* FileHider WebUI: virtualized file browser and symlink resolution. */

  // ---------- file browser ----------

  function openBrowserNow(dir) {
    if (!state.currentPkg) return;
    const logical = normalizeBrowserPath(dir || "/");
    state.browserDir = logical;
    $("browserModal").classList.add("open");
    syncOverlayLock();
    $("jumpInput").value = logical;
    $("browserSearch").value = "";
    webLog("browser", "open " + logical);
    loadBrowser(logical);
  }

  function isDirectory(item) { return item.kind === "D" || item.kind === "LD"; }
  function isSymlink(item) { return item.kind === "L" || item.kind === "LD" || item.kind === "LB"; }

  function browserFilteredItems() {
    const term = state.browserFilter;
    if (!term) return state.browserItems;
    return state.browserItems.filter((item) =>
      item.name.toLowerCase().includes(term) || item.path.toLowerCase().includes(term));
  }

  function browserRange(total) {
    const list = $("browserList");
    const viewport = Math.max(list.clientHeight || 0, 320);
    const scrollTop = Math.max(list.scrollTop, 0);
    const start = Math.min(total, Math.max(0, Math.floor(scrollTop / BROWSER_ROW_HEIGHT) - 4));
    const end = Math.min(total, Math.max(start, Math.ceil((scrollTop + viewport) / BROWSER_ROW_HEIGHT) + 4));
    return { start, end };
  }

  function browserRowHtml(item, index) {
    const dir = isDirectory(item);
    const link = isSymlink(item);
    const icon = dir ? ICONS.folder : link ? ICONS.link : ICONS.file;
    const targetText = item.target ? '<span class="target">→ ' + escapeHtml(item.target) + '</span>' : "";
    const targetButton = link
      ? '<button class="add target" type="button" data-add-target="' + escapeHtml(item.target) +
        '" data-target-path="' + escapeHtml(item.path) + '" title="Add resolved symlink target" aria-label="Add resolved symlink target">↗</button>'
      : "";
    return '<div class="item' + (dir ? " dir" : "") + (item.kind === "LD" ? " linkdir" : "") + '"' +
      ' style="top:' + (index * BROWSER_ROW_HEIGHT) + 'px"' +
      ' data-path="' + escapeHtml(item.path) + '" data-kind="' + item.kind +
      '" data-target="' + escapeHtml(item.target) + '"' +
      ' title="' + escapeHtml(item.path + (item.target ? " → " + item.target : "")) + '">' +
      '<span class="ico">' + icon + '</span>' +
      '<span class="name mono">' + escapeHtml(item.name) + (dir ? "/" : "") + targetText + '</span>' +
      '<button class="add" type="button" data-add-path="' + escapeHtml(item.path) +
      '" data-target="' + escapeHtml(item.target) + '" title="Add this path" aria-label="Add this path">＋</button>' +
      targetButton + '</div>';
  }

  function scheduleTargetResolution() {
    if (browserTargetTimer) clearTimeout(browserTargetTimer);
    browserTargetTimer = setTimeout(() => {
      browserTargetTimer = 0;
      if (!$("browserModal").classList.contains("open")) return;
      resolveVisibleTargets();
    }, 300);
  }

  function renderBrowser(reset) {
    const list = $("browserList");
    const rows = $("browserRows");
    const filtered = browserFilteredItems();
    if (reset) list.scrollTop = 0;
    if (!filtered.length) {
      rows.style.height = "";
      const message = state.browserItems.length ? "No match for this filter." : "Folder is empty.";
      rows.innerHTML = '<div class="empty">' + escapeHtml(message) + '</div>';
      return;
    }
    rows.style.height = (filtered.length * BROWSER_ROW_HEIGHT) + "px";
    const range = browserRange(filtered.length);
    rows.innerHTML = filtered.slice(range.start, range.end)
      .map((item, offset) => browserRowHtml(item, range.start + offset)).join("");
    scheduleTargetResolution();
  }

  function browserListingError(output) {
    const lines = String(output || "").split("\n");
    if (lines.includes("FH_ERR=missing")) return "Folder not found.";
    if (lines.includes("FH_ERR=denied")) return "Permission denied. Try Root or Internal storage.";
    return "";
  }

  function cloneBrowserItem(item) {
    return {
      kind: item.kind, name: item.name, target: item.target,
      targetChecked: item.targetChecked, targetResolving: item.targetResolving, path: item.path,
    };
  }

  function makeBrowserItem(safe, kind, name) {
    if (!name || name === "." || name === "..") return null;
    if (safe === "/storage/emulated" && !/^\d+$/.test(name)) return null;
    const path = safe === "/" ? "/" + name : safe + "/" + name;
    return { kind, name, target: "", targetChecked: false, targetResolving: false, path };
  }

  function parseNativeBrowserListing(result, safe, sep) {
    const lines = String(result.stdout || "").split("\n");
    const namesAt = lines.indexOf(sep);
    const longAt = lines.indexOf(sep + "_LONG");
    if (namesAt < 0 || longAt <= namesAt) return null;

    const names = lines.slice(namesAt + 1, longAt);
    while (names.length && names[names.length - 1] === "") names.pop();
    if (names.length < 2 || !names.includes(".") || !names.includes("..")) return null;

    const longLines = [];
    for (const line of lines.slice(longAt + 1)) {
      if (!line || line.startsWith("total ")) continue;
      if ("dl-bcps?".includes(line.charAt(0))) longLines.push(line);
    }
    if (names.length !== longLines.length) return null;

    let physical = "";
    for (const line of lines.slice(0, namesAt)) {
      if (line.startsWith("FH_PWD=")) { physical = line.slice("FH_PWD=".length); break; }
    }

    const items = [];
    for (let i = 0; i < names.length; i++) {
      const line = longLines[i];
      const type = line.charAt(0);
      const kind = type === "d" ? "D" : (type === "l" ? "L" : (type === "-" ? "F" : "O"));
      const item = makeBrowserItem(safe, kind, names[i]);
      if (!item) continue;
      if (kind === "L") {
        const arrow = line.indexOf(" -> ");
        if (arrow >= 0) {
          item.target = resolveTargetPath(item.path, line.slice(arrow + 4));
          item.targetChecked = true;
        }
      }
      items.push(item);
    }
    return { physical, items, stderr: String(result.stderr || "").trim() };
  }

  function parseLegacyBrowserListing(result, safe) {
    let physical = "";
    const items = [];
    for (const line of String(result.stdout || "").split("\n")) {
      if (line.startsWith("FH_PWD=")) { physical = line.slice("FH_PWD=".length); continue; }
      if (!line || line === "FH_EMPTY" || line.startsWith("FH_ERR=")) continue;
      const tab = line.indexOf("\t");
      if (tab < 1) continue;
      const item = makeBrowserItem(safe, line.slice(0, tab), line.slice(tab + 1));
      if (item) items.push(item);
    }
    return { physical, items, stderr: String(result.stderr || "").trim() };
  }

  function nativeBrowserScript(source, sep) {
    return [
      "d=" + q(source),
      "if [ ! -d \"$d\" ]; then echo FH_ERR=missing; exit 0; fi",
      "cd \"$d\" 2>/dev/null || { echo FH_ERR=denied; exit 0; }",
      "printf 'FH_PWD=%s\\n' \"$(pwd -P 2>/dev/null)\"",
      "printf '%s\\n' " + q(sep),
      "LC_ALL=C LS_COLORS= /system/bin/ls -a -1 2>/dev/null",
      "printf '%s\\n' " + q(sep + "_LONG"),
      "LC_ALL=C LS_COLORS= /system/bin/ls -la 2>/dev/null",
    ].join("\n");
  }

  function legacyBrowserScript(source) {
    return [
      "d=" + q(source),
      "if [ ! -d \"$d\" ]; then echo FH_ERR=missing; exit 0; fi",
      "cd \"$d\" 2>/dev/null || { echo FH_ERR=denied; exit 0; }",
      "printf 'FH_PWD=%s\\n' \"$(pwd -P 2>/dev/null)\"",
      "n=0",
      "for f in .* *; do",
      "  if [ \"$f\" = \".\" ] || [ \"$f\" = \"..\" ]; then continue; fi",
      "  if [ ! -e \"$f\" ] && [ ! -L \"$f\" ]; then continue; fi",
      "  if [ -L \"$f\" ]; then",
      "    if [ -d \"$f\" ]; then k=LD; elif [ -e \"$f\" ]; then k=L; else k=LB; fi",
      "  elif [ -d \"$f\" ]; then k=D",
      "  elif [ -f \"$f\" ]; then k=F",
      "  else k=O; fi",
      "  n=$((n+1))",
      "  printf '%s\\t%s\\n' \"$k\" \"$f\"",
      "done",
      "if [ \"$n\" -eq 0 ]; then echo FH_EMPTY; fi",
    ].join("\n");
  }

  async function listBrowserDirectory(safe, source, sep, request) {
    const native = await run(nativeBrowserScript(source, sep));
    if (request !== state.browserRequest) return null;
    const nativeError = browserListingError(native.stdout);
    if (nativeError) return { error: nativeError };
    const parsedNative = parseNativeBrowserListing(native, safe, sep);
    if (parsedNative) return parsedNative;

    const legacy = await run(legacyBrowserScript(source));
    if (request !== state.browserRequest) return null;
    const legacyError = browserListingError(legacy.stdout);
    if (legacyError) return { error: legacyError };
    return parseLegacyBrowserListing(legacy, safe) || { error: "Could not read this folder." };
  }

  function getCachedBrowser(key) {
    const entry = state.browserCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > BROWSER_CACHE_TTL) {
      state.browserCache.delete(key);
      return null;
    }
    state.browserCache.delete(key);
    state.browserCache.set(key, entry);
    return entry;
  }

  function putCachedBrowser(key, physical, items) {
    state.browserCache.delete(key);
    state.browserCache.set(key, { physical, items, at: Date.now() });
    while (state.browserCache.size > BROWSER_CACHE_LIMIT) {
      const oldest = state.browserCache.keys().next().value;
      state.browserCache.delete(oldest);
    }
  }

  function setBrowserListing(safe, physical, items, emptyMessage) {
    state.browserPhysical = physical || "";
    state.browserItems = items;
    const resolved = state.browserPhysical;
    const resolvedDiffers = resolved && resolved !== safe;
    $("resolvedPath").hidden = !resolvedDiffers;
    $("resolvedPath").textContent = resolvedDiffers ? "Opens at " + resolved : "";
    if (!items.length) {
      const rows = $("browserRows");
      rows.style.height = "";
      rows.innerHTML = '<div class="empty">' + escapeHtml(emptyMessage || "Folder is empty.") + '</div>';
      return;
    }
    const rank = { D: 0, LD: 0, L: 1, LB: 1, O: 2, F: 3 };
    const order = (item) => rank[item.kind] === undefined ? 4 : rank[item.kind];
    items.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
    renderBrowser(true);
  }

  function showBrowserError(message) {
    state.browserItems = [];
    const rows = $("browserRows");
    rows.style.height = "";
    rows.innerHTML = '<div class="empty">' + escapeHtml(message) + '</div>';
  }

  async function loadBrowser(dir, options = {}) {
    const safe = normalizeBrowserPath(dir);
    const source = browserSourcePath(safe);
    const request = ++state.browserRequest;
    state.browserDir = safe;
    state.browserPhysical = "";
    state.browserItems = [];
    state.browserFilter = "";
    $("browserUp").disabled = safe === "/";
    $("resolvedPath").hidden = true;
    $("resolvedPath").textContent = "";
    $("jumpInput").value = safe;
    $("browserSearch").value = "";
    $("browserList").scrollTop = 0;
    if (browserTargetTimer) { clearTimeout(browserTargetTimer); browserTargetTimer = 0; }

    if (options.force) state.browserCache.delete(safe);
    const cached = getCachedBrowser(safe);
    if (cached) {
      setBrowserListing(safe, cached.physical, cached.items.map(cloneBrowserItem), "");
      webLog("browser", "cache hit " + safe + " entries=" + cached.items.length);
      return;
    }

    const rows = $("browserRows");
    rows.style.height = "";
    rows.innerHTML = '<div class="loading"><span class="spinner"></span><span>Loading…</span></div>';
    await nextFrame();
    if (request !== state.browserRequest) return;

    const sep = "__FH_SEP_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8) + "__";
    const listing = await listBrowserDirectory(safe, source, sep, request);
    if (!listing || request !== state.browserRequest) return;
    if (listing.error) {
      webLog("warn", "browser load " + safe + " failed: " + listing.error);
      showBrowserError(listing.error);
      return;
    }
    setBrowserListing(safe, listing.physical, listing.items, String(listing.stderr || "").trim());
    putCachedBrowser(safe, listing.physical, listing.items);
    webLog("browser", "load " + safe + " physical=" + (listing.physical || "-") +
      " entries=" + listing.items.length);
  }

  async function readSymlinkTarget(path) {
    const result = await run(
      "p=" + q(path) + " ; " +
      "t=$(/system/bin/readlink -f \"$p\" 2>/dev/null) ; " +
      "[ -n \"$t\" ] || t=$(/system/bin/readlink \"$p\" 2>/dev/null) ; " +
      "printf '%s' \"$t\""
    );
    const raw = String(result.stdout || "").trim();
    const target = raw ? resolveTargetPath(path, raw) : "";
    webLog("browser", "resolve " + path + " -> " + (target || "unresolved"));
    return target;
  }

  async function pathIsDirectory(path) {
    const result = await run("if [ -d " + q(path) + " ]; then echo FH_DIR; fi");
    return String(result.stdout || "").trim() === "FH_DIR";
  }

  async function resolveVisibleTargets() {
    if (state.browserTargetBusy) return;
    const filtered = browserFilteredItems();
    if (!filtered.length) return;
    const range = browserRange(filtered.length);
    const pending = filtered.slice(range.start, range.end)
      .filter((item) => isSymlink(item) && !item.target && !item.targetChecked && !item.targetResolving)
      .slice(0, 12);
    if (!pending.length) return;
    state.browserTargetBusy = true;
    const request = state.browserRequest;
    for (const item of pending) item.targetResolving = true;
    const script = pending.map((item) => {
      const path = "p=" + q(item.path) + " ; ";
      return path +
        "t=$(/system/bin/readlink -f \"$p\" 2>/dev/null) ; " +
        "[ -n \"$t\" ] || t=$(/system/bin/readlink \"$p\" 2>/dev/null) ; " +
        "printf '%s\\t%s\\n' \"$p\" \"$t\"";
    }).join("\n");
    const result = await run(script);
    state.browserTargetBusy = false;
    if (request !== state.browserRequest) {
      for (const item of pending) item.targetResolving = false;
      scheduleTargetResolution();
      return;
    }
    const found = new Map();
    for (const line of String(result.stdout || "").split("\n")) {
      const tab = line.indexOf("\t");
      if (tab < 1) continue;
      found.set(line.slice(0, tab), line.slice(tab + 1));
    }
    for (const item of pending) {
      item.targetResolving = false;
      item.targetChecked = true;
      const raw = found.get(item.path) || "";
      item.target = raw ? resolveTargetPath(item.path, raw) : "";
    }
    const cached = state.browserCache.get(state.browserDir);
    if (cached) {
      cached.items = state.browserItems.map(cloneBrowserItem);
      cached.physical = state.browserPhysical;
      cached.at = Date.now();
    }
    renderBrowser(false);
  }

  function closeBrowserNow() {
    $("browserModal").classList.remove("open");
    syncOverlayLock();
    state.browserRequest++;
    if (browserTargetTimer) { clearTimeout(browserTargetTimer); browserTargetTimer = 0; }
  }

  function closeBrowser() {
    dismissModal("browser");
  }
