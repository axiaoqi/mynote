"use strict";

const vaultUi = { unlocked: false, configured: false, epoch: 0, lastActive: 0, lastTouch: 0, timer: null, busy: false, view: "all", createGroup: false, navigationOnly: false };
const VAULT_IDLE_MS = 5 * 60 * 1000;

function resetVaultForms() {
  $("#vault-unlock-form").reset(); $("#vault-password-form").reset();
}

function clearSensitiveUi() {
  vaultUi.epoch++; vaultUi.unlocked = false; clearTimeout(vaultUi.timer);
  resetVaultForms();
  state.privateNavigationUnlocked = false; state.privateGroups = [];
  if (state.area === "private" || state.currentNote?.is_private || state.notes.some(note => note.is_private)) clearPrivateWorkspace();
  else renderGroups();
  for (const id of ["#vault-dialog", "#export-dialog", "#zip-password-dialog"]) if ($(id).open) $(id).close();
  $("#backup-form").reset(); $("#backup-files").replaceChildren();
}

function clearPrivateWorkspace() {
  clearTimeout(state.saveTimer); state.saveTimer = null;
  state.sessionEpoch++; state.area = "normal"; state.currentGroup = "home";
  state.currentNote = null; state.notes = []; state.groups = state.normalGroups || []; state.privateGroups = [];
  state.dirty = false; state.composing = false; state.pendingConflict = null;
  state.localConflictDraft = null; state.conflictServer = null; state.search = ""; els.search.value = "";
  els.clearSearch.classList.add("hidden"); els.search.placeholder = "搜索全部便签";
  clearEditor(); renderGroups(); renderGroupSelect(); renderNotes();
  els.listTitle.textContent = "首页"; els.emptyTrash.classList.add("hidden");
  closePrivateDialogs();
  persistLocation(); mobileView("list");
}

function closePrivateDialogs() {
  for (const dialog of [els.inputDialog, els.confirmDialog, els.conflict]) if (dialog.open) dialog.close("cancel");
  els.inputDialogField.value = ""; els.confirmMessage.textContent = "";
}

async function lockPrivateArea(notifyServer = true) {
  const wasPrivate = state.area === "private";
  vaultUi.epoch++; vaultUi.unlocked = false; clearTimeout(vaultUi.timer); resetVaultForms();
  state.privateGroups = [];
  state.privateNavigationUnlocked = false;
  if (wasPrivate) clearPrivateWorkspace();
  else {
    // A valid grant also permits private matches in ordinary search.
    const hadPrivate = state.currentNote?.is_private || state.notes.some(note => note.is_private);
    state.sessionEpoch++;
    state.notes = state.notes.filter(note => !note.is_private);
    if (state.currentNote?.is_private) {
      state.currentNote = null; state.localConflictDraft = null; state.conflictServer = null;
      state.pendingConflict = null; state.composing = false;
      clearEditor();
      if (els.conflict.open) els.conflict.close();
    }
    if (hadPrivate) closePrivateDialogs();
    renderNotes(); renderGroups(); renderGroupSelect();
  }
  if (notifyServer) {
    try { await api("/api/vault/lock", { method: "POST" }); }
    catch (error) { toast(error.message, "error"); }
  }
  if (state.user) {
    try { await loadNotes(); } catch (_) {}
  }
}

function syncPrivateExpiry(expiresAt) {
  if (!expiresAt) {
    if (vaultUi.unlocked) lockPrivateArea(false);
    return;
  }
  vaultUi.unlocked = true;
  state.privateNavigationUnlocked = true;
  renderNavigation();
  vaultUi.lastActive = expiresAt * 1000 - VAULT_IDLE_MS;
  armVaultTimer();
}

function armVaultTimer() {
  clearTimeout(vaultUi.timer);
  vaultUi.timer = setTimeout(() => lockPrivateArea(), Math.max(0, VAULT_IDLE_MS - (Date.now() - vaultUi.lastActive)));
}

