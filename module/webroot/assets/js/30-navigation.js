"use strict";

/* FileHider WebUI: views, overlays, browser-history routing, and back handling. */

let navDepth = 0;
let historySeq = 0;
let pendingDiscard = null;
let pendingDiscardTimer = 0;
let pendingRestoreDetail = false;
let pendingRestoreTimer = 0;
let menuGuardActive = false;
let menuGuardPopping = false;
let pendingMenuAction = null;

const FORWARD_RESTORE_TIMEOUT = 400;

function closeMenu() {
  const menu = $("overflowMenu");
  if (menu) menu.hidden = true;
  const button = $("menuBtn");
  if (button) button.setAttribute("aria-expanded", "false");
}

function openMenu() {
  const menu = $("overflowMenu");
  const button = $("menuBtn");
  if (!menu || !menu.hidden) return;
  menu.hidden = false;
  if (button) button.setAttribute("aria-expanded", "true");
  if (state.view !== "home" || menuGuardActive) return;
  try {
    history.pushState(
      historyEntry(normalizeRoute({ view: "home" }), 0, { homeGuard: true }),
      "",
      historyUrl()
    );
    menuGuardActive = true;
  } catch (_) {}
}

function popMenuGuard(action) {
  if (!menuGuardActive) {
    if (action) action();
    return;
  }
  menuGuardActive = false;
  pendingMenuAction = action || null;
  menuGuardPopping = true;
  try {
    history.back();
  } catch (_) {
    menuGuardPopping = false;
    const pending = pendingMenuAction;
    pendingMenuAction = null;
    if (pending) pending();
  }
}

function closeMenuWithGuard() {
  const guarded = menuGuardActive;
  closeMenu();
  if (guarded) popMenuGuard(null);
}

function replaceMenuRoute(route) {
  const next = normalizeRoute(route);
  menuGuardActive = false;
  navDepth = 1;
  try {
    history.replaceState(historyEntry(next, navDepth), "", historyUrl());
  } catch (_) {
    pendingMenuAction = () => pushRoute(next);
    menuGuardPopping = true;
    try {
      history.back();
    } catch (_) {
      menuGuardPopping = false;
      pendingMenuAction = null;
      pushRoute(next);
    }
    return;
  }
  webLog("nav", "replace menu route " + routeKey(next));
  renderRoute(next);
}

function runMenuAction(action) {
  if (action === "system") setShowSystem(!prefs.showSystem);
  else if (action === "help") showHelp();
  else if (action === "logs") showLogs();
  else if (action === "settings") showSettings();
  else if (action === "reload") reloadAll();
}

function toggleMenu() {
  const menu = $("overflowMenu");
  if (!menu) return;
  if (menu.hidden) openMenu();
  else closeMenuWithGuard();
}

function updateMenuState() {
  const check = $("menuSystemCheck");
  if (check) {
    check.textContent = "✓";
    check.classList.toggle("off", !prefs.showSystem);
  }
  const item = $("menuSystem");
  if (item) item.setAttribute("aria-checked", prefs.showSystem ? "true" : "false");
}

function openModalName() {
  if ($("browserModal") && $("browserModal").classList.contains("open")) return "browser";
  if ($("logsModal") && $("logsModal").classList.contains("open")) return "logs";
  if ($("importModal") && $("importModal").classList.contains("open")) return "import";
  return "";
}

function normalizeRoute(route) {
  const value = route && typeof route === "object" ? route : {};
  let view = ["home", "detail", "settings", "help"].includes(value.view) ? value.view : "home";
  let pkg = view === "detail" ? String(value.pkg || state.currentPkg || "") : "";
  if (view === "detail" && !pkg) view = "home";
  const modal = ["browser", "logs", "import"].includes(value.modal) ? value.modal : "";
  return { view, pkg, modal };
}

function currentRoute() {
  return normalizeRoute({
    view: state.view,
    pkg: state.currentPkg,
    modal: openModalName(),
  });
}

function routeKey(route) {
  return route.view + "|" + route.pkg + "|" + route.modal;
}

function historyEntry(route, depth, flags) {
  return Object.assign({ __filehider: true, depth, route }, flags || {});
}

function historyBaseUrl() {
  return location.href.split("#")[0];
}

function historyUrl() {
  historySeq += 1;
  return historyBaseUrl() + "#fh-" + historySeq;
}

