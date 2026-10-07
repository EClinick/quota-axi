import { createHash } from "node:crypto";
import type { AccountingRecord, AccountingTokens } from "./types.js";

type ObjectValue = Record<string, unknown>;
export function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
function timestamp(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
  )
    return null;
  // Validate local calendar/time components before applying the timezone offset.
  // Date.parse alone rolls impossible dates (and 24:00) into another day.
  const local = value.slice(0, 19);
  const calendar = new Date(`${local}Z`);
  if (
    !Number.isFinite(calendar.getTime()) ||
    calendar.toISOString().slice(0, 19) !== local
  )
    return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function model(value: unknown): string | null {
  return typeof value === "string" &&
    /^(?:gpt-|claude-|codex-|o[1-9](?:-|$))[a-zA-Z0-9._-]*$/.test(value) &&
    value.length <= 128
    ? value
    : null;
}
function tier(value: unknown): string | null {
  return typeof value === "string" &&
    [
      "default",
      "standard",
      "auto",
      "priority",
      "flex",
      "fast",
      "batch",
    ].includes(value)
    ? value
    : null;
}
function identifier(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    ? value
    : null;
}
function safeSum(values: (number | null)[]): number | null {
  if (values.some((n) => n === null)) return null;
  const total = (values as number[]).reduce((a, b) => a + b, 0);
  return Number.isSafeInteger(total) ? total : null;
}
function difference(a: number | null, b: number | null): number | null {
  return a !== null && b !== null && a >= b ? a - b : null;
}
export function revision(record: AccountingRecord): void {
  record.warnings = [...new Set(record.warnings)].sort();
  record.revision = digest({ ...record, revision: undefined });
}

/** One parser per file; no transcript fields are retained in state or identity. */
export class UsageParser {
  private previous: (number | null)[] | null = null;
  private currentModel: string | null = null;
  private currentTier: string | null = null;
  private session: string | null = null;
  private fork = false;
  constructor(
    private provider: "codex" | "claude",
    private sourceId: string,
    private fileId: string,
    private warn: (reason: string) => void,
    private observe: (time: string) => void,
  ) {}

  gap(): void {
    this.previous = null;
    this.currentModel = null;
    this.currentTier = null;
  }

  parse(raw: unknown, line: number): AccountingRecord | null {
    const row = object(raw);
    if (this.provider === "claude") return this.claude(row, line);
    const payload = object(row.payload);
    if (row.type === "session_meta") {
      this.session = identifier(payload.id);
      this.fork = Boolean(payload.forked_from_id || payload.parent_session_id);
    }
    if (row.type === "turn_context") {
      this.currentModel = model(payload.model);
      this.currentTier = tier(payload.service_tier);
    }
    if (
      row.type !== "event_msg" ||
      payload.type !== "token_count" ||
      !payload.info
    )
      return null;
    const time = timestamp(row.timestamp);
    if (time) this.observe(time);
    else this.warn("missing_timestamp");
    const info = object(payload.info);
    const totals = this.counter(info.total_token_usage);
    const last = this.counter(info.last_token_usage);
    const warnings: string[] = [];
    let delta: (number | null)[] | null;
    if (totals) {
      if (this.previous && totals.every((n, i) => n === this.previous![i]))
        return null;
      if (
        this.previous &&
        totals.every(
          (n, i) =>
            n === null || this.previous![i] === null || n >= this.previous![i]!,
        )
      ) {
        delta = totals.map((n, i) => difference(n, this.previous![i]));
        if (
          last &&
          delta.some((n, i) => n !== null && last[i] !== null && n !== last[i])
        ) {
          delta = last;
          warnings.push("counter_gap");
        } else if (delta.some((n) => n === null)) {
          // Comparable categories agree; fill unavailable deltas from the
          // independent request without discarding other known categories.
          delta = delta.map((n, i) => n ?? last?.[i] ?? null);
          warnings.push("incomplete_baseline");
        }
      } else {
        delta = last;
        if (this.previous) warnings.push("counter_reset");
        else if (this.fork || !last || totals.some((n, i) => n !== last[i]))
          warnings.push("incomplete_baseline");
      }
      this.previous = totals;
    } else {
      // A last-only event has no stable cumulative baseline; retain its observation,
      // but never advertise the source as a complete history.
      delta = last;
      this.previous = null;
      warnings.push("missing_cumulative_counter");
    }
    for (const warning of warnings) this.warn(warning);
    if (!delta) {
      this.warn("missing_tokens");
      return null;
    }
    const [input, cached, output, reasoning] = delta;
    if (
      (cached !== null && input !== null && cached > input) ||
      (reasoning !== null && output !== null && reasoning > output)
    ) {
      this.warn("invalid_tokens");
      return null;
    }
    if (delta.some((n) => n === null)) {
      warnings.push("missing_tokens");
      this.warn("missing_tokens");
    }
    if (!time) return null;
    const record = this.base(
      time,
      model(info.model) ?? this.currentModel,
      tier(info.service_tier) ?? this.currentTier,
      last?.[0] ?? null,
      row.timestamp,
    );
    record.tokens = {
      input: difference(input, cached),
      cacheRead: cached,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheWriteUnknown: 0,
      output,
      reasoning,
    };
    record.identity = {
      key: digest([
        this.sourceId,
        this.session ?? this.fileId,
        time,
        totals ?? ["line", line],
      ]),
      scope: "source-local",
      kind: "counter-observation",
    };
    record.warnings.push(...warnings);
    revision(record);
    return record;
  }

