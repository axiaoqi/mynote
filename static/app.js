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
};

const els = {
  boot: $("#boot-screen"), auth: $("#auth-screen"), app: $("#app"), workspace: $("#workspace"),
  loginTab: $("#login-tab"), registerTab: $("#register-tab"),
  loginForm: $("#login-form"), registerForm: $("#register-form"), firstUserTip: $("#first-user-tip"),
  groups: $("#group-list"), listTitle: $("#list-title"), listCount: $("#list-count"),
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
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  let body = options.body;
  if (method !== "GET" && method !== "HEAD") headers["X-CSRF-Token"] = state.csrf;
  if (body && !(body instanceof FormData) && typeof body !== "string") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(url, { method, headers, body, credentials: "same-origin" });
  } catch (error) {
    throw new ApiError("无法连接到便签服务，请检查电脑是否仍在运行", 0, {});
  }
  const type = response.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    if (response.status === 401 && url !== "/api/login") showAuth();
    throw new ApiError(data?.error || `请求失败（${response.status}）`, response.status, data);
  }
  return data;
}

function escapeHtml(value = "") {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function toast(message, kind = "normal") {
  const node = document.createElement("div");
  node.className = `toast ${kind === "error" ? "error" : ""}`;
  node.textContent = message;
  els.toast.append(node);
  setTimeout(() => node.remove(), 3400);
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

function switchAuth(tab) {
  const registering = tab === "register";
  els.loginTab.classList.toggle("active", !registering);
  els.registerTab.classList.toggle("active", registering);
  els.loginForm.classList.toggle("hidden", registering);
  els.registerForm.classList.toggle("hidden", !registering);
  $(registering ? "input[name='username']" : "input[name='username']", registering ? els.registerForm : els.loginForm)?.focus();
}

function showAuth() {
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
    else showAuth();
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
    await enterApp(data.user);
  } catch (error) {
    errorNode.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function loadGroups() {
  const data = await api("/api/groups");
  state.groups = data.groups;
  renderGroups();
  renderGroupSelect();
}

function renderGroups() {
  els.groups.innerHTML = state.groups.map(group => `
    <div class="group-row" data-group-row="${group.id}">
      <button class="nav-item ${String(state.currentGroup) === String(group.id) ? "active" : ""}" data-view="${group.id}" type="button">
        <span class="nav-icon">□</span><span class="group-name">${escapeHtml(group.name)}</span><span class="group-count">${group.note_count}</span>
      </button>
      <span class="group-actions">
        <button class="group-action" data-group-rename="${group.id}" type="button" title="重命名">✎</button>
        <button class="group-action" data-group-delete="${group.id}" type="button" title="删除">×</button>
      </span>
    </div>`).join("");
  $$(".nav-item[data-view]").forEach(button => button.classList.toggle("active", String(button.dataset.view) === String(state.currentGroup)));
}

function renderGroupSelect() {
  els.groupSelect.innerHTML = `<option value="">首页</option>${state.groups.map(group => `<option value="${group.id}">${escapeHtml(group.name)}</option>`).join("")}`;
  if (state.currentNote) els.groupSelect.value = state.currentNote.group_id ?? "";
}

function viewTitle(view) {
  if (view === "home") return "首页";
  if (view === "trash") return "回收站";
  return state.groups.find(group => String(group.id) === String(view))?.name || "便签";
}

async function selectView(view, save = true, updateLocation = true) {
  if (save) await flushSave();
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
  const params = new URLSearchParams();
  if (state.currentGroup === "trash") params.set("trash", "1");
  else if (state.currentGroup === "home") params.set("group_id", "ungrouped");
  else params.set("group_id", state.currentGroup);
  if (state.search) params.set("q", state.search);
  const data = await api(`/api/notes?${params}`);
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
  els.editorShell.classList.add("hidden");
  els.editorEmpty.classList.remove("hidden");
  els.content.innerHTML = "";
}

async function selectNote(noteId) {
  if (state.currentNote?.id === noteId) { mobileView("editor"); return; }
  await flushSave();
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
  $(".pin-button-icon", els.pin).textContent = pinned ? "◆" : "♧";
  $(".pin-button-label", els.pin).textContent = pinned ? "已置顶" : "置顶";
}

async function newNote() {
  if (state.currentGroup === "trash") await selectView("home");
  await flushSave();
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
  const blank = editorIsBlank();
  els.saveState.textContent = blank ? "内容为空，离开后移除" : "未保存";
  els.saveState.className = "save-state unsaved";
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  if (blank) return;
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
  if (!state.currentNote || state.currentNote.is_deleted) return;
  const noteId = state.currentNote.id;
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
    if (state.currentNote?.id !== noteId) return;
    if (blank) {
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
    els.saveState.textContent = "已保存";
    els.saveState.className = "save-state";
    els.updated.textContent = `更新于 ${formatTime(data.note.updated_at, true)}`;
    const listNote = state.notes.find(note => note.id === noteId);
    if (listNote) Object.assign(listNote, data.note, { preview: data.note.preview });
    state.notes.sort((a, b) => Number(b.is_pinned) - Number(a.is_pinned) || new Date(b.updated_at) - new Date(a.updated_at));
    renderNotes();
  } catch (error) {
    if (error.code === "edit_conflict") {
      state.conflictServer = error.data.current;
      state.localConflictDraft = { ...draft, id: noteId };
      els.saveState.textContent = "保存冲突";
      els.saveState.className = "save-state error";
      els.conflict.showModal();
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
  if (!state.currentNote || state.currentNote.is_deleted) return;
  if (editorIsBlank()) await saveNow(true);
  else if (state.saveTimer) await saveNow();
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
  els.loginForm.addEventListener("submit", event => { event.preventDefault(); authSubmit(els.loginForm, "/api/login"); });
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
    const view = event.target.closest("[data-view]")?.dataset.view;
    if (view !== undefined) selectView(/^\d+$/.test(view) ? Number(view) : view);
    const noteCard = event.target.closest("[data-note-id]");
    if (noteCard) {
      const row = noteCard.closest("[data-swipe-row]");
      if (Date.now() < suppressNoteClickUntil) return;
      if (openSwipeRow) { closeSwipeRow(); return; }
      if (!row?.classList.contains("swiping")) selectNote(Number(noteCard.dataset.noteId));
    }
    const rename = event.target.closest("[data-group-rename]");
    if (rename) { event.stopPropagation(); renameGroup(Number(rename.dataset.groupRename)); }
    const remove = event.target.closest("[data-group-delete]");
    if (remove) { event.stopPropagation(); deleteGroup(Number(remove.dataset.groupDelete)); }
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
    await flushSave();
    state.currentNote = null;
    clearEditor();
    renderNotes();
    persistLocation();
    mobileView("list");
  });
  $("#user-menu-button").addEventListener("click", openSettings);
  $("#settings-close").addEventListener("click", () => els.settings.close());
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
      const body = Object.fromEntries(new FormData(event.target));
      await api("/api/account", { method: "PATCH", body }); event.target.reset(); toast("密码已更新");
    } catch (error) { toast(error.message, "error"); }
  });
  $("#logout-button").addEventListener("click", async () => {
    await flushSave();
    try { await api("/api/logout", { method: "POST" }); } catch (_) {}
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

  $("#conflict-load").addEventListener("click", () => {
    state.currentNote = state.conflictServer; state.conflictServer = null; state.localConflictDraft = null; els.conflict.close(); renderEditor(); renderNotes(); persistLocation(); toast("已载入服务器版本");
  });
  $("#conflict-copy").addEventListener("click", async () => {
    const draft = state.localConflictDraft; if (!draft) return;
    try {
      const data = await api("/api/notes", { method: "POST", body: { content_html: `<p><strong>冲突副本</strong></p>${draft.content_html}`, group_id: draft.group_id } });
      els.conflict.close(); state.conflictServer = null; state.localConflictDraft = null; await loadNotes(); await selectNote(data.note.id); toast("本机内容已保存为新便签");
    } catch (error) { toast(error.message, "error"); }
  });

  window.addEventListener("beforeunload", event => {
    const emptyDraft = state.currentNote && !state.currentNote.is_deleted && editorIsBlank();
    if (state.saveTimer || state.savePromise || emptyDraft) { event.preventDefault(); event.returnValue = ""; }
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && state.saveTimer) saveNow(); });
  document.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); saveNow(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n" && state.user) { event.preventDefault(); newNote(); }
  });
}

bindEvents();
bootstrap();
