// agent-phone operator panel.
//
// Security rule for this file: never assign untrusted text to innerHTML.
// Approval summaries, trace labels, message bodies and device names can all be
// influenced by the agent. Everything is built with h(), which only ever sets
// textContent. The CSP forbids inline script as a second line of defence.
"use strict";

// ------------------------------------------------------------------ utilities

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = Boolean(v);
    else if (k === "disabled") el.disabled = Boolean(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const enc = encodeURIComponent;

function ago(ts) {
  if (!ts) return "";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleString();
}

function until(ts) {
  const s = Math.round((ts - Date.now()) / 1000);
  if (s <= 0) return "expired";
  if (s < 60) return `${s}s left`;
  return `${Math.round(s / 60)}m left`;
}

function toast(msg, kind) {
  const t = h("div", { class: `toast ${kind || ""}`, text: msg });
  $("#toasts").append(t);
  setTimeout(() => t.remove(), kind === "error" ? 6000 : 3000);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast("Copy failed — select and copy manually", "error");
  }
}

class AuthError extends Error {}

async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      "x-agent-phone": "1",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (r.status === 401) throw new AuthError("signed out");
  const type = r.headers.get("content-type") || "";
  const data = type.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && (data.error || data.hint)) || `HTTP ${r.status}`);
  return data;
}

function run(fn) {
  return async (ev) => {
    const btn = ev && ev.currentTarget instanceof HTMLButtonElement ? ev.currentTarget : null;
    if (btn) btn.disabled = true;
    try {
      await fn(ev);
    } catch (e) {
      if (e instanceof AuthError) return showLogin();
      toast(e.message || String(e), "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  };
}

// ------------------------------------------------------------------ state

const state = {
  overview: null,
  route: "phone",
  routeArg: null,
  deviceId: localStorageGet("deviceId"),
  screenUrl: null,
  deviceSize: null,
  screenTimer: null,
  overviewTimer: null,
  events: null,
  openTrace: null,
};

function localStorageGet(k) {
  try {
    return localStorage.getItem(`ap.${k}`);
  } catch {
    return null;
  }
}
function localStorageSet(k, v) {
  try {
    localStorage.setItem(`ap.${k}`, v);
  } catch {
    /* private mode */
  }
}

const pendingApprovals = () => (state.overview ? state.overview.approvals.filter((a) => a.status === "pending") : []);
/** The phone an agent is using first, then usable phones (Android, iOS, mock), offline last. */
const rank = (d) =>
  (d.leasedBy ? -10 : 0) +
  (d.state === "available" || d.state === "busy" ? 0 : 10) +
  ({ android: 0, ios: 1, mock: 2 }[d.platform] ?? 3);
const devices = () => (state.overview ? [...state.overview.devices].sort((a, b) => rank(a) - rank(b)) : []);
const currentDevice = () => {
  const ds = devices();
  return ds.find((d) => d.id === state.deviceId) || ds[0] || null;
};
const locked = (envName) => state.overview && state.overview.envOverrides.includes(envName);

// ------------------------------------------------------------------ boot + auth

async function boot() {
  $("#app").replaceChildren(h("p", { class: "muted", text: "Looking for phones…" }));
  const m = /[#&]code=([\w-]+)/.exec(location.hash);
  if (m) {
    history.replaceState(null, "", "#/");
    try {
      await api("POST", "/panel/login", { code: m[1] });
    } catch (e) {
      toast(e.message, "error");
    }
  }
  window.addEventListener("hashchange", route);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshOverview();
      scheduleScreen(0);
    }
  });
  try {
    await refreshOverview();
  } catch (e) {
    if (e instanceof AuthError) return showLogin();
    return toast(e.message, "error");
  }
  $("#tabs").hidden = false;
  connectEvents();
  route();
  state.overviewTimer = setInterval(() => refreshOverview().catch(() => {}), 5000);
}

function showLogin() {
  clearInterval(state.overviewTimer);
  clearTimeout(state.screenTimer);
  if (state.events) state.events.close();
  $("#tabs").hidden = true;
  setStatus("down", "signed out");
  const input = h("input", { type: "password", autocomplete: "current-password", placeholder: "op_…", "aria-label": "Operator token" });
  const submit = run(async (ev) => {
    ev.preventDefault();
    await api("POST", "/panel/login", { token: input.value.trim() });
    location.hash = "#/";
    location.reload();
  });
  $("#app").replaceChildren(
    h("div", { class: "card login" },
      h("h2", { text: "Operator sign-in" }),
      h("p", { class: "muted small", text: "This panel controls the phone your agent uses. Sign in with the operator token — not the agent token." }),
      h("form", { onsubmit: submit },
        h("label", { class: "field" }, h("span", { text: "Operator token" }), input),
        h("button", { class: "primary", type: "submit", text: "Sign in" }),
      ),
      h("p", { class: "muted small" },
        "On the host: ", h("code", { text: "agent-phone panel-link" }), " prints a one-time sign-in link, and ",
        h("code", { text: "agent-phone token" }), " shows the operator token."),
    ),
  );
  input.focus();
}

async function logout() {
  await fetch("/panel/logout", { method: "POST", headers: { "x-agent-phone": "1" } });
  showLogin();
}

function setStatus(kind, text) {
  const s = $("#status");
  s.className = `status ${kind}`;
  $("#status-text").textContent = text;
}

function connectEvents() {
  if (state.events) state.events.close();
  const es = new EventSource("/events");
  state.events = es;
  es.addEventListener("hello", () => setStatus("live", "live"));
  es.addEventListener("heartbeat", () => setStatus("live", "live"));
  es.onerror = () => setStatus("down", "reconnecting");
  es.addEventListener("approval_required", (e) => {
    const a = JSON.parse(e.data);
    if (!state.overview || !state.overview.approvals.some((x) => x.id === a.id && x.status === "pending")) {
      toast(a.type === "handoff" ? `Your agent needs a hand: ${a.reason}` : `Approval needed: ${a.summary}`);
    }
    refreshOverview();
  });
  es.addEventListener("approval_decided", () => refreshOverview());
  es.addEventListener("control", () => refreshOverview());
  es.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    toast(`Message from ${m.from}`);
    if (state.route === "setup") refreshOverview();
  });
}

