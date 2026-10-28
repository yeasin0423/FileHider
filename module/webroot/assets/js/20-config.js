"use strict";

/* FileHider WebUI: targets.conf parsing, loading, status, and atomic writing. */

  // ---------- config ----------

  function addRule(map, pkg, path) {
    const value = appVisiblePath(path);
    if (!value || value === "/") return;
    if (!map.has(pkg)) map.set(pkg, new Set());
    map.get(pkg).add(value);
  }

  function parseConfig(text) {
    const rules = new Map();
    const disabled = new Set();
    for (const raw of String(text || "").split("\n")) {
      const line = raw.replace(/#.*/, "").trim();
      if (!line) continue;
      if (line.charAt(0) === "!") {
        const pkg = line.slice(1).trim();
        if (pkg && !/\s/.test(pkg)) disabled.add(pkg);
        continue;
      }
      const match = line.match(/^(\S+)\s+(\/.+)$/);
      if (!match) continue;
      const path = normalizePath(match[2]);
      if (path && path !== "/") addRule(rules, match[1], path);
    }
    return { rules, disabled };
  }

  function serializeConfig(rules = state.rules, disabled = state.disabled) {
    const packages = new Set([...rules.keys(), ...disabled]);
    const lines = CONFIG_HEADER.trimEnd().split("\n");
    for (const pkg of Array.from(packages).sort()) {
      if (disabled.has(pkg)) lines.push("!" + pkg);
      const paths = rules.get(pkg);
      if (!paths) continue;
      for (const path of Array.from(paths).sort()) lines.push(pkg + "\t" + path);
    }
    return lines.join("\n") + "\n";
  }

  function isConfigured(pkg) {
    const paths = state.rules.get(pkg);
    return (paths && paths.size > 0) || state.disabled.has(pkg);
  }

  function isAppActive(pkg) {
    const paths = state.rules.get(pkg);
    return !!paths && paths.size > 0 && !state.disabled.has(pkg);
  }

  function activeAppCount() {
    let count = 0;
    for (const [pkg, paths] of state.rules) {
      if (paths.size > 0 && !state.disabled.has(pkg)) count++;
    }
    return count;
  }

  function inactiveAppCount() {
    let count = 0;
    for (const pkg of state.disabled) {
      const paths = state.rules.get(pkg);
      if (paths && paths.size > 0) count++;
    }
    return count;
  }

  function activeRuleCount() {
    let count = 0;
    for (const [pkg, paths] of state.rules) {
      if (!state.disabled.has(pkg)) count += paths.size;
    }
    return count;
  }

  function totalRuleCount() {
    let count = 0;
    for (const paths of state.rules.values()) count += paths.size;
    return count;
  }

  function ruleSummary() {
    const active = activeAppCount();
    const inactive = inactiveAppCount();
    const rules = activeRuleCount();
    const pieces = [];
    if (active) pieces.push(active + " active " + (active === 1 ? "app" : "apps"));
    if (inactive) pieces.push(inactive + " inactive");
    if (rules) pieces.push(rules + " " + (rules === 1 ? "path" : "paths"));
    return pieces.join(" · ") || "No rules";
  }

  async function detectModule() {
    if (!hasBridge) return;
    const result = await run(
      "if [ -e " + q(MODULE_DIR + "/disable") + " ]; then echo FH_DISABLED; fi; " +
      "/system/bin/cat " + q(MODULE_DIR + "/module.prop") + " 2>/dev/null"
    );
    state.moduleDisabled = result.stdout.includes("FH_DISABLED");
    const match = result.stdout.match(/^version=(.+)$/m);
    state.moduleVersion = match ? match[1].trim() : "";
    webLog("config", "module version=" + (state.moduleVersion || "unknown") +
      " disabled=" + state.moduleDisabled);
  }

  async function loadRules() {
    if (!hasBridge) {
      state.rules = new Map();
      state.disabled = new Set();
      return;
    }
    const result = await run("/system/bin/cat " + q(STORE) + " 2>/dev/null");
    const parsed = parseConfig(result.stdout);
    state.rules = parsed.rules;
    state.disabled = parsed.disabled;
    webLog("config", "loaded " + STORE + " bytes=" + String(result.stdout || "").length +
      " apps=" + state.rules.size + " disabled=" + state.disabled.size +
      " errno=" + result.errno);
  }

  function updateStatus() {
    const active = activeAppCount();
    const inactive = inactiveAppCount();
    const configured = active + inactive;
    const pill = $("statusPill");
    const label = $("statusText");
    if (!pill || !label) return;

    let tone = "warn";
    let text = "No rules";
    if (!hasBridge) { tone = "bad"; text = "No bridge"; }
    else if (state.moduleDisabled) { tone = "bad"; text = "Disabled"; }
    else if (active > 0) { tone = "ok"; text = "Ready"; }
    else if (configured > 0) { tone = "warn"; text = "Inactive"; }

    pill.className = "pill " + tone;
    label.textContent = text;
    pill.title = state.moduleDisabled
      ? "The module is disabled"
      : (!hasBridge ? "No KernelSU/APatch bridge" : ruleSummary());

    const homeState = $("homeState");
    if (homeState) homeState.textContent = configured ? ruleSummary() : "Tap an app to add paths";
    if (state.view === "home") {
      const sub = $("viewSub");
      if (sub) sub.textContent = configured ? ruleSummary() : "Per-app path hiding";
    }
    const version = $("settingsVersion");
    if (version) version.textContent = state.moduleVersion || "unknown";
    const bridgeState = $("settingsBridge");
    if (bridgeState) bridgeState.textContent = hasBridge ? "connected" : "not available";
    const configPath = $("settingsConfigPath");
    if (configPath) configPath.textContent = STORE;
  }

  // ---------- config writing ----------

  async function writeConfigText(text) {
    if (!hasBridge) return { ok: false, error: "No shell bridge" };
    const payload = b64encode(text);
    const expectedBytes = new TextEncoder().encode(text).length;
    const tmp = STORE + ".tmp";
    const command = [
      "/system/bin/mkdir -p " + q("/data/adb/filehider"),
      "/system/bin/rm -f " + q(tmp),
      "if printf %s " + q(payload) + " | /system/bin/base64 -d > " + q(tmp) +
        " && /system/bin/chmod 0644 " + q(tmp) +
        " && { /system/bin/chcon u:object_r:system_file:s0 " + q(tmp) + " 2>/dev/null || true; }" +
        " && /system/bin/mv -f " + q(tmp) + " " + q(STORE) +
        "; then echo FH_SAVED; else /system/bin/rm -f " + q(tmp) + "; echo FH_FAILED; fi",
      "echo FH_BYTES=$(/system/bin/wc -c < " + q(STORE) + " 2>/dev/null)",
    ].join(" ; ");
    const result = await run(command);
    const sizeMatch = result.stdout.match(/FH_BYTES=\s*(\d+)/);
    const savedBytes = sizeMatch ? Number(sizeMatch[1]) : -1;
    const ok = result.stdout.includes("FH_SAVED") && savedBytes === expectedBytes;
    return {
      ok,
      savedBytes,
      expectedBytes,
      error: ok ? "" : (result.stderr || result.stdout || "write failed"),
    };
  }

  function enqueueWrite(text) {
    const task = configQueue.then(() => writeConfigText(text), () => writeConfigText(text));
    configQueue = task.catch(() => ({ ok: false }));
    return task;
  }

  async function saveConfig(options = {}) {
    const result = await enqueueWrite(serializeConfig());
    if (result.ok) {
      webLog("config", "saved bytes=" + result.savedBytes + " apps=" + state.rules.size +
        " disabled=" + state.disabled.size);
      if (!options.quiet) toast("Saved " + totalRuleCount() + " path(s)");
      updateStatus();
    } else {
      webLog("error", "save failed expected=" + result.expectedBytes +
        " got=" + result.savedBytes + " " + String(result.error || "unknown error"));
      toast("Save failed: " + String(result.error || "unknown error"), true);
    }
    return result.ok;
  }
