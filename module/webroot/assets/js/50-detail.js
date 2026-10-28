"use strict";

/* FileHider WebUI: path presets, draft editing, and per-app saving. */

  // ---------- presets ----------

  const PRESET_CATALOG = [
    {
      id: "integrity",
      title: "Integrity & environment",
      tone: "safe",
      description: "Common build, CPU, and kernel facts used by integrity checks. Usually safe to hide from one app.",
      items: [
        { path: "/proc/cpuinfo", risk: "safe", note: "CPU model and features" },
        { path: "/proc/stat", risk: "safe", note: "CPU, boot, and context stats" },
        { path: "/proc/version", risk: "safe", note: "Kernel version string" },
        { path: "/system/build.prop", risk: "safe", note: "ROM fingerprint and props" },
        { path: "/vendor/build.prop", risk: "safe", note: "Vendor build properties" },
      ],
    },
    {
      id: "root",
      title: "Root traces",
      tone: "caution",
      description: "Classic root-manager paths. These are usually harmless to hide from a target app, but check the app if it needs root.",
      items: [
        { path: "/system/bin/su", risk: "safe", note: "SU binary" },
        { path: "/system/xbin/su", risk: "safe", note: "SU binary" },
        { path: "/sbin/su", risk: "safe", note: "SU binary" },
        { path: "/su", risk: "safe", note: "SU binary" },
        { path: "/system/xbin", risk: "caution", note: "Legacy tool directory" },
        { path: "/system/app/Superuser.apk", risk: "safe", note: "Legacy root app" },
        { path: "/data/adb", risk: "caution", note: "Root manager data" },
        { path: "/data/adb/modules", risk: "caution", note: "Installed modules" },
        { path: "/data/adb/magisk", risk: "caution", note: "Magisk data" },
        { path: "/data/adb/ksu", risk: "caution", note: "KernelSU data" },
        { path: "/data/adb/ap", risk: "caution", note: "APatch data" },
        { path: "/sbin/.magisk", risk: "safe", note: "Legacy Magisk mount" },
        { path: "/init.magisk.rc", risk: "safe", note: "Magisk init hook" },
        { path: "/cache/magisk.log", risk: "safe", note: "Magisk log" },
      ],
    },
    {
      id: "emulator",
      title: "Emulator",
      tone: "caution",
      description: "Goldfish/QEMU artifacts. Hiding these can reveal that an app is not expecting an emulator, but some emulators use them for normal operation.",
      items: [
        { path: "/dev/qemu_pipe", risk: "caution", note: "QEMU pipe" },
        { path: "/dev/goldfish_pipe", risk: "caution", note: "Goldfish pipe" },
        { path: "/system/bin/qemu-props", risk: "caution", note: "QEMU props binary" },
        { path: "/system/lib/libc_malloc_debug_qemu.so", risk: "caution", note: "QEMU malloc debug" },
        { path: "/system/lib64/libc_malloc_debug_qemu.so", risk: "caution", note: "QEMU malloc debug" },
        { path: "/sys/qemu_trace", risk: "caution", note: "QEMU trace" },
        { path: "/proc/tty/drivers", risk: "caution", note: "TTY drivers" },
      ],
    },
    {
      id: "native",
      title: "Native & maps",
      tone: "danger",
      advanced: true,
      description: "Powerful checks that can expose memory and mount details. Danger: these can break ART, crash reporting, unwinding, or unrelated probes.",
      items: [
        { path: "/proc/self/maps", risk: "danger", note: "Memory map" },
        { path: "/proc/self/smaps", risk: "danger", note: "Detailed memory map" },
        { path: "/proc/self/mountinfo", risk: "danger", note: "Mount namespace" },
        { path: "/proc/self/mounts", risk: "danger", note: "Mounted filesystems" },
      ],
    },
    {
      id: "system",
      title: "System libraries",
      tone: "danger",
      advanced: true,
      description: "Very broad directory hides. Danger: an app that loads a system native library after startup can fail or crash.",
      items: [
        { path: "/system/lib64", risk: "danger", note: "64-bit system libraries" },
        { path: "/system/lib", risk: "danger", note: "32-bit system libraries" },
      ],
    },
    {
      id: "other",
      title: "Other common checks",
      tone: "caution",
      description: "Additional paths that show up in app and shell-based probes.",
      items: [
        { path: "/data/local/tmp", risk: "caution", note: "Temporary shell area" },
        { path: "/proc/self/status", risk: "caution", note: "TracerPid and process state" },
        { path: "/proc/self/cmdline", risk: "caution", note: "Process command line" },
        { path: "/proc/1/root", risk: "caution", note: "Init root link" },
      ],
    },
  ];

  function findPreset(path) {
    for (const category of PRESET_CATALOG) {
      const item = category.items.find((entry) => entry.path === path);
      if (item) return { category, item };
    }
    return null;
  }

  function renderPresets() {
    const container = $("presetList");
    if (!container) return;
    container.innerHTML = PRESET_CATALOG.map((category) => {
      const items = category.items.map((item) => {
        const added = state.draftPaths.has(appVisiblePath(item.path));
        const risk = item.risk === "danger" ? "danger" : item.risk === "caution" ? "caution" : "safe";
        return '<button type="button" class="preset ' + risk + (added ? " added" : "") + '"' +
          ' data-preset-path="' + escapeHtml(item.path) + '"' +
          (added ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' +
          '<span class="preset-path">' + escapeHtml(item.path) + '</span>' +
          '<span class="preset-note">' + escapeHtml(item.note) + '</span>' +
          '<span class="risk">' + (added ? "Added" : risk === "danger" ? "Danger" : risk === "caution" ? "Caution" : "Safe") + '</span>' +
          '</button>';
      }).join("");
      return '<details class="preset-group" data-preset-category="' + escapeHtml(category.id) + '"' +
        (state.presetOpen.has(category.id) ? " open" : "") + '>' +
        '<summary><span class="summary-dot" style="background:' +
        (category.tone === "danger" ? "var(--danger)" : category.tone === "caution" ? "var(--warn)" : "var(--safe)") +
        '"></span><span>' + escapeHtml(category.title) + '</span>' +
        '<span class="summary-tail">' + (category.advanced ? "Advanced" : category.items.length + " paths") +
        '<span class="chevron">' + ICONS.chevron + '</span></span></summary>' +
        '<div class="preset-body"><p class="preset-desc">' + escapeHtml(category.description) + '</p>' +
        '<div class="preset-items">' + items + '</div></div></details>';
    }).join("");
  }

  function renderDraftChips() {
    const container = $("draftChips");
    if (!container) return;
    if (!state.draftPaths.size) {
      container.innerHTML = '<div class="empty" style="width:100%;padding:15px 10px">No hidden paths yet. Add one below or pick a common path.</div>';
      return;
    }
    container.innerHTML = Array.from(state.draftPaths).sort().map((path) => {
      const preset = findPreset(path);
      const risk = preset && preset.item.risk === "danger" ? '<span class="chip-risk">risky</span>' : "";
      return '<span class="chip">' + risk + '<span class="path mono">' + escapeHtml(path) + '</span>' +
        '<button type="button" data-remove-draft="' + escapeHtml(path) + '" aria-label="Remove path">×</button></span>';
    }).join("");
  }

  function renderDetail() {
    const pkg = state.currentPkg;
    const app = appByPkg(pkg) || { pkg, label: pkg, isSystem: false, missing: true };
    const active = state.draftPaths.size > 0 && !state.draftDisabled;
    const avatar = $("detailAvatar");
    if (avatar) {
      avatar.setAttribute("style", avatarStyle(pkg));
      avatar.innerHTML = iconInner(app);
    }
    $("detailName").textContent = appLabel(app);
    $("detailPkg").textContent = pkg;
    $("detailMeta").textContent = state.draftPaths.size
      ? state.draftPaths.size + " hidden " + (state.draftPaths.size === 1 ? "path" : "paths") +
        (state.draftDisabled ? " · inactive, paths retained" : " · active")
      : "No paths yet";
    const toggle = $("detailActive");
    toggle.checked = active;
    toggle.disabled = state.draftPaths.size === 0 || state.busy;
    $("detailActiveLabel").textContent = active ? "Active" : "Inactive";
    $("draftCount").textContent = state.draftPaths.size + " path" + (state.draftPaths.size === 1 ? "" : "s");
    $("detailDirty").textContent = state.detailDirty ? "Unsaved changes" : "All changes saved";
    $("detailDirty").classList.toggle("dirty", state.detailDirty);
    $("detailRuleSummary").textContent = state.draftPaths.size
      ? state.draftPaths.size + " hidden path" + (state.draftPaths.size === 1 ? "" : "s") + (state.draftDisabled ? " · inactive" : "")
      : "No paths for this app";
    $("saveDetail").disabled = state.busy;
    $("saveStop").disabled = state.busy;
    const savedPaths = state.rules.get(pkg);
    const canClear = !!(savedPaths && savedPaths.size) || state.disabled.has(pkg) || state.draftPaths.size > 0;
    $("clearAppRules").disabled = state.busy || !canClear;
    renderDraftChips();
    renderPresets();
  }

  // ---------- draft editing ----------

  function hidePathNotice() {
    const el = $("pathNotice");
    if (!el) return;
    el.hidden = true;
    el.textContent = "";
  }

  function showStorageNotice(raw) {
    const aliases = storageAliases(raw);
    if (aliases.length <= 1) { hidePathNotice(); return; }
    const list = aliases.map((path) => '<span class="mono">' + escapeHtml(path) + '</span>').join(", ");
    $("pathNotice").innerHTML = '<b>Shared storage:</b> this rule hides every name for the same location: ' + list + '.';
    $("pathNotice").hidden = false;
  }

  function showSymlinkNotice(linkPath, target) {
    if (!target) { hidePathNotice(); return; }
    const targetSaved = appVisiblePath(target);
    const canAdd = targetSaved && targetSaved !== "/" && !state.draftPaths.has(targetSaved);
    const button = canAdd
      ? '<button class="btn small" type="button" data-add-notice="' + escapeHtml(target) + '">Add target too</button>'
      : "";
    $("pathNotice").innerHTML =
      '<b>Symlink:</b> <span class="mono">' + escapeHtml(linkPath) + '</span> points to ' +
      '<span class="mono">' + escapeHtml(target) + '</span>. Hiding the link name does not hide the target unless you add it.' + button;
    $("pathNotice").hidden = false;
  }

  function addDraftPaths(values) {
    const added = [];
    for (const value of values) {
      const raw = normalizePath(value);
      if (!raw || raw === "/") continue;
      const path = appVisiblePath(raw);
      if (!path || state.draftPaths.has(path)) continue;
      if (!state.draftPaths.size) state.draftDisabled = false;
      state.draftPaths.add(path);
      added.push(path);
    }
    if (added.length) {
      state.detailDirty = true;
      webLog("draft", "add pkg=" + state.currentPkg + " paths=" + added.join(","));
      renderDetail();
    }
    return added;
  }

  function addDraftPath(value, symlinkTarget, options) {
    const opts = options && typeof options === "object" ? options : {};
    const raw = normalizePath(value);
    if (!raw) { toast("Path must be absolute", true); return; }
    if (raw === "/") { toast("Choose a file or folder below /", true); return; }
    const path = appVisiblePath(raw);
    if (state.draftPaths.has(path)) { toast("Already added: " + path); return; }
    const added = addDraftPaths([raw]);
    if (symlinkTarget) showSymlinkNotice(path, symlinkTarget);
    else showStorageNotice(raw);
    if (!opts.keepInput) $("pathInput").value = "";
    if (added.length) toast("Added " + path);
  }

  function toggleDetailActive(value) {
    if (!state.draftPaths.size) return;
    state.draftDisabled = !value;
    state.detailDirty = true;
    renderDetail();
  }

  async function forceStop(pkg) {
    if (!hasBridge) { toast("No shell bridge", true); return; }
    const result = await run("/system/bin/am force-stop " + q(pkg) + " 2>&1");
    const message = String(result.stdout || result.stderr || "").trim();
    if (result.errno === 0 && !/error|exception|denied/i.test(message)) {
      webLog("apps", "force-stopped " + pkg);
      toast("Force-stopped " + pkg + ". Open it again.");
    } else {
      webLog("error", "force-stop " + pkg + " failed: " + (message || "unknown error"));
      toast("Force-stop failed: " + (message || "unknown error"), true);
    }
  }

  async function saveDetail(stopAfter) {
    const pkg = state.currentPkg;
    if (!pkg || state.busy) return;
    if (!state.draftPaths.size) state.draftDisabled = false;
    const previousPaths = state.rules.has(pkg) ? new Set(state.rules.get(pkg)) : null;
    const previousDisabled = state.disabled.has(pkg);

    if (state.draftPaths.size) {
      state.rules.set(pkg, new Set(state.draftPaths));
      if (state.draftDisabled) state.disabled.add(pkg);
      else state.disabled.delete(pkg);
    } else {
      state.rules.delete(pkg);
      state.disabled.delete(pkg);
    }

    state.busy = true;
    renderDetail();
    const ok = await saveConfig({ quiet: true });
    state.busy = false;
    if (!ok) {
      if (previousPaths) state.rules.set(pkg, previousPaths); else state.rules.delete(pkg);
      if (previousDisabled) state.disabled.add(pkg); else state.disabled.delete(pkg);
      webLog("error", "saveDetail failed pkg=" + pkg);
      renderDetail();
      renderApps();
      updateStatus();
      return;
    }

    state.detailDirty = false;
    renderDetail();
    renderApps();
    updateStatus();
    webLog("config", "saveDetail pkg=" + pkg + " paths=" + state.draftPaths.size +
      " inactive=" + state.draftDisabled + " forceStop=" + !!stopAfter);
    toast("Saved " + pkg + (state.draftPaths.size && state.draftDisabled ? " (inactive, paths kept)" : ""));
    if (stopAfter) await forceStop(pkg);
  }

  async function removeAppRules() {
    const pkg = state.currentPkg;
    if (!pkg || state.busy) return;
    const savedPaths = state.rules.has(pkg) ? new Set(state.rules.get(pkg)) : null;
    const wasDisabled = state.disabled.has(pkg);
    const draftPaths = new Set(state.draftPaths);
    const draftDisabled = state.draftDisabled;
    const wasDirty = state.detailDirty;
    const pathCount = savedPaths ? savedPaths.size : 0;
    if (!pathCount && !wasDisabled && !draftPaths.size) {
      toast("No rules to remove for this app");
      return;
    }

    const app = appByPkg(pkg);
    const okay = await uiConfirm({
      title: "Remove all rules?",
      message: "This deletes every saved path and the inactive marker for " +
        appLabel(app || { pkg, label: pkg }) + " (" + pkg + "). Other apps are not changed." +
        (draftPaths.size || wasDirty ? " Unsaved path edits will also be discarded." : ""),
      confirmLabel: "Remove all",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!okay) return;

    state.rules.delete(pkg);
    state.disabled.delete(pkg);
    state.draftPaths = new Set();
    state.draftDisabled = false;
    state.detailDirty = false;
    state.busy = true;
    renderDetail();
    const ok = await saveConfig({ quiet: true });
    state.busy = false;
    if (!ok) {
      if (savedPaths) state.rules.set(pkg, savedPaths);
      if (wasDisabled) state.disabled.add(pkg);
      state.draftPaths = draftPaths;
      state.draftDisabled = draftDisabled;
      state.detailDirty = wasDirty;
      webLog("error", "removeApp failed pkg=" + pkg);
      renderDetail();
      renderApps();
      updateStatus();
      return;
    }

    renderDetail();
    renderApps();
    updateStatus();
    webLog("config", "removeApp pkg=" + pkg + " paths=" + pathCount +
      " inactive=" + wasDisabled + " draft=" + draftPaths.size);
    toast("Removed all rules for " + pkg);
  }

  async function toggleAppActive(pkg, active) {
    const paths = state.rules.get(pkg);
    if (!paths || !paths.size) { openDetail(pkg); return; }
    if (active) state.disabled.delete(pkg);
    else state.disabled.add(pkg);
    renderApps();
    updateStatus();
    const ok = await saveConfig({ quiet: true });
    if (!ok) {
      await loadRules();
      renderApps();
      updateStatus();
      return;
    }
    webLog("config", "app active=" + active + " pkg=" + pkg);
    toast(active ? "Active: " + pkg : "Inactive: " + pkg + " — paths kept");
  }
