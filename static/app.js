"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  csrf: $("meta[name='csrf-token']").content,
  user: null,
  groups: [],
  notes: [],
  currentGroup: "home",
  currentNote: null,
  search: "",
  saveTimer: null,
  savePromise: null,
  conflictServer: null,
  localConflictDraft: null,
  registrationOpen: true,
  dirty: false,
  editRevision: 0,
  composing: false,
  pendingConflict: null,
  sessionEpoch: 0,
};

const syncState = { revision: null, busy: false, writes: 0, mutation: 0, timer: null, channel: null };

let openGroupActionId = null;
let openGroupActionButton = null;

const els = {
  boot: $("#boot-screen"), auth: $("#auth-screen"), app: $("#app"), workspace: $("#workspace"),
  loginTab: $("#login-tab"), registerTab: $("#register-tab"),
  loginForm: $("#login-form"), registerForm: $("#register-form"), firstUserTip: $("#first-user-tip"),
  groups: $("#group-list"), listTitle: $("#list-title"), listCount: $("#list-count"),
  groupActionMenu: $("#group-action-menu"), groupMenuRename: $("#group-menu-rename"), groupMenuDelete: $("#group-menu-delete"),
  noteList: $("#note-list"), listEmpty: $("#note-list-empty"), search: $("#search-input"), clearSearch: $("#clear-search"),
  emptyTrash: $("#empty-trash-button"), editorEmpty: $("#editor-empty"), editorShell: $("#editor-shell"),
  content: $("#note-content"), saveState: $("#save-state"),
  updated: $("#updated-time"), groupSelect: $("#editor-group-select"),
  pin: $("#pin-button"), normalActions: $(".normal-actions"), trashActions: $(".trash-actions"), toolbar: $("#toolbar"),
  imageInput: $("#image-input"), importInput: $("#import-input"), toast: $("#toast-region"),
  inputDialog: $("#input-dialog"), inputDialogForm: $("#input-dialog-form"), inputDialogTitle: $("#input-dialog-title"),
  inputDialogField: $("#input-dialog-field"), inputDialogError: $("#input-dialog-error"),
  confirmDialog: $("#confirm-dialog"), confirmTitle: $("#confirm-title"), confirmMessage: $("#confirm-message"),
  settings: $("#settings-dialog"), adminSection: $("#admin-section"), adminUsers: $("#admin-user-list"),
  registrationToggle: $("#registration-toggle"), conflict: $("#conflict-dialog"),
};

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.code = data?.code;
    this.data = data;
  }
}

async function api(url, options = {}) {
  const method = options.method || "GET";
  const writing = method !== "GET" && method !== "HEAD";
  if (writing) { syncState.writes++; syncState.mutation++; }
  try {
    const headers = { Accept: "application/json", ...(options.headers || {}) };
    let body = options.body;
    if (method !== "GET" && method !== "HEAD") headers["X-CSRF-Token"] = state.csrf;
    if (body && !(body instanceof FormData) && typeof body !== "string") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(url, { method, headers, body, credentials: "same-origin", cache: "no-store", signal: options.signal });
    } catch (error) {
      throw new ApiError("无法连接到便签服务，请检查电脑是否仍在运行", 0, {});
    }
    const type = response.headers.get("content-type") || "";
    const data = type.includes("application/json") ? await response.json() : null;
    if (data?.csrf_token) state.csrf = data.csrf_token;
    if (!response.ok) {
      if (response.status === 401 && url !== "/api/login") {
        // Revoked/expired cookies need a fresh CSRF token before the next login.
        try { await api("/api/session"); } catch (_) {}
        showAuth();
      }
      throw new ApiError(data?.error || `请求失败（${response.status}）`, response.status, data);
    }
    if (writing && /^\/api\/(notes|groups|import)(?:[/?]|$)/.test(url)) {
      try { syncState.channel?.postMessage({ userId: state.user?.id }); } catch (_) {}
    }
    return data;
  } finally {
    if (writing) { syncState.writes--; syncState.mutation++; }
  }
}

