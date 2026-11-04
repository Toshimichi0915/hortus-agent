// hortus console: post(), sse(), and per-page behaviours. Pages work without it for reading.
const $ = (s) => document.querySelector(s);
const msg = $("#msg");
const say = (t, bad) => {
  msg.textContent = t || "";
  msg.className = bad ? "error" : "";
};
const key = `draft:${location.pathname}`;

async function post(method, input) {
  const r = await fetch(`/api/${method}`, {
    method: "POST",
    headers: { "X-Hortus": "1", "Content-Type": "application/json" },
    body: JSON.stringify(input ?? {}),
  });
  const j = await r.json().catch(() => ({ error: { message: `${r.status} ${r.statusText}` } }));
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

/** <time datetime> (rendered in UTC) in the browser's own time zone; a relative one ("in 12 min", data-rel) stays. */
const pad = (n) => String(n).padStart(2, "0");
function localTimes(root = document) {
  for (const t of root.querySelectorAll("time[datetime]:not([data-rel])")) {
    const d = new Date(t.dateTime);
    if (Number.isNaN(d.getTime())) continue;
    t.textContent = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    t.title = d.toString();
  }
}
localTimes();

/**
 * `f` once at a time: calls while it runs fold into one more run after it, so a burst of 200 approvals is two page
 * fetches, not 200 racing ones (an older response landing last). Resolves after a run that started after the call.
 */
function single(f) {
  let running = null;
  let queued = null;
  const run = () => {
    if (!running) {
      running = f().finally(() => {
        running = null;
      });
      return running;
    }
    queued ??= running
      .catch(() => {})
      .then(() => {
        queued = null;
        return run();
      });
    return queued;
  };
  return run;
}
const refreshNav = single(navBadge);
const refresh = single(rerender);

/** Only the nav's approvals badge (pages without approvals on them are not re-fetched). */
async function navBadge() {
  const n = (await post("approval.count", {}).catch(() => null)) ?? undefined;
  const a = $('nav a[href="/approvals"]');
  if (n === undefined || !a) return;
  a.querySelector(".badge")?.remove();
  a.textContent = a.textContent.trim();
  if (n) a.insertAdjacentHTML("beforeend", ` <span class="badge">${n}</span>`);
}

/** Re-fetch this page and swap every [data-refresh] container (and the nav badge); textareas outside stay. */
async function rerender() {
  const doc = new DOMParser().parseFromString(await (await fetch(location.href)).text(), "text/html");
  // the focused control is about to be replaced: focus its twin after (keyboard users keep their place)
  const active = document.activeElement;
  const twin = active?.dataset?.call
    ? `[data-call="${active.dataset.call}"][data-input="${CSS.escape(active.dataset.input ?? "")}"]`
    : null;
  const asks = () => document.querySelectorAll("#approvals .approval").length;
  const before = asks();
  for (const el of document.querySelectorAll("[data-refresh]")) {
    const n = doc.getElementById(el.id);
    if (n) el.innerHTML = n.innerHTML;
  }
  if (asks() > before) toEnd(); // chat: the Worker waits on it, and it lands below the stream, off a phone's screen
  const nav = doc.querySelector("nav");
  if (nav) $("nav").innerHTML = nav.innerHTML;
  localTimes();
  labelCells();
  if (active && !active.isConnected) ((twin && document.querySelector(twin)) || $(".composer textarea"))?.focus();
}

/** Phones show a table row as a stacked card: each cell carries its column's name (app.css shows it). */
function labelCells() {
  for (const t of document.querySelectorAll("table")) {
    const names = [...t.querySelectorAll("thead th")].map((th) => th.textContent.trim());
    for (const tr of names.length ? t.querySelectorAll("tbody tr") : [])
      for (const [i, td] of [...tr.children].entries()) if (names[i]) td.dataset.label = names[i];
  }
}
labelCells();

async function act(el, input) {
  say(""); // a stale result must not read as this action's
  // busy while in flight: a second click or Enter must not send it twice (aria-disabled, not disabled: focus stays)
  const controls = el.tagName === "FORM" ? [...el.querySelectorAll("button:not([data-call])")] : [el];
  el.dataset.busy = "";
  for (const c of controls) c.setAttribute("aria-disabled", "true");
  const slow = setTimeout(() => say("working…"), 300);
  try {
    const r = await post(el.dataset.call, input).finally(() => clearTimeout(slow));
    say(typeof r?.message === "string" ? r.message : "done");
    if (el.dataset.go) {
      location.href = el.dataset.go.replace("{id}", encodeURIComponent(r?.id ?? r));
      return;
    }
    if ("reset" in el.dataset) el.reset();
    await refresh();
  } catch (e) {
    say(e.message, true);
    // a stale page (another tab, the CLI or the phone decided; SSE lost): show the decision instead of live buttons
    if (/already decided/.test(e.message)) refresh();
    throw e;
  } finally {
    delete el.dataset.busy;
    for (const c of controls) c.removeAttribute("aria-disabled");
  }
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-call]");
  if (!b || "busy" in b.dataset) return;
  if ("confirm" in b.dataset && !b.dataset.armed) {
    b.dataset.armed = b.textContent;
    b.textContent = `Confirm: ${b.textContent}`;
    setTimeout(() => {
      if (b.dataset.armed) b.textContent = b.dataset.armed;
      delete b.dataset.armed;
    }, 4000);
    return;
  }
  if (b.dataset.armed) b.textContent = b.dataset.armed;
  delete b.dataset.armed;
  act(b, JSON.parse(b.dataset.input || "{}")).catch(() => {});
});

