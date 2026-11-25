import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(process.env.FAKE_VERSION ?? "1.5.3");
  process.exit(0);
}
if (args.includes("--help")) {
  console.error(
    [
      "--print",
      "--model",
      "--output-format",
      "--conversation",
      "--disable-slash-commands",
      "--settings",
      "--print-timeout",
    ]
      .map((flag) => `  ${flag}  fixture`)
      .join("\n"),
  );
  process.exit(0);
}
if (
  !args.some((arg) => arg.startsWith("--print=")) ||
  !args.includes("--disable-slash-commands") ||
  args.includes("--mode")
)
  process.exit(91);
if (
  JSON.parse(args[args.indexOf("--settings") + 1]).toolPermission !==
  "request-review"
)
  process.exit(92);
const scenario = process.env.FAKE_SCENARIO;
if (scenario === "stderr-auth") {
  console.error("Error: authentication required");
  console.error("PRIVATE_SECRET_TOKEN");
  process.exit(1);
}
const id = args.includes("--conversation")
  ? args[args.indexOf("--conversation") + 1]
  : "b501d899-978f-4497-a0ca-0400db2a25a2";
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
if (scenario?.startsWith("late-mutation-")) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      'process.on("SIGTERM",()=>{});setTimeout(()=>process.exit(97),30000);setTimeout(()=>require("node:fs").writeFileSync(process.argv[1],"descendant mutation"),500);setInterval(()=>{},1000)',
      process.env.FAKE_EFFECT,
    ],
    { stdio: "ignore" },
  );
  await new Promise((resolve) => child.once("spawn", resolve));
  await writeFile(process.env.FAKE_PID, String(child.pid));
  emit({
    event: "init",
    conversation_id: scenario.endsWith("session")
      ? "c501d899-978f-4497-a0ca-0400db2a25a2"
      : id,
    init: {
      model: scenario.endsWith("model")
        ? "private-native-value"
        : args[args.indexOf("--model") + 1],
      cwd: scenario.endsWith("cwd") ? "/private-native-value" : process.cwd(),
      tools: [],
      permission_mode: scenario.endsWith("permissions")
        ? "always-proceed"
        : "request-review",
    },
  });
  setTimeout(() => writeFile(process.env.FAKE_EFFECT, "parent mutation"), 400);
  setTimeout(() => process.exit(97), 30000);
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
emit({
  event: "init",
  conversation_id: id,
  init: {
    model: args[args.indexOf("--model") + 1],
    cwd: process.cwd(),
    tools: [],
    permission_mode:
      scenario === "unsafe" ? "always-proceed" : "request-review",
  },
});
if (scenario === "hang" || scenario === "descendant") {
  if (scenario === "descendant") {
    // The legacy runner owns this group only while the original leader lives.
    process.on("SIGTERM", () => {});
    const child = spawn(
      process.execPath,
      ["-e", 'process.on("SIGTERM",()=>{});setTimeout(()=>process.exit(97),30000);setInterval(()=>{},1000)'],
      { stdio: "ignore" },
    );
    await writeFile(process.env.FAKE_PID, String(child.pid));
  }
  // A fixture failure lifeline is separate from framework cleanup evidence.
  setTimeout(() => process.exit(97), 30000);
  setInterval(() => {}, 1000);
} else if (scenario === "incomplete") process.exit(0);
else if (scenario === "large") process.stdout.write("x".repeat(100000));
else if (scenario === "oversized-frame")
  emit({ event: "future", payload: "x".repeat(1100000) });
else if (scenario === "invalid-utf8")
  process.stdout.write(Buffer.from([0xc3, 0x28]));
else if (scenario === "frames")
  for (let i = 0; i < 3000; i++) emit({ event: "future", i });
else {
  if (process.env.FAKE_ARGS)
    await writeFile(process.env.FAKE_ARGS, JSON.stringify(args));
  let text = "¡Hola!\n";
  if (process.env.FAKE_MEMORY) {
    if (args.includes("--conversation"))
      text = await readFile(process.env.FAKE_MEMORY, "utf8");
    else {
      text = args.find((arg) => arg.startsWith("--print=")).slice(8);
      await writeFile(process.env.FAKE_MEMORY, text);
    }
  }
  const bytes = Buffer.from(
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: id,
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        text_delta: text,
      },
    }) + "\n",
  );
  for (let i = 0; i < bytes.length; i++)
    process.stdout.write(bytes.subarray(i, i + 1));
  emit({
    event: "result",
    result: {
      conversation_id: id,
      status: "SUCCESS",
      response: text,
      num_turns: args.includes("--conversation") ? 2 : 1,
      usage: { input_tokens: 100, output_tokens: 5 },
    },
  });
}
