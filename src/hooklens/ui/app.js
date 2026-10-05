"use strict";

// Category order is fixed: it sets the color slot of each category.
const CATS = {
  bash: "Bash",
  file_write: "File writes",
  file_read: "File reads",
  search: "Search",
  mcp: "MCP",
  web: "Web",
  agent: "Subagents",
  other: "Other",
};
const ORDER = Object.keys(CATS);
const AGENT_NAMES = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };
const AGENT_SHORT = { claude: "Claude", codex: "Codex", cursor: "Cursor" };
const STATUS = { ok: "OK", error: "Error", running: "No result", interrupted: "Interrupted" };
const KIND_LABELS = {
  prompt: "Prompt",
  stop: "Turn end",
  session_start: "Session start",
  session_end: "Session end",
  subagent: "Subagent finished",
  compact: "Context compacted",
  notification: "Notification",
  interrupt: "Interrupted",
  permission: "Permission request",
};
// A gap between events longer than this is idle time: it does not count as active time,
// and the trace draws it as a short break, so one long wait does not flatten everything else.
const IDLE_GAP = 300;
const TABS = { trace: "Trace", tools: "Tools & files", events: "Events" };
const OLD_TABS = { timeline: "trace", graph: "tools" };
const SVG_NS = "http://www.w3.org/2000/svg";

const params = new URLSearchParams(location.search);
const state = {
  agent: params.get("agent") || "",
  sessions: [],
  current: null,
  data: null,
  turns: [],
  tab: TABS[params.get("tab")] ? params.get("tab") : OLD_TABS[params.get("tab")] || "trace",
  open: new Set(), // keys of the expanded turns
  selected: null, // "turn:<n>" or "event:<id>"
  detail: null, // rendered detail of the selected event
  prompts: new Map(), // full prompt text by event id
  catFilter: "",
  errorsOnly: false,
  query: "",
  showEmpty: false,
};

// ---------- small helpers ----------

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

function s(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  for (const c of children) node.append(c);
  return node;
}