document.addEventListener("submit", (e) => {
  const f = e.target;
  if (!f.dataset.call) return;
  e.preventDefault();
  if ("busy" in f.dataset) return;
  const input = JSON.parse(f.dataset.input || "{}");
  try {
    for (const el of f.elements) {
      if (!el.name || el.value === "" || !el.offsetParent) continue;
      let v = el.value;
      if ("json" in el.dataset) v = JSON.parse(v);
      else if ("list" in el.dataset)
        v = v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      else if (el.type === "number") v = Number(v);
      // a dotted name nests: credentials.notion.value → { credentials: { notion: { value } } }
      const path = el.name.split(".");
      let o = input;
      for (const k of path.slice(0, -1)) o = o[k] ??= {};
      o[path[path.length - 1]] = v;
    }
  } catch (err) {
    return say(err.message, true);
  }
  act(f, input)
    .then(() => {
      // the draft goes only once the message is in (a failed send keeps it)
      if (f.classList.contains("composer")) sessionStorage.removeItem(key);
      if (f.elements.text && f.classList.contains("composer")) f.elements.text.value = "";
    })
    .catch(() => {});
});

// a phone's keyboard has no Shift+Enter: there Enter is a newline and the Send button sends
const touch = matchMedia("(pointer: coarse)").matches;
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    say("");
    // Esc cancels an armed confirm
    for (const b of document.querySelectorAll("button[data-armed]")) {
      b.textContent = b.dataset.armed;
      delete b.dataset.armed;
    }
  }
  const t = e.target;
  if (
    !touch &&
    e.key === "Enter" &&
    !e.shiftKey &&
    !e.isComposing &&
    t.closest?.(".composer") &&
    t.tagName === "TEXTAREA"
  ) {
    e.preventDefault();
    t.form.requestSubmit();
  }
});

// chat: the result line rides in the sticky composer instead of sitting under it
$(".composer")?.append(msg);
const draft = $(".composer textarea");
if (draft) {
  if (touch) draft.placeholder = "Message";
  draft.value = sessionStorage.getItem(key) || "";
  draft.addEventListener("input", () => sessionStorage.setItem(key, draft.value));
}

const page = document.body.dataset.page;
const st = $("#stream");
/** The chat's end, the page's too: on a phone the stream runs past the screen, its end under the sticky composer. */
function toEnd() {
  st.scrollTop = st.scrollHeight;
  scrollTo(0, document.documentElement.scrollHeight);
}
const atBottom = () => st.scrollHeight - st.scrollTop - st.clientHeight < 40;
if (st) toEnd();
const conn = $("#conn");
// every page: the nav badge follows; pages showing approvals re-render
const onApprovals = ["approvals", "chat", "tasks", "task"].includes(page) ? refresh : refreshNav;
const onTasks = ["tasks", "chat", "task"].includes(page) ? refresh : null;
const channels = ["approvals", ...(onTasks ? ["tasks"] : []), ...(st ? ["chat"] : [])].join(",");
let last = st?.dataset.last;
let es = null;
let lost = false;
/** The page's one stream (server.ts › events). EventSource retries by itself (Last-Event-ID), the owner sees that it
 * does; a stream that dropped missed its events, so once it is back the page re-renders as if one came. */
