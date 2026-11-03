/** Test-only crash points: `HORTUS_TEST_CRASH_AT=<name>` SIGKILLs the process when it reaches `crashPoint(name)`. */
export function crashPoint(name: string): void {
  if (process.env.HORTUS_TEST_CRASH_AT === name) process.kill(process.pid, "SIGKILL");
}