async function vaultActivity(event) {
  const privateEditor = state.currentNote?.is_private && (!event || event.target.closest("#editor-shell"));
  if (!vaultUi.unlocked || (state.area !== "private" && !privateEditor) || document.visibilityState !== "visible") return;
  const now = Date.now();
  if (now - vaultUi.lastActive >= VAULT_IDLE_MS) { await lockPrivateArea(); return; }
  vaultUi.lastActive = now; armVaultTimer();
  if (now - vaultUi.lastTouch < 15000) return;
  vaultUi.lastTouch = now;
  const epoch = vaultUi.epoch;
  try { await api("/api/vault/touch", { method: "POST" }); }
  catch (error) { if (epoch === vaultUi.epoch) { await lockPrivateArea(false); toast(error.message, "error"); } }
}

async function activatePrivateArea() {
  const epoch = ++vaultUi.epoch;
  vaultUi.unlocked = true; vaultUi.lastActive = vaultUi.lastTouch = Date.now(); armVaultTimer();
  state.privateNavigationUnlocked = true;
  if (vaultUi.navigationOnly) {
    const data = await api("/api/groups?space=private");
    if (epoch !== vaultUi.epoch) return;
    state.privateGroups = data.groups;
    if (state.area === "private") state.groups = data.groups;
    navigationState.privateCollapsed = false; saveNavigationState(); renderGroups();
    if ($("#vault-dialog").open) $("#vault-dialog").close();
    return;
  }
  state.sessionEpoch++; state.area = "private"; state.currentNote = null; state.notes = []; state.groups = [];
  clearEditor();
  if (vaultUi.createGroup) { navigationState.privateCollapsed = false; saveNavigationState(); }
  if ($("#vault-dialog").open) $("#vault-dialog").close();
  if (els.settings.open) els.settings.close();
  await loadGroups();
  if (epoch !== vaultUi.epoch || state.area !== "private") return;
  const view = ["all", "home", "trash"].includes(vaultUi.view) || state.groups.some(group => String(group.id) === String(vaultUi.view)) ? vaultUi.view : "all";
  await selectView(view, false);
  if (epoch !== vaultUi.epoch) return;
  if (vaultUi.createGroup) { vaultUi.createGroup = false; await createGroup(); }
}

async function enterPrivateArea(view = "all", create = false, navigationOnly = false) {
  if (!(await flushSave())) return;
  vaultUi.view = view; vaultUi.createGroup = create; vaultUi.navigationOnly = navigationOnly;
  const epoch = vaultUi.epoch;
  try {
    const status = await api("/api/vault");
    if (epoch !== vaultUi.epoch) return;
    vaultUi.configured = status.configured;
    if (status.unlocked) {
      await api("/api/vault/touch", { method: "POST" });
      if (epoch === vaultUi.epoch) await activatePrivateArea();
    } else {
      if (state.area === "private") await lockPrivateArea(false);
      await showVault();
    }
  } catch (error) { toast(error.message, "error"); }
}

async function showVault() {
  resetVaultForms();
  if (!$("#vault-dialog").open) $("#vault-dialog").showModal();
  const epoch = ++vaultUi.epoch;
  try {
    const status = await api("/api/vault");
    if (epoch !== vaultUi.epoch || !$("#vault-dialog").open) return;
    vaultUi.configured = status.configured;
    $("#vault-account-proof").classList.toggle("hidden", status.configured);
    $("#vault-account-proof input").required = !status.configured;
    $("#vault-old-proof").classList.toggle("hidden", !status.configured);
    $("#vault-old-proof input").required = status.configured;
    $("#vault-password-panel").open = !status.configured;
    $("#vault-unlock-form").classList.toggle("hidden", !status.configured);
    $("#vault-status").textContent = status.configured ? "验证独立密码后进入。连续 5 分钟未使用后自动锁定。" : "首次使用，请验证登录密码并设置独立访问密码。";
  } catch (error) { toast(error.message, "error"); }
}

