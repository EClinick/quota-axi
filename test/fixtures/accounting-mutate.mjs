// Loaded before the denial preload only for the two synthetic mutation cases.
// Captured writers are private to this module and restricted to one fixture.
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const target = path.join(
  fs.realpathSync(process.env.ACCOUNTING_TEST_ROOT),
  "projects",
  "mutating.jsonl",
);
const original = fs.readFileSync(target, "utf8");
const openSync = fs.openSync.bind(fs);
const writeSync = fs.writeSync.bind(fs);
const closeSync = fs.closeSync.bind(fs);
const utimes = fs.utimesSync.bind(fs);
const open = fs.promises.open.bind(fs.promises);
const mode = process.env.ACCOUNTING_TEST_MUTATION;
if (mode !== "append" && mode !== "rewrite")
  throw new Error("invalid mutation");
let changed = false;
fs.promises.open = async function (value, ...args) {
  const handle = await open(value, ...args);
  if (path.resolve(String(value)) !== target) return handle;
  const initial = await handle.stat();
  const read = handle.read.bind(handle);
  handle.read = async function (...readArgs) {
    const result = await read(...readArgs);
    if (!changed && result.bytesRead) {
      changed = true;
      const fd = openSync(target, mode === "append" ? "a" : "w");
      try {
        const row = JSON.parse(original);
        row.message.usage.output_tokens = 20;
        writeSync(
          fd,
          mode === "append" ? original : JSON.stringify(row) + "\n",
        );
      } finally {
        closeSync(fd);
      }
      // Make same-size rewrite detection independent of filesystem clock resolution.
      utimes(target, initial.atime, new Date(initial.mtimeMs + 10000));
    }
    return result;
  };
  return handle;
};
syncBuiltinESMExports();