function iconSvg(name, size = 24) {
  const shape = {
    download: [s("path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }), s("path", { d: "m7 10 5 5 5-5M12 15V3" })],
    sidebar: [s("rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }), s("path", { d: "M9 4v16" })],
    chevron: [s("path", { d: "m9 6 6 6-6 6" })],
  }[name] || [];
  return s("svg", { class: "icon-svg", width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, ...shape);
}

// replaceChildren() turns a null argument into the text "null", so drop empty children first.
const setChildren = (node, ...children) => node.replaceChildren(...children.filter((c) => c != null && c !== false));

const catColor = (c) => `var(--cat-${CATS[c] ? c : "other"})`;
const swatch = (c) => h("span", { class: "sw", style: `background:${catColor(c)}` });

function fmtDur(ms) {
  if (ms == null || ms < 0) return "–";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${String(Math.round(sec % 60)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function fmtNum(n) {
  if (n == null) return "–";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}K`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}

const plural = (n, word) => `${fmtNum(n)} ${word}${n === 1 ? "" : "s"}`;
const toDate = (t) => new Date(t * 1000);
const fmtTime = (t) => toDate(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtClock = (t) => toDate(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtDate = (t) => toDate(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtDateSec = (t) => `${toDate(t).toLocaleDateString([], { month: "short", day: "numeric" })}, ${fmtClock(t)}`;
const dayKey = (t) => toDate(t).toDateString();

function fmtDay(t) {
  const days = Math.round((new Date(new Date().toDateString()) - new Date(dayKey(t))) / 864e5);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return toDate(t).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

const basename = (p) => (p || "").split(/[\\/]/).filter(Boolean).pop() || p || "";
const truncate = (str, n) => (str && str.length > n ? str.slice(0, n - 1) + "…" : str || "");
const firstLine = (str) => {
  const lines = (str || "").trim().split("\n");
  return lines.length > 1 ? `${lines[0]} …` : lines[0];
};

// Show paths inside the session folder relative to it, also inside commands.
function shorten(text, cwd) {
  if (!text || !cwd) return text || "";
  const base = cwd.replace(/[\\/]+$/, "");
  if (text === base) return ".";
  return text.split(`${base}/`).join("").split(`${base}\\`).join("");
}

// mcp__server__tool -> server · tool
const prettyTool = (name) => (name && name.startsWith("mcp__") ? name.slice(5).split("__").join(" · ") : name || "");

// Prompts can hold markup that the agent adds: task notifications, slash commands, pasted text.
function cleanPrompt(text) {
  const raw = text || "";
  if (raw.includes("<task-notification>")) {
    const m = /<summary>([\s\S]*?)(<\/summary>|$)/.exec(raw);
    const status = /<status>([^<]*)<\/status>/.exec(raw);
    const title = m && m[1].trim() ? m[1].trim() + (m[2] ? "" : "…") : `Background task ${status ? status[1] : "update"}`;
    return { title, system: true };
  }
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(raw);
  if (cmd) {
    const args = /<command-args>([^<]*)/.exec(raw);
    return { title: `${cmd[1]} ${args ? args[1] : ""}`.trim(), system: false };
  }
  const title = raw
    .replace(/<(system-reminder|ide_selection|ide_opened_file)>[\s\S]*?(<\/\1>|$)/g, " ")
    .replace(/<pasted_content[^>]*>[\s\S]*?(<\/pasted_content[^>]*>|$)/g, " [pasted text] ")
    .replace(/<\/?[a-z][\w-]*(\s[^>]*)?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { title: title || "Prompt", system: false };
}

const sessionTitle = (x) => (x.title ? cleanPrompt(x.title).title : `Session ${x.id.slice(0, 8)}`);
const isEmptySession = (x) => !x.tool_call_count && !x.prompt_count;
const wide = () => matchMedia("(min-width: 1100px)").matches;

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

// ---------- time ----------

const eventPoints = (events) => events.flatMap((e) => (e.ended_at != null ? [e.started_at, e.ended_at] : [e.started_at]));

// Group time points that are at most IDLE_GAP seconds apart.
function segments(points) {
  const segs = [];
  for (const t of [...points].sort((a, b) => a - b)) {
    const last = segs[segs.length - 1];
    if (last && t - last.end <= IDLE_GAP) last.end = t;
    else segs.push({ start: t, end: t });
  }
  return segs;
}

const activeMs = (segs) => segs.reduce((sum, g) => sum + (g.end - g.start), 0) * 1000;

// Map a time to 0..1 across the segments, with a short fixed break for each idle gap.
function timeScale(segs) {
  const GAP = 0.025;
  const total = segs.reduce((a, g) => a + (g.end - g.start), 0);
  const avail = 1 - GAP * (segs.length - 1);
  const k = total > 0 ? avail / total : 0;
  let cursor = 0;
  const parts = segs.map((g) => {
    const x0 = cursor;
    const x1 = x0 + (k ? (g.end - g.start) * k : avail / segs.length);
    cursor = x1 + GAP;
    return { ...g, x0, x1 };
  });
  const at = (t) => {
    for (let i = 0; i < parts.length; i++) {
      const g = parts[i];
      if (t <= g.end) {
        if (t >= g.start || i === 0) return g.x0 + Math.max(0, t - g.start) * k;
        const p = parts[i - 1]; // t is inside an idle gap: spread it over the break
        return p.x1 + ((t - p.end) / (g.start - p.end)) * (g.x0 - p.x1);
      }
    }
    return 1;
  };
  const gaps = parts.slice(1).map((g, i) => ({ x: (parts[i].x1 + g.x0) / 2, ms: (g.start - parts[i].end) * 1000 }));
  return { at, gaps };
}

// ---------- turns ----------

// A turn is one prompt and everything the agent did until the next prompt.
function buildTurns(events) {
  const sorted = [...events].sort((a, b) => a.started_at - b.started_at || a.id - b.id);
  const turns = [];
  let turn = null;
  for (const e of sorted) {
    if (e.kind === "prompt") {
      turn = { prompt: e, ...cleanPrompt(e.summary), events: [e] };
      turns.push(turn);
    } else if (e.kind !== "session_start" && e.kind !== "session_end") {
      if (!turn) turns.push((turn = { prompt: null, title: "Before the first prompt", system: true, events: [] }));
      turn.events.push(e);
    }
  }
  return turns.map((t, i) => {
    const calls = t.events.filter((e) => e.kind === "tool_call");
    const points = eventPoints(t.events);
    const segs = segments(points);
    const start = Math.min(...points);
    const end = Math.max(...points);
    return { ...t, index: i + 1, key: `turn:${i}`, calls, segs, start, end,
      errors: calls.filter((e) => e.status === "error").length, active: activeMs(segs), wall: (end - start) * 1000 };
  });
}

// ---------- tooltip ----------

const tip = document.getElementById("tooltip");

function showTip(evt, title, body, meta, cat) {
  setChildren(
    tip,
    h("div", { class: "t-title" }, cat ? swatch(cat) : null, title),
    body ? h("div", { class: "t-body" }, truncate(body, 400)) : null,
    meta ? h("div", { class: "t-meta" }, meta) : null,
  );
  tip.classList.add("show");
  const pad = 14;
  const r = tip.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}

const hideTip = () => tip.classList.remove("show");

const statusText = (st) => h("span", { class: `status ${st}` }, STATUS[st] || st);
const errBadge = (n) => h("span", { class: "badge-err" }, n === 1 ? "1 error" : `${n} errors`);

// ---------- sessions ----------

async function loadSessions() {
  const q = state.agent ? `?agent=${state.agent}` : "";
  state.sessions = await api(`/api/sessions${q}`);
  renderSessionList();
  const wanted = location.hash.slice(1);
  if (wanted && wanted !== state.current) return openSession(wanted);
  if (!state.current) {
    const first = state.sessions.find((x) => !isEmptySession(x)) || state.sessions[0];
    if (first) return openSession(first.id);
  }
  if (!state.sessions.length) renderEmpty();
}

function renderSessionList() {
  const list = document.getElementById("session-list");
  const query = document.getElementById("filter").value.trim().toLowerCase();
  const matches = state.sessions.filter(
    (x) => !query || [x.title, x.cwd, x.id, x.model].some((v) => (v || "").toLowerCase().includes(query)),
  );
  const empty = matches.filter(isEmptySession);
  const rows = matches.filter((x) => state.showEmpty || !isEmptySession(x) || x.id === state.current);
  const manyAgents = new Set(state.sessions.map((x) => x.agent)).size > 1;
  const items = [];
  let day = null;
  for (const x of rows) {
    if (fmtDay(x.started_at) !== day) {
      day = fmtDay(x.started_at);
      items.push(h("li", { class: "s-day" }, day));
    }
    items.push(h("li", {}, h("button", { class: "s-item", type: "button", "aria-current": String(x.id === state.current),
      onclick: () => openSession(x.id) },
      h("div", { class: "s-title" }, sessionTitle(x)),
      h("div", { class: "s-meta" },
        h("span", {}, basename(x.cwd) || "–"),
        h("span", { class: "num" }, fmtTime(x.started_at)),
        h("span", { class: "num" }, plural(x.tool_call_count, "call")),
        x.error_count ? h("span", { class: "s-err num" }, plural(x.error_count, "error")) : null,
        manyAgents ? h("span", {}, AGENT_SHORT[x.agent] || x.agent) : null))));
  }
  if (!rows.length) items.push(h("li", { class: "s-none" }, matches.length ? "Only empty sessions match." : "No sessions match."));
  list.replaceChildren(...items);
  const toggle = document.getElementById("empty-toggle");
  toggle.hidden = !empty.length;
  toggle.textContent = state.showEmpty ? "Hide empty sessions" : `Show ${plural(empty.length, "empty session")}`;
}

function renderEmpty() {
  document.getElementById("main").replaceChildren(
    h("div", { class: "empty" },
      h("p", {}, "No sessions recorded yet."),
      h("p", {}, "Run ", h("code", {}, "hooklens install"), ", then start a new Claude Code, Codex, or Cursor session.")),
  );
}

async function openSession(id) {
  if (id !== state.current) {
    Object.assign(state, { open: new Set(), selected: null, detail: null, catFilter: "", errorsOnly: false, query: "" });
    state.prompts.clear();
  }
  state.current = id;
  if (location.hash.slice(1) !== id) history.replaceState(null, "", `${location.search}#${id}`);
  renderSessionList();
  try {
    state.data = await api(`/api/sessions/${encodeURIComponent(id)}`);
  } catch {
    document.getElementById("main").replaceChildren(h("div", { class: "empty" }, "Session not found."));
    return;
  }
  state.turns = buildTurns(state.data.events);
  renderMain();
}

// ---------- session view ----------

function setTab(id) {
  state.tab = id;
  const q = new URLSearchParams(location.search);
  q.set("tab", id);
  history.replaceState(null, "", `?${q}${location.hash}`);
  renderMain();
}

function renderMain() {
  const { session: se, events, summary } = state.data;
  const end = se.ended_at || se.started_at;
  const wallMs = (end - se.started_at) * 1000;
  const active = activeMs(segments(eventPoints(events)));
  const tokensIn = se.input_tokens + se.cache_read_tokens + se.cache_write_tokens;
  const cachePct = tokensIn ? Math.round((100 * se.cache_read_tokens) / tokensIn) : 0;
  const title = sessionTitle(se);

  const stat = (label, value, note, opts = {}) => h(opts.onclick ? "button" : "div",
    { class: `stat${opts.bad ? " bad" : ""}`, type: opts.onclick ? "button" : null, onclick: opts.onclick, title: opts.title },
    h("div", { class: "stat-label" }, label), h("div", { class: "stat-value num" }, value), h("div", { class: "stat-note" }, note));
  const showErrors = () => {
    Object.assign(state, { errorsOnly: true, catFilter: "", query: "" });
    setTab("events");
  };

  const panel = h("div", { class: "view", role: "tabpanel", "aria-labelledby": `tab-${state.tab}` },
    state.tab === "trace" ? renderTrace() : state.tab === "tools" ? renderTools() : renderEvents());

  document.getElementById("main").replaceChildren(
    h("header", { class: "s-header" },
      h("div", { class: "s-head" },
        h("div", { class: "s-eyebrow" }, [AGENT_NAMES[se.agent] || se.agent, basename(se.cwd), se.model].filter(Boolean).join(" · ")),
        h("h1", { title }, truncate(title, 160)),
        h("div", { class: "s-sub num" },
          `${fmtDate(se.started_at)} – ${dayKey(end) === dayKey(se.started_at) ? fmtTime(end) : fmtDate(end)}`)),
      h("button", { class: "btn", type: "button", onclick: exportSession, title: "Download this session as JSON" },
        iconSvg("download", 14), "Export")),
    h("div", { class: "stats" },
      stat("Active time", fmtDur(active), `of ${fmtDur(wallMs)} in total`,
        { title: "Time with agent activity. A gap of more than 5 minutes between events counts as idle." }),
      stat("Tool calls", fmtNum(se.tool_call_count), plural(se.prompt_count, "prompt")),
      stat("Errors", fmtNum(se.error_count), se.error_count ? "Show in events" : "None",
        { bad: se.error_count > 0, onclick: se.error_count ? showErrors : null }),
      stat("Files changed", fmtNum(summary.files_written_total), `${fmtNum(summary.files_read_total)} read`),
      stat("Tokens", fmtNum(tokensIn + se.output_tokens), `${cachePct}% cache reads`)),
    h("div", { class: "tabs", role: "tablist", "aria-label": "Session views" },
      ...Object.entries(TABS).map(([id, label]) => h("button", { class: "tab", type: "button", role: "tab", id: `tab-${id}`,
        "aria-selected": String(state.tab === id), onclick: () => setTab(id) }, label))),
    panel,
  );
}

// ---------- trace ----------

function renderTrace() {
  if (!state.turns.length) return h("div", { class: "empty" }, "No events recorded for this session yet.");
  const maxActive = Math.max(1, ...state.turns.map((t) => t.active));
  const rows = [];
  let prev = null;
  for (const t of state.turns) {
    const idle = prev ? (t.start - prev.end) * 1000 : 0;
    if (!prev || dayKey(t.start) !== dayKey(prev.start)) {
      rows.push(h("div", { class: "tr-day" }, h("span", {}, fmtDay(t.start)),
        idle > IDLE_GAP * 1000 ? h("span", { class: "idle num" }, `${fmtDur(idle)} idle`) : null));
    } else if (idle > IDLE_GAP * 1000) {
      rows.push(h("div", { class: "tr-idle num" }, `${fmtDur(idle)} idle`));
    }
    rows.push(turnRow(t, maxActive));
    if (state.open.has(t.key)) rows.push(turnChildren(t));
    prev = t;
  }
  const selectedTurn = state.turns.find((t) => t.key === state.selected);
  if (selectedTurn) state.detail = turnDetail(selectedTurn);
  return h("div", { class: "trace" },
    h("div", { class: "trace-list" },
      h("div", { class: "tr-head" }, h("span", {}), h("span", {}, "Time"), h("span", {}, "Turn"),
        h("span", { class: "tr-calls" }, "Calls"), h("span", { class: "tr-err" }), h("span", { class: "tr-dur" }, "Active"),
        h("span", { class: "tr-meter-head" })),
      ...rows),
    h("aside", { id: "detail-panel", class: "detail-panel" },
      state.detail || h("div", { class: "detail-empty" }, "Select a turn or a tool call to see its details.")));
}

function turnRow(t, maxActive) {
  const open = state.open.has(t.key);
  const toggle = () => {
    if (open) state.open.delete(t.key);
    else state.open.add(t.key);
    state.selected = t.key;
    renderMain();
  };
  return h("button", { class: `tr-row tr-turn${t.system ? " system" : ""}${state.selected === t.key ? " selected" : ""}`,
    type: "button", "aria-expanded": String(open), "data-key": t.key, onclick: toggle },
    h("span", { class: "tr-chev" }, iconSvg("chevron", 14)),
    h("span", { class: "tr-time num" }, fmtTime(t.start)),
    h("span", { class: "tr-title" }, t.system ? h("span", { class: "tag" }, "system") : null, h("span", { class: "tr-text" }, t.title)),
    h("span", { class: "tr-calls num" }, t.calls.length || ""),
    h("span", { class: "tr-err" }, t.errors ? errBadge(t.errors) : null),
    h("span", { class: "tr-dur num", title: t.wall - t.active >= 1000 ? `${fmtDur(t.wall)} with idle time` : null }, fmtDur(t.active)),
    h("span", { class: "tr-meter", "aria-hidden": "true" }, h("span", { style: `width:${Math.max(2, (100 * t.active) / maxActive)}%` })));
}

function turnChildren(t) {
  const x = timeScale(t.segs);
  const gapLines = () => x.gaps.map((g) => h("span", { class: "gap", style: `left:${100 * g.x}%` }));
  const items = t.events.filter((e) => e.kind !== "prompt" && e.kind !== "stop").map((e) => childRow(t, e, x, gapLines));
  if (!items.length) return h("div", { class: "tr-children" }, h("div", { class: "tr-none" }, "No tool calls in this turn."));
  const axis = h("div", { class: "tr-child tr-axis num" }, h("span", { class: "tr-off" }, "Start"), h("span", {}, "Tool"),
    h("span", { class: "tr-target" }, "Target"), h("span", { class: "tr-dur" }, "Duration"),
    h("span", { class: "tr-track" }, ...gapLines(),
      ...x.gaps.map((g) => h("span", { class: "gap-label", style: `left:${100 * g.x}%`, title: `${fmtDur(g.ms)} idle` }, "≈")),
      h("span", { class: "axis-end" }, fmtDur(t.active))));
  return h("div", { class: "tr-children" }, axis, ...items);
}

function childRow(t, e, x, gapLines) {
  const cwd = state.data.session.cwd;
  const key = `event:${e.id}`;
  const left = x.at(e.started_at);
  const isCall = e.kind === "tool_call";
  const label = isCall ? shorten(e.target || e.summary || "", cwd) : e.summary || "";
  const mark = isCall
    ? h("span", { class: "tr-bar", style: `left:${100 * left}%;width:${100 * Math.max(x.at(e.ended_at ?? e.started_at) - left, 0)}%;`
        + `background:${catColor(e.category)}${e.status === "running" ? ";opacity:.45" : ""}` })
    : h("span", { class: "tr-pt", style: `left:${100 * left}%` });
  const meta = isCall ? `${fmtClock(e.started_at)} · ${fmtDur(e.duration_ms)} · ${STATUS[e.status] || e.status}` : fmtClock(e.started_at);
  return h("button", { class: `tr-row tr-child${isCall ? "" : " tr-point"}${state.selected === key ? " selected" : ""}`, type: "button",
    "data-key": key, onclick: () => selectEvent(e.id) },
    h("span", { class: "tr-off num" }, `+${fmtDur((e.started_at - t.start) * 1000)}`),
    h("span", { class: "tr-tool" }, isCall ? swatch(e.category) : h("span", { class: "pt-dot" }),
      h("span", { class: "tr-text" }, isCall ? prettyTool(e.tool_name) || CATS[e.category] : KIND_LABELS[e.kind] || e.kind)),
    h("span", { class: "tr-target" }, e.status === "error" ? h("span", { class: "badge-err" }, "Error")
      : isCall && e.status !== "ok" ? h("span", { class: "badge-muted" }, STATUS[e.status] || e.status) : null,
      h("span", { class: "tr-text mono" }, firstLine(label))),
    h("span", { class: "tr-dur num" }, isCall ? fmtDur(e.duration_ms) : ""),
    h("span", { class: "tr-track", onmousemove: (ev) => showTip(ev, isCall ? prettyTool(e.tool_name) : KIND_LABELS[e.kind], label, meta,
      isCall ? e.category : null), onmouseleave: hideTip }, ...gapLines(), mark));
}

// ---------- details ----------

const dlRow = (k, v) => (v == null || v === "" ? null : [h("dt", {}, k), h("dd", {}, v)]);
const section = (title, ...body) => h("section", { class: "d-section" }, h("h3", {}, title), ...body);

function aggregateFiles(files) {
  const map = new Map();
  for (const f of files) {
    const x = map.get(f.path) || { path: f.path, read: 0, write: 0 };
    if (f.op === "read") x.read++;
    else x.write++;
    map.set(f.path, x);
  }
  return [...map.values()].sort((a, b) => b.write - a.write || b.read - a.read || a.path.localeCompare(b.path));
}

function fileList(files, limit = 60) {
  const shown = files.slice(0, limit);
  return h("ul", { class: "f-list" },
    ...shown.map((f) => {
      const base = basename(f.path);
      const dir = f.path.slice(0, f.path.length - base.length);
      return h("li", { title: `${f.path}\n${plural(f.write, "write")}, ${plural(f.read, "read")}` },
        h("span", { class: "f-name" }, h("span", { class: "f-base" }, base), dir ? h("span", { class: "f-dir" }, dir) : null),
        h("span", { class: "f-op" }, swatch(f.write ? "file_write" : "file_read"), f.write ? "changed" : "read"));
    }),
    files.length > limit ? h("li", { class: "f-more" }, `${files.length - limit} more`) : null);
}

function categoryShare(calls) {
  const activity = ORDER.map((cat) => ({ cat, ms: calls.filter((e) => (e.category || "other") === cat)
    .reduce((sum, e) => sum + (e.duration_ms || 0), 0) })).filter((x) => x.ms > 0);
  const total = activity.reduce((sum, x) => sum + x.ms, 0);
  if (!total) return h("div", { class: "muted" }, "No tool-call durations recorded.");
  const pct = (ms) => `${Math.round((100 * ms) / total)}%`;
  return h("div", {},
    h("div", { class: "share", role: "img", "aria-label": activity.map((x) => `${CATS[x.cat]} ${pct(x.ms)}`).join(", ") },
      ...activity.map((x) => h("span", { style: `flex:${x.ms} 1 0;background:${catColor(x.cat)}`,
        onmousemove: (ev) => showTip(ev, CATS[x.cat], null, `${fmtDur(x.ms)} · ${pct(x.ms)} of tool time`, x.cat), onmouseleave: hideTip }))),
    h("div", { class: "share-legend" },
      ...activity.map((x) => h("span", {}, swatch(x.cat), h("b", {}, CATS[x.cat]), h("span", { class: "num" }, `${fmtDur(x.ms)} · ${pct(x.ms)}`)))));
}

function turnDetail(t) {
  const ids = new Set(t.calls.map((e) => e.id));
  const files = aggregateFiles(state.data.files.filter((f) => ids.has(f.event_id)));
  const promptBox = h("div", { class: "d-prompt" }, state.prompts.get(t.prompt?.id) || t.prompt?.summary || "No prompt");
  if (t.prompt && !state.prompts.has(t.prompt.id)) {
    api(`/api/events/${t.prompt.id}`).then((e) => {
      state.prompts.set(t.prompt.id, e.detail?.prompt || t.prompt.summary);
      promptBox.textContent = state.prompts.get(t.prompt.id);
    }).catch(() => {});
  }
  return h("div", { class: "detail" },
    h("div", { class: "d-eyebrow num" }, `Turn ${t.index} · ${fmtDate(t.start)}`),
    h("h2", {}, truncate(t.title, 200)),
    h("dl", { class: "d-grid num" },
      dlRow("Active time", fmtDur(t.active)),
      dlRow("Total time", t.wall - t.active >= 1000 ? fmtDur(t.wall) : null),
      dlRow("Tool calls", String(t.calls.length)),
      dlRow("Errors", t.errors ? h("span", { class: "status error" }, String(t.errors)) : "0")),
    t.calls.length ? section("Time by activity", categoryShare(t.calls)) : null,
    section("Prompt", promptBox),
    files.length ? section(`Files (${files.length})`, fileList(files)) : null);
}

// Show each input field on its own, so a multi-line command reads as it was written.
function inputView(input) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return h("pre", {}, typeof input === "string" ? input : JSON.stringify(input, null, 2));
  }
  return h("div", { class: "kv" }, ...Object.entries(input).map(([k, v]) => h("div", {},
    h("div", { class: "kv-key mono" }, k), h("pre", {}, typeof v === "string" ? v : JSON.stringify(v, null, 2)))));
}

function eventDetail(e) {
  const cwd = state.data.session.cwd;
  const d = e.detail || {};
  const isCall = e.kind === "tool_call";
  const block = (title, v, cls) => (v == null || v === "" ? null
    : section(title, h("pre", { class: cls }, typeof v === "string" ? v : JSON.stringify(v, null, 2))));
  return h("div", { class: "detail" },
    h("div", { class: "d-eyebrow" }, isCall ? [swatch(e.category), CATS[e.category] || e.category] : KIND_LABELS[e.kind] || e.kind),
    h("h2", {}, isCall ? prettyTool(e.tool_name) : truncate(cleanPrompt(e.summary).title, 200) || e.kind),
    h("dl", { class: "d-grid num" },
      dlRow("Status", isCall ? statusText(e.status) : null),
      dlRow("Started", fmtDateSec(e.started_at)),
      dlRow("Duration", isCall ? fmtDur(e.duration_ms) : null),
      dlRow("Source", e.source === "transcript" ? "Transcript (no hook for this tool)" : null),
      dlRow("Tool use id", e.tool_use_id)),
    e.target && d.input === undefined ? section("Target", h("pre", {}, shorten(e.target, cwd))) : null,
    e.files.length ? section(`Files (${e.files.length})`,
      fileList(aggregateFiles(e.files.map((f) => ({ path: shorten(f.path, cwd), op: f.op }))))) : null,
    block("Error", d.error, "err"),
    block("Prompt", d.prompt),
    d.input !== undefined ? section("Input", inputView(d.input)) : null,
    block("Response (excerpt)", d.response),
    !isCall && !d.prompt && Object.keys(d).length ? block("Payload", d) : null);
}

async function selectEvent(id) {
  hideTip();
  state.selected = `event:${id}`;
  let e;
  try {
    e = await api(`/api/events/${id}`);
  } catch {
    return;
  }
  state.detail = eventDetail(e);
  const panel = document.getElementById("detail-panel");
  document.querySelectorAll(".tr-row.selected").forEach((r) => r.classList.remove("selected"));
  document.querySelector(`.tr-row[data-key="event:${id}"]`)?.classList.add("selected");
  if (panel && wide()) {
    setChildren(panel, state.detail);
    panel.scrollTop = 0;
    return;
  }
  document.getElementById("drawer-title").textContent = e.kind === "tool_call" ? prettyTool(e.tool_name) : KIND_LABELS[e.kind] || e.kind;
  setChildren(document.getElementById("drawer-body"), state.detail);
  drawer.setAttribute("aria-hidden", "false");
}

// ---------- tools and files ----------

function toolStats(calls) {
  const map = new Map();
  for (const e of calls) {
    const name = e.tool_name || "unknown";
    const x = map.get(name) || { name, cats: {}, calls: 0, errors: 0, durs: [] };
    x.calls++;
    if (e.status === "error") x.errors++;
    if (e.duration_ms != null) x.durs.push(e.duration_ms);
    x.cats[e.category || "other"] = (x.cats[e.category || "other"] || 0) + 1;
    map.set(name, x);
  }
  return [...map.values()].map((x) => {
    x.durs.sort((a, b) => a - b);
    const q = (p) => (x.durs.length ? x.durs[Math.min(x.durs.length - 1, Math.floor(p * x.durs.length))] : null);
    const cat = Object.entries(x.cats).sort((a, b) => b[1] - a[1])[0][0];
    return { ...x, cat, total: x.durs.reduce((a, b) => a + b, 0), p50: q(0.5), p95: q(0.95) };
  }).sort((a, b) => b.total - a.total || b.calls - a.calls);
}

function rankList(items, cat) {
  if (!items.length) return h("div", { class: "muted" }, "None");
  const max = Math.max(...items.map((i) => i.count));
  return h("ul", { class: "rank" }, ...items.map((i) => h("li", { title: i.name },
    h("span", { class: "rank-name mono" }, i.name), h("span", { class: "rank-count num" }, i.count),
    h("span", { class: "rank-bar" }, h("span", { style: `width:${(100 * i.count) / max}%;background:${catColor(cat)}` })))));
}

function renderTools() {
  const { events, summary, files } = state.data;
  const calls = events.filter((e) => e.kind === "tool_call");
  if (!calls.length) return h("div", { class: "empty" }, "No tool calls in this session.");
  const tools = toolStats(calls);
  const maxTotal = Math.max(1, ...tools.map((t) => t.total));
  const allFiles = aggregateFiles(files);
  const num = (v, cls = "r num") => h("td", { class: cls }, v);
  return h("div", { class: "tools" },
    h("section", { class: "card" }, h("h2", {}, "Time by activity"), h("p", { class: "sub" }, "Share of the recorded tool-call time"),
      categoryShare(calls)),
    h("section", { class: "card" }, h("h2", {}, "Tools"), h("p", { class: "sub" }, "Sorted by total time"),
      h("div", { class: "table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Tool"), h("th", { class: "r" }, "Calls"), h("th", { class: "r" }, "Errors"),
          h("th", { class: "r" }, "Total"), h("th", { class: "r" }, "Median"), h("th", { class: "r" }, "p95"), h("th", { class: "bar-col" }))),
        h("tbody", {}, ...tools.map((t) => h("tr", {},
          h("td", {}, h("span", { class: "status" }, swatch(t.cat), prettyTool(t.name))),
          num(t.calls), h("td", { class: "r num" }, t.errors ? h("span", { class: "status error" }, t.errors) : h("span", { class: "muted" }, "–")),
          num(fmtDur(t.total)), num(fmtDur(t.p50)), num(fmtDur(t.p95)),
          h("td", { class: "bar-col" }, h("span", { class: "t-bar" },
            h("span", { style: `width:${Math.max(1, (100 * t.total) / maxTotal)}%;background:${catColor(t.cat)}` }))))))))),
    h("div", { class: "two" },
      h("section", { class: "card" }, h("h2", {}, `Files (${allFiles.length})`), h("p", { class: "sub" }, "Changed files first"),
        allFiles.length ? fileList(allFiles, 200) : h("div", { class: "muted" }, "No files recorded.")),
      h("div", { class: "stack" },
        h("section", { class: "card" }, h("h2", {}, "Commands"), h("p", { class: "sub" }, "Programs run in Bash"),
          rankList(summary.commands, "bash")),
        summary.mcp_servers.length ? h("section", { class: "card" }, h("h2", {}, "MCP servers"), h("p", { class: "sub" }, "Calls by server"),
          rankList(summary.mcp_servers, "mcp")) : null)));
}

// ---------- events ----------

function renderEvents() {
  const host = h("div", { class: "table-wrap" });
  const count = h("span", { class: "count num" });
  const update = () => renderEventTable(host, count);
  const search = h("input", { class: "input", type: "search", placeholder: "Search tools, targets, prompts", value: state.query,
    "aria-label": "Search events", oninput: (e) => { state.query = e.target.value; update(); } });
  const cats = ORDER.filter((c) => state.data.summary.categories[c]);
  const select = h("select", { class: "input", "aria-label": "Filter by category", onchange: (e) => { state.catFilter = e.target.value; update(); } },
    h("option", { value: "", selected: !state.catFilter }, "All categories"),
    ...cats.map((c) => h("option", { value: c, selected: state.catFilter === c }, CATS[c])));
  const errors = h("label", { class: "check" }, h("input", { type: "checkbox", checked: state.errorsOnly,
    onchange: (e) => { state.errorsOnly = e.target.checked; update(); } }), "Errors only");
  update();
  return h("section", { class: "card events" }, h("div", { class: "toolbar" }, search, select, errors, count), host);
}

function renderEventTable(host, count) {
  const { events, session } = state.data;
  const cwd = session.cwd;
  const multiDay = dayKey(session.started_at) !== dayKey(session.ended_at || session.started_at);
  const q = state.query.trim().toLowerCase();
  const text = (e) => (e.kind === "prompt" ? cleanPrompt(e.summary).title : shorten(e.target || (e.kind !== "tool_call" ? e.summary : "") || "", cwd));
  const rows = events.filter((e) => (!state.catFilter || e.category === state.catFilter)
    && (!state.errorsOnly || e.status === "error")
    && (!q || [e.tool_name, e.target, e.summary].some((v) => (v || "").toLowerCase().includes(q))));
  count.textContent = rows.length === events.length ? plural(events.length, "event") : `${rows.length} of ${plural(events.length, "event")}`;
  if (!rows.length) {
    setChildren(host, h("div", { class: "empty" }, "No events match."));
    return;
  }
  setChildren(host, h("table", { class: "clickable" },
    h("thead", {}, h("tr", {}, h("th", {}, "Time"), h("th", {}, "Type"), h("th", {}, "Tool"), h("th", {}, "Target"),
      h("th", { class: "r" }, "Duration"), h("th", {}, "Status"))),
    h("tbody", {}, ...rows.map((e) => {
      const isCall = e.kind === "tool_call";
      return h("tr", { onclick: () => selectEvent(e.id) },
        h("td", { class: "num nowrap muted" }, multiDay ? fmtDateSec(e.started_at) : fmtClock(e.started_at)),
        h("td", { class: "nowrap" }, isCall ? h("span", { class: "status" }, swatch(e.category), CATS[e.category] || e.category)
          : h("span", { class: "muted" }, KIND_LABELS[e.kind] || e.kind)),
        h("td", { class: "nowrap" }, prettyTool(e.tool_name)),
        h("td", { class: "target", title: text(e) }, firstLine(text(e))),
        h("td", { class: "r num nowrap" }, isCall ? fmtDur(e.duration_ms) : ""),
        h("td", { class: "nowrap" }, isCall && e.status !== "ok" ? statusText(e.status) : ""));
    }))));
}

// ---------- export, sidebar, drawer ----------

function exportSession() {
  const blob = new Blob([JSON.stringify({ ...state.data, exported_at: new Date().toISOString() }, null, 2)],
    { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: `hooklens-session-${state.data.session.id.slice(0, 8)}.json` });
  document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

const sidebarToggle = document.getElementById("sidebar-toggle");
function updateSidebarToggle() {
  const collapsed = document.body.classList.contains("sidebar-collapsed");
  const label = collapsed ? "Show sessions sidebar" : "Hide sessions sidebar";
  sidebarToggle.replaceChildren(iconSvg("sidebar", 18));
  sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  sidebarToggle.setAttribute("aria-label", label);
  sidebarToggle.title = label;
}
sidebarToggle.addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("sidebar-collapsed");
  try { localStorage.setItem("hooklens-sidebar-collapsed", String(collapsed)); } catch { /* storage can be blocked */ }
  updateSidebarToggle();
});
try {
  if (localStorage.getItem("hooklens-sidebar-collapsed") === "true") document.body.classList.add("sidebar-collapsed");
} catch { /* storage can be blocked */ }
updateSidebarToggle();

const drawer = document.getElementById("drawer");
document.getElementById("drawer-close").addEventListener("click", () => drawer.setAttribute("aria-hidden", "true"));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") drawer.setAttribute("aria-hidden", "true"); });

// ---------- controls and live refresh ----------

document.querySelectorAll("#agent-filter button").forEach((b) => {
  b.setAttribute("aria-pressed", String(b.dataset.agent === state.agent));
  b.addEventListener("click", () => {
    state.agent = b.dataset.agent;
    document.querySelectorAll("#agent-filter button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    const q = new URLSearchParams(location.search);
    if (state.agent) q.set("agent", state.agent);
    else q.delete("agent");
    state.current = null;
    history.replaceState(null, "", `${location.pathname}${q.toString() ? `?${q}` : ""}`);
    loadSessions();
  });
});
document.getElementById("filter").addEventListener("input", renderSessionList);
document.getElementById("empty-toggle").addEventListener("click", () => {
  state.showEmpty = !state.showEmpty;
  renderSessionList();
});
document.getElementById("refresh").addEventListener("click", () => refresh(true));
window.addEventListener("hashchange", () => { const id = location.hash.slice(1); if (id && id !== state.current) openSession(id); });

async function refresh(force) {
  const before = state.sessions.find((x) => x.id === state.current);
  await loadSessions();
  const after = state.sessions.find((x) => x.id === state.current);
  const changed = before && after && (before.ended_at !== after.ended_at || before.tool_call_count !== after.tool_call_count);
  if (state.current && (force || changed)) {
    state.data = await api(`/api/sessions/${encodeURIComponent(state.current)}`);
    state.turns = buildTurns(state.data.events);
    renderMain();
  }
}

setInterval(() => {
  const typing = document.activeElement?.matches?.("#main input, #main select");
  if (document.getElementById("live").checked && !document.hidden && !typing && drawer.getAttribute("aria-hidden") === "true") refresh(false);
}, 5000);

loadSessions().catch((err) => {
  document.getElementById("main").replaceChildren(h("div", { class: "empty" }, `Could not load sessions: ${err.message}`));
});