function initNavigation() {
  navDepth = 0;
  try {
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
    const base = historyBaseUrl();
    const home = normalizeRoute({ view: "home" });
    // Home is the resting entry. Do not leave a permanent guard above it:
    // when the manager's canGoBack is false, Android back closes the WebUI
    // on the first press. Transient guards are added only for dialogs and
    // the home overflow menu.
    history.replaceState(historyEntry(home, 0, { root: true }), "", base);
  } catch (_) {}
  webLog("nav", "history init length=" + history.length);
  window.addEventListener("popstate", onPopState);
}

function closeModalsExcept(keep) {
  if (keep !== "browser") closeBrowserNow();
  if (keep !== "logs") closeLogsNow();
  if (keep !== "import") closeImportNow();
}

function renderRoute(route) {
  const next = normalizeRoute(route);
  webLog("nav", "render view=" + next.view + " pkg=" + (next.pkg || "-") + " modal=" + (next.modal || "-"));
  closeMenu();
  closeModalsExcept(next.modal || "");

  if (next.view === "home") {
    state.currentPkg = "";
    renderApps();
    showView("home");
    if (next.modal === "logs") openLogsNow();
    return;
  }

  if (next.view === "detail") {
    if (!next.pkg) {
      state.currentPkg = "";
      showView("home");
      renderApps();
      return;
    }
    if (state.currentPkg !== next.pkg || state.view !== "detail") {
      state.currentPkg = next.pkg;
      state.presetOpen = new Set();
      state.draftPaths = new Set(state.rules.get(next.pkg) || []);
      state.draftDisabled = state.disabled.has(next.pkg);
      state.detailDirty = false;
      renderDetail();
    }
    showView("detail");
    if (next.modal === "browser") openBrowserNow(state.browserDir || "/");
    else if (next.modal === "logs") openLogsNow();
    return;
  }

  if (next.view === "settings") {
    state.currentPkg = "";
    renderSettings();
    showView("settings");
    if (next.modal === "logs") openLogsNow();
    else if (next.modal === "import") openImportNow();
    return;
  }

  state.currentPkg = "";
  showView("help");
  if (next.modal === "logs") openLogsNow();
}

function pushRoute(route) {
  const next = normalizeRoute(route);
  if (menuGuardActive) {
    replaceMenuRoute(next);
    return;
  }
  if (routeKey(next) === routeKey(currentRoute())) {
    renderRoute(next);
    return;
  }
  navDepth += 1;
  webLog("nav", "push " + routeKey(next) + " depth=" + navDepth);
  try {
    history.pushState(historyEntry(next, navDepth), "", historyUrl());
  } catch (_) {}
  renderRoute(next);
}

function goHistoryBack() {
  if (navDepth <= 0) return false;
  try {
    history.back();
    return true;
  } catch (_) {
    navDepth = Math.max(0, navDepth - 1);
    return false;
  }
}

function goHomeRoot() {
  if (navDepth > 0) {
    try {
      history.go(-navDepth);
      return;
    } catch (_) {}
  }
  renderRoute({ view: "home" });
}

function exitWebUI() {
  const api = bridge && (typeof bridge.exit === "function" ? bridge.exit
    : typeof bridge.close === "function" ? bridge.close : null);
  if (api) {
    try {
      api.call(bridge);
      return true;
    } catch (_) {}
  }
  if (goHistoryBack()) return true;
  toast("Use Android back to close this screen");
  return false;
}

function dismissModal(name) {
  if (openModalName() !== name) {
    if (name === "browser") closeBrowserNow();
    else if (name === "logs") closeLogsNow();
    else if (name === "import") closeImportNow();
    return;
  }
  if (!goHistoryBack()) {
    if (name === "browser") closeBrowserNow();
    else if (name === "logs") closeLogsNow();
    else if (name === "import") closeImportNow();
  }
}

function closeAllModalsNow() {
  closeBrowserNow();
  closeLogsNow();
  closeImportNow();
}

function restoreRouteAfterCancelledBack(stateObject) {
  navDepth = (stateObject ? Number(stateObject.depth) || 0 : 0) + 1;
  try {
    history.pushState(historyEntry(currentRoute(), navDepth), "", historyUrl());
  } catch (_) {}
}

function clearPendingDiscardTimer() {
  if (pendingDiscardTimer) {
    clearTimeout(pendingDiscardTimer);
    pendingDiscardTimer = 0;
  }
}

function clearPendingRestoreTimer() {
  if (pendingRestoreTimer) {
    clearTimeout(pendingRestoreTimer);
    pendingRestoreTimer = 0;
  }
}