function escapeHtml(value = "") {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function toast(message, kind = "normal") {
  // Modal dialogs render above the document, regardless of the page's z-index.
  // Keep their feedback inside the dialog so it remains visible and accessible.
  const dialog = document.activeElement?.closest("dialog[open]") || document.querySelector("dialog[open]");
  let region = els.toast;
  if (dialog) {
    region = dialog.querySelector(".dialog-toast-region");
    if (!region) {
      region = document.createElement("div");
      region.className = "dialog-toast-region";
      region.setAttribute("aria-live", "polite");
      region.setAttribute("aria-atomic", "true");
      dialog.append(region);
    }
  }
  const node = document.createElement("div");
  node.className = `toast ${kind === "error" ? "error" : ""}`;
  node.textContent = message;
  region.append(node);
  setTimeout(() => {
    node.remove();
    if (region !== els.toast && !region.childElementCount) region.remove();
  }, 3400);
}

function formatTime(value, includeTime = false) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
  return new Intl.DateTimeFormat("zh-CN", includeTime ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" } : { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function isMobile() { return window.matchMedia("(max-width: 760px)").matches; }
function mobileView(view) { if (isMobile()) els.workspace.dataset.mobileView = view; }

function setLoginPasswordVisible(visible) {
  $("#login-password").type = visible ? "text" : "password";
  const button = $("#login-password-toggle");
  button.dataset.visible = String(visible);
  button.setAttribute("aria-label", visible ? "隐藏密码" : "显示密码");
  button.title = visible ? "隐藏密码" : "显示密码";
}

function switchAuth(tab) {
  setLoginPasswordVisible(false);
  $(".auth-tabs").classList.remove("hidden");
  $("#mfa-login-form").classList.add("hidden");
  const registering = tab === "register";
  els.loginTab.classList.toggle("active", !registering);
  els.registerTab.classList.toggle("active", registering);
  els.loginForm.classList.toggle("hidden", registering);
  els.registerForm.classList.toggle("hidden", !registering);
  $(registering ? "input[name='username']" : "input[name='username']", registering ? els.registerForm : els.loginForm)?.focus();
}

function showAuth() {
  state.sessionEpoch++;
  clearTimeout(syncState.timer);
  syncState.revision = null;
  if (els.settings.open) els.settings.close();
  clearTimeout(state.saveTimer);
  state.user = null;
  els.boot.classList.add("hidden");
  els.app.classList.add("hidden");
  els.auth.classList.remove("hidden");
  els.registerTab.classList.toggle("hidden", !state.registrationOpen);
  els.firstUserTip.classList.toggle("hidden", !state.registrationOpen);
  switchAuth("login");
}

async function enterApp(user) {
  state.sessionEpoch++;
  syncState.revision = null;
  state.currentNote = null;
  state.localConflictDraft = null;
  state.conflictServer = null;
  state.composing = false;
  state.pendingConflict = null;
  if (els.conflict.open) els.conflict.close();
  clearEditor();
  state.user = user;
  els.auth.classList.add("hidden");
  els.app.classList.add("hidden");
  els.boot.classList.remove("hidden");
  $("#user-display-name").textContent = user.display_name;
  $("#user-name").textContent = `@${user.username}`;
  $("#user-avatar").textContent = [...user.display_name][0]?.toUpperCase() || "我";
  $("#profile-form input[name='display_name']").value = user.display_name;
  await loadGroups();
  await restoreLocation();
  els.boot.classList.add("hidden");
  els.app.classList.remove("hidden");
  scheduleSync(0);
}

function scheduleSync(delay = 4000) {
  clearTimeout(syncState.timer);
  if (state.user) syncState.timer = setTimeout(checkSync, delay);
}

function syncContext() {
  return JSON.stringify([state.sessionEpoch, state.user?.id, state.currentGroup, state.search,
    state.currentNote?.id, state.currentNote?.version, state.editRevision, syncState.mutation]);
}

function noteChanged(note) {
  const current = state.currentNote;
  return current && (!note || ["version", "group_id", "is_deleted", "is_pinned", "content_html"]
    .some(key => current[key] !== note[key]));
}

function showEditConflict(note) {
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  if (state.composing) { state.pendingConflict = { note }; return; }
  state.conflictServer = note;
  state.localConflictDraft = { ...currentDraft(), id: state.currentNote.id };
  els.saveState.textContent = "保存冲突";
  els.saveState.className = "save-state error";
  if (!els.conflict.open) els.conflict.showModal();
}

async function checkSync() {
  if (syncState.busy) { scheduleSync(); return; }
  if (!state.user || document.visibilityState === "hidden" || syncState.writes || state.savePromise
      || state.composing || state.localConflictDraft || document.querySelector("dialog[open]")) {
    scheduleSync(); return;
  }
  syncState.busy = true;
  const context = syncContext();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  const options = { signal: controller.signal };
  try {
    const marker = await api("/api/sync", options);
    if (context !== syncContext()) return;
    if (marker.user_id !== state.user.id) { showAuth(); return; }
    if (marker.revision === syncState.revision) return;
    const { groups } = await api("/api/groups", options);
    const groupExists = ["home", "trash"].includes(state.currentGroup)
      || groups.some(group => String(group.id) === String(state.currentGroup));
    const view = groupExists ? state.currentGroup : "home";
    const params = new URLSearchParams();
    if (view === "trash") params.set("trash", "1");
    else params.set("group_id", view === "home" ? "ungrouped" : view);
    if (state.search) params.set("q", state.search);
    const { notes } = await api(`/api/notes?${params}`, options);
    let note = null;
    if (state.currentNote) {
      try { note = (await api(`/api/notes/${state.currentNote.id}`, options)).note; }
      catch (error) { if (error.status !== 404) throw error; }
    }
    const latest = await api("/api/sync", options);
    // Never apply a response across navigation, typing, saves, or account changes.
    if (context !== syncContext() || latest.user_id !== marker.user_id || latest.revision !== marker.revision
        || syncState.writes || state.savePromise || state.composing || document.querySelector("dialog[open]")) return;
    if (state.dirty) {
      if (noteChanged(note)) showEditConflict(note);
      return;
    }
    const changed = noteChanged(note);
    state.groups = groups;
    state.notes = notes;
    state.currentGroup = view;
    if (changed) {
      const scrollTop = els.content.scrollTop;
      state.currentNote = note;
      renderEditor();
      els.content.scrollTop = scrollTop;
    }
    renderGroups();
    renderGroupSelect();
    renderNotes();
    els.listTitle.textContent = viewTitle(view);
    els.emptyTrash.classList.toggle("hidden", view !== "trash");
    persistLocation();
    syncState.revision = marker.revision;
  } catch (_) {
    // Offline/background failures are retried without repeatedly interrupting typing.
  } finally {
    clearTimeout(timeout);
    syncState.busy = false;
    scheduleSync();
  }
}

function persistLocation() {
  const params = new URLSearchParams();
  params.set("group", String(state.currentGroup));
  if (state.currentNote) params.set("note", String(state.currentNote.id));
  history.replaceState(null, "", `${location.pathname}${location.search}#${params}`);
}

async function restoreLocation() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const noteId = Number(params.get("note"));
  if (Number.isInteger(noteId) && noteId > 0) {
    try {
      const data = await api(`/api/notes/${noteId}`);
      const note = data.note;
      const view = note.is_deleted ? "trash" : note.group_id ?? "home";
      await selectView(view, false, false);
      state.currentNote = note;
      renderEditor();
      renderNotes();
      persistLocation();
      mobileView("editor");
      return;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  const requested = params.get("group");
  let view = "home";
  if (requested === "trash") view = "trash";
  else if (/^\d+$/.test(requested || "") && state.groups.some(group => group.id === Number(requested))) view = Number(requested);
  await selectView(view, false, false);
  persistLocation();
  mobileView("list");
}

async function bootstrap() {
  try {
    const data = await api("/api/session");
    state.csrf = data.csrf_token;
    state.registrationOpen = data.registration_open;
    if (data.authenticated) await enterApp(data.user);
    else {
      showAuth();
      if (data.mfa_required) showMfaLogin();
    }
  } catch (error) {
    showAuth();
    toast(error.message, "error");
  }
}

async function authSubmit(form, endpoint) {
  const errorNode = $(".form-error", form);
  errorNode.textContent = "";
  const button = $("button[type='submit']", form);
  button.disabled = true;
  const body = Object.fromEntries(new FormData(form));
  try {
    const data = await api(endpoint, { method: "POST", body });
    state.csrf = data.csrf_token;
    form.reset();
    if (data.mfa_required) { showMfaLogin(); return; }
    await enterApp(data.user);
  } catch (error) {
    errorNode.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function loadGroups() {
  const epoch = state.sessionEpoch;
  const data = await api("/api/groups");
  if (epoch !== state.sessionEpoch) return;
  syncState.revision = null;
  state.groups = data.groups;
  renderGroups();
  renderGroupSelect();
}

function renderGroups() {
  closeGroupActionMenu();
  els.groups.innerHTML = state.groups.map(group => `
    <div class="group-row" data-group-row="${group.id}">
      <button class="nav-item ${String(state.currentGroup) === String(group.id) ? "active" : ""}" data-view="${group.id}" type="button">
        <svg class="folder-icon group-folder-icon" viewBox="0 0 20 18" aria-hidden="true"><path d="M2.5 4.5h5l1.7 2h8.3v8.75H2.5zM2.5 4.5V2.75h5.3"></path></svg>
        <span class="group-name">${escapeHtml(group.name)}</span>
      </button>
      <button class="group-more-button" data-group-more="${group.id}" type="button" title="更多操作" aria-label="${escapeHtml(group.name)}的更多操作" aria-haspopup="menu" aria-controls="group-action-menu" aria-expanded="false">
        <svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="4" cy="9" r="1"></circle><circle cx="9" cy="9" r="1"></circle><circle cx="14" cy="9" r="1"></circle></svg>
      </button>
    </div>`).join("");
  $$(".nav-item[data-view]").forEach(button => button.classList.toggle("active", String(button.dataset.view) === String(state.currentGroup)));
}

function closeGroupActionMenu(restoreFocus = false) {
  if (!els.groupActionMenu) return;
  els.groupActionMenu.classList.add("hidden");
  els.groupActionMenu.removeAttribute("style");
  if (openGroupActionButton) {
    openGroupActionButton.setAttribute("aria-expanded", "false");
    openGroupActionButton.closest(".group-row")?.classList.remove("menu-open");
    if (restoreFocus) openGroupActionButton.focus();
  }
  openGroupActionId = null;
  openGroupActionButton = null;
}

function toggleGroupActionMenu(groupId, button) {
  if (openGroupActionId === groupId) { closeGroupActionMenu(); return; }
  closeGroupActionMenu();
  openGroupActionId = groupId;
  openGroupActionButton = button;
  button.setAttribute("aria-expanded", "true");
  button.closest(".group-row")?.classList.add("menu-open");
  els.groupMenuRename.dataset.groupRename = groupId;
  els.groupMenuDelete.dataset.groupDelete = groupId;
  els.groupActionMenu.classList.remove("hidden");

  const anchor = button.getBoundingClientRect();
  const menu = els.groupActionMenu.getBoundingClientRect();
  const margin = 8;
  const left = Math.max(margin, Math.min(anchor.right - menu.width, window.innerWidth - menu.width - margin));
  const below = anchor.bottom + 5;
  const top = below + menu.height <= window.innerHeight - margin ? below : Math.max(margin, anchor.top - menu.height - 5);
  els.groupActionMenu.style.left = `${left}px`;
  els.groupActionMenu.style.top = `${top}px`;
}

function renderGroupSelect() {
  const selected = state.dirty ? els.groupSelect.value : state.currentNote?.group_id ?? "";
  els.groupSelect.innerHTML = `<option value="">首页</option>${state.groups.map(group => `<option value="${group.id}">${escapeHtml(group.name)}</option>`).join("")}`;
  els.groupSelect.value = selected;
}

function viewTitle(view) {
  if (view === "home") return "首页";
  if (view === "trash") return "回收站";
  return state.groups.find(group => String(group.id) === String(view))?.name || "便签";
}

async function selectView(view, save = true, updateLocation = true) {
  if (save && !(await flushSave())) return;
  state.currentGroup = view;
  state.currentNote = null;
  state.search = "";
  els.search.value = "";
  els.clearSearch.classList.add("hidden");
  els.listTitle.textContent = viewTitle(view);
  els.emptyTrash.classList.toggle("hidden", view !== "trash");
  renderGroups();
  clearEditor();
  await loadNotes();
  mobileView("list");
  if (updateLocation) persistLocation();
}

async function loadNotes() {
  const context = JSON.stringify([state.sessionEpoch, state.currentGroup, state.search]);
  const params = new URLSearchParams();
  if (state.currentGroup === "trash") params.set("trash", "1");
  else if (state.currentGroup === "home") params.set("group_id", "ungrouped");
  else params.set("group_id", state.currentGroup);
  if (state.search) params.set("q", state.search);
  const data = await api(`/api/notes?${params}`);
  if (context !== JSON.stringify([state.sessionEpoch, state.currentGroup, state.search])) return;
  syncState.revision = null;
  state.notes = data.notes;
  renderNotes();
  await loadGroups();
}

function renderNotes() {
  els.listCount.textContent = state.notes.length;
  els.noteList.innerHTML = state.notes.map(note => {
    const lines = (note.preview || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const lead = lines[0] || "空白便签";
    const remainder = lines.slice(1).join(" ") || (lines.length ? "" : "暂无内容");
    const swipeDelete = state.currentGroup === "trash" ? "" : `
      <button class="swipe-delete-button" data-swipe-delete="${note.id}" type="button" aria-label="删除便签：${escapeHtml(lead)}">删除</button>`;
    return `
    <div class="note-swipe-row" data-swipe-row="${note.id}">
      ${swipeDelete}
      <article class="note-card ${state.currentNote?.id === note.id ? "active" : ""}" data-note-id="${note.id}" tabindex="0">
        <div class="note-card-title-row">${note.is_pinned ? '<span class="pin-mark">◆</span>' : ""}<h3>${escapeHtml(lead)}</h3></div>
        <p>${escapeHtml(remainder)}</p>
        <time datetime="${escapeHtml(note.updated_at)}">${formatTime(note.updated_at)}</time>
      </article>
    </div>`;
  }).join("");
  els.listEmpty.classList.toggle("hidden", state.notes.length > 0);
  if (!state.notes.length) {
    $("#note-list-empty strong").textContent = state.currentGroup === "trash" ? "回收站是空的" : state.search ? "没有匹配的便签" : "这里还没有便签";
    $("#note-list-empty span").textContent = state.currentGroup === "trash" ? "删除的便签会暂存在这里" : state.search ? "换个关键词试试" : "点击“新建”记录第一条内容";
  }
}

function clearEditor() {
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  state.dirty = false;
  state.editRevision++;
  els.editorShell.classList.add("hidden");
  els.editorEmpty.classList.remove("hidden");
  els.content.innerHTML = "";
}

async function selectNote(noteId) {
  if (state.currentNote?.id === noteId) { mobileView("editor"); return; }
  if (!(await flushSave())) return;
  try {
    const data = await api(`/api/notes/${noteId}`);
    state.currentNote = data.note;
    renderEditor();
    renderNotes();
    mobileView("editor");
    persistLocation();
  } catch (error) { toast(error.message, "error"); }
}

function renderEditor() {
  syncState.revision = null;
  state.dirty = false;
  state.editRevision++;
  const note = state.currentNote;
  if (!note) return clearEditor();
  els.editorEmpty.classList.add("hidden");
  els.editorShell.classList.remove("hidden");
  els.content.innerHTML = note.content_html || "";
  els.groupSelect.value = note.group_id ?? "";
  updatePinButton(note.is_pinned);
  els.updated.textContent = `更新于 ${formatTime(note.updated_at, true)}`;
  els.saveState.textContent = "已保存";
  els.saveState.className = "save-state";
  els.normalActions.classList.toggle("hidden", note.is_deleted);
  els.trashActions.classList.toggle("hidden", !note.is_deleted);
  els.toolbar.classList.toggle("hidden", note.is_deleted);
  els.content.contentEditable = note.is_deleted ? "false" : "true";
}

function updatePinButton(pinned) {
  els.pin.classList.toggle("active", pinned);
  els.pin.setAttribute("aria-pressed", String(pinned));
  els.pin.title = pinned ? "取消置顶" : "置顶";
  els.pin.setAttribute("aria-label", pinned ? "取消置顶" : "置顶");
  $(".pin-button-label", els.pin).textContent = pinned ? "已置顶" : "置顶";
}

async function newNote() {
  if (state.currentGroup === "trash") await selectView("home");
  if (!(await flushSave())) return;
  const groupId = /^\d+$/.test(String(state.currentGroup)) ? Number(state.currentGroup) : null;
  try {
    const data = await api("/api/notes", { method: "POST", body: { group_id: groupId } });
    state.notes.unshift({ ...data.note, preview: "" });
    await loadGroups();
    state.currentNote = data.note;
    renderNotes();
    renderEditor();
    mobileView("editor");
    persistLocation();
    els.content.focus();
  } catch (error) { toast(error.message, "error"); }
}

function markUnsaved() {
  if (!state.currentNote || state.currentNote.is_deleted) return;
  state.dirty = true;
  state.editRevision++;
  const blank = editorIsBlank();
  els.saveState.textContent = blank ? "内容为空，离开后移除" : "未保存";
  els.saveState.className = "save-state unsaved";
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  if (blank || state.composing || state.localConflictDraft) return;
  state.saveTimer = setTimeout(() => saveNow(), 750);
}

function currentDraft() {
  return {
    content_html: els.content.innerHTML,
    group_id: els.groupSelect.value ? Number(els.groupSelect.value) : null,
    is_pinned: els.pin.classList.contains("active"),
    version: state.currentNote.version,
  };
}

function editorIsBlank() {
  const visibleText = (els.content.textContent || "").replace(/[\s\u200B-\u200D\uFEFF]/g, "");
  return !visibleText && !els.content.querySelector("img");
}

async function saveNow(discardEmpty = false) {
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  if (state.composing || state.localConflictDraft) return;
  if (state.savePromise) {
    const waitingNote = state.currentNote?.id;
    await state.savePromise.catch(() => {});
    if (state.currentNote?.id === waitingNote && state.dirty) return saveNow(discardEmpty);
    return;
  }
  if (!state.currentNote || state.currentNote.is_deleted) return;
  const noteId = state.currentNote.id;
  const editRevision = state.editRevision;
  const sessionEpoch = state.sessionEpoch;
  const draft = currentDraft();
  const blank = editorIsBlank();
  if (blank && !discardEmpty) {
    els.saveState.textContent = "内容为空，离开后移除";
    els.saveState.className = "save-state unsaved";
    return;
  }
  els.saveState.textContent = blank ? "正在移除…" : "保存中…";
  els.saveState.className = "save-state saving";
  const operation = blank
    ? api(`/api/notes/${noteId}`, { method: "DELETE", body: { version: draft.version, discard_if_blank: true } })
    : api(`/api/notes/${noteId}`, { method: "PATCH", body: draft });
  state.savePromise = operation;
  try {
    const data = await operation;
    if (state.currentNote?.id !== noteId || state.sessionEpoch !== sessionEpoch) return;
    if (blank) {
      if (state.editRevision !== editRevision) { showEditConflict(null); return; }
      state.notes = state.notes.filter(note => note.id !== noteId);
      state.currentNote = null;
      clearEditor();
      renderNotes();
      await loadGroups();
      mobileView("list");
      persistLocation();
      return;
    }
    state.currentNote = { ...state.currentNote, ...data.note };
    state.dirty = state.editRevision !== editRevision;
    els.saveState.textContent = state.dirty ? "未保存" : "已保存";
    els.saveState.className = state.dirty ? "save-state unsaved" : "save-state";
    els.updated.textContent = `更新于 ${formatTime(data.note.updated_at, true)}`;
    const listNote = state.notes.find(note => note.id === noteId);
    if (listNote) Object.assign(listNote, data.note, { preview: data.note.preview });
    state.notes.sort((a, b) => Number(b.is_pinned) - Number(a.is_pinned) || new Date(b.updated_at) - new Date(a.updated_at));
    renderNotes();
  } catch (error) {
    if (state.currentNote?.id !== noteId || state.sessionEpoch !== sessionEpoch) return;
    state.dirty = true;
    if (error.code === "edit_conflict" || error.status === 404) {
      showEditConflict(error.data.current || null);
    } else {
      els.saveState.textContent = "保存失败";
      els.saveState.className = "save-state error";
      toast(error.message, "error");
    }
  } finally {
    if (state.savePromise === operation) state.savePromise = null;
  }
}

async function flushSave() {
  if (state.savePromise) await state.savePromise.catch(() => {});
  if (state.localConflictDraft || state.composing) return false;
  if (!state.currentNote || state.currentNote.is_deleted) return true;
  if (editorIsBlank()) await saveNow(true);
  else if (state.dirty) await saveNow();
  return !state.dirty && !state.localConflictDraft;
}

function askInput(title, initial = "", maxLength = 50) {
  return new Promise(resolve => {
    els.inputDialogTitle.textContent = title;
    els.inputDialogField.value = initial;
    els.inputDialogField.maxLength = maxLength;
    els.inputDialogError.textContent = "";
    els.inputDialog.showModal();
    setTimeout(() => { els.inputDialogField.focus(); els.inputDialogField.select(); }, 0);
    const close = () => { els.inputDialog.removeEventListener("close", close); resolve(els.inputDialog.returnValue === "default" ? els.inputDialogField.value.trim() : null); };
    els.inputDialog.addEventListener("close", close);
  });
}

function confirmAction(title, message, confirmLabel = "确认") {
  return new Promise(resolve => {
    els.confirmTitle.textContent = title;
    els.confirmMessage.textContent = message;
    $("#confirm-button").textContent = confirmLabel;
    els.confirmDialog.showModal();
    const close = () => { els.confirmDialog.removeEventListener("close", close); resolve(els.confirmDialog.returnValue === "confirm"); };
    els.confirmDialog.addEventListener("close", close);
  });
}

async function createGroup() {
  const name = await askInput("新建分组");
  if (!name) return;
  try {
    const data = await api("/api/groups", { method: "POST", body: { name } });
    state.groups.push(data.group);
    renderGroups(); renderGroupSelect();
    toast("分组已创建");
  } catch (error) { toast(error.message, "error"); }
}

async function renameGroup(groupId) {
  const group = state.groups.find(item => item.id === groupId);
  if (!group) return;
  const name = await askInput("重命名分组", group.name);
  if (!name || name === group.name) return;
  try {
    await api(`/api/groups/${groupId}`, { method: "PATCH", body: { name } });
    group.name = name; renderGroups(); renderGroupSelect(); els.listTitle.textContent = viewTitle(state.currentGroup);
  } catch (error) { toast(error.message, "error"); }
}

async function deleteGroup(groupId) {
  const group = state.groups.find(item => item.id === groupId);
  if (!group || !(await confirmAction("删除分组", `确定删除“${group.name}”吗？其中的便签会移到“首页”。`, "删除"))) return;
  try {
    await api(`/api/groups/${groupId}`, { method: "DELETE" });
    if (String(state.currentGroup) === String(groupId)) state.currentGroup = "home";
    if (state.currentNote?.group_id === groupId) state.currentNote.group_id = null;
    await loadGroups(); await selectView(state.currentGroup, false);
  } catch (error) { toast(error.message, "error"); }
}

async function trashNote(noteId) {
  const note = state.notes.find(item => item.id === noteId) || (state.currentNote?.id === noteId ? state.currentNote : null);
  const noteLabel = (note?.preview || "").split(/\r?\n/).find(line => line.trim())?.trim() || "这条空白便签";
  if (!note || !(await confirmAction("移到回收站", `确定删除“${noteLabel}”吗？`, "移到回收站"))) return;
  try {
    await api(`/api/notes/${noteId}`, { method: "DELETE" });
    state.notes = state.notes.filter(item => item.id !== noteId);
    if (state.currentNote?.id === noteId) {
      state.currentNote = null;
      clearEditor();
      mobileView("list");
      persistLocation();
    }
    renderNotes();
    await loadGroups();
  } catch (error) { toast(error.message, "error"); }
}

async function trashCurrent() {
  if (state.currentNote) await trashNote(state.currentNote.id);
}

async function restoreCurrent() {
  if (!state.currentNote) return;
  try {
    await api(`/api/notes/${state.currentNote.id}/restore`, { method: "POST" });
    state.notes = state.notes.filter(note => note.id !== state.currentNote.id);
    state.currentNote = null; clearEditor(); renderNotes(); await loadGroups(); mobileView("list"); persistLocation(); toast("便签已恢复");
  } catch (error) { toast(error.message, "error"); }
}

async function permanentDelete() {
  if (!state.currentNote || !(await confirmAction("永久删除", "此操作无法撤销，确定永久删除这条便签吗？", "永久删除"))) return;
  try {
    await api(`/api/notes/${state.currentNote.id}/permanent`, { method: "DELETE" });
    state.notes = state.notes.filter(note => note.id !== state.currentNote.id);
    state.currentNote = null; clearEditor(); renderNotes(); mobileView("list"); persistLocation();
  } catch (error) { toast(error.message, "error"); }
}

async function emptyTrash() {
  if (!state.notes.length || !(await confirmAction("清空回收站", "回收站内的便签和图片将永久删除，且无法恢复。", "全部删除"))) return;
  try {
    const data = await api("/api/trash", { method: "DELETE" });
    state.notes = []; state.currentNote = null; clearEditor(); renderNotes(); persistLocation(); toast(`已永久删除 ${data.deleted} 条便签`);
  } catch (error) { toast(error.message, "error"); }
}

async function uploadImage(file) {
  if (!state.currentNote || !file) return;
  if (file.size > 10 * 1024 * 1024) return toast("单张图片不能超过 10 MB", "error");
  const form = new FormData(); form.append("file", file);
  els.saveState.textContent = "上传图片…"; els.saveState.className = "save-state saving";
  try {
    const data = await api(`/api/notes/${state.currentNote.id}/attachments`, { method: "POST", body: form });
    els.content.focus();
    document.execCommand("insertHTML", false, `<img src="${data.attachment.url}" alt="${escapeHtml(data.attachment.original_name)}" data-attachment-id="${data.attachment.id}"><p><br></p>`);
    markUnsaved();
  } catch (error) { toast(error.message, "error"); }
  finally { els.imageInput.value = ""; }
}

async function openSettings() {
  $("#profile-form input[name='display_name']").value = state.user.display_name;
  els.settings.showModal();
  await refreshMfa();
  els.adminSection.classList.toggle("hidden", !state.user.is_admin);
  if (state.user.is_admin) {
    try {
      const data = await api("/api/admin/users");
      els.registrationToggle.checked = data.registration_open;
      renderAdminUsers(data.users);
    } catch (error) { toast(error.message, "error"); }
  }
}

function renderAdminUsers(users) {
  els.adminUsers.innerHTML = users.map(user => `
    <div class="admin-user">
      <span class="avatar">${escapeHtml([...user.display_name][0] || "?")}</span>
      <span class="user-copy"><strong>${escapeHtml(user.display_name)} ${user.is_admin ? '<span class="admin-badge">管理员</span>' : ""}</strong><small>@${escapeHtml(user.username)}</small></span>
      ${user.id === state.user.id ? '<small>当前账号</small>' : `<label class="switch-row" title="启用账号"><input type="checkbox" data-user-active="${user.id}" ${user.is_active ? "checked" : ""}><span class="switch"></span></label>`}
    </div>`).join("");
}

async function importFile(file) {
  if (!file) return;
  const form = new FormData(); form.append("file", file);
  toast("正在导入，请稍候…");
  try {
    const data = await api("/api/import", { method: "POST", body: form });
    await loadGroups(); await loadNotes();
    toast(`导入完成：${data.notes} 条便签，${data.groups} 个分组`);
  } catch (error) { toast(error.message, "error"); }
  finally { els.importInput.value = ""; }
}

function bindEvents() {
  const swipeWidth = 78;
  let swipeGesture = null;
  let openSwipeRow = null;
  let suppressNoteClickUntil = 0;

  const closeSwipeRow = (row = openSwipeRow) => {
    if (!row) return;
    row.classList.remove("swiped", "swiping");
    $(".note-card", row)?.style.removeProperty("transform");
    if (openSwipeRow === row) openSwipeRow = null;
  };

  els.loginTab.addEventListener("click", () => switchAuth("login"));
  els.registerTab.addEventListener("click", () => switchAuth("register"));
  $("#login-password-toggle").addEventListener("click", () => {
    setLoginPasswordVisible($("#login-password").type === "password");
  });
  els.loginForm.addEventListener("reset", () => setLoginPasswordVisible(false));
  els.loginForm.addEventListener("submit", event => {
    event.preventDefault();
    setLoginPasswordVisible(false);
    authSubmit(els.loginForm, "/api/login");
  });
  els.registerForm.addEventListener("submit", event => { event.preventDefault(); authSubmit(els.registerForm, "/api/register"); });

  document.addEventListener("click", event => {
    const swipeDelete = event.target.closest("[data-swipe-delete]");
    if (swipeDelete) {
      event.stopPropagation();
      const noteId = Number(swipeDelete.dataset.swipeDelete);
      closeSwipeRow(swipeDelete.closest("[data-swipe-row]"));
      trashNote(noteId);
      return;
    }
    const groupMore = event.target.closest("[data-group-more]");
    if (groupMore) {
      event.stopPropagation();
      toggleGroupActionMenu(Number(groupMore.dataset.groupMore), groupMore);
      return;
    }
    const rename = event.target.closest("[data-group-rename]");
    if (rename) {
      event.stopPropagation();
      const groupId = Number(rename.dataset.groupRename);
      closeGroupActionMenu();
      renameGroup(groupId);
      return;
    }
    const remove = event.target.closest("[data-group-delete]");
    if (remove) {
      event.stopPropagation();
      const groupId = Number(remove.dataset.groupDelete);
      closeGroupActionMenu();
      deleteGroup(groupId);
      return;
    }
    if (!event.target.closest("#group-action-menu")) closeGroupActionMenu();
    const view = event.target.closest("[data-view]")?.dataset.view;
    if (view !== undefined) selectView(/^\d+$/.test(view) ? Number(view) : view);
    const noteCard = event.target.closest("[data-note-id]");
    if (noteCard) {
      const row = noteCard.closest("[data-swipe-row]");
      if (Date.now() < suppressNoteClickUntil) return;
      if (openSwipeRow) { closeSwipeRow(); return; }
      if (!row?.classList.contains("swiping")) selectNote(Number(noteCard.dataset.noteId));
    }
  });
  els.noteList.addEventListener("keydown", event => {
    if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-note-id]")) { event.preventDefault(); selectNote(Number(event.target.dataset.noteId)); }
  });
  els.noteList.addEventListener("pointerdown", event => {
    if (!isMobile() || state.currentGroup === "trash" || event.button !== 0 || event.target.closest("[data-swipe-delete]")) return;
    const card = event.target.closest(".note-card");
    const row = card?.closest("[data-swipe-row]");
    if (!card || !row) return;
    if (openSwipeRow && openSwipeRow !== row) closeSwipeRow();
    const wasOpen = row.classList.contains("swiped");
    swipeGesture = {
      pointerId: event.pointerId,
      row,
      card,
      startX: event.clientX,
      startY: event.clientY,
      base: wasOpen ? -swipeWidth : 0,
      offset: wasOpen ? -swipeWidth : 0,
      dragging: false,
    };
    card.setPointerCapture?.(event.pointerId);
  });
  els.noteList.addEventListener("pointermove", event => {
    const gesture = swipeGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (!gesture.dragging) {
      if (Math.abs(deltaY) > 10 && Math.abs(deltaY) > Math.abs(deltaX)) { swipeGesture = null; return; }
      if (Math.abs(deltaX) < 8 || Math.abs(deltaX) <= Math.abs(deltaY)) return;
      gesture.dragging = true;
      gesture.row.classList.add("swiping");
    }
    event.preventDefault();
    gesture.offset = Math.max(-swipeWidth, Math.min(0, gesture.base + deltaX));
    gesture.card.style.transform = `translateX(${gesture.offset}px)`;
  }, { passive: false });
  const finishSwipe = event => {
    const gesture = swipeGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const shouldOpen = gesture.dragging && gesture.offset < -(swipeWidth / 2);
    gesture.row.classList.remove("swiping");
    gesture.card.style.removeProperty("transform");
    gesture.row.classList.toggle("swiped", shouldOpen);
    openSwipeRow = shouldOpen ? gesture.row : null;
    if (gesture.dragging) suppressNoteClickUntil = Date.now() + 350;
    swipeGesture = null;
  };
  els.noteList.addEventListener("pointerup", finishSwipe);
  els.noteList.addEventListener("pointercancel", finishSwipe);
  els.noteList.addEventListener("scroll", () => closeSwipeRow(), { passive: true });
  $("#new-note-button").addEventListener("click", newNote);
  $("#empty-new-note").addEventListener("click", newNote);
  $("#new-group-button").addEventListener("click", createGroup);
  $("#delete-note-button").addEventListener("click", trashCurrent);
  $("#restore-note-button").addEventListener("click", restoreCurrent);
  $("#permanent-delete-button").addEventListener("click", permanentDelete);
  els.emptyTrash.addEventListener("click", emptyTrash);

  let searchTimer;
  els.search.addEventListener("input", () => {
    clearTimeout(searchTimer); state.search = els.search.value.trim(); els.clearSearch.classList.toggle("hidden", !state.search);
    searchTimer = setTimeout(() => loadNotes().catch(error => toast(error.message, "error")), 300);
  });
  els.clearSearch.addEventListener("click", () => { els.search.value = ""; state.search = ""; els.clearSearch.classList.add("hidden"); loadNotes(); });

  els.content.addEventListener("input", markUnsaved);
  els.content.addEventListener("compositionstart", () => {
    state.composing = true;
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
  });
  els.content.addEventListener("compositionend", () => {
    state.composing = false;
    markUnsaved();
    if (state.pendingConflict) {
      const { note } = state.pendingConflict;
      state.pendingConflict = null;
      showEditConflict(note);
    }
  });
  els.content.addEventListener("paste", () => setTimeout(markUnsaved));
  els.groupSelect.addEventListener("change", () => { markUnsaved(); saveNow(); });
  els.pin.addEventListener("click", () => { updatePinButton(!els.pin.classList.contains("active")); markUnsaved(); saveNow(); });

  els.toolbar.addEventListener("mousedown", event => event.preventDefault());
  els.toolbar.addEventListener("wheel", event => {
    if (els.toolbar.scrollWidth <= els.toolbar.clientWidth) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (!delta) return;
    event.preventDefault();
    els.toolbar.scrollLeft += delta;
  }, { passive: false });
  els.toolbar.addEventListener("click", event => {
    const button = event.target.closest("button"); if (!button || !state.currentNote) return;
    els.content.focus();
    if (button.dataset.cmd) document.execCommand(button.dataset.cmd, false, button.dataset.value || null);
    else if (button.dataset.special === "link") {
      const url = window.prompt("请输入链接地址（https://…）");
      if (url && /^(https?:\/\/|mailto:)/i.test(url)) document.execCommand("createLink", false, url);
      else if (url) toast("链接需以 http://、https:// 或 mailto: 开头", "error");
    } else if (button.dataset.special === "checklist") document.execCommand("insertHTML", false, "<div>☐&nbsp; </div>");
    else if (button.dataset.special === "image") els.imageInput.click();
    markUnsaved();
  });
  els.imageInput.addEventListener("change", () => uploadImage(els.imageInput.files[0]));

  $("#open-sidebar").addEventListener("click", () => mobileView("sidebar"));
  $("#sidebar-close").addEventListener("click", () => mobileView("list"));
  $("#back-to-list").addEventListener("click", async () => {
    if (!(await flushSave())) return;
    state.currentNote = null;
    clearEditor();
    renderNotes();
    persistLocation();
    mobileView("list");
  });
  $("#user-menu-button").addEventListener("click", openSettings);
  $("#settings-close").addEventListener("click", () => {
    if (canCloseSecurity()) els.settings.close();
  });
  $("#import-button").addEventListener("click", () => els.importInput.click());
  els.importInput.addEventListener("change", () => importFile(els.importInput.files[0]));

  $("#profile-form").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const displayName = new FormData(event.target).get("display_name");
      const data = await api("/api/account", { method: "PATCH", body: { display_name: displayName } });
      state.user = data.user; $("#user-display-name").textContent = data.user.display_name; $("#user-avatar").textContent = [...data.user.display_name][0]; toast("昵称已更新");
    } catch (error) { toast(error.message, "error"); }
  });
  $("#password-form").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      if (!(await flushSave())) return;
      const body = Object.fromEntries(new FormData(event.target));
      Object.assign(body, factorBody(body.factor));
      await api("/api/account", { method: "PATCH", body }); event.target.reset(); toast("密码已更新");
    } catch (error) { toast(error.message, "error"); }
  });
  $("#logout-button").addEventListener("click", async () => {
    if (!canCloseSecurity()) return;
    if (!(await flushSave())) return;
    try {
      await api("/api/logout", { method: "POST" });
      await api("/api/session");
    } catch (_) {}
    els.settings.close(); showAuth();
  });
  els.registrationToggle.addEventListener("change", async () => {
    try { const data = await api("/api/admin/registration", { method: "PATCH", body: { open: els.registrationToggle.checked } }); state.registrationOpen = data.registration_open; toast(data.registration_open ? "已开放注册" : "已关闭注册"); }
    catch (error) { els.registrationToggle.checked = !els.registrationToggle.checked; toast(error.message, "error"); }
  });
  els.adminUsers.addEventListener("change", async event => {
    const input = event.target.closest("[data-user-active]"); if (!input) return;
    try { await api(`/api/admin/users/${input.dataset.userActive}`, { method: "PATCH", body: { is_active: input.checked } }); toast(input.checked ? "账号已启用" : "账号已停用"); }
    catch (error) { input.checked = !input.checked; toast(error.message, "error"); }
  });

  els.conflict.addEventListener("cancel", event => event.preventDefault());
  $("#conflict-load").addEventListener("click", () => {
    state.currentNote = state.conflictServer; state.conflictServer = null; state.localConflictDraft = null; els.conflict.close(); renderEditor(); renderNotes(); persistLocation(); toast("已载入服务器版本");
    syncState.revision = null; scheduleSync(0);
  });
  $("#conflict-copy").addEventListener("click", async () => {
    const draft = state.localConflictDraft; if (!draft) return;
    try {
      const { groups } = await api("/api/groups");
      const groupId = groups.some(group => group.id === draft.group_id) ? draft.group_id : null;
      const data = await api("/api/notes", { method: "POST", body: { content_html: `<p><strong>冲突副本</strong></p>${draft.content_html}`, group_id: groupId } });
      els.conflict.close(); state.conflictServer = null; state.localConflictDraft = null;
      state.currentNote = data.note; renderEditor();
      if (!["home", "trash"].includes(state.currentGroup) && !groups.some(group => String(group.id) === String(state.currentGroup))) state.currentGroup = "home";
      await loadNotes(); persistLocation(); syncState.revision = null; scheduleSync(0); toast("本机内容已保存为新便签");
    } catch (error) { toast(error.message, "error"); }
  });

  window.addEventListener("beforeunload", event => {
    const emptyDraft = state.currentNote && !state.currentNote.is_deleted && editorIsBlank();
    if (state.dirty || state.localConflictDraft || state.saveTimer || state.savePromise || emptyDraft) { event.preventDefault(); event.returnValue = ""; }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && state.saveTimer) saveNow();
    if (document.visibilityState === "visible") scheduleSync(0);
  });
  window.addEventListener("online", async () => {
    if (state.user && state.dirty && !editorIsBlank()) await saveNow();
    scheduleSync(0);
  });
  window.addEventListener("focus", () => scheduleSync(0));
  try {
    syncState.channel = new BroadcastChannel("mynote-saved");
    syncState.channel.onmessage = event => {
      if (state.user && event.data?.userId === state.user.id) scheduleSync(0);
    };
  } catch (_) { /* Periodic checks also work when tab messaging is unavailable. */ }
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && openGroupActionId !== null) { closeGroupActionMenu(true); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); saveNow(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n" && state.user) { event.preventDefault(); newNote(); }
  });
}

