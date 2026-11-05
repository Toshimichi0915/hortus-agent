/** The `transforms` approval entry (3f): one header line, the folded manifest or its diff, and the credential form. */
import { button, details, h, type Raw } from "../html.ts";

interface Cred {
  type: string;
  hosts: string[];
  locations: string[];
}

export interface TransformSummary {
  name?: string;
  new?: boolean;
  manifestDiff?: string | null;
  /** lines of transform.js that differ from the enabled version (null when new) */
  codeChanged?: number | null;
  manifest?: string;
  credentials?: Record<string, Cred>;
  missing?: { name: string; type: string }[];
  configured?: string[];
  tests?: number;
}

const FIELDS: Record<string, [string, string][]> = {
  token: [["value", "password"]],
  "webhook-secret": [["value", "password"]],
  "github-app": [
    ["appId", "number"],
    ["installationId", "number"],
    ["privateKey", "textarea"], // an <input> drops a PEM's newlines
  ],
  aws: [
    ["keyId", "password"],
    ["secret", "password"],
  ],
};

export function transformView(s: TransformSummary): Raw {
  const puts = Object.entries(s.credentials ?? {}).map(
    ([n, c]) =>
      h`put <code>${n}</code> into <code>${c.locations.join(", ")}</code> on <code>${c.hosts.join(", ")}</code>`,
  );
  return h`<p class="req">transform <code>${s.name ?? ""}</code> (${s.new ? "new" : "changed"}): ${puts.map((p, i) =>
    i ? h`; ${p}` : p,
  )}</p>
${s.new ? details("manifest", s.manifest ?? "") : details("manifest diff", s.manifestDiff ?? "")}
${s.codeChanged ? h`<p class="hint"><code>transform.js</code> changed (${String(s.codeChanged)} lines)</p>` : ""}
<p class="hint">${String(s.tests ?? 0)} test(s) passed in the sandbox</p>
${(s.configured ?? []).map((n) => h`<p class="hint"><code>${n}</code>: configured</p>`)}`;
}

/** Approve submits the entered credentials with the decision; empty fields stay unconfigured. */
export function transformForm(id: number, s: TransformSummary): Raw {
  const fields = (s.missing ?? []).map(({ name, type }) =>
    (FIELDS[type] ?? []).map(
      ([f, t]) =>
        h`<label>${name} (${type})${FIELDS[type]?.length === 1 ? "" : h` ${f}`} ${
          t === "textarea"
            ? h`<textarea name="credentials.${name}.${f}" rows="4" autocomplete="off" spellcheck="false" placeholder="leave empty to add later"></textarea>`
            : h`<input type="${t}" name="credentials.${name}.${f}" autocomplete="off" placeholder="leave empty to add later">`
        }</label>`,
    ),
  );
  return h`<form class="actions" data-call="approval.decide" data-input="${JSON.stringify({ id, decision: "approve" })}">${fields}<button type="submit" class="ok">Approve</button>${button(
    "Reject",
    "approval.decide",
    { id, decision: "reject" },
    { cls: "bad" },
  )}</form>`;
}