async function refreshOverview() {
  state.overview = await api("GET", "/api/operator/overview");
  const n = pendingApprovals().length;
  const badge = $("#badge");
  badge.hidden = n === 0;
  badge.textContent = String(n);
  document.title = n ? `(${n}) agent-phone` : "agent-phone";
  // Re-render only when something visible changed: a blind re-render every
  // five seconds would wipe whatever the operator is typing.
  const ov = state.overview;
  const phoneSig = JSON.stringify([
    ov.devices.map((d) => [d.id, d.state, Boolean(d.control), d.leasedBy]),
    ov.sessions.map((s) => [s.sessionId, s.actions, s.mode, s.device.id]),
    pendingApprovals().map((a) => a.id),
  ]);
  const approvalSig = JSON.stringify(ov.approvals.map((a) => [a.id, a.status]));
  if (state.route === "phone" && phoneSig !== state.phoneSig) {
    state.phoneSig = phoneSig;
    renderPhoneSide();
  }
  if (state.route === "approvals" && approvalSig !== state.approvalSig) {
    state.approvalSig = approvalSig;
    renderApprovals();
  }
}

// ------------------------------------------------------------------ router

function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  const tab = parts[0] || "phone";
  state.route = ["phone", "approvals", "activity", "connect", "setup"].includes(tab) ? tab : "phone";
  state.routeArg = parts[1] ? decodeURIComponent(parts[1]) : null;
  for (const a of document.querySelectorAll("#tabs a")) a.classList.toggle("active", a.dataset.tab === state.route);
  clearTimeout(state.screenTimer);
  const render = { phone: renderPhone, approvals: renderApprovals, activity: renderActivity, connect: renderConnect, setup: renderSetup }[state.route];
  Promise.resolve(render()).catch((e) => (e instanceof AuthError ? showLogin() : toast(e.message, "error")));
}

// ------------------------------------------------------------------ approval cards

function approvalCard(a, opts = {}) {
  const handoff = a.type === "handoff";
  const pending = a.status === "pending";
  const note = h("input", { type: "text", placeholder: "Note for the agent (optional)", "aria-label": "Note" });
  const decide = (approve) =>
    run(async () => {
      await api("POST", `/api/operator/approvals/${enc(a.id)}/${approve ? "approve" : "deny"}`, { note: note.value || undefined });
      if (handoff && a.deviceId) await api("POST", `/api/operator/devices/${enc(a.deviceId)}/control`, { action: "release" }).catch(() => {});
      toast(approve ? (handoff ? "Handed back to the agent" : "Approved") : handoff ? "Declined" : "Denied");
      await refreshOverview();
      if (state.route === "approvals") renderApprovals();
    });
  const takeControl = run(async () => {
    if (a.deviceId) {
      state.deviceId = a.deviceId;
      localStorageSet("deviceId", a.deviceId);
      await api("POST", `/api/operator/devices/${enc(a.deviceId)}/control`, { action: "take" });
    }
    location.hash = "#/";
  });

  const evidence = h("img", { class: "evidence", alt: "Screen when the request was made", hidden: true });
  if (a.evidence && opts.evidence !== false) {
    fetch(`/api/operator/approvals/${enc(a.id)}/evidence.png`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (b) {
          evidence.src = URL.createObjectURL(b);
          evidence.hidden = false;
        }
      })
      .catch(() => {});
  }

  const statusPill = pending
    ? h("span", { class: `pill ${handoff ? "handoff" : "warn"}`, text: handoff ? "needs a human" : "approval" })
    : h("span", { class: `pill ${a.status === "approved" ? "ok" : "bad"}`, text: handoff && a.status === "approved" ? "done" : a.status });

  return h("div", { class: `card approval ${handoff ? "handoff" : ""} ${pending ? "" : "decided"} ${opts.focus ? "focus" : ""}`, id: `a-${a.id}` },
    h("div", { class: "row spread" },
      h("div", { class: "row" }, statusPill, h("span", { class: "muted small mono", text: a.id })),
      h("span", { class: "muted small", text: pending ? until(a.expiresAt) : ago(a.decidedAt) }),
    ),
    // Refs like "e3" mean nothing to a human; drop them from the summary.
    h("p", { class: "summary", text: handoff ? a.reason : String(a.summary).replace(/\be\d+ /, "") }),
    handoff ? h("p", { class: "reason", text: a.summary }) : h("p", { class: "reason", text: `Why it was stopped: ${a.reason}` }),
    evidence,
    pending
      ? h("div", { class: "stack" },
          note,
          handoff
            ? h("div", { class: "row" },
                h("button", { class: "primary", onclick: takeControl, text: "Take control" }),
                h("button", { class: "ok", onclick: decide(true), text: "Done — hand back" }),
                h("button", { class: "danger", onclick: decide(false), text: "Can't help" }),
              )
            : h("div", { class: "row" },
                h("button", { class: "ok", onclick: decide(true), text: "Approve" }),
                h("button", { class: "danger", onclick: decide(false), text: "Deny" }),
              ),
        )
      : a.note
        ? h("p", { class: "muted small", text: `Note: ${a.note}` })
        : null,
  );
}

