import { PROVIDER_IDS, type ProviderId } from "../types.js";
import type { AccountingOptions } from "./types.js";

export const ACCOUNTING_HELP = `usage: quota-axi accounting --from <UTC ISO> --to <UTC ISO> [flags]
Local-only prototype: normalized records with coverage, not prices or invoices.
flags:
  --codex-root <profile directory>   Read sessions/ and archived_sessions/ only (repeatable)
  --claude-root <profile directory>  Read projects/ only (repeatable)
  --provider <ids>                   Default: codex,claude; others report unsupported
  --json                            JSON is the only accounting format
  --max-files <1-10000>              Default 2000
  --max-bytes <1-1073741824>          Default 268435456 (aggregate)
  --max-lines <1-2000000>             Default 500000 (aggregate)
  --max-line-bytes <1-8388608>        Default 1048576
  --max-entries <1-100000>            Default 20000 (aggregate traversal)
  --max-depth <1-32>                 Default 12
  --max-ms <1-120000>                Default 15000
No root discovery, credential reads, subprocesses, network, or cache writes.
Intervals are UTC, from-inclusive/to-exclusive; baseline reconstruction precedes filtering.
Coverage describes selected local files, not complete vendor/account history.
Replace complete source/interval snapshots; never add repeated polls. Partial results cannot delete history.
`;

const limits = {
  "max-files": ["maxFiles", 2000, 10000],
  "max-bytes": ["maxBytes", 268435456, 1073741824],
  "max-lines": ["maxLines", 500000, 2000000],
  "max-line-bytes": ["maxLineBytes", 1048576, 8388608],
  "max-entries": ["maxEntries", 20000, 100000],
  "max-depth": ["maxDepth", 12, 32],
  "max-ms": ["maxMs", 15000, 120000],
} as const;

function utc(value: string): string {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) {
    throw new Error("accounting requires UTC ISO timestamps");
  }
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !==
      value.replace(/Z$/, value.includes(".") ? "Z" : ".000Z")
  ) {
    throw new Error("invalid accounting timestamp");
  }
  return date.toISOString();
}

export function parseAccountingArgs(args: string[]): AccountingOptions {
  const options: AccountingOptions = {
    providers: [],
    roots: [],
    from: "",
    to: "",
    limits: Object.fromEntries(
      Object.values(limits).map(([key, value]) => [key, value]),
    ) as unknown as AccountingOptions["limits"],
  };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const [flag, ...inline] = args[i].split("=");
    if (flag === "--json") {
      if (inline.length) throw new Error("invalid accounting boolean flag");
      continue;
    }
    const name = flag.slice(2);
    if (
      !flag.startsWith("--") ||
      ![
        "from",
        "to",
        "provider",
        "codex-root",
        "claude-root",
        ...Object.keys(limits),
      ].includes(name)
    ) {
      throw new Error("unsupported accounting option; see accounting --help");
    }
    const value = inline.length ? inline.join("=") : args[++i];
    if (!value) throw new Error("missing accounting option value");
    if (name === "provider") {
      for (const id of value.split(",")) {
        if (!(PROVIDER_IDS as readonly string[]).includes(id))
          throw new Error("unknown accounting provider");
        if (!options.providers.includes(id as ProviderId))
          options.providers.push(id as ProviderId);
      }
    } else if (name === "codex-root" || name === "claude-root") {
      if (options.roots.length >= 32)
        throw new Error("too many accounting roots");
      options.roots.push({
        provider: name === "codex-root" ? "codex" : "claude",
        path: value,
      });
    } else {
      if (seen.has(name)) throw new Error("duplicate accounting option");
      seen.add(name);
      if (name === "from" || name === "to") options[name] = utc(value);
      else {
        const [key, , max] = limits[name as keyof typeof limits];
        const number = Number(value);
        if (
          !/^\d+$/.test(value) ||
          !Number.isSafeInteger(number) ||
          number < 1 ||
          number > max
        )
          throw new Error("accounting limit outside allowed range");
        options.limits[key] = number;
      }
    }
  }
  if (!options.from || !options.to || options.from >= options.to)
    throw new Error("accounting requires --from before --to");
  if (!options.providers.length) options.providers = ["codex", "claude"];
  if (options.roots.some((root) => !options.providers.includes(root.provider)))
    throw new Error("accounting root excluded by provider selection");
  return options;
}