  private counter(value: unknown): (number | null)[] | null {
    const row = object(value);
    const values = [
      count(row.input_tokens),
      count(row.cached_input_tokens),
      count(row.output_tokens),
      count(row.reasoning_output_tokens),
    ];
    return values.some((n) => n !== null) ? values : null;
  }

  private base(
    time: string,
    observedModel: string | null,
    observedTier: string | null,
    context: number | null,
    originalTime: unknown,
  ): AccountingRecord {
    return {
      provider: this.provider,
      sourceId: this.sourceId,
      identity: { key: "", scope: "source-local", kind: "file-position" },
      revision: "",
      timestamp: time,
      timestampSource: "event",
      timestampPrecision:
        typeof originalTime === "string" && originalTime.includes(".")
          ? "millisecond"
          : "second",
      model: observedModel,
      serviceTier: {
        status: observedTier === null ? "unknown" : "known",
        value: observedTier,
      },
      contextTokens: {
        status: context === null ? "unknown" : "known",
        value: context,
      },
      account: { status: "unknown" },
      tokens: {
        input: null,
        cacheRead: null,
        cacheWrite5m: null,
        cacheWrite1h: null,
        cacheWriteUnknown: null,
        output: null,
        reasoning: null,
      },
      warnings: [
        ...(observedModel ? [] : ["unknown_model"]),
        ...(observedTier ? [] : ["unknown_service_tier"]),
      ],
    };
  }

  private claude(row: ObjectValue, line: number): AccountingRecord | null {
    if (row.type !== "assistant") return null;
    const time = timestamp(row.timestamp);
    if (time) this.observe(time);
    const message = object(row.message);
    const usage = object(message.usage);
    if (!Object.keys(usage).length) {
      this.warn("missing_tokens");
      return null;
    }
    if (!time) {
      this.warn("missing_timestamp");
      return null;
    }
    const input = count(usage.input_tokens);
    const read = count(usage.cache_read_input_tokens);
    const write = count(usage.cache_creation_input_tokens);
    const lifetimes = object(usage.cache_creation);
    let short = count(lifetimes.ephemeral_5m_input_tokens);
    let long = count(lifetimes.ephemeral_1h_input_tokens);
    let unknown: number | null;
    if (!Object.keys(lifetimes).length) {
      short = 0;
      long = 0;
      unknown = write;
    } else {
      unknown = difference(write, safeSum([short, long]));
    }
    const record = this.base(
      time,
      model(message.model),
      tier(usage.service_tier),
      safeSum([input, read, write]),
      row.timestamp,
    );
    record.tokens = {
      input,
      cacheRead: read,
      cacheWrite5m: short,
      cacheWrite1h: long,
      cacheWriteUnknown: unknown,
      output: count(usage.output_tokens),
      reasoning: null,
    };
    if (
      Object.entries(record.tokens).some(
        ([key, value]) => key !== "reasoning" && value === null,
      )
    ) {
      record.warnings.push("missing_or_inconsistent_tokens");
      this.warn("missing_or_inconsistent_tokens");
    }
    if (unknown) record.warnings.push("unknown_cache_lifetime");
    const request = identifier(row.requestId);
    const msg = identifier(message.id);
    if (request && msg) {
      record.identity = {
        key: digest(["claude", request, msg]),
        scope: "vendor-request",
        kind: "request-message",
      };
    } else {
      record.identity.key = digest([this.sourceId, this.fileId, line]);
      record.warnings.push("missing_request_identity");
      this.warn("missing_request_identity");
    }
    revision(record);
    return record;
  }
}

