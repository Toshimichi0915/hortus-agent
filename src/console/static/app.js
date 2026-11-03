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

function sse(name, handler, q = "") {
  const es = new EventSource(`/events/${name}${q}`);
  es.onmessage = (e) => handler(JSON.parse(e.data));
  return es;
}

/** <time datetime> (rendered in UTC) in the browser's own time zone. */
const pad = (n) => String(n).padStart(2, "0");
function localTimes(root = document) {
  for (const t of root.querySelectorAll("time[datetime]")) {
    const d = new Date(t.dateTime);
    if (Number.isNaN(d.getTime())) continue;
    t.textContent = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    t.title = d.toString();
  }
}
localTimes();

/** Re-fetch this page and swap every [data-refresh] container (and the nav badge); textareas outside stay. */
async function refresh() {
  const doc = new DOMParser().parseFromString(await (await fetch(location.href)).text(), "text/html");
  for (const el of document.querySelectorAll("[data-refresh]")) {
    const n = doc.getElementById(el.id);
    if (n) el.innerHTML = n.innerHTML;
  }
  const nav = doc.querySelector("nav");
  if (nav) $("nav").innerHTML = nav.innerHTML;
  localTimes();
}

async function act(el, input) {
  try {
    const r = await post(el.dataset.call, input);
    say(typeof r?.message === "string" ? r.message : "done");
    if (el.dataset.go) {
      location.href = el.dataset.go.replace("{id}", encodeURIComponent(r?.id ?? r));
      return;
    }
    if ("reset" in el.dataset) el.reset();
    await refresh();
  } catch (e) {
    say(e.message, true);
    throw e;
  }
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-call]");
  if (!b) return;
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

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") say("");
  const t = e.target;
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && t.closest?.(".composer") && t.tagName === "TEXTAREA") {
    e.preventDefault();
    t.form.requestSubmit();
  }
});

const draft = $(".composer textarea");
if (draft) {
  draft.value = sessionStorage.getItem(key) || "";
  draft.addEventListener("input", () => sessionStorage.setItem(key, draft.value));
}

const page = document.body.dataset.page;
const st = $("#stream");
if (st) {
  const atBottom = () => st.scrollHeight - st.scrollTop - st.clientHeight < 40;
  st.scrollTop = st.scrollHeight;
  sse(
    "chat",
    (d) => {
      const stick = atBottom();
      st.insertAdjacentHTML("beforeend", d.html);
      if (stick) st.scrollTop = st.scrollHeight;
    },
    `?task=${encodeURIComponent(st.dataset.task)}&after=${st.dataset.last}`,
  );
}
if (["approvals", "chat", "tasks"].includes(page)) sse("approvals", refresh);
if (["tasks", "chat", "task"].includes(page)) sse("tasks", refresh);

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
