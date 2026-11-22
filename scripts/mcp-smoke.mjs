// MCP stdio smoke: starts `<cmd...> mcp`, performs initialize + tools/list and
// asserts every stdout line is JSON-RPC and the 4 tunnel tools are offered.
// Usage: node scripts/mcp-smoke.mjs <command> [args...]
import { spawn } from "node:child_process";

const [cmd, ...args] = process.argv.slice(2);
const child = spawn(cmd, [...args, "mcp"], { stdio: ["pipe", "pipe", "inherit"] });
const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
let buf = "";
const lines = [];
const timer = setTimeout(() => { console.error("timeout waiting for tools/list"); child.kill(); process.exit(1); }, 30_000);

child.stdout.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { console.error(`non-JSON on stdout: ${line}`); process.exit(1); }
    lines.push(msg);
    if (msg.id === 1) {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    }
    if (msg.id === 2) {
      const names = (msg.result?.tools ?? []).map((t) => t.name).sort();
      const want = ["tunnel_down", "tunnel_list", "tunnel_logs", "tunnel_up"];
      clearTimeout(timer);
      child.stdin.end(); // client disconnect → server should exit on its own
      if (JSON.stringify(names) !== JSON.stringify(want)) { console.error(`tools: ${names}`); process.exit(1); }
      console.log(`mcp:             ok (${names.join(", ")})`);
    }
  }
});
child.on("exit", (code) => {
  if (!lines.some((m) => m.id === 2)) { console.error(`server exited early (${code})`); process.exit(1); }
  // stdin closed by us → the server must shut itself down cleanly.
  if (code !== 0) { console.error(`server exit code ${code} after client disconnect`); process.exit(1); }
  console.log("mcp shutdown:    ok (exit 0 on client disconnect)");
});

send({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
});