/** Claude streaming revisions replace one request observation, never sum chunks. */
export function mergeRecord(
  previous: AccountingRecord,
  next: AccountingRecord,
): AccountingRecord {
  if (previous.revision === next.revision) return previous;
  const merged = {
    ...previous,
    tokens: { ...previous.tokens },
    warnings: [...previous.warnings, ...next.warnings],
  };
  const mergeEvidence = (
    a: string | null,
    b: string | null,
    field: "model" | "service_tier",
  ): string | null => {
    const conflict = `conflicting_${field}`;
    if (
      merged.warnings.includes(conflict) ||
      (a !== null && b !== null && a !== b)
    ) {
      merged.warnings.push(conflict, "conflicting_metadata");
      return null;
    }
    return a ?? b;
  };
  merged.model = mergeEvidence(previous.model, next.model, "model");
  const serviceTier = mergeEvidence(
    previous.serviceTier.value,
    next.serviceTier.value,
    "service_tier",
  );
  merged.serviceTier = {
    status: serviceTier === null ? "unknown" : "known",
    value: serviceTier,
  };
  if (
    previous.provider === "claude" &&
    previous.identity.scope === "vendor-request"
  ) {
    // Counts in repeated assistant chunks are cumulative within the message.
    for (const key of Object.keys(
      merged.tokens,
    ) as (keyof AccountingTokens)[]) {
      const a = previous.tokens[key],
        b = next.tokens[key];
      merged.tokens[key] = a === null ? b : b === null ? a : Math.max(a, b);
    }
    // A later lifetime breakdown supersedes an earlier unspecified write total.
    const classified = safeSum([
      merged.tokens.cacheWrite5m,
      merged.tokens.cacheWrite1h,
    ]);
    const previousTotal = safeSum([
      previous.tokens.cacheWrite5m,
      previous.tokens.cacheWrite1h,
      previous.tokens.cacheWriteUnknown,
    ]);
    const nextTotal = safeSum([
      next.tokens.cacheWrite5m,
      next.tokens.cacheWrite1h,
      next.tokens.cacheWriteUnknown,
    ]);
    const total =
      previousTotal === null
        ? nextTotal
        : nextTotal === null
          ? previousTotal
          : Math.max(previousTotal, nextTotal);
    const cacheConflict =
      merged.warnings.includes("conflicting_cache_creation") ||
      (merged.tokens.cacheWrite5m !== null &&
        merged.tokens.cacheWrite1h !== null &&
        (classified === null || (total !== null && classified > total)));
    if (cacheConflict) {
      merged.warnings.push("conflicting_cache_creation");
      merged.tokens.cacheWrite5m = null;
      merged.tokens.cacheWrite1h = null;
      merged.tokens.cacheWriteUnknown = null;
    } else merged.tokens.cacheWriteUnknown = difference(total, classified);
    merged.contextTokens = { status: "unknown", value: null };
    const context = safeSum([
      merged.tokens.input,
      merged.tokens.cacheRead,
      cacheConflict ? null : total,
    ]);
    if (context !== null)
      merged.contextTokens = { status: "known", value: context };
  } else if (JSON.stringify(previous.tokens) !== JSON.stringify(next.tokens)) {
    merged.warnings.push("conflicting_observation");
  }
  // Equal instants retain the coarser observed precision, independent of order.
  const earliest =
    next.timestamp < previous.timestamp ||
    (next.timestamp === previous.timestamp &&
      next.timestampPrecision === "second")
      ? next
      : previous;
  merged.timestamp = earliest.timestamp;
  merged.timestampPrecision = earliest.timestampPrecision;
  merged.timestampSource = earliest.timestampSource;
  revision(merged);
  return merged;
}