// ------------------------------------------------------------------ phone tab

function renderPhone() {
  state.phoneSig = null;
  const img = h("img", { id: "screen", alt: "", draggable: "false" });
  const overlay = h("div", { class: "overlay", id: "overlay", text: "Loading screen…" });
  const frame = h("div", { class: "phone", id: "frame" }, img, overlay);
  attachPointer(img, frame);
  $("#app").replaceChildren(
    h("div", { id: "phone-banners" }),
    h("div", { class: "grid2" },
      h("div", {}, frame),
      h("div", { id: "phone-side" }),
    ),
  );
  renderPhoneSide();
  scheduleScreen(0);
}

function renderPhoneSide() {
  const side = $("#phone-side");
  const banners = $("#phone-banners");
  if (!side || !state.overview) return;
  const ov = state.overview;
  const dev = currentDevice();
  if (dev && dev.id !== state.deviceId) state.deviceId = dev.id;

  banners.replaceChildren(...pendingApprovals().slice(0, 3).map((a) => approvalCard(a, { evidence: false })));

  if (!dev) {
    side.replaceChildren(
      h("div", { class: "card" },
        h("h2", { text: "No phone connected" }),
        h("p", { class: "muted", text: "Start one on the host with `agent-phone up`, or bring up the container stack. It appears here within a few seconds." }),
      ),
    );
    const o = $("#overlay");
    if (o) {
      o.hidden = false;
      o.textContent = "No phone";
    }
    return;
  }

  const inControl = Boolean(dev.control);
  $("#frame")?.classList.toggle("control", inControl);
  const session = ov.sessions.find((s) => s.device.id === dev.id);

  const choices = devices().filter((d) => d.state !== "offline" || d.id === dev.id);
  const offline = ov.devices.length - choices.length;
  const picker = choices.length > 1 || offline
    ? h("select", {
        "aria-label": "Phone",
        onchange: (e) => {
          state.deviceId = e.target.value;
          localStorageSet("deviceId", state.deviceId);
          renderPhoneSide();
          scheduleScreen(0);
        },
      }, ...choices.map((d) => {
        const o = h("option", { value: d.id, text: `${d.name}${d.state === "offline" ? " (offline)" : ""}` });
        o.selected = d.id === dev.id;
        return o;
      }), offline ? h("option", { disabled: true, text: `${offline} offline not shown` }) : null)
    : null;

  const control = run(async () => {
    await api("POST", `/api/operator/devices/${enc(dev.id)}/control`, { action: inControl ? "release" : "take" });
    toast(inControl ? "Control handed back to the agent" : "You have control. The agent is paused.");
    await refreshOverview();
    scheduleScreen(0);
  });

  const statusCard = h("div", { class: "card" },
    h("div", { class: "row spread" },
      h("h2", { text: dev.name }),
      h("span", { class: `pill ${dev.state === "available" || dev.state === "busy" ? "ok" : "bad"}`, text: dev.state }),
    ),
    picker,
    h("p", { class: "muted small mono", text: dev.id }),
    session
      ? h("div", { class: "stack" },
          h("p", {},
            h("strong", { text: "Agent session " }), h("span", { class: "mono", text: session.sessionId }),
            h("span", { class: "muted", text: ` · ${session.actions} actions · mode ${session.mode} · active ${ago(session.lastActiveAt)}` }),
          ),
          h("button", {
            class: "danger small",
            text: "End session",
            onclick: run(async () => {
              if (!confirm("End the agent's session? It will lose its place.")) return;
              await api("DELETE", `/api/operator/sessions/${enc(session.sessionId)}`);
              await refreshOverview();
            }),
          }),
        )
      : h("p", { class: "muted", text: "No agent is using this phone right now." }),
    h("div", { class: "row" },
      h("button", { class: inControl ? "ok" : "primary", onclick: control, text: inControl ? "Hand back to agent" : "Take control" }),
    ),
    inControl
      ? h("p", { class: "small muted", text: "Tap the screen to tap; drag to swipe; hold to long-press. The agent's actions fail with device_busy until you hand back." })
      : h("p", { class: "small muted", text: "Take control to sign in to accounts, solve a CAPTCHA, or fix something the agent is stuck on." }),
  );

  const text = h("input", {
    type: "text",
    value: state.typeDraft || "",
    placeholder: "Text to type into the focused field",
    autocomplete: "off",
    "aria-label": "Text to type",
    oninput: (e) => (state.typeDraft = e.target.value),
  });
  const send = run(async (ev) => {
    ev.preventDefault();
    if (!text.value) return;
    await input({ type: "text", text: text.value });
    text.value = "";
    state.typeDraft = "";
  });
  const key = (k, label) => h("button", { class: "small", disabled: !inControl, onclick: run(() => input({ type: "key", key: k })), text: label });
  const appId = h("input", { type: "text", placeholder: "com.android.vending", "aria-label": "App package" });

  const controls = h("div", { class: "card" },
    h("h3", { text: "Controls" }),
    h("div", { class: "keys" },
      key("back", "Back"), key("home", "Home"), key("recents", "Recents"), key("enter", "Enter"),
      h("button", { class: "small", disabled: !inControl, onclick: run(() => input({ type: "scroll", direction: "up" })), text: "Scroll ↑" }),
      h("button", { class: "small", disabled: !inControl, onclick: run(() => input({ type: "scroll", direction: "down" })), text: "Scroll ↓" }),
      key("delete", "Delete"), key("tab", "Tab"),
    ),
    h("form", { class: "row", onsubmit: send },
      h("div", { class: "grow" }, text),
      h("button", { type: "submit", disabled: !inControl, text: "Type" }),
    ),
    h("p", { class: "small muted", text: "Typed text is sent to the phone but never written to any log." }),
    h("form", {
      class: "row",
      onsubmit: run(async (ev) => {
        ev.preventDefault();
        if (appId.value) await input({ type: "open_app", appId: appId.value.trim() });
      }),
    }, h("div", { class: "grow" }, appId), h("button", { type: "submit", disabled: !inControl, text: "Open app" })),
    apkUpload(dev),
  );

  side.replaceChildren(statusCard, controls);
}

