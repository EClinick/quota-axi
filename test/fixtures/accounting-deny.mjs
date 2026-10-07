// Executable-boundary tripwires. A forbidden operation exits even if production
// catches exceptions; an empty stderr alone cannot hide a swallowed denial.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import dns from "node:dns";
const deny = () => {
  process.stderr.write("ACCOUNTING_FORBIDDEN_IO\n");
  process.exit(91);
};
const root = fs.realpathSync(process.env.ACCOUNTING_TEST_ROOT);
const code = fs.realpathSync(process.cwd());
function guard(value) {
  if (typeof value === "number") return;
  const target = path.resolve(
    value instanceof URL ? fileURLToPath(value) : String(value),
  );
  if (
    !target.startsWith(root + path.sep) &&
    !target.startsWith(code + path.sep) &&
    target !== root &&
    target !== code
  )
    deny();
  if (
    /(?:^|[/\\])(?:auth\.json|\.credentials\.json|credentials\.json|config\.json|settings\.json|auth\.jsonl)$/.test(
      target,
    )
  )
    deny();
}
function guardOpenFlags(flags = "r") {
  if (typeof flags === "string") {
    if (!["r", "rs", "sr"].includes(flags)) deny();
  } else if (
    typeof flags !== "number" ||
    flags &
      (fs.constants.O_WRONLY |
        fs.constants.O_RDWR |
        fs.constants.O_CREAT |
        fs.constants.O_TRUNC |
        fs.constants.O_APPEND)
  )
    deny();
}
for (const owner of [fs, fs.promises]) {
  for (const name of [
    "open",
    "openSync",
    "readFile",
    "readFileSync",
    "createReadStream",
    "opendir",
    "readdir",
    "readdirSync",
  ]) {
    if (!owner[name]) continue;
    const original = owner[name];
    owner[name] = function (value, ...args) {
      guard(value);
      if (name === "open" || name === "openSync") guardOpenFlags(args[0]);
      else if (name === "createReadStream") guardOpenFlags(args[0]?.flags);
      else if (name === "readFile" || name === "readFileSync")
        guardOpenFlags(args[0]?.flag);
      return original.call(this, value, ...args);
    };
  }
  for (const name of [
    "writeFile",
    "writeFileSync",
    "appendFile",
    "appendFileSync",
    "mkdir",
    "mkdirSync",
    "unlink",
    "unlinkSync",
    "rename",
    "renameSync",
    "createWriteStream",
  ])
    if (owner[name]) owner[name] = deny;
}
for (const owner of [childProcess, http, https, net, tls, dgram, dns]) {
  for (const name of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
    "request",
    "get",
    "connect",
    "createConnection",
    "createSocket",
    "lookup",
    "resolve",
  ])
    if (owner[name]) owner[name] = deny;
}
net.Socket.prototype.connect = deny;
globalThis.fetch = deny;
syncBuiltinESMExports();
