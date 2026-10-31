"use strict";

function bindPaneResize() {
  const workspace = els.workspace;
  const handles = { sidebar: $("#sidebar-resizer"), list: $("#list-resizer") };
  const defaults = () => window.innerWidth <= 1024 ? { sidebar: 140, list: 260 } : { sidebar: 184, list: 292 };
  let preferred = defaults(), widths, dragging = null;
  try {
    const stored = JSON.parse(localStorage.getItem("mynote-pane-widths") || "null");
    if (stored && Number.isFinite(stored.sidebar) && Number.isFinite(stored.list)) preferred = stored;
  } catch (_) {}
  const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
  function apply() {
    if (isMobile()) return;
    const total = workspace.clientWidth || window.innerWidth;
    const sidebar = clamp(preferred.sidebar, 140, Math.min(420, total - 200 - 280));
    const list = clamp(preferred.list, 200, Math.min(640, total - sidebar - 280));
    widths = { sidebar, list };
    workspace.style.setProperty("--sidebar-width", `${sidebar}px`);
    workspace.style.setProperty("--list-width", `${list}px`);
    for (const [kind, handle] of Object.entries(handles)) {
      handle.setAttribute("aria-valuemin", kind === "sidebar" ? "140" : "200");
      handle.setAttribute("aria-valuemax", String(Math.min(kind === "sidebar" ? 420 : 640, total - widths[kind === "sidebar" ? "list" : "sidebar"] - 280)));
      handle.setAttribute("aria-valuenow", String(Math.round(widths[kind])));
    }
  }
  function save() {
    try { localStorage.setItem("mynote-pane-widths", JSON.stringify(preferred)); } catch (_) {}
  }
  function finish(cancel = false) {
    if (!dragging) return;
    const { handle, pointerId, before } = dragging;
    dragging = null;
    if (cancel) preferred = before;
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    handle.classList.remove("resizing"); document.body.classList.remove("resizing-panes");
    apply(); if (!cancel) save();
  }
  for (const [kind, handle] of Object.entries(handles)) {
    handle.addEventListener("pointerdown", event => {
      if (isMobile() || event.button !== 0 || !event.isPrimary) return;
      finish(true); apply();
      dragging = { kind, handle, pointerId: event.pointerId, x: event.clientX, start: widths[kind], before: { ...preferred } };
      handle.setPointerCapture(event.pointerId); handle.classList.add("resizing");
      document.body.classList.add("resizing-panes"); event.preventDefault();
    });
    handle.addEventListener("pointermove", event => {
      if (!dragging || dragging.pointerId !== event.pointerId) return;
      preferred[kind] = dragging.start + event.clientX - dragging.x;
      apply(); preferred[kind] = widths[kind]; event.preventDefault();
    });
    handle.addEventListener("pointerup", () => finish());
    handle.addEventListener("pointercancel", () => finish(true));
    handle.addEventListener("lostpointercapture", () => finish(true));
    handle.addEventListener("dblclick", () => { preferred[kind] = defaults()[kind]; apply(); save(); });
    handle.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || isMobile()) return;
      event.preventDefault(); apply();
      preferred[kind] = event.key === "Home" ? Number(handle.getAttribute("aria-valuemin")) : event.key === "End" ? Number(handle.getAttribute("aria-valuemax")) : widths[kind] + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 32 : 8);
      apply(); preferred[kind] = widths[kind]; save();
    });
  }
  window.addEventListener("resize", () => { finish(true); apply(); });
  window.addEventListener("blur", () => finish(true));
  apply();
}

let groupDrag = null;
let groupOrderSaving = false;
let suppressGroupClickUntil = 0;

function cancelGroupDrag() {
  const drag = groupDrag;
  if (!drag) return;
  groupDrag = null; clearTimeout(drag.timer); cancelAnimationFrame(drag.frame);
  if (drag.active) {
    // Restore the DOM order if a drag was interrupted before saving.
    for (const id of drag.originalIds) {
      const row = drag.container.querySelector(`[data-group-row="${id}"]`);
      if (row) drag.container.append(row);
    }
    suppressGroupClickUntil = Date.now() + 500;
  }
  drag.ghost?.remove(); drag.row.classList.remove("group-drag-source");
  if (drag.button.hasPointerCapture(drag.pointerId)) drag.button.releasePointerCapture(drag.pointerId);
  document.body.classList.remove("sorting-groups");
  if (!groupOrderSaving) delete els.workspace.dataset.groupDragging;
}

