/**
 * The browser's end of `/events`: one EventSource for the page, whatever subscribes (each open stream holds one of a
 * browser's six connections), carrying the one chat that has a listener. It runs in web/ and imports nothing of node's.
 *
 * Whatever was emitted while no stream was open is lost, so after a gap every topic fires once and its pages reload.
 * A chat resumes by itself: the browser sends `Last-Event-ID` on its own retries, and `?after=` covers the reopen, for
 * the stream the browser gives up on (a non-200, as Vite's proxy answers with the daemon down).
 */

const CLOSED = 2; // EventSource.CLOSED; node has no EventSource to read it from

/**
 * `(topics) => release`: holds the stream open for `topics` (`tasks`, `approvals`, `settings`, `chat:<id>`), which fire
 * as events on `bus`. Holders of one render settle before the URL is looked at, so a chat page's mount opens one stream.
 */
export function liveStream(
  bus: EventTarget,
  open: (url: string) => EventSource,
  onDown: (down: boolean) => void,
  retryMs = 3000,
): (topics: string[]) => () => void {
  const held = new Map<string, number>();
  const fire = (topic: string) => bus.dispatchEvent(new Event(topic));
  let source: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let task: string | undefined;
  let last = -1;
  let missed = false;

  const stop = () => {
    clearTimeout(retry);
    source?.close();
    source = undefined;
  };

  const connect = () => {
    stop();
    const chat = task === undefined ? "" : `,chat?task=${encodeURIComponent(task)}${last < 0 ? "" : `&after=${last}`}`;
    const s = open(`/events/tasks,approvals,settings${chat}`);
    source = s;
    s.onopen = () => {
      onDown(false);
      if (missed) for (const t of held.keys()) fire(t);
      missed = false;
    };
    s.onerror = () => {
      missed = true;
      onDown(true);
      if (s.readyState === CLOSED) retry = setTimeout(connect, retryMs);
    };
    s.onmessage = (e) => {
      last = Number(e.lastEventId);
      fire(`chat:${task}`);
    };
    for (const t of ["tasks", "approvals", "settings"]) s.addEventListener(t, () => fire(t));
  };

  const sync = () => {
    if (!held.size) return stop();
    const next = [...held.keys()].find((t) => t.startsWith("chat:"))?.slice("chat:".length);
    if (source && next === task) return;
    if (next !== task) last = -1;
    if (source) missed = true;
    task = next;
    connect();
  };

  return (topics) => {
    const hold = (by: number) => {
      for (const t of topics) {
        const n = (held.get(t) ?? 0) + by;
        if (n) held.set(t, n);
        else held.delete(t);
      }
      queueMicrotask(sync);
    };
    hold(1);
    return () => hold(-1);
  };
}
