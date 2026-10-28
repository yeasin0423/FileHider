"use strict";

/* FileHider WebUI: preferences, shell bridge helpers, path helpers, and app labels. */

  // ---------- preferences ----------

  const prefs = { theme: "auto", accent: "mint", iconShape: "circle", showSystem: false };
  const PREF = {
    theme: "fh.theme",
    accent: "fh.accent",
    iconShape: "fh.iconShape",
    showSystem: "fh.showSystem",
  };

  const UI_LOG_PERSIST_KEY = "fh.uiTail";
  const UI_LOG_PERSIST_LIMIT = 60;
  const UI_LOG_PERSIST_LEVELS = new Set(["nav", "ui", "theme", "error", "webui"]);
  let previousUiTail = "";

  function capturePreviousUiLog() {
    try {
      previousUiTail = localStorage.getItem(UI_LOG_PERSIST_KEY) || "";
      localStorage.removeItem(UI_LOG_PERSIST_KEY);
    } catch (_) {
      previousUiTail = "";
    }
  }

  function previousUiLogText() {
    return previousUiTail.trim();
  }

  function persistUiLog(line) {
    try {
      const current = localStorage.getItem(UI_LOG_PERSIST_KEY);
      const lines = current ? current.split("\n") : [];
      lines.push(line);
      if (lines.length > UI_LOG_PERSIST_LIMIT) {
        lines.splice(0, lines.length - UI_LOG_PERSIST_LIMIT);
      }
      localStorage.setItem(UI_LOG_PERSIST_KEY, lines.join("\n"));
    } catch (_) {}
  }

  function readPref(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value == null ? fallback : value;
    } catch (_) {
      return fallback;
    }
  }

  function writePref(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (_) {}
  }

  function loadPrefs() {
    const theme = readPref(PREF.theme, "auto");
    const accent = readPref(PREF.accent, "mint");
    const iconShape = readPref(PREF.iconShape, "circle");
    prefs.theme = ["auto", "dark", "light"].includes(theme) ? theme : "auto";
    prefs.accent = ["mint", "blue", "violet", "amber"].includes(accent) ? accent : "mint";
    prefs.iconShape = ["circle", "squircle", "rounded"].includes(iconShape) ? iconShape : "circle";
    prefs.showSystem = readPref(PREF.showSystem, "false") === "true";
    state.showSystem = prefs.showSystem;
  }

  const darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  let lastThemeLog = "";

  function resolvedTheme() {
    if (prefs.theme === "auto") return darkQuery && darkQuery.matches ? "dark" : "light";
    return prefs.theme;
  }

  function autoDarkActive() {
    if (!document.body) return false;
    const probe = document.createElement("div");
    probe.style.cssText = "display:none;background-color:canvas;color-scheme:light";
    document.body.appendChild(probe);
    let active = false;
    try {
      const bg = getComputedStyle(probe).backgroundColor;
      active = bg !== "rgb(255, 255, 255)" && bg !== "rgba(255, 255, 255, 1)";
    } catch (_) {}
    probe.remove();
    return active;
  }

  function applyTheme() {
    const theme = resolvedTheme();
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.accent = prefs.accent;
    document.documentElement.dataset.iconShape = prefs.iconShape;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#070b10" : "#eef4f9");
    const scheme = document.querySelector('meta[name="color-scheme"]');
    if (scheme) scheme.setAttribute("content", theme === "dark" ? "only dark" : "only light");
    if (lastThemeLog !== theme) {
      lastThemeLog = theme;
      webLog("theme", "resolved=" + theme + " autoDark=" + (autoDarkActive() ? "yes" : "no"));
    }
    document.querySelectorAll("[data-theme-choice]").forEach((button) => {
      button.classList.toggle("active", button.dataset.themeChoice === prefs.theme);
    });
    document.querySelectorAll("[data-accent-choice]").forEach((button) => {
      button.classList.toggle("active", button.dataset.accentChoice === prefs.accent);
    });
    document.querySelectorAll("[data-icon-shape-choice]").forEach((button) => {
      button.classList.toggle("active", button.dataset.iconShapeChoice === prefs.iconShape);
    });
  }

  function setTheme(value) {
    prefs.theme = ["auto", "dark", "light"].includes(value) ? value : "auto";
    writePref(PREF.theme, prefs.theme);
    applyTheme();
    webLog("prefs", "theme=" + prefs.theme);
  }

  function setAccent(value) {
    prefs.accent = ["mint", "blue", "violet", "amber"].includes(value) ? value : "mint";
    writePref(PREF.accent, prefs.accent);
    applyTheme();
    webLog("prefs", "accent=" + prefs.accent);
  }

  function setIconShape(value) {
    prefs.iconShape = ["circle", "squircle", "rounded"].includes(value) ? value : "circle";
    writePref(PREF.iconShape, prefs.iconShape);
    applyTheme();
    webLog("prefs", "iconShape=" + prefs.iconShape);
  }

  function setShowSystem(value) {
    prefs.showSystem = !!value;
    state.showSystem = prefs.showSystem;
    writePref(PREF.showSystem, prefs.showSystem);
    updateMenuState();
    const checkbox = $("settingsShowSystem");
    if (checkbox) checkbox.checked = prefs.showSystem;
    renderApps();
    webLog("prefs", "showSystem=" + prefs.showSystem);
  }

  // ---------- shell and utility ----------

  function q(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function b64encode(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function webLog(level, message) {
    const now = new Date();
    const stamp = now.toISOString().replace("T", " ").replace("Z", "");
    const kind = String(level || "info");
    const line = stamp + " [" + kind + "] " + String(message || "");
    state.uiLog.push(line);
    if (state.uiLog.length > UI_LOG_LIMIT) {
      state.uiLog.splice(0, state.uiLog.length - UI_LOG_LIMIT);
    }
    if (UI_LOG_PERSIST_LEVELS.has(kind)) persistUiLog(line);
    try { console.debug("[FileHider WebUI]", line); } catch (_) {}
  }

  function uiLogText() {
    return state.uiLog.length ? state.uiLog.join("\n") : "(no WebUI activity)";
  }

  function toast(message, isError) {
    const el = $("toast");
    if (!el) return;
    el.textContent = message;
    el.className = "show" + (isError ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = ""; }, 2900);
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  function scrollDocumentTo(top) {
    const y = Math.max(0, Number(top) || 0);
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    try { window.scrollTo(0, y); } catch (_) {}
    root.style.scrollBehavior = previous;
  }

  // ---------- overlay/background scroll lock ----------

  let overlayScrollY = 0;
  let overlayLocked = false;

  function syncOverlayLock() {
    const anyOpen = !!document.querySelector(".modal.open");
    if (anyOpen === overlayLocked) return;
    if (anyOpen) {
      overlayScrollY = Number(window.scrollY || document.documentElement.scrollTop || 0);
      document.documentElement.classList.add("overlay-open");
      document.body.classList.add("overlay-open");
      overlayLocked = true;
      return;
    }
    document.documentElement.classList.remove("overlay-open");
    document.body.classList.remove("overlay-open");
    overlayLocked = false;
    const restore = overlayScrollY;
    requestAnimationFrame(() => scrollDocumentTo(restore));
  }

  // ---------- in-page confirmation ----------

  let confirmOpen = false;
  let confirmResolver = null;
  let confirmReturnFocus = null;
  let confirmGuardActive = false;
  let confirmGuardClosing = false;
  let confirmGuardComplete = null;
  let confirmGuardTimer = 0;
  let confirmHistoryBack = null;

  function pushConfirmHistoryGuard() {
    if (confirmGuardActive) return;
    try {
      navDepth += 1;
      history.pushState(historyEntry(currentRoute(), navDepth), "", historyUrl());
      confirmGuardActive = true;
    } catch (_) {
      navDepth = Math.max(0, navDepth - 1);
    }
  }

  function finishConfirmClose(value, resolve) {
    webLog("ui", "confirm " + (value ? "accepted" : "cancelled"));
    if (resolve) resolve(!!value);
    const focus = confirmReturnFocus;
    confirmReturnFocus = null;
    if (focus && document.contains(focus)) {
      setTimeout(() => { try { focus.focus(); } catch (_) {} }, 0);
    }
  }

  function clearConfirmGuardTimer() {
    if (confirmGuardTimer) {
      clearTimeout(confirmGuardTimer);
      confirmGuardTimer = 0;
    }
  }

  function uiConfirm(options) {
    const opts = options && typeof options === "object" ? options : {};
    if (confirmOpen) return Promise.resolve(false);
    const modal = $("confirmModal");
    if (!modal) return Promise.resolve(false);
    const guardHistory = opts.guardHistory !== false;

    const accept = $("confirmAccept");
    const cancel = $("confirmCancel");
    $("confirmIcon").textContent = opts.icon || "!";
    $("confirmTitle").textContent = opts.title || "Confirm";
    $("confirmMessage").textContent = opts.message || "";
    accept.textContent = opts.confirmLabel || "Continue";
    cancel.textContent = opts.cancelLabel || "Cancel";
    accept.className = "btn " + (opts.danger === false ? "primary" : "danger");
    confirmReturnFocus = document.activeElement;
    modal.classList.add("open");
    confirmOpen = true;
    confirmHistoryBack = typeof opts.onHistoryBack === "function" ? opts.onHistoryBack : null;
    if (guardHistory) pushConfirmHistoryGuard();
    syncOverlayLock();
    webLog("ui", "confirm opened: " + String(opts.title || "Confirm") +
      " guard=" + (guardHistory ? "1" : "0"));
    setTimeout(() => { try { cancel.focus(); } catch (_) {} }, 30);

    return new Promise((resolve) => {
      confirmResolver = resolve;
    });
  }

  function closeConfirm(value, options) {
    if (!confirmOpen) return false;
    const fromHistory = !!(options && options.fromHistory);
    confirmOpen = false;
    const modal = $("confirmModal");
    if (modal) modal.classList.remove("open");
    syncOverlayLock();
    const resolve = confirmResolver;
    const historyBack = confirmHistoryBack;
    confirmResolver = null;
    confirmHistoryBack = null;
    const finish = () => finishConfirmClose(value, resolve);
    const guarded = confirmGuardActive;
    confirmGuardActive = false;

    if (guarded && !fromHistory) {
      confirmGuardClosing = true;
      confirmGuardComplete = finish;
      clearConfirmGuardTimer();
      confirmGuardTimer = setTimeout(() => {
        confirmGuardTimer = 0;
        if (!confirmGuardClosing) return;
        confirmGuardClosing = false;
        confirmGuardComplete = null;
        navDepth = Math.max(0, navDepth - 1);
        finish();
      }, 350);
      try {
        history.back();
        return true;
      } catch (_) {
        clearConfirmGuardTimer();
        confirmGuardClosing = false;
        confirmGuardComplete = null;
        navDepth = Math.max(0, navDepth - 1);
      }
    }

    finish();
    if (fromHistory && historyBack) historyBack();
    return true;
  }

  // KernelSU and APatch expose:
  //   ksu.exec(command, optionsJsonString, callbackNameString)
  // The manager later evaluates <callbackName>(errno, stdout, stderr).
  let callbackSeq = 0;

  function run(command) {
    return new Promise((resolve) => {
      if (!hasBridge) {
        resolve({ errno: -1, stdout: "", stderr: "no shell bridge" });
        return;
      }
      const name = "__filehider_cb_" + Date.now() + "_" + (callbackSeq++);
      let settled = false;
      const cleanup = () => {
        try { delete window[name]; } catch (_) {}
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ errno: -1, stdout: "", stderr: "shell command timed out" });
      }, 45000);
      window[name] = (errno, stdout, stderr) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve({ errno: Number(errno) || 0, stdout: stdout || "", stderr: stderr || "" });
      };
      try {
        bridge.exec(command, "{}", name);
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve({ errno: -1, stdout: "", stderr: String(error) });
      }
    });
  }

  function selectElementText(el) {
    if (!el) return;
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (_) {}
  }

  async function copyText(text, fallbackEl) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) {}
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "-9999px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    let copied = false;
    try {
      area.focus();
      area.select();
      area.setSelectionRange(0, area.value.length);
      copied = document.execCommand("copy");
    } catch (_) {}
    area.remove();
    if (!copied && fallbackEl) selectElementText(fallbackEl);
    return copied;
  }

  function normalizePath(path) {
    let p = String(path || "").trim();
    if (!p.startsWith("/")) return "";
    p = p.replace(/\/{2,}/g, "/");
    if (p.length > 1) p = p.replace(/\/+$/, "");
    return p;
  }

  function appVisiblePath(path) {
    const p = normalizePath(path);
    if (!p) return "";
    let match = p.match(/^\/data\/media\/(\d+)(\/.*)?$/);
    if (match) return "/storage/emulated/" + match[1] + (match[2] || "");
    match = p.match(/^\/mnt\/user\/(\d+)\/primary(\/.*)?$/);
    if (match) return "/storage/emulated/" + match[1] + (match[2] || "");
    if (p === "/sdcard" || p === "/storage/self/primary") return "/storage/emulated/0";
    if (p.startsWith("/sdcard/")) return "/storage/emulated/0/" + p.slice("/sdcard/".length);
    if (p.startsWith("/storage/self/primary/")) return "/storage/emulated/0/" + p.slice("/storage/self/primary/".length);
    return p;
  }

  function normalizeBrowserPath(path) {
    return appVisiblePath(normalizePath(path) || "/") || "/";
  }

  function browserSourcePath(logical) {
    const match = logical.match(/^\/storage\/emulated(?:\/(\d+))?(\/.*)?$/);
    if (!match) return logical;
    if (match[1]) return "/data/media/" + match[1] + (match[2] || "");
    return "/data/media";
  }

  function storageAliases(path) {
    const raw = normalizePath(path);
    const out = [];
    const add = (value) => {
      if (value && !out.includes(value)) out.push(value);
    };
    const addUser = (user, rest) => {
      add("/storage/emulated/" + user + rest);
      add("/data/media/" + user + rest);
      add("/mnt/user/" + user + "/primary" + rest);
      if (user === "0") add("/sdcard" + rest);
    };
    add(raw);
    if (!raw) return out;
    let match = raw.match(/^\/data\/media\/(\d+)(\/.*)?$/);
    if (match) { addUser(match[1], match[2] || ""); return out; }
    match = raw.match(/^\/storage\/emulated\/(\d+)(\/.*)?$/);
    if (match) { addUser(match[1], match[2] || ""); return out; }
    match = raw.match(/^\/mnt\/user\/(\d+)\/primary(\/.*)?$/);
    if (match) { addUser(match[1], match[2] || ""); return out; }
    if (raw === "/sdcard" || raw === "/storage/self/primary") addUser("0", "");
    else if (raw.startsWith("/sdcard/")) addUser("0", "/" + raw.slice("/sdcard/".length));
    else if (raw.startsWith("/storage/self/primary/")) addUser("0", "/" + raw.slice("/storage/self/primary/".length));
    return out;
  }

  function resolveTargetPath(linkPath, target) {
    let value = String(target || "");
    if (!value) return "";
    if (!value.startsWith("/")) {
      const base = linkPath.slice(0, linkPath.lastIndexOf("/")) || "/";
      value = base + "/" + value;
    }
    const parts = [];
    for (const part of value.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") { if (parts.length) parts.pop(); continue; }
      parts.push(part);
    }
    return "/" + parts.join("/");
  }

  function hashHue(value) {
    let h = 0;
    for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  function appLabel(app) {
    const label = String(app && app.label ? app.label : "").trim();
    return label || (app && app.pkg) || "Unknown app";
  }

  function appByPkg(pkg) {
    return state.apps.find((app) => app.pkg === pkg) || null;
  }

  function iconInner(app) {
    const label = appLabel(app);
    const letter = (label.replace(/[^A-Za-z0-9]/g, "").charAt(0) || "?").toUpperCase();
    const src = app && app.pkg ? "ksu://icon/" + escapeHtml(app.pkg) : "";
    return '<span class="monogram">' + escapeHtml(letter) + '</span>' +
      (src ? '<img class="app-icon" loading="lazy" alt="" src="' + src + '" onerror="this.remove()">' : "");
  }

  function avatarStyle(pkg) {
    return "--h:" + hashHue(pkg || "app");
  }