/** Container phones have no Play Store: installing an APK is how an app gets onto them. */
function apkUpload(dev) {
  const file = h("input", { type: "file", accept: ".apk,application/vnd.android.package-archive", "aria-label": "APK file" });
  const go = run(async () => {
    const f = file.files && file.files[0];
    if (!f) return toast("Choose an .apk file first", "error");
    toast(`Installing ${f.name}…`);
    const r = await fetch(`/api/operator/devices/${enc(dev.id)}/install`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "x-agent-phone": "1", "content-type": "application/vnd.android.package-archive" },
      body: f,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    toast(`Installed ${f.name}`);
    file.value = "";
  });
  return h("div", { class: "stack" },
    h("h3", { text: "Install an app" }),
    h("p", { class: "small muted", text: "No Play Store on this phone? Upload the app's APK (for example from the vendor's site or APKMirror)." }),
    h("div", { class: "row" }, h("div", { class: "grow" }, file), h("button", { onclick: go, text: "Install" })),
  );
}

async function input(body) {
  const dev = currentDevice();
  if (!dev) return;
  await api("POST", `/api/operator/devices/${enc(dev.id)}/input`, body);
  scheduleScreen(250);
}

function scheduleScreen(delay) {
  clearTimeout(state.screenTimer);
  state.screenTimer = setTimeout(refreshScreen, delay);
}

async function refreshScreen() {
  if (state.route !== "phone") return;
  const dev = currentDevice();
  const img = $("#screen");
  const overlay = $("#overlay");
  if (!img) return;
  if (!dev || document.hidden) return scheduleScreen(2000);
  try {
    const r = await fetch(`/api/operator/devices/${enc(dev.id)}/screen.png?max=720`, { credentials: "same-origin" });
    if (r.status === 401) return showLogin();
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    state.deviceSize = { w: Number(r.headers.get("x-device-width")), h: Number(r.headers.get("x-device-height")) };
    const url = URL.createObjectURL(await r.blob());
    img.src = url;
    img.alt = `Live screen of ${dev.name}`;
    if (state.screenUrl) URL.revokeObjectURL(state.screenUrl);
    state.screenUrl = url;
    overlay.hidden = true;
  } catch (e) {
    overlay.hidden = false;
    overlay.textContent = `Screen unavailable: ${e.message}`;
  }
  scheduleScreen(dev.control ? 700 : 2000);
}

function attachPointer(img, frame) {
  let down = null;
  const toDevice = (ev) => {
    const r = img.getBoundingClientRect();
    const s = state.deviceSize || { w: img.naturalWidth, h: img.naturalHeight };
    return {
      x: Math.round(((ev.clientX - r.left) / r.width) * s.w),
      y: Math.round(((ev.clientY - r.top) / r.height) * s.h),
      px: ev.clientX - r.left + 10,
      py: ev.clientY - r.top + 10,
    };
  };
  img.addEventListener("pointerdown", (ev) => {
    const dev = currentDevice();
    if (!dev || !dev.control) {
      toast("Take control first");
      return;
    }
    ev.preventDefault();
    img.setPointerCapture(ev.pointerId);
    down = { ...toDevice(ev), t: Date.now() };
  });
  img.addEventListener("pointerup", run(async (ev) => {
    if (!down) return;
    const up = toDevice(ev);
    const start = down;
    down = null;
    const dist = Math.hypot(up.px - start.px, up.py - start.py);
    const held = Date.now() - start.t;
    const ripple = h("span", { class: "ripple" });
    ripple.style.left = `${start.px}px`;
    ripple.style.top = `${start.py}px`;
    frame.append(ripple);
    setTimeout(() => ripple.remove(), 600);
    if (dist > 12) {
      await input({ type: "swipe", fromX: start.x, fromY: start.y, toX: up.x, toY: up.y, durationMs: Math.min(Math.max(held, 120), 1200) });
    } else {
      await input({ type: "tap", x: start.x, y: start.y, ...(held > 600 ? { durationMs: held } : {}) });
    }
  }));
  img.addEventListener("pointercancel", () => (down = null));
}

