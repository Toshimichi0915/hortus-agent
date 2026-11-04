/**
 * Recovery at start (07-step3-runtime.md › Recovery): processes and tasks left by a crash, stale session links and
 * cgroups. Stale `hortus:` nftables rules, taps and addresses are flushed by the runtime module (net.flushStale);
 * pending approvals stay; the gateway's reconcile runs at its own start.
 */
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { scan } from "../agent/loop.ts";
import type { Ctx } from "../ctx.ts";
import * as paths from "../paths.ts";
import { links } from "../proxy/index.ts";
import * as cgroup from "./cgroup.ts";
import * as tasks from "./tasks.ts";

const read = (p: string): string => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

/** gone, or a zombie (its parent, the dead hortusd's, is not ours to reap) */
const dead = (pid: number): boolean => /^\d+ \(.*\) [ZX]/s.test(read(`/proc/${pid}/stat`) || "0 () X");

/**
 * Processes an earlier hortusd on this HORTUS_HOME left running: a QEMU or virtiofsd naming `tasks/<id>/vfs/…`, a host
 * session's `hortus-agent --task tasks/<id>`. A restart in a new scope (`systemd-run --scope`, a plain fork) has a new
 * cgroup base, so the old `tasks/<id>` cgroups are not under it, and a QEMU killed with hortusd before it joined its
 * cgroup is in none: each is found by its argv (own uid only); its task cgroup is killed when it is in one, else the
 * process itself. Returns what it killed, for the log.
 */
export async function reapOrphans(): Promise<string[]> {
  const prefix = `${paths.home()}/tasks/`;
  // QEMU option values double a comma (vm.ts › opt)
  const forms = [prefix, prefix.replaceAll(",", ",,")];
  const uid = process.getuid?.();
  const found: string[] = [];
  const pids: number[] = [];
  const lone: number[] = [];
  const groups = new Set<string>();
  for (const name of readdirSync("/proc")) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      if (statSync(`/proc/${name}`).uid !== uid) continue;
    } catch {
      continue;
    }
    const argv = read(`/proc/${name}/cmdline`).split("\0");
    // only these: the owner's own `tail -f ~/.hortus/tasks/<id>/out/console.log` names the directory too
    const vm = /(^|\/)(qemu-system-[^/]*|virtiofsd)$/.test(argv[0] ?? "");
    let id: string | undefined;
    argv.forEach((a, i) => {
      if (!vm && argv[i - 1] !== "--task") return;
      for (const f of forms) {
        const at = a.indexOf(f);
        if (at >= 0) id ??= /^[A-Za-z0-9_-]+/.exec(a.slice(at + f.length))?.[0];
      }
    });
    if (!id || dead(pid)) continue;
    found.push(`${pid} ${argv[0]} (${id})`);
    pids.push(pid);
    const cg = read(`/proc/${name}/cgroup`)
      .split("\n")
      .find((l) => l.startsWith("0::"))
      ?.slice(3);
    if (cg?.endsWith(`/tasks/${id}`)) groups.add(join(cgroup.ROOT, cg));
    else lone.push(pid);
  }
  for (const g of groups) await cgroup.killPath(g).catch(() => {});
  for (const pid of lone)
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  // every one, not only the lone ones: an emptied cgroup (killPath returned) can still hold a QEMU in its exit, and
  // nothing may write out/ once the task resumes there (seen in vm.test: alive just after the restart)
  for (let i = 0; i < 200 && !pids.every(dead); i++) await sleep(50);
  return found;
}

export async function recover(c: Ctx): Promise<void> {
  const log = c.log("recovery");
  // first: an orphaned session would keep writing the out/ its task resumes in
  const orphans = await reapOrphans().catch((e) => {
    log.error("orphan scan failed", e);
    return [];
  });
  if (orphans.length) log.info("killed orphaned task processes", { processes: orphans });
  const rows = c.db.prepare("SELECT id, kind FROM tasks WHERE status = 'running'").all() as {
    id: string;
    kind: string;
  }[];
  for (const { id, kind } of rows) {
    if (kind === "chat") tasks.setStatus(id, "waiting");
    // a firing runs at most once: a run that never reached the model is over
    else if (kind === "run" && scan(join(paths.out(id), "sessions")).tokens === 0) await tasks.close(id, "failed");
    // resume in the same directory; the agent closes dangling tool calls (F5)
    else tasks.setStatus(id, "queued");
    log.info("recovered", { task: id, kind });
  }
  // a VM's tap link too: its tap is gone (net.flushStale), the row would map the address to a dead task
  const stale = c.db.prepare("SELECT address FROM links WHERE kind IN ('session', 'vm')").all() as {
    address: string;
  }[];
  for (const { address } of stale) links.release(address);
  let dirs: string[] = [];
  try {
    // the cgroup's own control files sit beside the task cgroups
    dirs = readdirSync(join(cgroup.base(), "tasks"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {}
  for (const id of dirs) await cgroup.kill(id).catch((e) => log.error("stale cgroup", e, { task: id }));
  // the virtiofsd sockets of VMs that died with hortusd (startVm clears its own before use too)
  let ids: string[] = [];
  try {
    ids = readdirSync(join(paths.home(), "tasks"));
  } catch {}
  for (const id of ids) rmSync(join(paths.task(id), "vfs"), { recursive: true, force: true });
}
