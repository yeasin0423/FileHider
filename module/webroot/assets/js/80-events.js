"use strict";

/* FileHider WebUI: DOM event bindings. */

  // ---------- events ----------

  function bindEvents() {
    $("backBtn").addEventListener("click", back);
    $("menuBtn").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleMenu();
    });
    $("overflowMenu").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-menu]");
      if (!button) return;
      const action = button.dataset.menu;
      const guarded = menuGuardActive && state.view === "home";
      closeMenu();
      if (guarded && (action === "settings" || action === "help" || action === "logs")) {
        replaceMenuRoute(action === "settings" ? { view: "settings" }
          : action === "help" ? { view: "help" }
          : { view: "home", modal: "logs" });
        return;
      }
      if (guarded) {
        popMenuGuard(() => runMenuAction(action));
        return;
      }
      runMenuAction(action);
    });
    document.addEventListener("click", (event) => {
      if (event.target.closest("#overflowMenu") || event.target.closest("#menuBtn")) return;
      if (!$("overflowMenu") || $("overflowMenu").hidden) return;
      event.preventDefault();
      event.stopPropagation();
      closeMenuWithGuard();
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (confirmOpen) {
        closeConfirm(false);
        return;
      }
      if ($("overflowMenu") && !$("overflowMenu").hidden) {
        closeMenuWithGuard();
        return;
      }
      if (openModalName() || state.view !== "home") back();
    });
    $("confirmCancel").addEventListener("click", () => closeConfirm(false));
    $("confirmAccept").addEventListener("click", () => closeConfirm(true));
    $("confirmModal").addEventListener("click", (event) => {
      if (event.target === $("confirmModal")) closeConfirm(false);
    });

    // A touch that starts on the dimmed backdrop must not scroll the page
    // behind the sheet. Inner scrollers handle their own touch gestures.
    document.querySelectorAll(".modal").forEach((modal) => {
      modal.addEventListener("touchmove", (event) => {
        if (event.target === modal) event.preventDefault();
      }, { passive: false });
    });

    document.querySelectorAll("[data-sheet-back]").forEach((button) => {
      button.addEventListener("click", () => dismissModal(button.dataset.sheetBack));
    });

    $("appSearch").addEventListener("input", renderApps);
    $("reloadApps").addEventListener("click", () => loadApps({ announce: true }));
    $("appList").addEventListener("change", async (event) => {
      const input = event.target.closest('input[data-toggle]');
      if (!input) return;
      await toggleAppActive(input.dataset.toggle, input.checked);
    });
    $("appList").addEventListener("click", (event) => {
      if (event.target.closest("input, .app-check")) return;
      const row = event.target.closest(".app-row");
      if (row) openDetail(row.dataset.pkg);
    });
    $("appList").addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (event.target.closest("input, .app-check")) return;
      const row = event.target.closest(".app-row");
      if (!row) return;
      event.preventDefault();
      openDetail(row.dataset.pkg);
    });

    $("addPath").addEventListener("click", () => addDraftPath($("pathInput").value, "", { keepInput: true }));
    $("pathInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addDraftPath($("pathInput").value, "", { keepInput: true });
      }
    });
    $("draftChips").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-remove-draft]");
      if (!button) return;
      state.draftPaths.delete(button.dataset.removeDraft);
      if (!state.draftPaths.size) state.draftDisabled = false;
      state.detailDirty = true;
      renderDetail();
      hidePathNotice();
    });
    $("pathNotice").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-add-notice]");
      if (button) addDraftPath(button.dataset.addNotice);
    });
    $("presetList").addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-preset-path]");
      if (!button || button.classList.contains("added")) return;
      const path = button.dataset.presetPath;
      const found = findPreset(path);
      if (found && found.item.risk === "danger") {
        const okay = await uiConfirm({
          title: "Add an advanced path?",
          message: path + "\n\n" +
            (found.item.note || "This can break the app.") +
            "\n\nHiding this path can break native loading, ART, unwinding, or unrelated probes.",
          confirmLabel: "Add path",
          cancelLabel: "Cancel",
          danger: true,
        });
        if (!okay) return;
      }
      addDraftPath(path);
    });
    $("presetList").addEventListener("toggle", (event) => {
      const group = event.target && event.target.closest
        ? event.target.closest("details.preset-group")
        : null;
      if (!group) return;
      const id = group.dataset.presetCategory;
      if (!id) return;
      if (group.open) state.presetOpen.add(id);
      else state.presetOpen.delete(id);
    }, true);
    $("detailActive").addEventListener("change", (event) => toggleDetailActive(event.target.checked));
    $("saveDetail").addEventListener("click", () => saveDetail(false));
    $("saveStop").addEventListener("click", () => saveDetail(true));
    $("clearAppRules").addEventListener("click", removeAppRules);
    $("browse").addEventListener("click", () => openBrowser(state.browserDir || "/"));
    $("browseStorage").addEventListener("click", () => openBrowser("/storage/emulated/0"));

    document.querySelectorAll("[data-theme-choice]").forEach((button) => {
      button.addEventListener("click", () => setTheme(button.dataset.themeChoice));
    });
    document.querySelectorAll("[data-accent-choice]").forEach((button) => {
      button.addEventListener("click", () => setAccent(button.dataset.accentChoice));
    });
    document.querySelectorAll("[data-icon-shape-choice]").forEach((button) => {
      button.addEventListener("click", () => setIconShape(button.dataset.iconShapeChoice));
    });
    $("resetAppearance").addEventListener("click", () => {
      prefs.theme = "auto";
      prefs.accent = "mint";
      prefs.iconShape = "circle";
      writePref(PREF.theme, prefs.theme);
      writePref(PREF.accent, prefs.accent);
      writePref(PREF.iconShape, prefs.iconShape);
      setShowSystem(false);
      applyTheme();
      webLog("prefs", "appearance reset");
      toast("Appearance reset");
    });
    $("settingsShowSystem").addEventListener("change", (event) => setShowSystem(event.target.checked));
    $("settingsReloadApps").addEventListener("click", () => loadApps({ announce: true }));
    $("exportConfig").addEventListener("click", copyConfig);
    $("exportConfigFile").addEventListener("click", exportConfigFile);
    $("importConfig").addEventListener("click", openImport);
    $("reloadConfig").addEventListener("click", reloadConfig);
    $("resetRules").addEventListener("click", resetRules);
    $("settingsLogs").addEventListener("click", showLogs);

    $("helpView").addEventListener("click", (event) => {
      if (event.target.closest("[data-open-logs]")) showLogs();
      if (event.target.closest("[data-open-settings]")) showSettings();
    });

    $("closeBrowser").addEventListener("click", closeBrowser);
    $("browserModal").addEventListener("click", (event) => {
      if (event.target === $("browserModal")) closeBrowser();
    });
    $("refreshBrowser").addEventListener("click", () => {
      if (state.browserDir) loadBrowser(state.browserDir, { force: true });
    });
    $("browserList").addEventListener("click", async (event) => {
      const addTarget = event.target.closest("button[data-add-target]");
      if (addTarget) {
        event.stopPropagation();
        const linkPath = addTarget.dataset.targetPath || "";
        const knownTarget = addTarget.dataset.addTarget || "";
        const canonical = await readSymlinkTarget(linkPath);
        const target = canonical || knownTarget;
        if (!target) { toast("Could not resolve this symlink target", true); return; }
        addDraftPath(target);
        return;
      }
      const add = event.target.closest("button[data-add-path]");
      if (add) {
        event.stopPropagation();
        addDraftPath(add.dataset.addPath, add.dataset.target || "");
        return;
      }
      const item = event.target.closest(".item");
      if (!item) return;
      const path = item.dataset.path;
      const kind = item.dataset.kind;
      if (kind === "D" || kind === "LD") { loadBrowser(path); return; }
      if (kind === "L" || kind === "LB") {
        const request = state.browserRequest;
        const isDir = await pathIsDirectory(path);
        if (request !== state.browserRequest || !$("browserModal").classList.contains("open")) return;
        if (isDir) loadBrowser(path);
        else addDraftPath(path, item.dataset.target || "");
        return;
      }
      addDraftPath(path, item.dataset.target || "");
    });
    let browserScrollFrame = 0;
    $("browserList").addEventListener("scroll", () => {
      if (browserScrollFrame) return;
      browserScrollFrame = requestAnimationFrame(() => { browserScrollFrame = 0; renderBrowser(false); });
    }, { passive: true });
    $("browserSearch").addEventListener("input", () => {
      state.browserFilter = $("browserSearch").value.trim().toLowerCase();
      renderBrowser(true);
    });
    $("browserUp").addEventListener("click", () => {
      if (state.browserDir === "/") return;
      const parts = state.browserDir.split("/").filter(Boolean);
      parts.pop();
      loadBrowser("/" + parts.join("/"));
    });
    $("addCurrentDir").addEventListener("click", () => {
      const logical = state.browserDir;
      const physical = state.browserPhysical || "";
      const logicalSaved = appVisiblePath(logical);
      if (logicalSaved === "/") { toast("Choose a folder below /", true); return; }
      const physicalSaved = physical ? appVisiblePath(physical) : "";
      const resolvedDiffers = physicalSaved && physicalSaved !== "/" && physicalSaved !== logicalSaved;
      const added = addDraftPaths(resolvedDiffers ? [logical, physical] : [logical]);
      if (resolvedDiffers) {
        $("pathNotice").innerHTML =
          '<b>Symlink folder:</b> <span class="mono">' + escapeHtml(logical) + '</span> opens <span class="mono">' +
          escapeHtml(physical) + '</span>. Both names are selected so the folder is hidden either way.';
        $("pathNotice").hidden = false;
      } else {
        showStorageNotice(logical);
      }
      if (!added.length) toast("Already selected: " + logicalSaved);
      else if (resolvedDiffers) toast("Added folder and its resolved target");
      else toast("Added " + added[0]);
      closeBrowser();
    });
    $("jump").addEventListener("click", () => loadBrowser($("jumpInput").value));
    $("jumpInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); loadBrowser($("jumpInput").value); }
    });

    $("closeLogs").addEventListener("click", closeLogs);
    $("logsModal").addEventListener("click", (event) => {
      if (event.target === $("logsModal")) closeLogs();
    });
    $("refreshLogs").addEventListener("click", refreshLogs);
    $("copyLogs").addEventListener("click", async () => {
      const copied = await copyText($("logOutput").textContent, $("logOutput"));
      toast(copied ? "Copied" : "Long-press the selected text and choose Copy", !copied);
    });
    $("saveLogs").addEventListener("click", saveDiagnosticsFile);
    $("stopTargets").addEventListener("click", stopConfiguredApps);

    $("importCancel").addEventListener("click", closeImport);
    $("importCancel2").addEventListener("click", closeImport);
    $("importModal").addEventListener("click", (event) => {
      if (event.target === $("importModal")) closeImport();
    });
    $("chooseImportFile").addEventListener("click", () => $("importFile").click());
    $("importFile").addEventListener("change", async (event) => {
      const file = event.target.files && event.target.files[0];
      await importSelectedFile(file);
      event.target.value = "";
    });
    $("importApply").addEventListener("click", applyImport);

    if (darkQuery) {
      const onChange = () => { if (prefs.theme === "auto") applyTheme(); };
      if (typeof darkQuery.addEventListener === "function") darkQuery.addEventListener("change", onChange);
      else if (typeof darkQuery.addListener === "function") darkQuery.addListener(onChange);
    }
  }
