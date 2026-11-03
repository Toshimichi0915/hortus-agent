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

/** Re-fetch this page and swap every [data-refresh] container (and the nav badge); textareas outside stay. */
async function refresh() {
  const doc = new DOMParser().parseFromString(await (await fetch(location.href)).text(), "text/html");
  for (const el of document.querySelectorAll("[data-refresh]")) {
    const n = doc.getElementById(el.id);
    if (n) el.innerHTML = n.innerHTML;
  }
  const nav = doc.querySelector("nav");
  if (nav) $("nav").innerHTML = nav.innerHTML;
}

async function act(el, input) {
  try {
    const r = await post(el.dataset.call, input);
    say("done");
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
      input[el.name] = v;
    }
  } catch (err) {
    return say(err.message, true);
  }
  if (f.classList.contains("composer")) sessionStorage.removeItem(key);
  act(f, input)
    .then(() => {
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
if (page === "tasks") sse("tasks", refresh);

// Settings › Remote: the enrolment code's countdown
setInterval(() => {
  for (const el of document.querySelectorAll("[data-expires]")) {
    const s = Math.max(0, Math.round((Date.parse(el.dataset.expires) - Date.now()) / 1000));
    el.textContent = s ? `expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "expired";
  }
}, 1000);
