"use strict";

/* FileHider WebUI: startup. */

  // ---------- startup ----------

  async function start() {
    capturePreviousUiLog();
    loadPrefs();
    applyTheme();
    updateMenuState();
    renderSettings();
    bindEvents();
    initNavigation();
    showView("home");
    webLog("webui", "start asset=3.2 bridge=" + (hasBridge ? "yes" : "no") +
      " theme=" + prefs.theme + " accent=" + prefs.accent +
      " iconShape=" + prefs.iconShape + " showSystem=" + prefs.showSystem);

    if (!hasBridge) {
      $("noBridge").hidden = false;
      $("appCount").textContent = "No apps";
      $("appList").innerHTML = '<div class="empty">Open this page from KernelSU or APatch to load apps and read the config.</div>';
      updateStatus();
      return;
    }

    try {
      if (typeof bridge.fullScreen === "function") bridge.fullScreen(false);
    } catch (_) {}
    try {
      await detectModule();
      await loadRules();
      await loadApps();
      renderSettings();
      updateStatus();
      webLog("webui", "startup complete apps=" + state.apps.length + " source=" + (state.appsSource || "-"));
    } catch (error) {
      webLog("error", "startup failed: " + String(error && error.message || error));
      toast("Could not load app list: " + String(error && error.message || error), true);
      renderApps();
      updateStatus();
    }
  }

  window.addEventListener("error", (event) => {
    webLog("error", "javascript: " + String(event.message || "unknown") +
      " @ " + String(event.filename || "?") + ":" + String(event.lineno || 0));
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event && event.reason;
    webLog("error", "unhandled rejection: " + String(reason && reason.message || reason || "unknown"));
  });

  start();
