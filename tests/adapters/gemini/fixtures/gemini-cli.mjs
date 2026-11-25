#!/usr/bin/env node
// SYNTHETIC Gemini 0.56 protocol. No network, credentials, or model calls.
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
const args = process.argv.slice(2),
  value = (flag) => {
    const literal = args.find((arg) => arg.startsWith(`${flag}=`));
    return literal
      ? literal.slice(flag.length + 1)
      : args.includes(flag)
        ? args[args.indexOf(flag) + 1]
        : undefined;
  };
if (args.includes("--version")) {
  console.log("0.56.0");
  process.exit(0);
}
if (args.includes("--help")) {
  for (const f of [
    "--prompt",
    "--model",
    "--output-format",
    "--resume",
    "--admin-policy",
    "--approval-mode",
    "--extensions",
  ])
    console.log(`  ${f}  fixture`);
  process.exit(0);
}
if (process.env.FAKE_CALLS)
  appendFileSync(
    process.env.FAKE_CALLS,
    JSON.stringify({ args, cwd: process.cwd() }) + "\n",
  );
const session = value("--resume") ?? randomUUID();
const emit = (x) => process.stdout.write(JSON.stringify(x) + "\n");
const scenario = process.env.FAKE_SCENARIO;
if (scenario === "descendant") {
  // Keep the owned leader alive until escalation; a saved PGID after leader
  // exit is not signal authority. Exited-leader ownership is proved by host 9A.
  process.on("SIGTERM", () => {});
  setTimeout(() => process.exit(0), 30_000); // Test-only failure lifeline, never credited as cleanup.
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),30000);setInterval(()=>{},1000)"],
    { stdio: "ignore" },
  );
  writeFileSync(process.env.FAKE_PID, String(child.pid));
  emit({ type: "init", session_id: session });
  setInterval(() => {}, 1000);
} else if (scenario === "large") {
  process.stdout.write("x".repeat(200_000));
} else if (scenario === "hang") {
  emit({ type: "init", session_id: session });
  setInterval(() => {}, 1000);
} else {
  emit({ type: "init", session_id: session, model: value("--model") });
  if (scenario === "write") writeFileSync(value("--prompt"), "UNSAFE");
  const text = process.env.FAKE_TEXT ?? "¡Hola!";
  emit({ type: "message", role: "assistant", content: text, delta: true });
  if (scenario !== "incomplete")
    emit({
      type: "result",
      status: "success",
      stats: { input_tokens: 8, output_tokens: 2, cached: 1 },
    });
}
