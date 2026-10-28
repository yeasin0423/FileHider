"use strict";

/* FileHider WebUI: app list rendering and package loading. */

  // ---------- app list ----------

  function appRowHtml(app) {
    const pkg = app.pkg;
    const paths = state.rules.get(pkg) || new Set();
    const active = isAppActive(pkg);
    const disabled = state.disabled.has(pkg) && paths.size > 0;
    const noPaths = paths.size === 0;
    const label = appLabel(app);
    const badges = [];
    if (app.isSystem) badges.push('<span class="badge system">system</span>');
    if (disabled) badges.push('<span class="badge off">inactive</span>');
    if (app.missing) badges.push('<span class="badge danger">not installed</span>');
    const count = paths.size
      ? '<span class="count-pill' + (disabled ? " off" : "") + '">' + paths.size + '</span>'
      : "";
    return '<div class="app-row' + (disabled ? " inactive" : "") + (app.missing ? " missing" : "") + '"' +
      ' data-pkg="' + escapeHtml(pkg) + '" role="button" tabindex="0"' +
      ' aria-label="' + escapeHtml(label + ", " + pkg + (active ? ", active" : disabled ? ", inactive" : ", no paths")) + '">' +
      '<label class="app-check" title="' + (noPaths ? "Add a path first" : (active ? "Set inactive" : "Set active")) + '">' +
      '<input type="checkbox" data-toggle="' + escapeHtml(pkg) + '"' + (active ? " checked" : "") +
      (noPaths ? " disabled" : "") + '>' +
      '<span></span></label>' +
      '<div class="avatar" style="' + avatarStyle(pkg) + '" aria-hidden="true">' + iconInner(app) + '</div>' +
      '<div class="app-main"><div class="app-name">' + escapeHtml(label) + '</div>' +
      '<div class="app-pkg">' + escapeHtml(pkg) + '</div></div>' +
      '<div class="app-tail">' + badges.join("") + count + '<span class="chevron">' + ICONS.chevron + '</span></div>' +
      '</div>';
  }

  function renderApps() {
    const container = $("appList");
    if (!container) return;
    if (!state.apps.length) {
      container.innerHTML = '<div class="empty">' +
        (hasBridge ? "No installed apps were returned. Try Reload or check root bridge access." : "Open this page from the KernelSU or APatch module WebUI.") +
        '</div>';
      $("appCount").textContent = "No apps";
      return;
    }

    const term = String($("appSearch") && $("appSearch").value || "").trim().toLowerCase();
    const visible = state.apps.filter((app) => {
      if (app.isSystem && !state.showSystem && !isConfigured(app.pkg)) return false;
      if (!term) return true;
      return app.pkg.toLowerCase().includes(term) || appLabel(app).toLowerCase().includes(term);
    }).sort((a, b) => {
      const configuredA = isConfigured(a.pkg) ? 0 : 1;
      const configuredB = isConfigured(b.pkg) ? 0 : 1;
      if (configuredA !== configuredB) return configuredA - configuredB;
      return appLabel(a).localeCompare(appLabel(b), undefined, { sensitivity: "base" });
    });

    if (!visible.length) {
      container.innerHTML = '<div class="empty">No app matches this search.</div>';
    } else {
      container.innerHTML = visible.slice(0, 1000).map(appRowHtml).join("");
    }
    $("appCount").textContent = visible.length + " app" + (visible.length === 1 ? "" : "s");
    updateStatus();
  }

  // ---------- app loading ----------

  function parsePackageLines(text) {
    return String(text || "").split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("package:"))
      .map((line) => line.slice(8).trim())
      .filter(Boolean);
  }

  function shortPackageList(values) {
    if (!values.length) return "-";
    const shown = values.slice(0, 12).join(",");
    return values.length > 12 ? shown + " +" + (values.length - 12) : shown;
  }

  async function listPackages() {
    // pm is authoritative and not cached by the manager process. The manager
    // bridge package list can stay stale until the manager activity restarts.
    const result = await run("/system/bin/pm list packages 2>/dev/null");
    if (result.errno === 0) {
      const live = parsePackageLines(result.stdout);
      if (live.length) return { source: "pm", packages: live };
    }
    if (bridge && typeof bridge.listPackages === "function") {
      try {
        let raw = bridge.listPackages("all");
        if (raw && typeof raw.then === "function") raw = await raw;
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed) && parsed.length) {
          return {
            source: "manager",
            packages: parsed.map((item) => typeof item === "string" ? item : item && item.packageName)
              .filter(Boolean),
          };
        }
      } catch (_) {}
    }
    return { source: "none", packages: [] };
  }

  async function getPackageInfos(packages) {
    if (!packages.length || !bridge || typeof bridge.getPackagesInfo !== "function") return [];
    try {
      let raw = bridge.getPackagesInfo(JSON.stringify(packages));
      if (raw && typeof raw.then === "function") raw = await raw;
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object") return [parsed];
    } catch (_) {}
    return [];
  }

  async function getSystemPackages() {
    const result = await run("/system/bin/pm list packages -s 2>/dev/null");
    return new Set(parsePackageLines(result.stdout));
  }

  async function loadApps(options = {}) {
    const container = $("appList");
    if (!container) return;
    const request = ++appsLoadSeq;
    const announce = !!options.announce;
    const previous = new Map(state.apps.map((app) => [app.pkg, app]));
    container.innerHTML = '<div class="loading"><span class="spinner"></span><span>Reading installed apps…</span></div>';
    $("appCount").textContent = "Loading apps…";

    let snapshot = { source: "none", packages: [] };
    try {
      snapshot = await listPackages();
    } catch (error) {
      webLog("apps", "package query failed: " + String(error && error.message || error));
    }
    if (request !== appsLoadSeq) return;

    if (!snapshot.packages.length) {
      state.apps = [];
      state.appsSource = snapshot.source;
      renderApps();
      webLog("apps", "refresh source=" + snapshot.source + " count=0");
      if (announce) toast("No apps found. Check root bridge access.", true);
      return;
    }

    const unique = Array.from(new Set(snapshot.packages.filter(Boolean))).sort();
    const infos = await getPackageInfos(unique);
    if (request !== appsLoadSeq) return;
    const infoByPkg = new Map();
    for (const info of infos) {
      if (info && info.packageName) infoByPkg.set(info.packageName, info);
    }

    let systemPackages = null;
    if (!infos.some((info) => info && typeof info.isSystem === "boolean")) {
      systemPackages = await getSystemPackages();
      if (request !== appsLoadSeq) return;
    }

    const seen = new Set();
    const apps = [];
    for (const pkg of unique) {
      const info = infoByPkg.get(pkg) || {};
      const prior = previous.get(pkg);
      const isSystem = typeof info.isSystem === "boolean"
        ? info.isSystem
        : (prior && typeof prior.isSystem === "boolean"
          ? prior.isSystem
          : !!(systemPackages && systemPackages.has(pkg)));
      const label = String(info.appLabel || "").trim() || (prior && prior.label) || pkg;
      seen.add(pkg);
      apps.push({ pkg, label, isSystem, missing: false });
    }

    // Keep configured apps visible even if they were uninstalled. The user can
    // still open the detail page and remove their rules.
    for (const pkg of new Set([...state.rules.keys(), ...state.disabled])) {
      if (!seen.has(pkg)) {
        const prior = previous.get(pkg);
        apps.push({
          pkg,
          label: prior && prior.label ? prior.label : pkg,
          isSystem: prior ? !!prior.isSystem : false,
          missing: true,
        });
      }
    }

    const beforePkgs = new Set(previous.keys());
    const afterPkgs = new Set(apps.map((app) => app.pkg));
    const added = apps.filter((app) => !beforePkgs.has(app.pkg)).map((app) => app.pkg);
    const removed = Array.from(beforePkgs).filter((pkg) => !afterPkgs.has(pkg));
    const missing = apps.filter((app) => app.missing).length;

    state.apps = apps;
    state.appsSource = snapshot.source;
    renderApps();
    updateStatus();
    webLog(
      snapshot.source === "pm" ? "info" : "warn",
      "apps refresh source=" + snapshot.source + " count=" + apps.length +
      " infos=" + infoByPkg.size + " missing=" + missing +
      " added=" + shortPackageList(added) + " removed=" + shortPackageList(removed)
    );
    if (announce) {
      toast("App list refreshed: " + apps.length + " app" + (apps.length === 1 ? "" : "s"));
    }
  }
