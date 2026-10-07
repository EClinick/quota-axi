import type { ProviderId } from "../types.js";

/** Independent wire contract, not a quota or billing schema. */
export interface AccountingTokens {
  input: number | null;
  cacheRead: number | null;
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
  cacheWriteUnknown: number | null;
  output: number | null;
  /** A subset of output, never add this to output. */
  reasoning: number | null;
}

export interface AccountingRecord {
  provider: "codex" | "claude";
  sourceId: string;
  identity: {
    key: string;
    scope: "source-local" | "vendor-request";
    kind: "counter-observation" | "request-message" | "file-position";
  };
  revision: string;
  timestamp: string;
  timestampSource: "event";
  timestampPrecision: "second" | "millisecond";
  model: string | null;
  serviceTier: { status: "known" | "unknown"; value: string | null };
  contextTokens: { status: "known" | "unknown"; value: number | null };
  account: { status: "unknown" };
  tokens: AccountingTokens;
  warnings: string[];
}

export interface AccountingSource {
  provider: ProviderId;
  capability: "supported" | "unsupported";
  sourceId: string | null;
  coverage: "complete" | "partial" | "error" | "unsupported";
  replacementSafe: boolean;
  truncated: boolean;
  reasons: string[];
  files: number;
  bytes: number;
  lines: number;
  evidence: { first: string | null; last: string | null };
}

export interface AccountingResponse {
  schemaVersion: 1;
  parserVersion: "1";
  kind: "local-usage-accounting";
  collection: { startedAt: string; endedAt: string };
  interval: {
    from: string;
    to: string;
    semantics: "from-inclusive-to-exclusive";
  };
  snapshot: {
    id: string;
    semantics: "replace-complete-source-interval-never-add-polls";
  };
  limits: AccountingLimits;
  sources: AccountingSource[];
  records: AccountingRecord[];
}

export interface AccountingLimits {
  maxFiles: number;
  maxBytes: number;
  maxLines: number;
  maxLineBytes: number;
  maxEntries: number;
  maxDepth: number;
  maxMs: number;
}

export interface AccountingOptions {
  providers: ProviderId[];
  roots: { provider: "codex" | "claude"; path: string }[];
  from: string;
  to: string;
  limits: AccountingLimits;
}