// ------------------------------------------------------------------ approvals tab

function renderApprovals() {
  const ov = state.overview;
  if (ov) state.approvalSig = JSON.stringify(ov.approvals.map((a) => [a.id, a.status]));
  if (!ov) return;
  const pending = pendingApprovals();
  const recent = ov.approvals.filter((a) => a.status !== "pending");
  $("#app").replaceChildren(
    h("h2", { text: pending.length ? `Waiting on you (${pending.length})` : "Nothing waiting on you" }),
    pending.length ? null : h("p", { class: "muted", text: "Risky actions and requests for help appear here, and on your phone if notifications are set up (Setup → Notifications)." }),
    ...pending.map((a) => approvalCard(a, { focus: a.id === state.routeArg })),
    recent.length ? h("h2", { text: "Recently decided" }) : null,
    ...recent.slice(0, 15).map((a) => approvalCard(a, { evidence: false, focus: a.id === state.routeArg })),
  );
  if (state.routeArg) document.getElementById(`a-${state.routeArg}`)?.scrollIntoView({ block: "center" });
}

// ------------------------------------------------------------------ activity tab

async function renderActivity() {
  const data = await api("GET", "/api/operator/sessions");
  const liveIds = new Set(data.live.map((s) => s.sessionId));
  const rows = data.past.map((s) =>
    h("tr", { class: "clickable", onclick: () => openTrace(s.sessionId) },
      h("td", { class: "mono", text: s.sessionId }),
      h("td", { text: (s.device && (s.device.name || s.device.id)) || "?" }),
      h("td", {}, liveIds.has(s.sessionId) ? h("span", { class: "pill ok", text: "live" }) : h("span", { class: "pill", text: "ended" })),
      h("td", { class: "muted", text: ago(s.lastActivity) }),
    ),
  );
  const log = await api("GET", "/api/operator/log");
  $("#app").replaceChildren(
    h("div", { class: "cols" },
      h("div", { class: "card" },
        h("h2", { text: "Sessions" }),
        rows.length
          ? h("div", { class: "table-wrap" }, h("table", {},
              h("thead", {}, h("tr", {}, h("th", { text: "Session" }), h("th", { text: "Phone" }), h("th", { text: "" }), h("th", { text: "Last activity" }))),
              h("tbody", {}, rows),
            ))
          : h("p", { class: "muted", text: "No sessions yet." }),
      ),
      h("div", { class: "card", id: "trace" },
        h("h2", { text: "Trace" }),
        h("p", { class: "muted", text: "Pick a session to see every action the agent took." }),
      ),
    ),
    h("div", { class: "card" },
      h("h2", { text: "Your actions" }),
      log.entries.length
        ? h("div", {}, ...log.entries.slice(0, 30).map((e) =>
            h("div", { class: "event" },
              h("span", { class: "muted small", text: ago(e.ts) }),
              h("div", {}, h("span", { class: "kind", text: e.action }), " ",
                h("span", { class: "detail", text: [e.type, e.key, e.deviceId, e.approvalId, e.sessionId].filter(Boolean).join(" · ") })),
            )))
        : h("p", { class: "muted", text: "Nothing yet." }),
    ),
  );
  const pick = state.routeArg || state.openTrace;
  if (pick) openTrace(pick);
}

async function openTrace(id) {
  state.openTrace = id;
  const box = $("#trace");
  if (!box) return;
  const data = await api("GET", `/api/operator/sessions/${enc(id)}/trace`);
  const events = data.events.map((e) => {
    const detail = [
      e.args && e.args.label,
      e.args && e.args.reason,
      e.result && e.result.change,
      e.error,
      e.durationMs ? `${e.durationMs}ms` : null,
    ].filter(Boolean).join(" · ");
    const thumb = e.screenshot ? h("img", { class: "thumb", alt: "screen" }) : null;
    if (thumb) {
      const file = String(e.screenshot).split(/[\\/]/).pop();
      fetch(`/api/operator/sessions/${enc(id)}/screens/${enc(file)}`, { credentials: "same-origin" })
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => b && (thumb.src = URL.createObjectURL(b)))
        .catch(() => {});
    }
    return h("div", { class: `event ${e.ok ? "" : "fail"}` },
      h("span", { class: "muted small", text: new Date(e.ts).toLocaleTimeString() }),
      h("div", {}, h("div", { class: "kind", text: e.kind }), detail ? h("div", { class: "detail", text: detail }) : null, thumb),
    );
  });
  box.replaceChildren(
    h("div", { class: "row spread" }, h("h2", { text: `Trace ${id}` }), h("span", { class: "muted small", text: `${data.events.length} events` })),
    ...(events.length ? events.reverse() : [h("p", { class: "muted", text: "No events." })]),
  );
}

// ------------------------------------------------------------------ connect tab

