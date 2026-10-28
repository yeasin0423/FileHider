"use strict";

/* FileHider WebUI: settings actions, import/export, diagnostics, and force-stop. */

  // ---------- settings ----------

  function renderSettings() {
    const show = $("settingsShowSystem");
    if (show) show.checked = prefs.showSystem;
    updateStatus();
    applyTheme();
  }

  async function resetRules() {
    const okay = await uiConfirm({
      title: "Reset all rules?",
      message: "Every app and path will be cleared. The current config will be backed up to targets.conf.bak first.",
      confirmLabel: "Reset all",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!okay) return;
    if (!hasBridge) { toast("No shell bridge", true); return; }
    webLog("config", "reset requested; backing up " + STORE);
    await run("/system/bin/cp -f " + q(STORE) + " " + q(STORE + ".bak") + " 2>/dev/null");
    const ok = (await enqueueWrite(CONFIG_HEADER)).ok;
    if (!ok) { webLog("error", "reset failed to write config"); toast("Reset failed", true); return; }
    state.rules.clear();
    state.disabled.clear();
    state.detailDirty = false;
    state.currentPkg = "";
    await loadApps();
    renderApps();
    updateStatus();
    webLog("config", "reset complete; config cleared");
    toast("All rules reset");
  }

  async function copyConfig() {
    const copied = await copyText(serializeConfig());
    webLog("config", "copy to clipboard=" + copied);
    toast(copied ? "Config copied" : "Could not copy the config", !copied);
  }

  function exportStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }

  async function exportConfigFile() {
    const text = serializeConfig();
    const expectedBytes = new TextEncoder().encode(text).length;
    if (!hasBridge) {
      const copied = await copyText(text);
      webLog("config", "export without bridge; clipboard=" + copied);
      toast(copied ? "No shell bridge — config copied instead" : "Could not export or copy the config", !copied);
      return;
    }

    const dir = "/data/media/0/Download";
    const name = "FileHider-targets-" + exportStamp() + ".conf";
    const file = dir + "/" + name;
    const command = [
      "/system/bin/mkdir -p " + q(dir),
      "if printf %s " + q(b64encode(text)) + " | /system/bin/base64 -d > " + q(file) +
        " && /system/bin/chmod 0644 " + q(file) +
        "; then echo FH_EXPORTED; else echo FH_EXPORT_FAILED; fi",
      "echo FH_BYTES=$(/system/bin/wc -c < " + q(file) + " 2>/dev/null)",
    ].join(" ; ");
    const result = await run(command);
    const sizeMatch = result.stdout.match(/FH_BYTES=\s*(\d+)/);
    const savedBytes = sizeMatch ? Number(sizeMatch[1]) : -1;
    const ok = result.stdout.includes("FH_EXPORTED") && savedBytes === expectedBytes;
    if (ok) {
      webLog("config", "export path=" + file + " bytes=" + savedBytes);
      toast("Exported to Download/" + name);
      return;
    }

    webLog("error", "export failed: " + (result.stderr || result.stdout || "write failed"));
    const copied = await copyText(text);
    toast(copied ? "Export failed — config copied instead" : "Export failed", true);
  }

  function readTextFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("File read failed"));
      reader.readAsText(file);
    });
  }

  async function importSelectedFile(file) {
    if (!file) return;
    try {
      const text = await readTextFile(file);
      $("importText").value = text;
      $("importFileStatus").textContent = "Loaded " + file.name + " (" + file.size + " bytes)";
      webLog("config", "import file loaded name=" + file.name + " bytes=" + file.size);
      toast("Loaded " + file.name);
    } catch (error) {
      $("importFileStatus").textContent = "Could not read that file. Paste its text instead.";
      webLog("error", "import file read failed: " + String(error && error.message || error));
      toast("Could not read that file", true);
    }
  }

  function openImportNow() {
    $("importText").value = "";
    const file = $("importFile");
    if (file) file.value = "";
    if ($("importFileStatus")) $("importFileStatus").textContent = "Or paste a configuration below.";
    $("importModal").classList.add("open");
    syncOverlayLock();
    webLog("nav", "import sheet opened");
    setTimeout(() => { try { $("importText").focus(); } catch (_) {} }, 80);
  }

  function closeImportNow() {
    $("importModal").classList.remove("open");
    syncOverlayLock();
  }

  async function applyImport() {
    const parsed = parseConfig($("importText").value);
    if (!parsed.rules.size && !parsed.disabled.size) {
      webLog("warn", "import rejected: no valid rules");
      toast("No valid rules found in that text", true);
      return;
    }
    webLog("config", "import rules=" + parsed.rules.size + " disabled=" + parsed.disabled.size);
    const ok = (await enqueueWrite(serializeConfig(parsed.rules, parsed.disabled))).ok;
    if (!ok) { webLog("error", "import write failed"); toast("Import failed", true); return; }
    state.rules = parsed.rules;
    state.disabled = parsed.disabled;
    state.detailDirty = false;
    closeImportNow();
    await loadApps();
    renderApps();
    updateStatus();
    goHomeRoot();
    webLog("config", "import complete");
    toast("Config imported and saved");
  }

  async function reloadConfig() {
    if (!(await confirmDiscardDraft())) return;
    state.detailDirty = false;
    webLog("config", "reload from disk requested");
    await loadRules();
    await loadApps();
    renderApps();
    updateStatus();
    toast("Reloaded rules from disk");
  }

  async function reloadAll() {
    if (!(await confirmDiscardDraft())) return;
    state.detailDirty = false;
    webLog("config", "reload apps and rules requested");
    await loadRules();
    await loadApps();
    renderApps();
    updateStatus();
    goHomeRoot();
    toast("Reloaded apps and rules");
  }

  // ---------- logs ----------

  function scrollLogsToBottom() {
    const box = $("logOutput");
    if (!box) return;
    requestAnimationFrame(() => {
      try { box.scrollTop = box.scrollHeight; } catch (_) {}
    });
  }

  function openLogsNow() {
    $("logsModal").classList.add("open");
    syncOverlayLock();
    refreshLogs();
  }

  function closeLogsNow() {
    $("logsModal").classList.remove("open");
    syncOverlayLock();
  }

  function previousUiLogSection() {
    const text = previousUiLogText();
    return text ? "\n\n===== previous WebUI activity =====\n" + text : "";
  }

  async function refreshLogs() {
    webLog("diag", "refresh requested");
    $("logOutput").textContent = "Loading diagnostics…";
    if (!hasBridge) {
      $("logOutput").textContent =
        "No shell bridge. Open this page from KernelSU or APatch.\n\n" +
        "On Magisk, run on a PC:\n  adb logcat -s FileHider\n\n" +
        "===== WebUI activity =====\n" + uiLogText() + previousUiLogSection() + "\n";
      scrollLogsToBottom();
      return;
    }
    const command = [
      "echo '===== module.prop ====='",
      "/system/bin/cat " + q(MODULE_DIR + "/module.prop") + " 2>/dev/null",
      "echo '===== abi ====='",
      "/system/bin/getprop ro.product.cpu.abilist 2>/dev/null",
      "echo '===== module dir ====='",
      "/system/bin/ls -lZ " + q(MODULE_DIR + "/") + " 2>&1",
      "echo '===== config file ====='",
      "/system/bin/ls -lZ " + q(STORE) + " 2>&1",
      "echo '===== targets.conf ====='",
      "/system/bin/cat " + q(STORE) + " 2>/dev/null",
      "echo '===== logcat FileHider ====='",
      "/system/bin/logcat -d -s FileHider 2>/dev/null | /system/bin/tail -n 250",
      "echo '===== logcat Zygisk (tail) ====='",
      "/system/bin/logcat -d -s Zygisk 2>/dev/null | /system/bin/tail -n 40",
    ].join(" ; ");
    const result = await run(command);
    let output = result.stdout.trim() || "(no output)";
    if (result.stderr.trim()) output += "\n\n[stderr]\n" + result.stderr.trim();
    output += "\n\n===== WebUI activity =====\n" + uiLogText() + previousUiLogSection();
    $("logOutput").textContent = output;
    scrollLogsToBottom();
    webLog("diag", "refresh complete output=" + output.length + " chars");
  }

  async function saveDiagnosticsFile() {
    let text = $("logOutput").textContent || "";
    if (!text.trim() || text.startsWith("Loading diagnostics")) {
      await refreshLogs();
      text = $("logOutput").textContent || "";
    }
    if (!text.trim()) {
      toast("No diagnostics to save", true);
      return;
    }

    const expectedBytes = new TextEncoder().encode(text).length;
    if (!hasBridge) {
      const copied = await copyText(text);
      webLog("diag", "save without bridge; clipboard=" + copied);
      toast(copied ? "No shell bridge — diagnostics copied instead" : "Could not save or copy diagnostics", !copied);
      return;
    }

    const button = $("saveLogs");
    if (button) button.disabled = true;
    webLog("diag", "save requested bytes=" + expectedBytes);
    try {
      const dir = "/data/media/0/Download";
      const name = "FileHider-diagnostics-" + exportStamp() + ".txt";
      const file = dir + "/" + name;
      const command = [
        "/system/bin/mkdir -p " + q(dir),
        "if printf %s " + q(b64encode(text)) + " | /system/bin/base64 -d > " + q(file) +
          " && /system/bin/chmod 0644 " + q(file) +
          "; then echo FH_SAVED; else echo FH_SAVE_FAILED; fi",
        "echo FH_BYTES=$(/system/bin/wc -c < " + q(file) + " 2>/dev/null)",
      ].join(" ; ");
      const result = await run(command);
      const sizeMatch = result.stdout.match(/FH_BYTES=\s*(\d+)/);
      const savedBytes = sizeMatch ? Number(sizeMatch[1]) : -1;
      const ok = result.stdout.includes("FH_SAVED") && savedBytes === expectedBytes;
      if (ok) {
        webLog("diag", "saved path=" + file + " bytes=" + savedBytes);
        toast("Saved to Download/" + name);
        return;
      }

      webLog("error", "diagnostics save failed: " + (result.stderr || result.stdout || "write failed"));
      const copied = await copyText(text);
      toast(copied ? "Save failed — diagnostics copied instead" : "Could not save diagnostics", true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function stopConfiguredApps() {
    const packages = Array.from(new Set([...state.rules.keys(), ...state.disabled]));
    if (!packages.length) { toast("No configured apps"); return; }
    const command = packages.map((pkg) => "/system/bin/am force-stop " + q(pkg)).join(" ; ");
    await run(command + " 2>&1");
    webLog("apps", "force-stopped configured count=" + packages.length);
    toast("Force-stopped " + packages.length + " app(s). Open them again.");
  }
