/**
 * Shim, profiles, cgroups, spawnSandboxed (no capabilities). Re-runs itself inside
 * `systemd-run --user --scope -p Delegate=yes` when available, so the cgroup assertions get a delegated cgroup.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Config } from "../config.ts";
import * as paths from "../paths.ts";
import type { TaskJson } from "../types.ts";
import * as cgroup from "./cgroup.ts";
import { caches, sandboxEnv, spawnSandboxed } from "./host.ts";
import { abi, denySet, profile, readOnlySet, shim } from "./landlock.ts";

const inScope = process.env.HORTUS_TEST_SCOPE === "1";
const hasSystemdRun = spawnSync("systemd-run", ["--user", "--scope", "-q", "--", "true"]).status === 0;

if (!inScope && hasSystemdRun) {
  test("sandbox tests inside a delegated user scope", () => {
    const r = spawnSync(
      "systemd-run",
      [
        "--user",
        "--scope",
        "-p",
        "Delegate=yes",
        "-q",
        "--",
        process.execPath,
        "--test",
        fileURLToPath(import.meta.url),
      ],
      {
        env: { ...process.env, HORTUS_TEST_SCOPE: "1", NODE_TEST_CONTEXT: undefined },
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /# skipped 0/, r.stdout);
  });
} else {
  suite();
}

function suite(): void {
  // Under $HOME, not /tmp: as an installed copy is, so the owner's tree and the sandbox's walks look the same.
  const root = mkdtempSync(join(homedir(), ".hortus-f4-test-"));
  const H = join(root, "home");
  process.env.HORTUS_HOME = H;
  process.env.HORTUS_NO_NET = "1";

  const secret = join(root, "secret");
  const config = Config.parse({ policy: { deny: [join(root, "denylink")] } });
  const files: Record<string, string> = {
    "vault.json": "{}",
    "hortusd.json": "{}",
    "tasks/O/ctl/task.json": "{}",
    "tasks/T/ctl/task.json": "{}",
    "tasks/T/out/.keep": "",
    "dof/slack/C1/channel.md": "# C1\n",
    "dof/slack.git/HEAD": "ref: refs/heads/main\n",
    "dof/github/o/r/issues/1.md": "out of scope\n",
    "dof/slack2/C1/channel.md": "a prefix of slack's name, out of scope\n",
    "clones/T/README": "x",
  };
  before(() => {
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(H, p, ".."), { recursive: true });
      writeFileSync(join(H, p), body);
    }
    mkdirSync(secret);
    writeFileSync(join(secret, "f"), "s");
    symlinkSync(secret, join(root, "denylink"));
    // a link inside a readable DOF is followed to its target, which Landlock checks on its own path
    symlinkSync("../../slack2/C1/channel.md", join(H, "dof/slack/C1/peek.md"));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  interface Ran {
    code: number | null;
    out: string;
    err: string;
  }
  /** Run `sh -c script` under the shim with `prof` on fd 3. */
  function shimRun(prof: string, script: string, args: string[] = ["sh", "-c", script]): Promise<Ran> {
    return new Promise((resolve) => {
      const c = spawn(shim.path, args, { cwd: "/", stdio: ["ignore", "pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      c.stdout?.on("data", (d) => {
        out += d;
      });
      c.stderr?.on("data", (d) => {
        err += d;
      });
      (c.stdio[3] as Writable).on("error", () => {}).end(prof);
      c.on("close", (code) => resolve({ code, out, err }));
    });
  }
  const shimSh = (prof: string, script: string) => shimRun(prof, script, ["--", "sh", "-c", script]);
  const task = { id: "T", clone: join(H, "clones/T"), dofs: ["slack"] };
  const denied = (r: Ran) => assert.match(r.err, /Permission denied|Operation not permitted/, r.err);
  const ok = (r: Ran) => assert.equal(r.code, 0, r.err);

  describe("shim", () => {
    test("reports the ABI", async () => assert.ok((await abi()) >= 1));
    test("refuses an unknown directive, a missing --, a truncated or oversize profile", async () => {
      assert.equal((await shimSh("bogus /x\nend\n", "true")).code, 64);
      assert.equal((await shimRun("end\n", "", ["sh", "-c", "true"])).code, 64);
      assert.equal((await shimSh("ro /usr\n", "true")).code, 64); // fd 3 closed early: no `end`
      assert.equal((await shimSh(`${"ro /usr\n".repeat(140_000)}end\n`, "true")).code, 64);
      assert.equal((await shimSh(`ro /${"a".repeat(5000)}\nend\n`, "true")).code, 64);
    });
    test("no ro/rw line: everything denied, exec fails", async () => {
      const r = await shimSh("end\n", "true");
      assert.equal(r.code, 67);
      assert.match(r.err, /exec failed: sh \(Permission denied\)/);
    });
  });

  describe("profile", () => {
    test("no path under a denied directory except carve-outs; every path exists", () => {
      const deny = denySet(config);
      const carve = ["dof/slack", "dof/slack.git", "repos", "tasks/T/ctl", "tasks/T/out", "clones/T"].map((p) =>
        join(H, p),
      );
      for (const kind of ["unattended", "chat"] as const) {
        const lines = profile(kind, task, config).trim().split("\n");
        assert.equal(lines.at(-1), "end");
        for (const l of lines.filter((l) => /^r[ow] /.test(l))) {
          const p = l.slice(3);
          const real = realpathSync(p);
          const inCarve = carve.some((c) => real === c || real.startsWith(`${c}/`));
          assert.ok(inCarve || !deny.some((d) => real === d || real.startsWith(`${d}/`)), `${kind}: ${l}`);
        }
      }
    });
    test("carve-out modes; chat has no ro lines except read-only carve-outs", () => {
      const u = profile("unattended", task, config).split("\n");
      assert.ok(u.includes(`ro ${join(H, "dof/slack")}`) && u.includes(`ro ${join(H, "dof/slack.git")}`));
      assert.ok(!u.some((l) => l.startsWith(`ro ${join(H, "dof/github")}`) || l === `ro ${join(H, "dof")}`));
      assert.ok(u.includes(`rw ${join(H, "tasks/T/out")}`));
      assert.ok(u.includes("scope signal") && u.includes("scope abstract"));
      const ro = profile("chat", task, config)
        .split("\n")
        .filter((l) => l.startsWith("ro "));
      const own = readOnlySet()
        .filter((p) => existsSync(p))
        .map((p) => `ro ${p}`);
      // no repos/ in this home; hortusd's own code and the user units are read-only too
      const dofs = [`ro ${join(H, "dof/slack")}`, `ro ${join(H, "dof/slack.git")}`];
      assert.deepEqual(ro.sort(), [...dofs, `ro ${join(H, "tasks/T/ctl")}`, ...own].sort());
    });
    test("a policy.deny symlink is denied by its target", () => {
      assert.ok(denySet(config).includes(secret));
      assert.ok(!profile("chat", task, config).includes(secret));
    });
  });

  describe("unattended domain", () => {
    const prof = () => profile("unattended", task, config);
    test("denied: vault.json, hortusd.json, other tasks, ~/x", async () => {
      denied(await shimSh(prof(), `cat ${H}/vault.json`));
      denied(await shimSh(prof(), `cat ${H}/hortusd.json`));
      denied(await shimSh(prof(), `ls ${H}/tasks/O`));
      denied(await shimSh(prof(), `touch ${homedir()}/.hortus-f4-x`));
    });
    test("allowed: dof read, out/clone write, /dev/null; /tmp is read-only unless policy.cache lists it", async () => {
      ok(await shimSh(prof(), `cat ${H}/dof/slack/C1/channel.md`));
      ok(await shimSh(prof(), `touch ${H}/tasks/T/out/x ${H}/clones/T/x`));
      denied(await shimSh(prof(), "mktemp /tmp/hortus-f4-XXXXXX"));
      const open = profile("unattended", task, Config.parse({ policy: { cache: ["/tmp"] } }));
      ok(await shimSh(open, "f=$(mktemp /tmp/hortus-f4-XXXXXX) && rm $f"));
      ok(await shimSh(prof(), "echo > /dev/null"));
      denied(await shimSh(prof(), `touch ${H}/dof/x`));
    });
    test("scope.dofs: a DOF outside it, and the DOF root, cannot be read", async () => {
      ok(await shimSh(prof(), `cat ${H}/dof/slack.git/HEAD`));
      denied(await shimSh(prof(), `cat ${H}/dof/github/o/r/issues/1.md`));
      denied(await shimSh(prof(), `ls ${H}/dof`));
      denied(await shimSh(prof(), `cat ${H}/dof/slack2/C1/channel.md`));
      denied(await shimSh(prof(), `cat ${H}/dof/slack/C1/peek.md`));
      denied(await shimSh(profile("unattended", { ...task, dofs: [] }, config), `cat ${H}/dof/slack/C1/channel.md`));
    });
    test("no connect to another process's socket under /tmp (X11, tmux, ssh-agent live there)", async () => {
      const sock = join(tmpdir(), `hortus-f4-sock-${process.pid}`);
      const server = createServer().listen(sock);
      await new Promise((r) => server.once("listening", r));
      const js = `require("net").connect(${JSON.stringify(sock)}).on("error",(e)=>{console.error(e.code);process.exit(1)}).on("connect",()=>process.exit(0))`;
      const r = await shimRun(prof(), "", ["--", process.execPath, "-e", js]);
      server.close();
      assert.equal(r.code, 1, r.err);
      assert.match(r.err, /EACCES|EPERM/);
    });
    test("nothing under the owner's home is writable, ~/.cache included (the owner runs what lies there)", async () => {
      const h = homedir();
      const rw = prof()
        .split("\n")
        .filter((l) => /^r[wn] /.test(l) && l.slice(3).startsWith(`${h}/`) && !l.slice(3).startsWith(`${root}/`));
      assert.deepEqual(rw, []);
      denied(await shimSh(prof(), `touch ${h}/.cache/hortus-f4-x`));
      // the Workers' own caches are the writable ones, under the denied HORTUS_HOME
      mkdirSync(paths.cache(), { recursive: true });
      ok(await shimSh(prof(), `touch ${paths.cache()}/x`));
    });
    test("no terminal, keyboard or screen of the owner's: of /dev, only what a program needs; a chat loses pts and input", async () => {
      const devs = prof()
        .split("\n")
        .filter((l) => l.includes(" /dev/"));
      assert.deepEqual(
        devs.sort(),
        ["full", "null", "random", "shm", "tty", "urandom", "zero"].map((d) => `rn /dev/${d}`),
      );
      denied(await shimSh(prof(), "ls /dev/pts"));
      denied(await shimSh(prof(), "exec 3<>/dev/ptmx"));
      // what this machine has: the `input` group opened these under `ro`, and reading one needs no ioctl
      for (const d of ["/dev/input/event0", "/dev/fb0", "/dev/tty2"])
        if (existsSync(d)) denied(await shimSh(prof(), `cat ${d} > /dev/null`));
      const chat = profile("chat", task, config);
      assert.ok(!chat.split("\n").some((l) => /^\w+ \/dev(\/(pts|input)(\/.*)?)?$/.test(l)));
      denied(await shimSh(chat, "ls /dev/pts"));
      denied(await shimSh(chat, "ls /dev/input"));
      ok(await shimSh(chat, "echo > /dev/null"));
      // /dev/stdout and the rest are links to the shim's own fds, which no rule names and none needs
      for (const p of [prof(), chat])
        ok(await shimSh(p, "echo x | cat /dev/stdin && echo y | cat /dev/fd/0 && ls /dev/fd/"));
      // with hortusd's own stdout on a file /dev/stdout resolves here, and the shim's (a pipe) is what a rule would name
      const file = join(root, "stdout-file");
      const fd = openSync(file, "w");
      const landlock = new URL("./landlock.js", import.meta.url).href;
      const js = `import(${JSON.stringify(landlock)}).then((l) => process.stdout.write(l.profile("unattended", ${JSON.stringify(task)}, { policy: {} })))`;
      spawnSync(process.execPath, ["-e", js], { stdio: ["ignore", fd, "inherit"] });
      closeSync(fd);
      assert.match(readFileSync(file, "utf8"), /^rn \/dev\/null$/m);
      assert.ok(!readFileSync(file, "utf8").includes("/dev/stdout"));
    });
    test("$HOME: only what is listed, however the store is named; a project's checkout only for its own task", async () => {
      const fx = join(root, "fx-home");
      const homeNow = process.env.HOME;
      const plant = (p: string, body = "s", mode = 0o644) => {
        mkdirSync(join(p, ".."), { recursive: true });
        writeFileSync(p, body, { mode });
      };
      const own = join(fx, "work/a");
      const other = join(fx, "work/b");
      plant(join(fx, ".claude/.credentials.json"));
      plant(join(fx, "nobody-listed-this/key"));
      plant(join(fx, ".gitconfig"));
      plant(join(fx, ".local/share/keys/x"));
      plant(join(fx, ".config/systemd/user/x.service")); // read-only for a chat, hidden here: a unit can hold a key
      plant(join(own, ".env"));
      plant(join(other, ".env"));
      plant(join(fx, ".nvm/versions/bin/tool"), "#!/bin/sh\necho tool\n", 0o755);
      plant(join(fx, "apps/foo"), "#!/bin/sh\necho foo\n", 0o755);
      mkdirSync(join(fx, ".local/bin"));
      symlinkSync("../../.nvm/versions/bin/tool", join(fx, ".local/bin/tool"));
      symlinkSync("../../apps/foo", join(fx, ".local/bin/foo"));
      // a project outside any home, and in a tree the walk from / would otherwise grant whole
      const outside = "/usr/share/zoneinfo";
      const projects = { a: { path: own }, b: { path: other }, c: { path: outside } };
      const asFixture = (policy: { read?: string[] }) => {
        const real = process.env.HOME;
        process.env.HOME = fx;
        try {
          return profile(
            "unattended",
            { ...task, project: "a" },
            { policy: policy as Config["policy"], projects: projects as unknown as Config["projects"] },
          );
        } finally {
          process.env.HOME = real;
        }
      };
      const p = asFixture({});
      denied(await shimSh(p, `cat ${fx}/.claude/.credentials.json`));
      denied(await shimSh(p, `cat ${fx}/nobody-listed-this/key`));
      denied(await shimSh(p, `cat ${fx}/.gitconfig`));
      denied(await shimSh(p, `cat ${fx}/.local/share/keys/x`));
      denied(await shimSh(p, `cat ${fx}/.config/systemd/user/x.service`));
      denied(await shimSh(p, `cat ${other}/.env`));
      denied(await shimSh(p, `cat ${outside}/UTC`));
      denied(await shimSh(p, `ls ${fx}`));
      plant(join(fx, "made-later/key"));
      denied(await shimSh(p, `cat ${fx}/made-later/key`));
      ok(await shimSh(p, `cat ${own}/.env`)); // --reference reads it; hortusd cloned from it
      denied(await shimSh(p, `touch ${own}/x`));
      assert.equal((await shimSh(p, `${fx}/.nvm/versions/bin/tool`)).out, "tool\n");
      assert.equal((await shimSh(p, `${fx}/.local/bin/tool`)).out, "tool\n"); // a link between two listed places
      denied(await shimSh(p, `${fx}/.local/bin/foo`)); // out of them: the target is what is checked
      assert.equal((await shimSh(asFixture({ read: [join(fx, "apps")] }), `${fx}/.local/bin/foo`)).out, "foo\n");
      // policy.read shows a tree, less what is denied inside it, and never another project
      const wide = asFixture({ read: [join(fx, "work")] });
      ok(await shimSh(wide, `cat ${own}/.env`));
      denied(await shimSh(wide, `cat ${other}/.env`));
      // a home outside /home (/var/home/me, /root) is hidden for being $HOME, not by HIDDEN
      process.env.HOME = outside;
      const elsewhere = profile("unattended", task, config);
      process.env.HOME = homeNow;
      denied(await shimSh(elsewhere, `cat ${outside}/UTC`));
      // nothing of the task's own runs off the list: the agent starts from a package and node outside it
      ok(await shimSh(p, `${process.execPath} -e 0`));
    });
    test("the owner's data outside $HOME is hidden: /tmp, disks, the journal, core dumps", async () => {
      for (const d of ["/tmp", "/mnt", "/srv", "/var/log", "/var/tmp", "/var/lib/systemd/coredump", "/sys/firmware"])
        if (existsSync(d)) denied(await shimSh(prof(), `ls ${d}`));
      ok(await shimSh(prof(), "ls /usr/bin /etc > /dev/null"));
      const walked = profile("unattended", task, Config.parse({ policy: { cache: ["/tmp"] } }));
      ok(await shimSh(walked, "ls /tmp > /dev/null"));
    });
    test("an unattended session's HOME is its own: hidden dotfiles read as absent", async () => {
      const out = join(root, "home-out");
      mkdirSync(join(out, "work"), { recursive: true });
      const env = caches(out);
      assert.equal(env.HOME, join(out, "work/.cache/home"));
      assert.equal(env.RUSTUP_HOME, join(homedir(), ".rustup"));
      assert.match(env.JAVA_TOOL_OPTIONS ?? "", /-Duser\.home=.*\.cache\/home/);
      const r = await shimRun(`rw ${out}\n${prof()}`, "", [
        "--",
        "env",
        `HOME=${env.HOME}`,
        "sh",
        "-c",
        "git config --global a.b c && git config --global a.b && test -w ~",
      ]);
      assert.equal(r.out, "c\n", r.err);
      assert.equal(r.err, "");
    });
    test("a session's PATH has what the owner installed under $HOME, hortusd's own does not", () => {
      const task2 = { id: "T", scope: { credentials: [] } } as unknown as TaskJson;
      const dirs = (sandboxEnv(task2).PATH ?? "").split(":");
      for (const d of [".local/bin", ".cargo/bin", "go/bin"]) assert.ok(dirs.includes(join(homedir(), d)), d);
      assert.ok(dirs.includes(join(process.execPath, "..")));
      assert.equal(sandboxEnv(task2).GIT_EDITOR, "true"); // no terminal: an editor would wait for good
    });
    test("a chat's Maven: the owner's repository when there is one, else the task's, which it can create", () => {
      const task2 = { id: "T", scope: { credentials: [] } } as unknown as TaskJson;
      const fx = join(root, "m2-home");
      const real = process.env.HOME;
      process.env.HOME = fx;
      try {
        assert.match(
          sandboxEnv(task2).MAVEN_OPTS ?? "",
          /maven\.repo\.local=.*tasks\/T\/out\/work\/\.cache\/\.m2\/repository/,
        );
        mkdirSync(join(fx, ".m2/repository"), { recursive: true });
        assert.ok(sandboxEnv(task2).MAVEN_OPTS?.includes(`maven.repo.local=${join(fx, ".m2/repository")}`));
      } finally {
        process.env.HOME = real;
      }
    });
    test("caches: task-local tool homes, shared caches linked, never through a planted link", () => {
      const out = join(root, "cache-out");
      mkdirSync(join(out, "work"), { recursive: true });
      const env = caches(out);
      assert.equal(env.CARGO_HOME, join(out, "work/.cache/cargo"));
      assert.ok(existsSync(join(out, "work/.cache/gradle")));
      assert.equal(env.npm_config_cache, join(out, "work/.cache/npm"));
      assert.equal(env.XDG_RUNTIME_DIR, join(out, "tmp"));
      assert.equal(env.XDG_CACHE_HOME, join(H, "cache/xdg"));
      assert.equal(env.GOMODCACHE, join(H, "cache/go"));
      assert.equal(env.MAVEN_OPTS, `-Duser.home=${join(out, "work/.cache")} -Dmaven.repo.local=${join(H, "cache/m2")}`);
      assert.equal(
        realpathSync(join(out, "work/.cache/cargo/registry")),
        realpathSync(join(H, "cache/cargo/registry")),
      );
      // the tools' plain-file tokens stay out of reach
      for (const p of [".npmrc", ".config/gh", ".config/glab-cli", ".m2/settings.xml"])
        assert.ok(denySet(config).includes(join(homedir(), p)), p);
      const evil = join(root, "cache-evil");
      mkdirSync(evil);
      rmSync(out, { recursive: true });
      mkdirSync(out);
      symlinkSync(evil, join(out, "work"));
      caches(out);
      assert.deepEqual(readdirSync(evil), []);
      rmSync(out, { recursive: true });
      mkdirSync(out);
      rmSync(join(H, "cache/gradle"), { recursive: true });
      symlinkSync(evil, join(H, "cache/gradle")); // a Worker's, in the shared cache
      caches(out);
      assert.deepEqual(readdirSync(evil), []);
      rmSync(join(H, "cache/gradle"));
    });
    test("a link planted in a writable tree never extends the next session's write access (/tmp/x → ~/.bashrc)", async () => {
      // a deny path inside the writable tree makes the builder walk it entry by entry, as HORTUS_HOME under /tmp does
      const tree = join(root, "rwtree");
      const victim = join(root, "victim");
      mkdirSync(join(tree, "secret"), { recursive: true });
      mkdirSync(victim);
      writeFileSync(join(tree, "y"), "");
      symlinkSync(victim, join(tree, "link"));
      const c = Config.parse({ policy: { deny: [join(tree, "secret")], cache: [tree] } });
      const p = profile("unattended", task, c);
      assert.ok(!p.split("\n").includes(`rn ${tree}/link`));
      denied(await shimSh(p, `touch ${tree}/link/x`));
      denied(await shimSh(p, `touch ${victim}/x`));
      ok(await shimSh(p, `echo >> ${tree}/y`));
    });
    test("a file created in a denied directory after spawn stays unreachable", async () => {
      const p = shimSh(prof(), `sleep 0.3; cat ${H}/late.txt`);
      writeFileSync(join(H, "late.txt"), "x");
      denied(await p);
    });
  });

  describe("chat domain", () => {
    const prof = () => profile("chat", task, config);
    test("rw beneath home entries, the deny set still closed", async () => {
      const cache = join(homedir(), ".cache");
      ok(await shimSh(prof(), `mkdir -p ${cache} && f=$(mktemp ${cache}/hortus-f4-XXXXXX) && rm $f`));
      denied(await shimSh(prof(), `cat ${homedir()}/.ssh/id_ed25519 > /dev/null`));
      denied(await shimSh(prof(), `cat ${homedir()}/.hortus/secrets.json > /dev/null`));
      denied(await shimSh(prof(), `cat ${H}/vault.json`));
      denied(await shimSh(prof(), `cat ${secret}/f`));
      for (const p of [".claude", ".claude.json", ".codex", ".gemini", ".config/Code", ".bash_history"])
        assert.ok(denySet(config).includes(join(realpathSync(homedir()), p)), p);
      // opens the shim for writing without changing it (a shim running elsewhere makes the kernel say ETXTBSY first)
      const w = await shimSh(prof(), `: >> ${fileURLToPath(new URL("../hortus-landlock", import.meta.url))}`);
      assert.match(w.err, /Permission denied|Text file busy/, w.err);
      ok(await shimSh(prof(), `test -r ${fileURLToPath(new URL("../hortus-landlock", import.meta.url))}`));
    });
  });

  describe("scoping", () => {
    test("no signal to the parent, no abstract socket", async () => {
      const prof = profile("chat", task, config);
      denied(await shimSh(prof, `kill -0 ${process.pid}`));
      const name = `\0hortus-f4-test-${process.pid}`;
      const server = createServer().listen(name);
      const js = `require("net").connect(${JSON.stringify(name)}).on("error",(e)=>{console.error(e.code);process.exit(1)}).on("connect",()=>process.exit(0))`;
      const r = await shimRun(prof, "", ["--", process.execPath, "-e", js]);
      server.close();
      assert.equal(r.code, 1);
      assert.match(r.err, /EPERM/);
    });
  });

  describe("cgroup", { skip: !inScope && "no delegated cgroup (systemd-run --user)" }, () => {
    test("the shim joins it; the domain cannot write to /sys/fs/cgroup", async () => {
      const cg = await cgroup.create("C1");
      const prof = profile("unattended", { ...task, cgroup: cg }, config);
      const r = await shimSh(prof, `cat /proc/self/cgroup; echo $$ > ${cgroup.base()}/cgroup.procs`);
      assert.ok(r.out.includes(`0::/${cgroup.relative(cg)}\n`), r.out);
      denied(r);
      await cgroup.kill("C1");
    });
    test("cgroup.kill ends a child and its forked grandchild", async () => {
      const cg = await cgroup.create("C2");
      const prof = profile("unattended", { ...task, cgroup: cg }, config);
      const run = shimSh(prof, "sleep 1000 & sleep 1000");
      for (let i = 0; i < 50 && (await cgroup.pids("C2")).length < 2; i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok((await cgroup.pids("C2")).length >= 2);
      await cgroup.kill("C2");
      assert.equal((await run).code, null);
      assert.deepEqual(await cgroup.pids("C2"), []);
    });
    test("depth and relative path for nftables", () => {
      assert.equal(cgroup.depth("/sys/fs/cgroup/a/b c/d"), 3);
      assert.equal(cgroup.relative("/sys/fs/cgroup/a/b c"), "a/b c");
    });
    test("spawnSandboxed: stdout lines, stderr to console.log, cleanup; kill()", async () => {
      const lines: string[] = [];
      const t = {
        id: "T",
        kind: "unattended",
        scope: { credentials: ["github"], repos: [] },
        paths: { dof: join(H, "dof"), work: join(H, "tasks/T/out/work"), clone: join(H, "clones/T") },
      } as unknown as TaskJson;
      const env = sandboxEnv(t);
      assert.equal(env.GH_TOKEN, "hortus-secret-github");
      assert.equal(env.TERM, "dumb");
      assert.match(env.GLAB_CONFIG_DIR ?? "", /\/work\/.cache\/glab$/);
      const at = Object.values(env).indexOf("lfs.locksverify");
      assert.equal(Object.values(env)[at + 1], "false", "git-lfs asks for no locks before a push");
      const c = await spawnSandboxed({
        task: t,
        kind: "unattended",
        cmd: ["sh", "-c", "echo one; echo two; echo oops >&2; cat $HORTUS_HOME/vault.json"],
        cwd: join(H, "clones/T"),
        env: { HORTUS_HOME: H },
        config,
        onStdout: (l) => lines.push(l),
      });
      const exit = await c.wait();
      assert.deepEqual(lines, ["one", "two"]);
      assert.equal(exit.code, 1);
      assert.match(readFileSync(join(paths.out("T"), "console.log"), "utf8"), /oops\n.*Permission denied/s);
      assert.ok(!existsSync(cgroup.path("T")));

      const k = await spawnSandboxed({
        task: t,
        kind: "unattended",
        cmd: ["sleep", "1000"],
        cwd: "/",
        config,
        onStdout() {},
      });
      // killed before the shim joined, the shim finds its cgroup gone and exits on its own (code, not signal)
      for (let i = 0; i < 100 && (await cgroup.pids("T")).length === 0; i++)
        await new Promise((r) => setTimeout(r, 20));
      await k.kill();
      assert.equal((await k.wait()).signal, "SIGKILL");
      assert.ok(!existsSync(cgroup.path("T")));
    });
    test("one task leaves nothing for another: core's bash overflow lands in out/tmp, and /tmp takes no file", async () => {
      const task = (id: string, dofs: string[]) =>
        ({
          id,
          kind: "unattended",
          scope: { credentials: [], repos: [], dofs },
          paths: { dof: join(H, "dof"), work: join(H, `tasks/${id}/out`) },
        }) as unknown as TaskJson;
      const run = async (id: string, dofs: string[], cmd: string[]) => {
        const lines: string[] = [];
        const c = await spawnSandboxed({
          task: task(id, dofs),
          kind: "unattended",
          cmd,
          cwd: paths.out(id),
          config,
          onStdout: (l) => lines.push(l),
        });
        return { code: (await c.wait()).code, out: lines.join("\n") };
      };
      // the real tool, as a Worker scoped to the DOF calls it: the whole output goes to a temp file past the limit
      const tools = fileURLToPath(new URL("../../node_modules/@hortus/core/dist/tools.js", import.meta.url));
      const body = `const { bashTool } = await import(${JSON.stringify(tools)});
        console.log(await bashTool.execute({ command: "cat ${join(H, "dof/slack/C1/channel.md")}; seq 1 20000" }));`;
      const a = await run("LA", ["slack"], [process.execPath, "--input-type=module", "-e", body]);
      const file = /Full output: (.+?)\]/.exec(a.out)?.[1];
      assert.ok(file, a.out);
      assert.equal(file.startsWith(join(paths.out("LA"), "tmp/")), true, file);
      assert.match(readFileSync(file, "utf8"), /^# C1\n/);
      const b = await run("LB", [], ["sh", "-c", `cat '${file}'; touch /tmp/hortus-f4-left-$$ && echo wrote`]);
      assert.equal(b.out, "");
      // close removes tasks/<id>, and the copy with it: nothing to find afterwards
      assert.equal(file.startsWith(paths.task("LA")), true);
    });
    test("what ignores TMPDIR and XDG_CACHE_HOME still writes: go's GOPATH, the JVM's temp, uv's tools", async () => {
      const t = {
        id: "TOOLS",
        kind: "unattended",
        scope: { credentials: [], repos: [] },
        paths: { dof: join(H, "dof"), work: join(H, "tasks/TOOLS/out/work") },
      } as unknown as TaskJson;
      const out = paths.out("TOOLS");
      mkdirSync(out, { recursive: true });
      writeFileSync(
        join(out, "Tmp.java"),
        'class Tmp { public static void main(String[] a) throws Exception { System.out.println(java.io.File.createTempFile("abc", null)); } }',
      );
      const lines: string[] = [];
      const c = await spawnSandboxed({
        task: t,
        kind: "unattended",
        cmd: [
          "bash",
          "-ec",
          // the first module fetch writes GOPATH/pkg/sumdb, `go install` GOPATH/bin; a JVM has /tmp compiled in
          `if command -v go; then G=$(go env GOPATH); mkdir -p "$G/pkg/sumdb" "$G/bin"; echo "go $G"; fi
           if command -v java; then java Tmp.java; fi
           if command -v uv; then uv tool list; fi
           echo finished`,
        ],
        cwd: out,
        config,
        onStdout: (l) => lines.push(l),
      });
      const exit = await c.wait();
      assert.equal(exit.code, 0, readFileSync(join(out, "console.log"), "utf8"));
      assert.equal(lines.at(-1), "finished");
      const has = (x: string) => spawnSync("sh", ["-c", `command -v ${x}`]).status === 0;
      if (has("go")) assert.ok(lines.includes(`go ${join(out, "work/.cache/go")}`), lines.join("\n"));
      if (has("java"))
        assert.ok(
          lines.some((l) => l.startsWith(join(out, "tmp/abc"))),
          lines.join("\n"),
        );
    });
    test("no Landlock: spawnSandboxed throws with the shim's reason", async () => {
      const fake = join(root, "fake-shim");
      writeFileSync(
        fake,
        "#!/bin/sh\necho 'hortus-landlock: no Landlock in this kernel (Function not implemented)' >&2\nexit 66\n",
        {
          mode: 0o755,
        },
      );
      const real = shim.path;
      shim.path = fake;
      try {
        const t = {
          id: "N",
          kind: "unattended",
          scope: { credentials: [], repos: [] },
          paths: {},
        } as unknown as TaskJson;
        await assert.rejects(
          spawnSandboxed({ task: t, kind: "unattended", cmd: ["true"], cwd: "/", config, onStdout() {} }),
          /Landlock unavailable: hortus-landlock: no Landlock/,
        );
        assert.ok(!existsSync(cgroup.path("N")));
        shim.path = `${fake}-old`; // ABI 8 (no unix-socket rules); a new path, as abi() caches per path
        writeFileSync(shim.path, "#!/bin/sh\necho 8\n", { mode: 0o755 });
        await assert.rejects(
          spawnSandboxed({ task: t, kind: "unattended", cmd: ["true"], cwd: "/", config, onStdout() {} }),
          /Landlock ABI 8 is too old/,
        );
      } finally {
        shim.path = real;
      }
    });
  });
}