function connect() {
  es = new EventSource(`/events/${channels}${st ? `?task=${encodeURIComponent(st.dataset.task)}&after=${last}` : ""}`);
  if (conn) conn.textContent = "connecting…";
  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    const stick = atBottom();
    st.insertAdjacentHTML("beforeend", d.html);
    last = d.seq;
    if (stick) toEnd();
  };
  es.addEventListener("approvals", () => onApprovals());
  if (onTasks) es.addEventListener("tasks", () => onTasks());
  es.addEventListener("error", () => {
    lost = true;
    if (conn) conn.textContent = "reconnecting…";
  });
  es.addEventListener("open", () => {
    if (conn) conn.textContent = "";
    if (!lost) return;
    lost = false;
    onApprovals();
    onTasks?.();
  });
}
connect();
// a hidden tab holds no connection, so open tabs never add up to the origin's six; back, it catches up from `last`
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    if (!es) connect();
    return;
  }
  es?.close();
  es = null;
  lost = true;
});

// Settings › Remote: the enrolment code's countdown
setInterval(() => {
  for (const el of document.querySelectorAll("[data-expires]")) {
    const s = Math.max(0, Math.round((Date.parse(el.dataset.expires) - Date.now()) / 1000));
    el.textContent = s ? `expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "expired";
  }
}, 1000);

// Approvals › login view: screencast frames from /events/login onto the canvas, mouse and keys back as login.input
const lv = $("[data-login]");
if (lv) {
  const id = Number(lv.dataset.login);
  const cv = lv.querySelector("canvas");
  const g = cv.getContext("2d");
  const status = lv.querySelector("[data-lv-status]");
  const idle = lv.querySelector("[data-idle]");
  let until = 0;
  const es = new EventSource(`/events/login?id=${id}`);
  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.until) until = d.until;
    if (d.error || d.closed) {
      status.textContent = d.error || `closed (${d.closed}): reload to open it again`;
      until = 0;
      return es.close();
    }
    if (!d.frame) return;
    const img = new Image();
    img.onload = () => {
      if (cv.width !== d.w || cv.height !== d.h) [cv.width, cv.height] = [d.w, d.h];
      g.drawImage(img, 0, 0, d.w, d.h);
    };
    img.src = `data:image/jpeg;base64,${d.frame}`;
    status.textContent = "live";
  };
  // in order: a keyUp must not overtake its keyDown
  let queue = Promise.resolve();
  const send = (input) => {
    queue = queue
      .then(() => post("login.input", { id, ...input }))
      .then((r) => {
        if (r?.until) until = r.until;
      })
      .catch((err) => say(err.message, true));
  };
  const at = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * cv.width) / r.width, y: ((e.clientY - r.top) * cv.height) / r.height };
  };
  const button = (e) => ["left", "middle", "right"][e.button] ?? "left";
  cv.addEventListener("contextmenu", (e) => e.preventDefault());
  cv.addEventListener("pointerdown", (e) => {
    cv.focus();
    e.preventDefault();
    send({ type: "mouse", event: "mousePressed", ...at(e), button: button(e), clickCount: 1 });
  });
  cv.addEventListener("pointerup", (e) =>
    send({ type: "mouse", event: "mouseReleased", ...at(e), button: button(e), clickCount: 1 }),
  );
  let moved = 0;
  cv.addEventListener("pointermove", (e) => {
    if (Date.now() - moved < 50) return;
    moved = Date.now();
    send({ type: "mouse", event: "mouseMoved", ...at(e), button: e.buttons & 1 ? "left" : "none" });
  });
  cv.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      send({ type: "mouse", event: "mouseWheel", ...at(e), deltaX: e.deltaX, deltaY: e.deltaY });
    },
    { passive: false },
  );
  const key = (e, event) =>
    send({
      type: "key",
      event,
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      modifiers: (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0),
    });
  cv.addEventListener("keydown", (e) => {
    e.preventDefault();
    key(e, "keyDown");
  });
  cv.addEventListener("keyup", (e) => {
    e.preventDefault();
    key(e, "keyUp");
  });
  // the text box: phones (no keyboard for a canvas) and pasting; editing keys pass through as keys
  const box = lv.querySelector(".lv-keys input");
  box.addEventListener("input", () => {
    if (!box.value) return;
    send({ type: "text", text: box.value });
    box.value = "";
  });
  box.addEventListener("keydown", (e) => {
    if (!["Enter", "Backspace", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key))
      return;
    e.preventDefault();
    key(e, "keyDown");
    key(e, "keyUp");
  });
  setInterval(() => {
    const s = Math.max(0, Math.round((until - Date.now()) / 1000));
    idle.textContent = until ? `· closes after ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} idle` : "";
  }, 1000);
}
