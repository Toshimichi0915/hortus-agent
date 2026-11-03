/** `hortus image build [--no-browser]`: scripts/build-image.sh under sudo, for this HORTUS_HOME. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as paths from "../paths.ts";

const SCRIPT = fileURLToPath(new URL("../../scripts/build-image.sh", import.meta.url));

export async function imageBuild(args: string[]): Promise<void> {
  if (args[0] !== "build" || args.slice(1).some((a) => a !== "--no-browser"))
    throw new Error("usage: hortus image build [--no-browser]");
  const child = spawn("sudo", [`HORTUS_HOME=${paths.home()}`, "sh", SCRIPT, ...args.slice(1)], { stdio: "inherit" });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (code !== 0) throw new Error(`image build failed (exit ${code})`);
}
