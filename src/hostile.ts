/**
 * Files a Worker can write (`out/`, `schedules/<id>/`), read and written by hortusd as hostile input: never through a
 * link (a planted `out/summary.md → ~/.hortus/vault.json` or `out/console.log → ~/.bashrc`), never a FIFO or device
 * (which would block the daemon), never more than asked.
 */
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, rmSync, writeSync } from "node:fs";
import type { Readable } from "node:stream";
import { logger } from "./log.ts";

const log = logger("hostile");

/** `out/summary.md` (as the card stores it) */
export const MAX_SUMMARY = 64 * 1024;
/** `out/aux-tokens`: tokens of the tool-less calls (summary, handoff), which are not in any session */
export const AUX_TOKENS = "aux-tokens";
export const AUX_USD = "aux-usd";
/** one `out/sessions/*.jsonl` file */
export const MAX_SESSION = 64 * 1024 * 1024;
/** all of a task's `out/sessions/*.jsonl` read in one pass (scan, renderSession) */
export const MAX_SESSIONS = 4 * MAX_SESSION;
/** names one `readDir` lists (`out/sessions`, `out/outbox`) */
export const MAX_ENTRIES = 1000;

const { O_RDONLY, O_WRONLY, O_APPEND, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = constants;

type Read = (name: string, max: number) => { text: string; size: number } | null;

/**
 * `fn` over the first `max` names in `dir` that pass `keep` (sorted; `dropped` counts the rest), with `read` for an
 * entry (`readCapped`). `dir` itself is opened O_NOFOLLOW and entries are reached through its fd, so a planted
 * `out/sessions → /elsewhere` is never listed or read. Null when `dir` is not a directory.
 */
export function readDir<T>(
  dir: string,
  keep: (name: string) => boolean,
  max: number,
  fn: (names: string[], read: Read, dropped: number) => T,
): T | null {
  let fd: number;
  try {
    fd = openSync(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const at = `/proc/self/fd/${fd}`;
    const names = readdirSync(at).filter(keep).sort();
    return fn(names.slice(0, max), (name, cap) => readCapped(`${at}/${name}`, cap), Math.max(0, names.length - max));
  } finally {
    closeSync(fd);
  }
}

/** At most `max` bytes (the last `max` with `tail`); null for anything but a regular file. */
export function readCapped(path: string, max: number, tail = false): { text: string; size: number } | null {
  let fd: number;
  try {
    fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const buf = Buffer.alloc(Math.min(st.size, max));
    const n = readSync(fd, buf, 0, buf.length, tail ? st.size - buf.length : 0);
    return { text: buf.subarray(0, n).toString("utf8"), size: st.size };
  } finally {
    closeSync(fd);
  }
}

/** An append fd on a regular file (created if missing); a link, FIFO or directory planted there is replaced first. */
export function openAppend(path: string): number {
  const flags = O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK;
  let fd: number | undefined;
  try {
    fd = openSync(path, flags, 0o600);
    if (fstatSync(fd).isFile()) return fd;
  } catch {}
  if (fd !== undefined) closeSync(fd);
  rmSync(path, { force: true, recursive: true });
  return openSync(path, flags | O_EXCL, 0o600);
}

/** Appends `text` through `openAppend`; errors are dropped (a log line is not worth failing a session over). */
export function appendText(path: string, text: string): void {
  try {
    const fd = openAppend(path);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
  } catch {}
}

/** one line of a session's stdout (`lines`) */
export const MAX_LINE = 4 * 1024 * 1024;

/**
 * `fn` for every line of `input` (a session's stdout), like readline but bounded: a line over `max` bytes is cut at
 * `max` and the rest of it dropped, so a Worker printing without newlines cannot grow hortusd's memory.
 */
export function lines(input: Readable, max: number, fn: (line: string) => void): void {
  let parts: Buffer[] = [];
  let n = 0;
  const flush = () => {
    const line = Buffer.concat(parts).toString("utf8");
    parts = [];
    n = 0;
    try {
      fn(line.endsWith("\r") ? line.slice(0, -1) : line);
    } catch (e) {
      // the line is the Worker's: a handler choking on it (a JSON nested a million deep) loses the line, not hortusd
      log.error("line handler failed", e);
    }
  };
  input.on("data", (c: Buffer) => {
    for (let i = 0; i < c.length; ) {
      const nl = c.indexOf(10, i);
      const end = Math.min(nl < 0 ? c.length : nl, i + max - n);
      if (end > i) {
        parts.push(c.subarray(i, end));
        n += end - i;
      }
      if (nl < 0) break;
      flush();
      i = nl + 1;
    }
  });
  input.on("end", () => n > 0 && flush());
}

/** `rmSync` that a tree a session made read-only does not stop (a test's 0555 fixture, Go's module cache under a project's
 * own GOPATH): the session's uid is hortusd's. `chmod -R` follows no link it finds on the way. */
export function rmTree(path: string): void {
  try {
    rmSync(path, { force: true, recursive: true });
  } catch {
    spawnSync("chmod", ["-R", "u+rwx", path], { stdio: "ignore" });
    rmSync(path, { force: true, recursive: true });
  }
}

/** Replaces whatever `path` is (a link, say) with a new file holding `text`. */
export function replaceFile(path: string, text: string): void {
  rmSync(path, { force: true, recursive: true });
  const fd = openSync(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}