async function renderConnect() {
  const c = await api("GET", "/api/operator/connection");
  const ov = state.overview;
  let revealed = false;
  const tokenSpan = h("span", { text: "•".repeat(24) });
  const reveal = h("button", {
    class: "small ghost",
    text: "Show",
    onclick: () => {
      revealed = !revealed;
      tokenSpan.textContent = revealed ? c.agentToken : "•".repeat(24);
      reveal.textContent = revealed ? "Hide" : "Show";
    },
  });
  const copyRow = (value, shown) => h("div", { class: "copy" }, h("span", { text: shown || value }), h("button", { class: "small", onclick: () => copy(value), text: "Copy" }));
  const isLocal = /^http:\/\/(127\.|localhost|\[::1\])/.test(c.restUrl);

  $("#app").replaceChildren(
    isLocal
      ? h("div", { class: "banner" },
          h("strong", { text: "This address only works on this machine. " }),
          "A cloud agent such as Instinct cannot reach it. Run ", h("code", { text: "agent-phone serve --public" }),
          " for a public HTTPS address, or deploy the container stack (docs/hosting.md).")
      : null,
    h("div", { class: "cols" },
      h("div", { class: "card" },
        h("h2", { text: "Agents that speak MCP" }),
        h("p", { class: "muted small", text: "Claude, Cursor, and any client that supports remote MCP servers." }),
        h("label", { class: "field" }, h("span", { text: "Server URL" }), copyRow(c.mcpUrl)),
        h("label", { class: "field" }, h("span", { text: "Header" }),
          h("div", { class: "copy" }, h("span", {}, "Authorization: Bearer ", tokenSpan), reveal,
            h("button", { class: "small", onclick: () => copy(`Authorization: Bearer ${c.agentToken}`), text: "Copy" }))),
        h("p", { class: "small muted", text: `${ov ? ov.mcpClients : 0} MCP client(s) connected right now.` }),
      ),
      h("div", { class: "card" },
        h("h2", { text: "Agents that browse and run scripts" }),
        h("p", { class: "muted small", text: "Instinct and similar. Paste this into the agent; it contains the agent token, which is safe to give an agent." }),
        h("div", { class: "prompt", text: c.prompt }),
        h("div", { class: "row" }, h("button", { class: "primary", onclick: () => copy(c.prompt), text: "Copy instructions" }),
          h("a", { class: "btn", href: c.agentMd, target: "_blank", rel: "noopener", text: "Open agent.md" })),
      ),
    ),
    h("div", { class: "card" },
      h("h2", { text: "Never give an agent the operator token" }),
      h("p", { class: "muted", text: "The operator token approves the agent's risky actions. The server refuses it on agent routes so a mix-up fails loudly." }),
      h("button", {
        class: "danger",
        text: "Rotate agent token",
        onclick: run(async () => {
          if (!confirm("Issue a new agent token? Agents using the old one stop working immediately.")) return;
          await api("POST", "/api/operator/tokens/agent");
          toast("New agent token issued");
          renderConnect();
        }),
      }),
    ),
  );
}

// ------------------------------------------------------------------ setup tab

function field(label, input, hint, envName) {
  const lock = envName && locked(envName);
  if (lock) input.disabled = true;
  return h("label", { class: "field" },
    h("span", {}, label, lock ? h("span", { class: "lock", text: `set by ${envName}` }) : null),
    input,
    hint ? h("span", { class: "hint", text: hint }) : null,
  );
}

const textInput = (value, placeholder, type = "text") => h("input", { type, value: value || "", placeholder: placeholder || "", autocomplete: "off" });

/** Credential fields: never pre-filled; blank means "leave as is". */
function secretInput(masked, placeholder) {
  return h("input", { type: "password", value: "", placeholder: masked ? `saved (${masked}) — type to replace` : placeholder || "", autocomplete: "new-password" });
}