function bindGroupReorder() {
  function move(drag) {
    if (groupDrag !== drag || !drag.active || !drag.row.isConnected) return;
    drag.ghost.style.top = `${drag.y - drag.offsetY}px`;
    const bounds = drag.container.getBoundingClientRect();
    if (drag.x < bounds.left - 40 || drag.x > bounds.right + 40) return;
    const rows = [...drag.container.children].filter(row => row !== drag.row && row.matches("[data-group-row]"));
    const before = rows.find(row => {
      const rect = row.getBoundingClientRect(); return drag.y < rect.top + rect.height / 2;
    });
    drag.container.insertBefore(drag.row, before || null);
  }
  function autoScroll(drag) {
    if (groupDrag !== drag || !drag.active) return;
    const bounds = drag.scroller.getBoundingClientRect();
    if (drag.y < bounds.top + 28) drag.scroller.scrollTop -= 7;
    else if (drag.y > bounds.bottom - 28) drag.scroller.scrollTop += 7;
    move(drag); drag.frame = requestAnimationFrame(() => autoScroll(drag));
  }
  document.addEventListener("pointerdown", event => {
    if (!event.isPrimary) { cancelGroupDrag(); return; }
    if (event.button !== 0 || groupOrderSaving || document.querySelector("dialog[open]")) return;
    const button = event.target.closest(".group-row .nav-item[data-view]");
    const row = button?.closest("[data-group-row]");
    const container = row?.parentElement;
    if (!row || !["group-list", "private-group-list"].includes(container.id)) return;
    cancelGroupDrag();
    const drag = groupDrag = {
      button, row, container, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, area: container.id === "group-list" ? "normal" : "private",
      epoch: state.sessionEpoch, userId: state.user?.id, active: false,
      originalIds: [...container.children].map(item => Number(item.dataset.groupRow)),
      scroller: container.id === "private-group-list" ? $("#private-navigation") : container,
    };
    drag.timer = setTimeout(() => {
      if (groupDrag !== drag || !row.isConnected || drag.epoch !== state.sessionEpoch) { cancelGroupDrag(); return; }
      closeGroupActionMenu(); drag.active = true;
      els.workspace.dataset.groupDragging = "true";
      els.workspace.dispatchEvent(new Event("groupdragstart"));
      const rect = row.getBoundingClientRect();
      drag.offsetY = drag.y - rect.top;
      drag.ghost = row.cloneNode(true); drag.ghost.classList.add("group-drag-ghost");
      drag.ghost.inert = true; drag.ghost.setAttribute("aria-hidden", "true");
      drag.ghost.removeAttribute("data-group-row");
      drag.ghost.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
      document.body.append(drag.ghost); row.classList.add("group-drag-source");
      document.body.classList.add("sorting-groups");
      button.setPointerCapture(drag.pointerId); autoScroll(drag);
    }, 350);
  }, true);
  document.addEventListener("pointermove", event => {
    const drag = groupDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.epoch !== state.sessionEpoch || !drag.row.isConnected) { cancelGroupDrag(); return; }
    drag.x = event.clientX; drag.y = event.clientY;
    if (!drag.active) {
      if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 8) cancelGroupDrag();
      return;
    }
    event.preventDefault(); event.stopPropagation(); move(drag);
  }, { capture: true, passive: false });
  document.addEventListener("touchmove", event => {
    if (groupDrag?.active) event.preventDefault();
  }, { capture: true, passive: false });
  document.addEventListener("contextmenu", event => {
    if (groupDrag?.active) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  document.addEventListener("pointerup", async event => {
    const drag = groupDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active) { cancelGroupDrag(); return; }
    event.preventDefault(); event.stopPropagation();
    const ids = [...drag.container.children].map(row => Number(row.dataset.groupRow));
    groupDrag = null; clearTimeout(drag.timer); cancelAnimationFrame(drag.frame);
    drag.ghost.remove(); drag.row.classList.remove("group-drag-source");
    if (drag.button.hasPointerCapture(drag.pointerId)) drag.button.releasePointerCapture(drag.pointerId);
    document.body.classList.remove("sorting-groups"); suppressGroupClickUntil = Date.now() + 500;
    const changed = ids.some((id, index) => id !== drag.originalIds[index]);
    if (!changed || drag.epoch !== state.sessionEpoch) { delete els.workspace.dataset.groupDragging; return; }
    const current = drag.area === state.area ? state.groups : drag.area === "private" ? state.privateGroups : state.normalGroups;
    const byId = new Map(current.map(group => [group.id, group]));
    const sorted = ids.map(id => byId.get(id));
    if (sorted.some(group => !group)) { delete els.workspace.dataset.groupDragging; renderGroups(); return; }
    function apply(groups) {
      if (drag.area === "private") state.privateGroups = groups;
      else state.normalGroups = groups;
      if (drag.area === state.area) state.groups = groups;
    }
    groupOrderSaving = true; apply(sorted); renderGroups(); renderGroupSelect();
    try {
      await api(`/api/groups/reorder?space=${drag.area}`, { method: "POST", body: { ids } });
      syncState.revision = null;
    } catch (error) {
      if (drag.epoch === state.sessionEpoch && drag.userId === state.user?.id) {
        try {
          const latest = await api(`/api/groups?space=${drag.area}`);
          if (drag.epoch === state.sessionEpoch) apply(latest.groups);
        } catch (_) { if (drag.epoch === state.sessionEpoch) apply(current); }
        renderGroups(); renderGroupSelect();
      }
      if (error.code !== "stale_response") toast(error.message, "error");
    } finally {
      groupOrderSaving = false; delete els.workspace.dataset.groupDragging; scheduleSync(0);
    }
  }, { capture: true, passive: false });
  document.addEventListener("pointercancel", cancelGroupDrag, true);
  document.addEventListener("lostpointercapture", event => { if (groupDrag?.button === event.target) cancelGroupDrag(); }, true);
  document.addEventListener("click", event => {
    if (event.detail && Date.now() < suppressGroupClickUntil && event.target.closest(".sidebar")) {
      event.preventDefault(); event.stopPropagation();
    }
  }, true);
  window.addEventListener("blur", cancelGroupDrag);
  window.addEventListener("resize", cancelGroupDrag);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") cancelGroupDrag(); });
}

bindPaneResize();
bindGroupReorder();
