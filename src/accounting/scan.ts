import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { digest, mergeRecord, UsageParser } from "./normalize.js";
import type {
  AccountingOptions,
  AccountingRecord,
  AccountingResponse,
  AccountingSource,
} from "./types.js";

function concatenate(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
}

function reason(
  source: AccountingSource,
  code: string,
  truncated = false,
): void {
  if (!source.reasons.includes(code)) source.reasons.push(code);
  source.coverage = source.coverage === "error" ? "error" : "partial";
  source.replacementSafe = false;
  source.truncated ||= truncated;
}
function source(
  provider: AccountingSource["provider"],
  id: string | null,
): AccountingSource {
  const supported = provider === "codex" || provider === "claude";
  return {
    provider,
    capability: supported ? "supported" : "unsupported",
    sourceId: id,
    coverage: supported ? "complete" : "unsupported",
    replacementSafe: supported,
    truncated: false,
    reasons: supported ? [] : ["source_not_implemented"],
    files: 0,
    bytes: 0,
    lines: 0,
    evidence: { first: null, last: null },
  };
}

/** Read-only bounded snapshot. No discovery, credential adapters, or persisted cache. */
export async function collectAccounting(
  options: AccountingOptions,
): Promise<AccountingResponse> {
  const startedAt = new Date().toISOString();
  const deadline = performance.now() + options.limits.maxMs;
  const sources: AccountingSource[] = [];
  const records = new Map<string, AccountingRecord>();
  const aliases = new Set<string>();
  const roots = new Set<string>();
  let bytes = 0,
    lines = 0,
    entries = 0,
    files = 0;
  const withinBudget = (current: AccountingSource): boolean => {
    const code =
      performance.now() >= deadline
        ? "time_limit"
        : bytes >= options.limits.maxBytes
          ? "byte_limit"
          : lines >= options.limits.maxLines
            ? "line_limit"
            : files >= options.limits.maxFiles
              ? "file_limit"
              : null;
    if (code) reason(current, code, true);
    return code === null;
  };

  for (const provider of options.providers) {
    const selected = options.roots.filter((root) => root.provider === provider);
    if (provider !== "codex" && provider !== "claude") {
      sources.push(source(provider, null));
      continue;
    }
    if (!selected.length) {
      const current = source(provider, null);
      current.coverage = "error";
      reason(current, "root_not_selected");
      sources.push(current);
      continue;
    }
    for (const root of selected) {
      let canonical: string;
      try {
        canonical = await realpath(resolve(root.path));
      } catch {
        const current = source(
          provider,
          digest([provider, resolve(root.path)]),
        );
        current.coverage = "error";
        reason(current, "root_unavailable");
        sources.push(current);
        continue;
      }
      const id = digest([provider, canonical]);
      if (roots.has(id)) continue;
      roots.add(id);
      const current = source(provider, id);
      sources.push(current);
      let usageDirectories = 0;

      const accept = (record: AccountingRecord): void => {
        // Merge revisions before interval filtering: chunk timestamps can straddle a boundary.
        const key = `${id}:${record.identity.key}`;
        const previous = records.get(key);
        const merged = previous ? mergeRecord(previous, record) : record;
        records.set(key, merged);
        for (const warning of merged.warnings) {
          if (
            [
              "conflicting_metadata",
              "conflicting_observation",
              "conflicting_cache_creation",
            ].includes(warning)
          )
            reason(current, warning);
        }
      };

      const readFile = async (path: string): Promise<void> => {
        if (!withinBudget(current)) return;
        let handle;
        try {
          const actual = await realpath(path);
          const rel = relative(canonical, actual);
          if (
            rel.startsWith(`..${sep}`) ||
            rel === ".." ||
            resolve(actual) === canonical
          ) {
            reason(current, "outside_root");
            return;
          }
          const before = await lstat(path);
          if (!before.isFile() || before.isSymbolicLink()) {
            reason(current, "non_regular_file");
            return;
          }
          handle = await open(
            path,
            constants.O_RDONLY |
              (constants.O_NOFOLLOW ?? 0) |
              constants.O_NONBLOCK,
          );
          const initial = await handle.stat();
          if (
            !initial.isFile() ||
            initial.ino !== before.ino ||
            initial.dev !== before.dev
          ) {
            reason(current, "file_changed");
            return;
          }
          const alias = `${provider}:${initial.dev}:${initial.ino}`;
          if (aliases.has(alias)) {
            reason(current, "aliased_file");
            return;
          }
          aliases.add(alias);
          files++;
          current.files++;
          const parser = new UsageParser(
            provider,
            id,
            digest([id, relative(canonical, actual)]),
            (code) => reason(current, code),
            (time) => {
              const evidence = current.evidence;
              if (evidence.first === null || time < evidence.first)
                evidence.first = time;
              if (evidence.last === null || time > evidence.last)
                evidence.last = time;
            },
          );
          const buffer = new Uint8Array(
            Math.min(65536, options.limits.maxBytes),
          );
          let pending: Uint8Array = new Uint8Array(0),
            discard = false,
            offset = 0,
            line = 0;
          const consume = (chunk: Uint8Array): void => {
            line++;
            lines++;
            current.lines++;
            if (!chunk.length) return;
            try {
              const record = parser.parse(
                JSON.parse(
                  new TextDecoder("utf-8", { fatal: true }).decode(chunk),
                ),
                line,
              );
              if (record) accept(record);
            } catch {
              parser.gap();
              reason(current, "malformed_record");
            }
          };
          while (offset < initial.size) {
            // The file budget counts admission, not the currently admitted file.
            if (
              performance.now() >= deadline ||
              bytes >= options.limits.maxBytes ||
              lines >= options.limits.maxLines
            ) {
              reason(
                current,
                performance.now() >= deadline
                  ? "time_limit"
                  : bytes >= options.limits.maxBytes
                    ? "byte_limit"
                    : "line_limit",
                true,
              );
              break;
            }
            const amount = Math.min(
              buffer.length,
              initial.size - offset,
              options.limits.maxBytes - bytes,
            );
            const result = await handle.read(buffer, 0, amount, offset);
            if (!result.bytesRead) {
              reason(current, "file_changed");
              break;
            }
            offset += result.bytesRead;
            bytes += result.bytesRead;
            current.bytes += result.bytesRead;
            let start = 0;
            for (let index = 0; index < result.bytesRead; index++) {
              if (buffer[index] !== 10) continue;
              const part = buffer.subarray(start, index);
              if (
                !discard &&
                pending.length + part.length <= options.limits.maxLineBytes
              ) {
                consume(concatenate(pending, part));
              } else {
                line++;
                lines++;
                current.lines++;
                parser.gap();
                reason(current, "line_byte_limit", true);
              }
              pending = new Uint8Array(0);
              discard = false;
              start = index + 1;
              if (lines >= options.limits.maxLines) {
                if (start < result.bytesRead || offset < initial.size)
                  reason(current, "line_limit", true);
                break;
              }
            }
            if (lines >= options.limits.maxLines) break;
            const tail = buffer.subarray(start, result.bytesRead);
            if (pending.length + tail.length > options.limits.maxLineBytes) {
              pending = new Uint8Array(0);
              discard = true;
              parser.gap();
              reason(current, "line_byte_limit", true);
            } else if (!discard) pending = concatenate(pending, tail);
          }
          // An unterminated tail is not a committed observation, even if it parses.
          if (pending.length || discard) reason(current, "incomplete_tail");
          const final = await handle.stat();
          if (
            final.size !== initial.size ||
            final.mtimeMs !== initial.mtimeMs ||
            final.ctimeMs !== initial.ctimeMs
          )
            reason(current, "file_changed");
        } catch {
          reason(current, "file_unreadable");
        } finally {
          await handle?.close();
        }
      };

      const walk = async (path: string, depth: number): Promise<void> => {
        if (!withinBudget(current)) return;
        if (depth > options.limits.maxDepth) {
          reason(current, "depth_limit", true);
          return;
        }
        try {
          const stat = await lstat(path);
          if (stat.isSymbolicLink()) {
            reason(current, "symlink_skipped");
            return;
          }
          if (!stat.isDirectory()) {
            reason(current, "non_directory");
            return;
          }
          const children: {
            name: string;
            directory: boolean;
            file: boolean;
            symlink: boolean;
          }[] = [];
          const directory = await opendir(path);
          for await (const entry of directory) {
            if (!withinBudget(current)) break;
            // Entry admission is separate from processing admitted children.
            if (entries >= options.limits.maxEntries) {
              reason(current, "entry_limit", true);
              break;
            }
            entries++;
            children.push({
              name: entry.name,
              directory: entry.isDirectory(),
              file: entry.isFile(),
              symlink: entry.isSymbolicLink(),
            });
          }
          children.sort((a, b) =>
            a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
          );
          for (const child of children) {
            // Known credential stores are excluded even if renamed with a JSONL suffix.
            if (
              /^(?:auth|credentials?|\.credentials|config|settings)(?:[._-]|$)/i.test(
                child.name,
              )
            )
              continue;
            if (child.symlink) {
              reason(current, "symlink_skipped");
              continue;
            }
            if (child.directory) await walk(join(path, child.name), depth + 1);
            else if (child.file && child.name.endsWith(".jsonl"))
              await readFile(join(path, child.name));
          }
        } catch {
          reason(current, "directory_unreadable");
        }
      };
      for (const name of provider === "codex"
        ? ["sessions", "archived_sessions"]
        : ["projects"]) {
        const path = join(canonical, name);
        try {
          await lstat(path);
          usageDirectories++;
          await walk(path, 1);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            reason(current, "directory_unreadable");
        }
      }
      if (!usageDirectories) {
        current.coverage = "error";
        reason(current, "usage_root_missing");
      }
      current.reasons.sort();
    }
  }
  const selected = [...records.values()]
    .filter(
      (record) =>
        record.timestamp >= options.from && record.timestamp < options.to,
    )
    .sort(
      (a, b) =>
        a.timestamp.localeCompare(b.timestamp) ||
        options.providers.indexOf(a.provider) -
          options.providers.indexOf(b.provider) ||
        a.sourceId.localeCompare(b.sourceId) ||
        a.identity.key.localeCompare(b.identity.key),
    );
  return {
    schemaVersion: 1,
    parserVersion: "1",
    kind: "local-usage-accounting",
    collection: { startedAt, endedAt: new Date().toISOString() },
    interval: {
      from: options.from,
      to: options.to,
      semantics: "from-inclusive-to-exclusive",
    },
    snapshot: {
      id: digest([options.from, options.to, sources, selected]),
      semantics: "replace-complete-source-interval-never-add-polls",
    },
    limits: options.limits,
    sources,
    records: selected,
  };
}