async function renderSetup() {
  await refreshOverview();
  const ov = state.overview;
  const cfg = ov.config;

  // ---- identity
  const phone = textInput(cfg.identity.phoneNumber, "+15551234567", "tel");
  const email = textInput(cfg.identity.email, "agent@example.com", "email");
  const publicUrl = textInput(cfg.publicUrl, "https://phone.example.com");
  const identity = h("div", { class: "card" },
    h("h2", { text: "Identity" }),
    h("p", { class: "muted small", text: "The agent is told these when it starts a session, so it knows what to type when a form asks for a number or email." }),
    field("Phone number", phone, "The number your provider or relay phone receives SMS on.", "PHONE_NUMBER"),
    field("Email", email, null, "PHONE_EMAIL"),
    field("Public URL", publicUrl, "Set this if you put the server behind your own domain. Tunnels are detected automatically.", "PHONE_PUBLIC_URL"),
    h("button", {
      class: "primary",
      text: "Save",
      onclick: run(async () => {
        await api("PATCH", "/api/operator/config", { identity: { phoneNumber: phone.value, email: email.value }, publicUrl: publicUrl.value });
        toast("Saved");
      }),
    }),
  );

  // ---- SMS
  const telnyx = textInput(cfg.sources.telnyxPublicKey, "base64 public key from the Telnyx portal");
  const twilio = secretInput(cfg.sources.twilioAuthToken, "Twilio auth token");
  const copyRow = (label, value) => h("div", { class: "field" }, h("span", { class: "small", text: label }), h("div", { class: "copy" }, h("span", { text: value }), h("button", { class: "small", onclick: () => copy(value), text: "Copy" })));
  const inbox = await api("GET", "/api/operator/messages");
  const sms = h("div", { class: "card" },
    h("h2", { text: "Phone number & SMS" }),
    h("p", { class: "muted small", text: "A virtual phone has no SIM. Point a number at one of these webhooks and one-time codes reach the agent." }),
    h("h3", { text: "Telnyx (about $1/month)" }),
    copyRow("Messaging profile → inbound webhook URL", ov.hooks.telnyx),
    field("Telnyx public key", telnyx, "Used to verify every webhook's signature.", "PHONE_TELNYX_PUBLIC_KEY"),
    h("h3", { text: "Twilio" }),
    copyRow("Phone number → A message comes in → webhook", ov.hooks.twilio),
    field("Twilio auth token", twilio, "Used to verify X-Twilio-Signature.", "PHONE_TWILIO_AUTH_TOKEN"),
    h("h3", { text: "Relay phone (a spare Android with a real SIM)" }),
    h("p", { class: "muted small", text: "Install an SMS-forwarder app, point it at this URL, and send the relay token as a Bearer header (or ?token=)." }),
    copyRow("Forward to", ov.hooks.relay),
    h("div", { class: "row" },
      h("button", {
        class: "small",
        text: "Show relay token",
        onclick: run(async () => {
          const c = await api("GET", "/api/operator/connection");
          if (c.relayToken) copy(c.relayToken);
          else toast("No relay token yet — create one", "error");
        }),
      }),
      h("button", {
        class: "small",
        text: cfg.sources.relayToken ? "Rotate relay token" : "Create relay token",
        onclick: run(async () => {
          const r = await api("POST", "/api/operator/tokens/relay");
          await copy(r.relayToken);
          renderSetup();
        }),
      }),
    ),
    h("div", { class: "row" },
      h("button", {
        class: "primary",
        text: "Save",
        onclick: run(async () => {
          await api("PATCH", "/api/operator/config", { sources: { telnyxPublicKey: telnyx.value, ...(twilio.value ? { twilioAuthToken: twilio.value } : {}) } });
          toast("Saved");
          renderSetup();
        }),
      }),
      h("button", {
        text: "Send a test code",
        onclick: run(async () => {
          await api("POST", "/api/operator/messages/test", {});
          toast("Test message added to the inbox");
          renderSetup();
        }),
      }),
    ),
    h("h3", { text: "Recent messages" }),
    inbox.messages.length
      ? h("div", {}, ...inbox.messages.slice(0, 8).map((m) =>
          h("div", { class: "event" },
            h("span", { class: "muted small", text: ago(m.receivedAt) }),
            h("div", {}, h("div", {}, h("span", { class: "kind", text: m.from }), " ", h("span", { class: "pill", text: m.origin })), h("div", { class: "detail", text: m.body })),
          )))
      : h("p", { class: "muted small", text: "None yet." }),
  );

  // ---- email
  const im = cfg.sources.imap || {};
  const imHost = textInput(im.host, "imap.gmail.com");
  const imUser = textInput(im.user, "you@gmail.com");
  const imPass = secretInput(ov.secrets.some((s) => s.key === (im.passwordSecret || "imap_password")) ? "saved" : "", "app password");
  const imFrom = textInput(im.fromContains, "voice-noreply@google.com (optional)");
  const email2 = h("div", { class: "card" },
    h("h2", { text: "Email codes (IMAP)" }),
    h("p", { class: "muted small", text: "Reads verification emails — and Google Voice texts, if Voice forwards SMS to Gmail. Read-only: nothing is marked as read." }),
    field("IMAP host", imHost, null, "PHONE_IMAP_HOST"),
    field("Username", imUser),
    field("Password", imPass, "For Gmail, create an app password. Stored as the secret imap_password."),
    field("Only senders containing", imFrom),
    h("div", { class: "row" },
      h("button", {
        class: "primary",
        text: "Save",
        onclick: run(async () => {
          if (imPass.value) await api("PUT", `/api/operator/secrets/${enc(im.passwordSecret || "imap_password")}`, { value: imPass.value });
          await api("PATCH", "/api/operator/config", { sources: { imap: imHost.value ? { host: imHost.value, user: imUser.value, fromContains: imFrom.value } : null } });
          toast("Saved");
          renderSetup();
        }),
      }),
      h("button", {
        text: "Test connection",
        disabled: !im.host,
        onclick: run(async () => {
          const r = await api("POST", "/api/operator/messages/imap-test", {});
          toast(r.ok ? `Connected — ${r.recent.length} recent message(s)` : `Failed: ${r.error}`, r.ok ? "" : "error");
        }),
      }),
    ),
  );

  // ---- notifications
  const n = cfg.notify;
  const ntfy = textInput(n.ntfyUrl, "https://ntfy.sh/a-long-unguessable-topic");
  const ntfyToken = secretInput(n.ntfyToken, "optional access token");
  const tgToken = secretInput(n.telegramBotToken, "123456:ABC… from @BotFather");
  const tgChat = textInput(n.telegramChatId, "your chat id");
  const slack = secretInput(n.slackWebhook, "https://hooks.slack.com/services/…");
  const webhook = textInput(n.webhook, "https://example.com/agent-phone-events");
  const notify = h("div", { class: "card" },
    h("h2", { text: "Notifications" }),
    h("p", { class: "muted small", text: "When the agent needs an approval or a hand, you get a push with a link straight to it. Messages never include screenshots or tokens." }),
    h("p", { class: "small" }, "Active: ", ov.channels.length ? ov.channels.join(", ") : h("span", { class: "muted", text: "none" })),
    field("ntfy topic URL", ntfy, "Install the ntfy app and subscribe to the same topic. Use a long random topic name — anyone who knows it can read it.", "PHONE_NTFY_URL"),
    field("ntfy token", ntfyToken, null, "PHONE_NTFY_TOKEN"),
    field("Telegram bot token", tgToken, null, "PHONE_TELEGRAM_BOT_TOKEN"),
    field("Telegram chat id", tgChat, null, "PHONE_TELEGRAM_CHAT_ID"),
    field("Slack incoming webhook", slack, null, "PHONE_SLACK_WEBHOOK"),
    field("Generic webhook", webhook, "Receives JSON: type, id, summary, link.", "PHONE_APPROVAL_WEBHOOK"),
    h("div", { class: "row" },
      h("button", {
        class: "primary",
        text: "Save",
        onclick: run(async () => {
          await api("PATCH", "/api/operator/config", {
            notify: {
              ntfyUrl: ntfy.value,
              telegramChatId: tgChat.value,
              webhook: webhook.value,
              ...(ntfyToken.value ? { ntfyToken: ntfyToken.value } : {}),
              ...(tgToken.value ? { telegramBotToken: tgToken.value } : {}),
              ...(slack.value ? { slackWebhook: slack.value } : {}),
            },
          });
          toast("Saved");
          renderSetup();
        }),
      }),
      h("button", {
        text: "Send test",
        onclick: run(async () => {
          const r = await api("POST", "/api/operator/notify/test", {});
          if (!r.results.length) return toast("No channels configured", "error");
          for (const x of r.results) toast(`${x.channel}: ${x.ok ? "sent" : x.error}`, x.ok ? "" : "error");
        }),
      }),
    ),
  );

  // ---- secrets
  const sName = textInput("", "bank_password");
  const sValue = h("input", { type: "password", placeholder: "value", autocomplete: "new-password" });
  const secretsCard = h("div", { class: "card" },
    h("h2", { text: "Secrets" }),
    h("p", { class: "muted small", text: "The agent types these by name with phone_type_secret. It never sees the values, and neither does this page once saved." }),
    ov.secrets.length
      ? h("div", {}, ...ov.secrets.map((s) =>
          h("div", { class: "row spread event" },
            h("span", { class: "mono", text: s.key }),
            s.from === "env"
              ? h("span", { class: "pill", text: "from env" })
              : h("button", {
                  class: "small danger",
                  text: "Delete",
                  onclick: run(async () => {
                    if (!confirm(`Delete secret ${s.key}?`)) return;
                    await api("DELETE", `/api/operator/secrets/${enc(s.key)}`);
                    renderSetup();
                  }),
                }),
          )))
      : h("p", { class: "muted small", text: "No secrets yet." }),
    h("form", {
      class: "stack",
      onsubmit: run(async (ev) => {
        ev.preventDefault();
        await api("PUT", `/api/operator/secrets/${enc(sName.value.trim().toLowerCase())}`, { value: sValue.value });
        toast("Secret saved");
        renderSetup();
      }),
    }, field("Name", sName, "lowercase letters, digits and _"), field("Value", sValue), h("button", { class: "primary", type: "submit", text: "Save secret" })),
  );

  // ---- policy
  const p = ov.policy;
  const mode = h("select", {}, ...["observe", "guarded", "autonomous"].map((m) => {
    const o = h("option", { value: m, text: { observe: "observe — read only", guarded: "guarded — risky actions need you", autonomous: "autonomous — never ask (sandbox phones only)" }[m] });
    o.selected = p.mode === m;
    return o;
  }));
  const chk = (label, val, hint) => {
    const c = h("input", { type: "checkbox", checked: val });
    return [h("label", { class: "check" }, c, h("span", {}, label, hint ? h("span", { class: "hint", text: hint }) : null)), c];
  };
  const [shellRow, shell] = chk("Allow shell commands", p.allowShell, "Even when allowed, each command needs your approval in guarded mode.");
  const [installRow, install] = chk("Allow installing apps", p.allowInstall);
  const [clearRow, clearData] = chk("Allow clearing app data", p.allowClearAppData);
  const allowed = h("textarea", {}, p.allowedApps.join("\n"));
  const policy = h("div", { class: "card" },
    h("h2", { text: "What the agent may do" }),
    h("p", { class: "muted small", text: "This is a ceiling: an agent can ask for less, never more." }),
    field("Mode", mode),
    shellRow, installRow, clearRow,
    field("Only these apps (one per line, com.foo.* allowed; empty = any)", allowed),
    h("p", { class: "muted small mono", text: `Saved to ${ov.policyFile}` }),
    h("button", {
      class: "primary",
      text: "Save",
      onclick: run(async () => {
        if (mode.value === "autonomous" && !confirm("Autonomous mode lets the agent pay, send and delete without asking you. Only use it on a phone with no real accounts. Continue?")) return;
        await api("PUT", "/api/operator/policy", {
          mode: mode.value,
          allowShell: shell.checked,
          allowInstall: install.checked,
          allowClearAppData: clearData.checked,
          allowedApps: allowed.value.split(/\n|,/).map((s) => s.trim()).filter(Boolean),
        });
        toast("Policy saved — applies to new sessions");
      }),
    }),
  );

  $("#app").replaceChildren(
    h("div", { class: "cols" },
      h("div", {}, identity, sms, email2),
      h("div", {}, notify, secretsCard, policy,
        h("div", { class: "card" },
          h("p", { class: "muted small", text: `agent-phone v${ov.version} · ${ov.localUrl}${ov.publicUrl ? ` · ${ov.publicUrl}` : ""}` }),
          h("button", { class: "small ghost", onclick: logout, text: "Sign out" }),
        ),
      ),
    ),
  );
}

boot();