const securityUi = { busy: false, codesPending: false };

function factorBody(value = "") {
  const factor = String(value).trim();
  return /^[0-9]{6}$/.test(factor) ? { code: factor } : { recovery_code: factor };
}

function showMfaLogin() {
  els.loginForm.classList.add("hidden");
  els.registerForm.classList.add("hidden");
  $(".auth-tabs").classList.add("hidden");
  els.firstUserTip.classList.add("hidden");
  const form = $("#mfa-login-form");
  form.reset();
  $(".form-error", form).textContent = "";
  $("input[name='code']", form).inputMode = "numeric";
  form.classList.remove("hidden");
  $("input[name='code']", form).focus();
}

async function refreshMfa() {
  const buttons = ["#mfa-setup-button", "#mfa-codes-button", "#mfa-disable-button"];
  buttons.forEach(id => $(id).disabled = true);
  try {
    const data = await api("/api/mfa");
    $("#mfa-status").textContent = data.enabled
      ? `已开启 · 剩余 ${data.recovery_codes_remaining} 个恢复码。更换验证器请先关闭，再重新绑定。`
      : "尚未开启";
    $("#mfa-setup-button").classList.toggle("hidden", data.enabled);
    ["#mfa-codes-button", "#mfa-disable-button", "#mfa-proof-label", "#password-factor-label"].forEach(id => $(id).classList.toggle("hidden", !data.enabled));
    $("#mfa-proof-label input").required = data.enabled;
    $("#password-factor-label input").required = data.enabled;
    buttons.forEach(id => $(id).disabled = false);
  } catch (error) {
    $("#mfa-status").textContent = "读取二次验证状态失败，请关闭设置后重试";
    toast(error.message, "error");
  }
}