function restoreDetailEntry() {
  pendingRestoreDetail = true;
  webLog("nav", "discard back: forward-restoring detail entry");
  clearPendingRestoreTimer();
  pendingRestoreTimer = setTimeout(() => {
    pendingRestoreTimer = 0;
    if (!pendingRestoreDetail) return;
    pendingRestoreDetail = false;
    webLog("nav", "detail forward restore missed; using fallback");
    restoreRouteAfterCancelledBack(null);
  }, FORWARD_RESTORE_TIMEOUT);
  try {
    history.forward();
  } catch (_) {
    clearPendingRestoreTimer();
    pendingRestoreDetail = false;
    webLog("nav", "detail forward restore failed; using fallback");
    restoreRouteAfterCancelledBack(null);
  }
}

function queueDiscardConfirm(stateObject) {
  pendingDiscard = { depth: stateObject ? Number(stateObject.depth) || 0 : 0 };
  clearPendingDiscardTimer();
  pendingDiscardTimer = setTimeout(() => {
    pendingDiscardTimer = 0;
    if (!pendingDiscard) return;
    pendingDiscard = null;
    webLog("nav", "discard forward restore missed; using fallback");
    restoreRouteAfterCancelledBack(stateObject);
    showDiscardConfirmFromBack();
  }, FORWARD_RESTORE_TIMEOUT);
  try {
    history.forward();
  } catch (_) {
    clearPendingDiscardTimer();
    pendingDiscard = null;
    webLog("nav", "discard forward restore failed; using fallback");
    restoreRouteAfterCancelledBack(stateObject);
    showDiscardConfirmFromBack();
  }
}

async function showDiscardConfirmFromBack() {
  clearPendingDiscardTimer();
  const okay = await uiConfirm({
    title: "Discard unsaved changes?",
    message: "Your path edits on this app have not been saved.",
    confirmLabel: "Discard",
    cancelLabel: "Keep editing",
    danger: true,
    guardHistory: false,
    onHistoryBack: restoreDetailEntry,
  });
  if (!okay) return;
  state.detailDirty = false;
  if (goHistoryBack()) return;
  renderRoute({ view: "home" });
}

async function onPopState(event) {
  const stateObject = event.state && event.state.__filehider ? event.state : null;
  const target = normalizeRoute(stateObject ? stateObject.route : { view: "home" });
  const targetDepth = stateObject ? Number(stateObject.depth) || 0 : 0;

  webLog("nav", "pop target=" + routeKey(target) + " depth=" + targetDepth +
    " length=" + history.length + " confirm=" + (confirmOpen ? "1" : "0") +
    " pending=" + (pendingRestoreDetail ? "restore" : pendingDiscard ? "discard" : "-"));

  if (menuGuardPopping) {
    menuGuardPopping = false;
    navDepth = targetDepth;
    const action = pendingMenuAction;
    pendingMenuAction = null;
    if (action) {
      try { action(); } catch (error) {
        webLog("error", "menu action failed: " + String(error && error.message || error));
      }
    }
    return;
  }

  if (confirmGuardClosing) {
    confirmGuardClosing = false;
    navDepth = targetDepth;
    clearConfirmGuardTimer();
    const complete = confirmGuardComplete;
    confirmGuardComplete = null;
    if (complete) complete();
    return;
  }

  if (pendingRestoreDetail) {
    clearPendingRestoreTimer();
    pendingRestoreDetail = false;
    if (target.view === "detail" && target.pkg === state.currentPkg) {
      navDepth = targetDepth;
      webLog("nav", "detail restored after confirm back");
      return;
    }
    webLog("nav", "detail restore forward missed target; rendering target");
  }

  if (confirmOpen) {
    navDepth = targetDepth;
    closeConfirm(false, { fromHistory: true });
    return;
  }

  if (pendingDiscard) {
    clearPendingDiscardTimer();
    pendingDiscard = null;
    if (target.view === "detail" && target.pkg === state.currentPkg) {
      navDepth = targetDepth;
      webLog("nav", "discard confirm opened from back");
      showDiscardConfirmFromBack();
      return;
    }
    webLog("nav", "discard forward missed target; rendering target");
  }

  if ($("overflowMenu") && !$("overflowMenu").hidden) {
    const guardedHome = menuGuardActive;
    menuGuardActive = false;
    closeMenu();
    if (guardedHome) {
      navDepth = targetDepth;
      return;
    }
    if (state.view === "home" && stateObject && stateObject.root) {
      navDepth = targetDepth;
      return;
    }
    restoreRouteAfterCancelledBack(stateObject);
    return;
  }

  if (state.view === "detail" && state.detailDirty &&
      (target.view !== "detail" || target.pkg !== state.currentPkg)) {
    // Never push while handling popstate. The detail entry is already in
    // forward history; re-enter it before showing the guardless discard
    // dialog. This keeps the manager's native canGoBack state intact.
    webLog("nav", "dirty detail back; queue forward restore");
    queueDiscardConfirm(stateObject);
    return;
  }

  if (stateObject && stateObject.root && state.view === "home" && !openModalName()) {
    webLog("nav", "home root reached; exit requested");
    navDepth = targetDepth;
    exitWebUI();
    return;
  }

  navDepth = targetDepth;
  webLog("nav", "pop " + routeKey(target) + " depth=" + navDepth);
  renderRoute(target);
}

