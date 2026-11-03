// hortus remote console: passkey sign-in (/) and enrolment (/enroll?code=). The server does the WebAuthn checks.
const msg = document.getElementById("msg");
const say = (t, bad) => {
  msg.textContent = t || "";
  msg.className = bad ? "error" : "";
};

async function post(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "X-Hortus": "1", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ error: { message: `The server answered ${r.status}.` } }));
  if (j.error) throw new Error(j.error.message);
  return j;
}

const b64u = {
  decode: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)).buffer,
  encode: (buf) =>
    btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, ""),
};
const PKC = window.PublicKeyCredential;
const ids = (list) => (list || []).map((c) => ({ ...c, id: b64u.decode(c.id) }));

function creation(o) {
  if (PKC.parseCreationOptionsFromJSON) return PKC.parseCreationOptionsFromJSON(o);
  return {
    ...o,
    challenge: b64u.decode(o.challenge),
    user: { ...o.user, id: b64u.decode(o.user.id) },
    excludeCredentials: ids(o.excludeCredentials),
  };
}

function request(o) {
  if (PKC.parseRequestOptionsFromJSON) return PKC.parseRequestOptionsFromJSON(o);
  return { ...o, challenge: b64u.decode(o.challenge), allowCredentials: ids(o.allowCredentials) };
}

function toJSON(c) {
  try {
    if (c.toJSON) return c.toJSON();
  } catch {}
  const r = c.response;
  const response = { clientDataJSON: b64u.encode(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = b64u.encode(r.attestationObject);
    response.transports = r.getTransports?.() || [];
  } else {
    response.authenticatorData = b64u.encode(r.authenticatorData);
    response.signature = b64u.encode(r.signature);
    if (r.userHandle) response.userHandle = b64u.encode(r.userHandle);
  }
  return {
    id: c.id,
    rawId: b64u.encode(c.rawId),
    type: c.type,
    response,
    clientExtensionResults: c.getClientExtensionResults?.() || {},
    authenticatorAttachment: c.authenticatorAttachment || undefined,
  };
}

const failed = (e) =>
  say(e.name === "NotAllowedError" ? "The passkey prompt was cancelled or timed out. Try again." : e.message, true);

if (!PKC) say("This browser cannot use passkeys here (it needs HTTPS and WebAuthn).", true);

const signin = document.getElementById("signin");
signin?.addEventListener("click", async () => {
  signin.disabled = true;
  say("Waiting for the passkey…");
  try {
    const o = await post("/webauthn/login/options", {});
    const cred = await navigator.credentials.get({ publicKey: request(o) });
    await post("/webauthn/login/verify", { response: toJSON(cred) });
    location.replace(location.pathname === "/enroll" ? "/" : location.href);
  } catch (e) {
    failed(e);
  } finally {
    signin.disabled = false;
  }
});

const form = document.getElementById("enroll");
if (form) {
  const name = form.elements.device;
  name.value = navigator.userAgentData?.platform || navigator.platform || "";
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = form.dataset.code;
    const button = form.querySelector("button");
    button.disabled = true;
    say("Waiting for the device…");
    try {
      const o = await post("/webauthn/register/options", { code });
      const cred = await navigator.credentials.create({ publicKey: creation(o) });
      await post("/webauthn/register/verify", { code, device: name.value, response: toJSON(cred) });
      form.hidden = true;
      document.getElementById("enrolled").hidden = false;
      say("");
    } catch (err) {
      failed(err);
      button.disabled = false;
    }
  });
}