function clearBinding() {
  $("#mfa-binding-form").reset();
  $("#mfa-binding-form").classList.add("hidden");
  $("#mfa-qr").removeAttribute("src");
  $("#mfa-secret").value = "";
}

function displayRecoveryCodes(codes) {
  securityUi.codesPending = true;
  $("#mfa-recovery-codes").value = codes.join("\n");
  $("#mfa-recovery-panel").classList.remove("hidden");
  $("#mfa-recovery-panel").scrollIntoView({ block: "nearest" });
}

function canCloseSecurity() {
  if (securityUi.busy) { toast("正在处理安全设置，请稍候"); return false; }
  if (securityUi.codesPending) { toast("请先保存恢复码，并点击“我已安全保存”"); return false; }
  return true;
}

async function securitySubmit(form, action) {
  if (securityUi.busy) return;
  securityUi.busy = true;
  const buttons = [...form.querySelectorAll("button")];
  buttons.forEach(button => button.disabled = true);
  $(".form-error", form).textContent = "";
  try {
    await action();
  } catch (error) {
    $(".form-error", form).textContent = error.message;
  } finally {
    securityUi.busy = false;
    buttons.forEach(button => button.disabled = false);
  }
}

function bindSecurityEvents() {
  const loginForm = $("#mfa-login-form");
  $("#mfa-use-recovery").addEventListener("change", event => {
    const field = $("input[name='code']", loginForm);
    field.value = "";
    field.inputMode = event.target.checked ? "text" : "numeric";
    field.placeholder = event.target.checked ? "输入一个未使用的恢复码" : "6 位动态验证码";
    field.focus();
  });
  loginForm.addEventListener("submit", event => {
    event.preventDefault();
    securitySubmit(loginForm, async () => {
      const value = $("input[name='code']", loginForm).value.trim();
      const body = $("#mfa-use-recovery").checked ? { recovery_code: value } : { code: value };
      const data = await api("/api/mfa/login", { method: "POST", body });
      loginForm.reset();
      await enterApp(data.user);
    });
  });
  $("#mfa-login-back").addEventListener("click", async () => {
    if (securityUi.busy) return;
    try { await api("/api/mfa/cancel", { method: "POST" }); showAuth(); }
    catch (error) { toast(error.message, "error"); }
  });
  $("#mfa-settings-form").addEventListener("submit", event => {
    event.preventDefault();
    if (securityUi.codesPending) { toast("请先保存当前恢复码"); return; }
    const action = event.submitter?.value;
    if (!["setup", "disable", "recovery-codes"].includes(action)) return;
    if (action === "disable" && !window.confirm("关闭后，登录将只需密码。确定关闭二次验证？")) return;
    if (action === "recovery-codes" && !window.confirm("重新生成后，所有旧恢复码立即失效。继续？")) return;
    const form = event.target;
    securitySubmit(form, async () => {
      if (!(await flushSave())) return;
      const body = Object.fromEntries(new FormData(form));
      Object.assign(body, factorBody(body.factor));
      const data = await api(`/api/mfa/${action}`, { method: "POST", body });
      form.reset();
      clearBinding();
      if (action === "setup") {
        $("#mfa-secret").value = data.secret;
        $("#mfa-qr").src = data.qr_code;
        $("#mfa-binding-form .form-error").textContent = "";
        $("#mfa-binding-form").classList.remove("hidden");
        $("#mfa-binding-form input[name='code']").focus();
      } else {
        await refreshMfa();
        if (data.recovery_codes) displayRecoveryCodes(data.recovery_codes);
        toast(action === "disable" ? "二次验证已关闭，其他设备已退出" : "恢复码已更新，其他设备已退出");
      }
    });
  });
  $("#mfa-binding-form").addEventListener("submit", event => {
    event.preventDefault();
    const form = event.target;
    securitySubmit(form, async () => {
      if (!(await flushSave())) return;
      const data = await api("/api/mfa/enable", { method: "POST", body: Object.fromEntries(new FormData(form)) });
      clearBinding();
      await refreshMfa();
      displayRecoveryCodes(data.recovery_codes);
      toast("二次验证已开启，其他设备已退出");
    });
  });
  $("#mfa-download-codes").addEventListener("click", () => {
    const content = `MyNote 恢复码 · ${state.user.username}\n每个只能使用一次，请单独安全保存。\n\n${$("#mfa-recovery-codes").value}\n`;
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = "mynote-recovery-codes.txt";
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $("#mfa-ack-codes").addEventListener("click", () => {
    securityUi.codesPending = false;
    $("#mfa-recovery-codes").value = "";
    $("#mfa-recovery-panel").classList.add("hidden");
  });
  els.settings.addEventListener("cancel", event => { if (!canCloseSecurity()) event.preventDefault(); });
  els.settings.addEventListener("close", () => {
    clearBinding();
    $("#mfa-settings-form").reset();
    $("#password-form").reset();
    $("#mfa-recovery-codes").value = "";
    $("#mfa-recovery-panel").classList.add("hidden");
    securityUi.codesPending = false;
  });
  window.addEventListener("beforeunload", event => {
    if (securityUi.codesPending || securityUi.busy) { event.preventDefault(); event.returnValue = ""; }
  });
}

bindEvents();
bindSecurityEvents();
bootstrap();