function showView(view) {
  const nextKey = view + (view === "detail" ? ":" + state.currentPkg : "");
  const previousKey = state.viewKey;
  if (previousKey === "home" && nextKey !== "home") {
    state.homeScroll = Number(window.scrollY || document.documentElement.scrollTop || 0);
  }
  state.view = view;
  $("homeView").hidden = view !== "home";
  $("detailView").hidden = view !== "detail";
  $("settingsView").hidden = view !== "settings";
  $("helpView").hidden = view !== "help";
  const backButton = $("backBtn");
  if (backButton) {
    backButton.hidden = false;
    backButton.setAttribute("aria-label", view === "home" ? "Close WebUI" : "Go back");
    backButton.title = view === "home" ? "Close WebUI" : "Go back";
  }
  closeMenu();
  if (view === "home") {
    $("viewTitle").textContent = "File Hider";
    $("viewSub").textContent = ruleSummary();
  } else if (view === "detail") {
    const app = appByPkg(state.currentPkg);
    $("viewTitle").textContent = app ? appLabel(app) : "App rules";
    $("viewSub").textContent = state.currentPkg || "Application rules";
  } else if (view === "settings") {
    $("viewTitle").textContent = "Settings";
    $("viewSub").textContent = "Appearance & maintenance";
  } else {
    $("viewTitle").textContent = "Help & setup";
    $("viewSub").textContent = "Guide and limitations";
  }
  if (previousKey !== nextKey) {
    const target = nextKey === "home" ? state.homeScroll : 0;
    scrollDocumentTo(target);
    requestAnimationFrame(() => requestAnimationFrame(() => scrollDocumentTo(target)));
  }
  state.viewKey = nextKey;
}

function openDetail(pkg) {
  if (!pkg) return;
  pushRoute({ view: "detail", pkg });
}

async function confirmDiscardDraft() {
  if (state.view === "detail" && state.detailDirty) {
    const okay = await uiConfirm({
      title: "Discard unsaved changes?",
      message: "Your path edits on this app have not been saved.",
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      danger: true,
      guardHistory: false,
      onHistoryBack: restoreDetailEntry,
    });
    if (!okay) return false;
    state.detailDirty = false;
  }
  return true;
}

async function showSettings() {
  if (!(await confirmDiscardDraft())) return;
  pushRoute({ view: "settings" });
}

async function showHelp() {
  if (!(await confirmDiscardDraft())) return;
  pushRoute({ view: "help" });
}

function openBrowser(dir) {
  if (!state.currentPkg) return;
  state.browserDir = normalizeBrowserPath(dir || "/");
  pushRoute({ view: "detail", pkg: state.currentPkg, modal: "browser" });
}

function showLogs() {
  pushRoute({ view: state.view, pkg: state.currentPkg, modal: "logs" });
}

function closeLogs() {
  dismissModal("logs");
}

function openImport() {
  pushRoute({ view: "settings", modal: "import" });
}

function closeImport() {
  dismissModal("import");
}

async function back() {
  if (confirmOpen) {
    closeConfirm(false);
    return;
  }
  const modal = openModalName();
  if (modal) {
    dismissModal(modal);
    return;
  }
  if ($("overflowMenu") && !$("overflowMenu").hidden) {
    closeMenuWithGuard();
    return;
  }
  if (!(await confirmDiscardDraft())) return;
  if (goHistoryBack()) return;
  if (state.view !== "home") {
    renderRoute({ view: "home" });
    return;
  }
  exitWebUI();
}