async function refreshBackupSettings() {
  const userId = state.user?.id;
  try {
    const data = await api("/api/backups");
    if (userId !== state.user?.id) return;
    const form = $("#backup-form"), config = data.config;
    $("#backup-directory").textContent = config.directory || "instance/backups/用户名_账号编号/";
    form.elements.enabled.checked = Boolean(config.enabled);
    for (const key of ["interval_days", "time_of_day", "retention_days"]) form.elements[key].value = config[key];
    form.elements.password.required = !config.password_set;
    form.dataset.passwordSet = String(Boolean(config.password_set));
    $("#backup-current-password-label").classList.toggle("hidden", !config.password_set);
    form.elements.current_password.value = "";
    form.elements.current_password.required = false;
    form.elements.password.placeholder = config.password_set ? "已设置；留空保留原密码" : "尚未设置，请输入 ZIP 解压密码";
    $("#backup-password-status").textContent = config.password_set ? "ZIP 解压密码已设置。修改密码需验证原密码；保存后新备份使用新密码，旧备份仍使用旧密码。" : "ZIP 解压密码尚未设置，请输入并确认后保存。";
    form.elements.password.value = form.elements.confirm_password.value = "";
    const formatTime = value => new Date(value * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    $("#backup-status").textContent = config.last_error || `${config.last_success ? `上次成功生成：${formatTime(config.last_success)}。` : "尚未生成备份。"}${config.enabled && config.next_run ? `下次备份：${formatTime(config.next_run)}（北京时间）` : "自动备份未开启。"}`;
    renderBackupFiles(data.files);
  } catch (error) { toast(error.message, "error"); }
}

function renderBackupFiles(files) {
  const list = $("#backup-files"); list.replaceChildren();
  if (!files.length) { list.textContent = "暂无可用备份"; return; }
  for (const file of files) {
    const link = document.createElement("a"); link.href = `/api/backups/${file.id}`;
    link.textContent = `${file.filename} · ${(file.size / 1024).toFixed(1)} KB`;
    link.download = file.filename; list.append(link);
  }
}

function askZipPassword(message = "请输入 ZIP 解压密码") {
  const dialog = $("#zip-password-dialog"), form = $("#zip-password-form");
  form.reset(); $("#zip-password-tip").textContent = message;
  dialog.showModal(); form.elements.password.focus();
  return new Promise(resolve => {
    let value = null;
    function submit(event) { event.preventDefault(); value = form.elements.password.value; dialog.close(); }
    form.addEventListener("submit", submit);
    dialog.addEventListener("close", () => { form.removeEventListener("submit", submit); form.reset(); resolve(value); }, { once: true });
  });
}

function bindSecureDataEvents() {
  $("#vault-open").addEventListener("click", () => enterPrivateArea());
  $("#private-toggle").addEventListener("click", async () => {
    if (state.privateNavigationUnlocked && !navigationState.privateCollapsed) {
      navigationState.privateCollapsed = true; saveNavigationState(); closeGroupActionMenu(); renderNavigation();
    } else await enterPrivateArea("all", false, true);
  });
  $("#vault-settings-open").addEventListener("click", async () => { if (canCloseSecurity() && await flushSave()) { vaultUi.createGroup = false; vaultUi.navigationOnly = false; vaultUi.view = "all"; await showVault(); } });
  $("#vault-close").addEventListener("click", () => $("#vault-dialog").close());
  $("#vault-dialog").addEventListener("close", resetVaultForms);
  $("#private-lock").addEventListener("click", () => lockPrivateArea());
  $("#private-new-group").addEventListener("click", async () => {
    navigationState.privateCollapsed = false; saveNavigationState(); renderNavigation();
    if (state.area === "private") await createGroup();
    else await enterPrivateArea("all", true);
  });
  for (const type of ["pointerdown", "keydown", "input", "scroll"]) els.workspace.addEventListener(type, vaultActivity, { capture: true, passive: true });
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "hidden") resetVaultForms();
    if (document.visibilityState === "visible" && vaultUi.unlocked) {
      if (Date.now() - vaultUi.lastActive >= VAULT_IDLE_MS) await lockPrivateArea();
      else {
        try { const status = await api("/api/vault"); if (!status.unlocked) await lockPrivateArea(false); }
        catch (_) { await lockPrivateArea(false); }
      }
    }
  });
  window.addEventListener("pagehide", clearSensitiveUi);
  for (const [id, endpoint] of [["#vault-unlock-form", "/api/vault/unlock"], ["#vault-password-form", "/api/vault/password"]]) {
    $(id).addEventListener("submit", async event => {
      event.preventDefault(); if (vaultUi.busy) return;
      const form = event.target, epoch = vaultUi.epoch; vaultUi.busy = true;
      try {
        await api(endpoint, { method: "POST", body: Object.fromEntries(new FormData(form)) });
        form.reset();
        if (epoch !== vaultUi.epoch || !$("#vault-dialog").open) return;
        vaultUi.configured = true;
        await activatePrivateArea();
      } catch (error) { form.reset(); toast(error.message, "error"); }
      finally { vaultUi.busy = false; }
    });
  }
  $("#backup-form").addEventListener("submit", async event => {
    event.preventDefault(); const form = event.target, data = Object.fromEntries(new FormData(form));
    data.enabled = form.elements.enabled.checked;
    if (data.password !== data.confirm_password) { toast("两次输入的 ZIP 密码不一致", "error"); return; }
    const button = form.querySelector("button[type='submit']"); button.disabled = true;
    try { await api("/api/backups", { method: "PUT", body: data }); await refreshBackupSettings(); toast("备份设置已保存"); }
    catch (error) { toast(error.message, "error"); }
    finally { button.disabled = false; }
  });
  $("#backup-form input[name='password']").addEventListener("input", () => {
    const form = $("#backup-form");
    form.elements.current_password.required = form.dataset.passwordSet === "true" && form.elements.password.value.length > 0;
  });
  $("#backup-now").addEventListener("click", async event => {
    const button = event.target; button.disabled = true;
    try { await api("/api/backups/run", { method: "POST" }); await refreshBackupSettings(); toast("加密备份已生成"); }
    catch (error) { toast(error.message, "error"); }
    finally { button.disabled = false; }
  });
  $("#backup-refresh").addEventListener("click", async event => {
    const button = event.target, userId = state.user?.id; button.disabled = true;
    try {
      const data = await api("/api/backups");
      if (userId === state.user?.id) renderBackupFiles(data.files);
    } catch (error) { toast(error.message, "error"); }
    finally { button.disabled = false; }
  });
  let exportKind = "backup";
  $$('[data-export]').forEach(button => button.addEventListener("click", () => {
    exportKind = button.dataset.export;
    const form = $("#export-form"), json = exportKind === "json";
    form.reset(); $("#export-form .form-error").textContent = "";
    $("#export-password-fields").classList.toggle("hidden", json);
    form.elements.password.required = form.elements.confirm_password.required = !json;
    $("#export-title").textContent = json ? "导出 JSON" : "导出加密 ZIP";
    $("#export-tip").textContent = json ? "JSON 文件不加密，包含账号密码时会以明文导出。请妥善保存。" : "输入密码才能解压 ZIP；请另行保管密码。包含账号密码中的便签时，请先解锁“账号密码”。AES ZIP 可用 7-Zip、WinRAR 等工具解压。";
    $("#export-dialog").showModal();
  }));
  $("#export-close").addEventListener("click", () => { $("#export-form").reset(); $("#export-dialog").close(); });
  $("#export-dialog").addEventListener("close", () => $("#export-form").reset());
  $("#zip-password-close").addEventListener("click", () => $("#zip-password-dialog").close());
  $("#export-form").addEventListener("submit", async event => {
    event.preventDefault(); const form = event.target, button = form.querySelector("button[type='submit']");
    const sessionEpoch = state.sessionEpoch;
    if (exportKind !== "json" && form.elements.password.value !== form.elements.confirm_password.value) { $("#export-form .form-error").textContent = "两次输入的 ZIP 密码不一致"; return; }
    button.disabled = true;
    try {
      if (!(await flushSave())) return;
      const response = await fetch(`/api/export/${exportKind}`, exportKind === "json" ? { credentials: "same-origin", cache: "no-store" } : {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": state.csrf }, body: JSON.stringify({ password: form.elements.password.value }),
      });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error || "导出失败"); }
      const blob = await response.blob();
      if (sessionEpoch !== state.sessionEpoch) return;
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = exportKind === "json" ? "mynote-export.json" : exportKind === "markdown" ? "mynote-markdown.zip" : "mynote-full-backup.zip";
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      $("#export-dialog").close();
    } catch (error) { $("#export-form .form-error").textContent = error.message; }
    finally { button.disabled = false; }
  });
}

bindSecureDataEvents();
