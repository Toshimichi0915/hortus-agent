/**
 * Files a Worker can write (`out/`, `schedules/<id>/`), read and written by hortusd as hostile input: never through a
 * link (a planted `out/summary.md → ~/.hortus/vault.json` or `out/console.log → ~/.bashrc`), never a FIFO or device
 * (which would block the daemon), never more than asked.
 */
import { closeSync, constants, fstatSync, openSync, readSync, rmSync, writeSync } from "node:fs";

/** `out/summary.md` (as the card stores it) */
export const MAX_SUMMARY = 64 * 1024;
/** `out/aux-tokens`: tokens of the tool-less calls (summary, handoff), which are not in any session */
export const AUX_TOKENS = "aux-tokens";
/** one `out/sessions/*.jsonl` file */
export const MAX_SESSION = 64 * 1024 * 1024;

const { O_RDONLY, O_WRONLY, O_APPEND, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = constants;

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
