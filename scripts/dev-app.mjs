import { spawn } from "node:child_process";

const node = process.execPath;
const children = [
  spawn(node, ["--disable-warning=ExperimentalWarning", "local-service/server.mjs"], { stdio: "inherit" }),
  spawn(node, ["scripts/run-framework.mjs", "dev"], { stdio: "inherit" }),
];

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(exitCode), 300).unref();
}

for (const child of children) {
  child.on("exit", (code) => {
    if (!stopping && code && code !== 0) stop(code);
  });
  child.on("error", (error) => {
    console.error(error);
    stop(1);
  });
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
