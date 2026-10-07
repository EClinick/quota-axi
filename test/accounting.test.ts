import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  symlinkSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountingResponse } from "../src/accounting/types.js";

// Primary owner: the shipped executable, including routing, filesystem scanning,
// normalization and the wire privacy contract. No parser-only duplicate suite.
let home: string;
const from = "2026-10-01T00:00:00Z",
  to = "2026-11-01T00:00:00Z";
const time = "2026-10-07T12:00:00.000Z";
const sentinel = "PRIVATE_PROMPT_PATH_PROJECT_SECRET_SENTINEL";
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "accounting-")));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
function fixture(path: string, rows: unknown[], tail = ""): string {
  const full = join(home, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(
    full,
    rows.map((row) => JSON.stringify(row) + "\n").join("") + tail,
  );
  return full;
}
function run(extra: string[] = []): AccountingResponse {
  const result = invoke(["accounting", "--from", from, "--to", to, ...extra]);
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain(sentinel);
  expect(result.stdout).not.toContain(home);
  return JSON.parse(result.stdout);
}
function invoke(args: string[]) {
  return execute([resolve("dist/bin/quota-axi.js"), ...args]);
}
function execute(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", resolve("test/fixtures/accounting-deny.mjs"), ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        PATH: "",
        HOME: home,
        USERPROFILE: home,
        ACCOUNTING_TEST_ROOT: home,
        CODEX_HOME: home,
        CLAUDE_CONFIG_DIR: home,
        PI_CODING_AGENT_DIR: home,
        XDG_CONFIG_HOME: home,
        XDG_CACHE_HOME: home,
        XDG_DATA_HOME: home,
        OPENAI_API_KEY: sentinel,
        ANTHROPIC_API_KEY: sentinel,
      },
    },
  );
}
function counter(input: number, cache: number, output: number, reasoning = 0) {
  return {
    input_tokens: input,
    cached_input_tokens: cache,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
  };
}
function codex(
  total: ReturnType<typeof counter>,
  last = total,
  timestamp = time,
) {
  return {
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: { total_token_usage: total, last_token_usage: last },
    },
  };
}
function claude(output = 10, timestamp = time, overrides = {}) {
  return {
    type: "assistant",
    timestamp,
    requestId: "req_synthetic",
    sessionId: sentinel,
    cwd: sentinel,
    message: {
      id: "msg_synthetic",
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: sentinel }],
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 70,
        cache_creation: {
          ephemeral_5m_input_tokens: 30,
          ephemeral_1h_input_tokens: 40,
        },
        output_tokens: output,
        service_tier: "standard",
      },
    },
    ...overrides,
  };
}
const context = {
  type: "turn_context",
  payload: { model: "gpt-5-codex", service_tier: "fast", cwd: sentinel },
};
const session = {
  type: "session_meta",
  payload: { id: "00000000-0000-4000-8000-000000000001", cwd: sentinel },
};

describe("offline accounting executable", () => {
  it.each([
    "auth.json",
    ".credentials.json",
    "credentials.json",
    "config.json",
    "settings.json",
    "auth.jsonl",
  ])("denies synthetic credential reads: %s", (name) => {
    const target = fixture(name, [{ synthetic_secret: sentinel }]);
    for (const operation of [
      "fs.closeSync(fs.openSync(target, 'r'))",
      "fs.open(target, 'r', (error, fd) => { if (error) throw error; fs.closeSync(fd); })",
      "await (await fs.promises.open(target, 'r')).close()",
      "fs.readFileSync(target, 'utf8')",
      "fs.readFile(target, 'utf8', (error) => { if (error) throw error; })",
      "await fs.promises.readFile(target, 'utf8')",
      "for await (const chunk of fs.createReadStream(target)) void chunk",
    ]) {
      const result = execute([
        "--input-type=module",
        "-e",
        `
          import fs from "node:fs";
          const target = ${JSON.stringify(target)};
          ${operation};
          process.stdout.write("BOUNDARY_BYPASSED");
        `,
      ]);
      expect(result.status, `${operation}: ${result.stderr}`).toBe(91);
      expect(result.stderr).toBe("ACCOUNTING_FORBIDDEN_IO\n");
      expect(result.stdout).toBe("");
    }
  });

  it("denies an unselected nonexistent path before filesystem access", () => {
    const result = execute([
      "--input-type=module",
      "-e",
      `
        import fs from "node:fs";
        fs.readFileSync(${JSON.stringify(`${home}-unselected/never-created.txt`)});
        process.stdout.write("BOUNDARY_BYPASSED");
      `,
    ]);
    expect(result.status, result.stderr).toBe(91);
    expect(result.stderr).toBe("ACCOUNTING_FORBIDDEN_IO\n");
    expect(result.stdout).toBe("");
  });

  it.each([
    "childProcess.spawn(null)",
    "childProcess.spawnSync(null)",
    "childProcess.exec(null)",
    "childProcess.execSync(null)",
    "childProcess.execFile(null)",
    "childProcess.execFileSync(null)",
    "childProcess.fork(null)",
    "http.request('data:text/plain,inert')",
    "http.get('data:text/plain,inert')",
    "https.request('data:text/plain,inert')",
    "https.get('data:text/plain,inert')",
    "net.connect({ host: '127.0.0.1', port: -1 })",
    "net.createConnection({ host: '127.0.0.1', port: -1 })",
    "new net.Socket().connect({ host: '127.0.0.1', port: -1 })",
    "tls.connect({ host: '127.0.0.1', port: -1 })",
    "dgram.createSocket('invalid-socket-type')",
    "dns.lookup('127.0.0.1', () => {})",
    "dns.resolve('127.0.0.1', 'INVALID_RECORD_TYPE', () => {})",
    "await fetch('data:text/plain,inert')",
  ])("denies inert process and network attempts: %s", (operation) => {
    const result = execute([
      "--input-type=module",
      "-e",
      `
        import childProcess from "node:child_process";
        import http from "node:http";
        import https from "node:https";
        import net from "node:net";
        import tls from "node:tls";
        import dgram from "node:dgram";
        import dns from "node:dns";
        ${operation};
        process.stdout.write("BOUNDARY_BYPASSED");
      `,
    ]);
    expect(result.status, result.stderr).toBe(91);
    expect(result.stderr).toBe("ACCOUNTING_FORBIDDEN_IO\n");
    expect(result.stdout).toBe("");
  });

  it.each([
    "fs.closeSync(fs.openSync(target, flags))",
    "fs.open(target, flags, (error, fd) => { if (error) throw error; fs.closeSync(fd); })",
    "await (await fs.promises.open(target, flags)).close()",
    "fs.readFileSync(target, { flag: flags })",
    "fs.readFile(target, { flag: flags }, (error) => { if (error) throw error; })",
    "await fs.promises.readFile(target, { flag: flags })",
    "for await (const chunk of fs.createReadStream(target, { flags })) void chunk",
  ])("denies write-capable flags before file mutation: %s", (call) => {
    const existing = fixture("existing.txt", ["preserve"]);
    const original = readFileSync(existing, "utf8");
    const absent = join(home, "absent.txt");
    for (const flags of ["r", "rs", "sr", constants.O_RDONLY]) {
      const result = execute([
        "--input-type=module",
        "-e",
        `
          import fs from "node:fs";
          const target = ${JSON.stringify(existing)}, flags = ${JSON.stringify(flags)};
          ${call};
          process.stdout.write(fs.readFileSync(target, "utf8"));
        `,
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(original);
    }
    for (const flags of [
      "w",
      "a",
      "r+",
      constants.O_WRONLY,
      constants.O_RDWR,
      constants.O_CREAT,
      constants.O_TRUNC,
      constants.O_APPEND,
    ]) {
      for (const target of [existing, absent]) {
        const result = execute([
          "--input-type=module",
          "-e",
          `
            import fs from "node:fs";
            const target = ${JSON.stringify(target)}, flags = ${JSON.stringify(flags)};
            ${call};
          `,
        ]);
        expect(result.status, `${call}: ${flags}: ${result.stderr}`).toBe(91);
        expect(result.stderr).toBe("ACCOUNTING_FORBIDDEN_IO\n");
        expect(existsSync(absent)).toBe(false);
        expect(readFileSync(existing, "utf8")).toBe(original);
      }
    }
  });

  it("normalizes disjoint Codex deltas and Claude chunk revisions without credentials or network; snapshots replay exactly", () => {
    fixture("auth.json", [{ access_token: sentinel }]);
    const path = fixture("codex/sessions/2026/rollout.jsonl", [
      session,
      context,
      codex(counter(100, 20, 10, 3)),
      codex(
        counter(160, 30, 18, 5),
        counter(60, 10, 8, 2),
        "2026-10-07T12:01:00Z",
      ),
      codex(counter(160, 30, 18, 5), undefined, "2026-10-07T12:02:00Z"),
    ]);
    mkdirSync(join(home, "codex/archived_sessions"));
    copyFileSync(path, join(home, "codex/archived_sessions/copied.jsonl"));
    fixture("claude/projects/private/stream.jsonl", [
      claude(),
      claude(15, "2026-10-07T12:01:00Z"),
      claude(12, "2026-10-07T12:03:00Z"),
    ]);
    fixture("codex/sessions/auth.jsonl", [{ access_token: sentinel }]);
    const args = [
      "--codex-root",
      join(home, "codex"),
      "--claude-root",
      join(home, "claude"),
    ];
    const first = run(args),
      second = run(args);
    expect(first.snapshot).toEqual(second.snapshot);
    expect(first.records).toEqual(second.records);
    expect(first.sources.map((s) => s.coverage)).toEqual([
      "complete",
      "complete",
    ]);
    expect(first).not.toHaveProperty("summary");
    expect(first.records.map((r) => r.tokens)).toEqual([
      {
        input: 80,
        cacheRead: 20,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheWriteUnknown: 0,
        output: 10,
        reasoning: 3,
      },
      {
        input: 100,
        cacheRead: 200,
        cacheWrite5m: 30,
        cacheWrite1h: 40,
        cacheWriteUnknown: 0,
        output: 15,
        reasoning: null,
      },
      {
        input: 50,
        cacheRead: 10,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheWriteUnknown: 0,
        output: 8,
        reasoning: 2,
      },
    ]);
    expect(first.sources.map((s) => s.evidence)).toEqual([
      { first: time, last: "2026-10-07T12:02:00.000Z" },
      { first: time, last: "2026-10-07T12:03:00.000Z" },
    ]);
    expect(first.records.map((r) => r.contextTokens.value)).toEqual([
      100, 370, 60,
    ]);
    expect(first.records.every((r) => r.account.status === "unknown")).toBe(
      true,
    );
    expect(
      first.records.find((r) => r.provider === "codex" && r.tokens.output === 8)
        ?.timestampPrecision,
    ).toBe("second");
    expect(
      first.records.find((r) => r.provider === "claude")?.identity.scope,
    ).toBe("vendor-request");
    expect(first.records.map((r) => [r.model, r.serviceTier])).toEqual([
      ["gpt-5-codex", { status: "known", value: "fast" }],
      ["claude-sonnet-4-5", { status: "known", value: "standard" }],
      ["gpt-5-codex", { status: "known", value: "fast" }],
    ]);
    for (const { models, tiers, expectedModel, expectedTier, conflicts } of [
      {
        models: ["claude-sonnet-4-5", "claude-sonnet-4-5", "claude-sonnet-4-5"],
        tiers: [null, "standard", null],
        expectedModel: "claude-sonnet-4-5",
        expectedTier: "standard",
        conflicts: [],
      },
      {
        models: [null, "claude-sonnet-4-5", null],
        tiers: ["standard", "standard", "standard"],
        expectedModel: "claude-sonnet-4-5",
        expectedTier: "standard",
        conflicts: [],
      },
      {
        models: ["claude-sonnet-4-5", null, null],
        tiers: ["standard", null, null],
        expectedModel: "claude-sonnet-4-5",
        expectedTier: "standard",
        conflicts: [],
      },
      {
        models: [null, null, null],
        tiers: [null, null, null],
        expectedModel: null,
        expectedTier: null,
        conflicts: [],
      },
      {
        models: ["claude-sonnet-4-5", "claude-opus-4-5", "claude-sonnet-4-5"],
        tiers: ["standard", "standard", "standard"],
        expectedModel: null,
        expectedTier: "standard",
        conflicts: ["conflicting_model"],
      },
      {
        models: ["claude-sonnet-4-5", "claude-sonnet-4-5", "claude-sonnet-4-5"],
        tiers: ["standard", "priority", "standard"],
        expectedModel: "claude-sonnet-4-5",
        expectedTier: null,
        conflicts: ["conflicting_service_tier"],
      },
      {
        models: ["claude-sonnet-4-5", "claude-opus-4-5", "claude-sonnet-4-5"],
        tiers: [null, null, "standard"],
        expectedModel: null,
        expectedTier: "standard",
        conflicts: ["conflicting_model"],
      },
      {
        models: [null, null, "claude-sonnet-4-5"],
        tiers: ["standard", "priority", "standard"],
        expectedModel: "claude-sonnet-4-5",
        expectedTier: null,
        conflicts: ["conflicting_service_tier"],
      },
      {
        models: ["claude-sonnet-4-5", "claude-opus-4-5", null],
        tiers: ["standard", "priority", null],
        expectedModel: null,
        expectedTier: null,
        conflicts: ["conflicting_model", "conflicting_service_tier"],
      },
    ]) {
      fixture(
        "claude/projects/private/stream.jsonl",
        [
          claude(),
          claude(15, "2026-10-07T12:01:00Z"),
          claude(12, "2026-10-07T12:03:00Z"),
        ].map((row, index) => ({
          ...row,
          message: {
            ...row.message,
            model: models[index] ?? undefined,
            usage: {
              ...row.message.usage,
              service_tier: tiers[index] ?? undefined,
            },
          },
        })),
      );
      const report = run([
        "--provider",
        "claude",
        "--claude-root",
        join(home, "claude"),
      ]);
      expect(report.records).toHaveLength(1);
      expect(report.records[0]).toMatchObject({
        model: expectedModel,
        serviceTier: {
          status: expectedTier === null ? "unknown" : "known",
          value: expectedTier,
        },
        timestamp: time,
        tokens: {
          input: 100,
          cacheRead: 200,
          cacheWrite5m: 30,
          cacheWrite1h: 40,
          cacheWriteUnknown: 0,
          output: 15,
          reasoning: null,
        },
      });
      expect(
        report.records[0].warnings.filter((warning) =>
          warning.startsWith("conflicting_"),
        ),
      ).toEqual(conflicts.length ? ["conflicting_metadata", ...conflicts] : []);
      expect(report.sources[0]).toMatchObject({
        coverage: conflicts.length ? "partial" : "complete",
        replacementSafe: !conflicts.length,
        reasons: conflicts.length ? ["conflicting_metadata"] : [],
      });
    }
  });

  it("exports per-source revisions while earliest chunks own interval membership", () => {
    fixture("full/projects/events.jsonl", [
      claude(10, "2026-10-31T23:59:00Z"),
      claude(15, "2026-11-01T00:01:00Z"),
    ]);
    fixture("copy/projects/events.jsonl", [claude(15, "2026-11-01T00:01:00Z")]);
    const args = [
      "--provider",
      "claude",
      "--claude-root",
      join(home, "full"),
      "--claude-root",
      join(home, "copy"),
    ];
    const october = run(args);
    const novemberResult = invoke([
      "accounting",
      "--from",
      to,
      "--to",
      "2026-12-01T00:00:00Z",
      ...args,
    ]);
    expect(novemberResult.status, novemberResult.stderr).toBe(0);
    const november: AccountingResponse = JSON.parse(novemberResult.stdout);
    expect(october.records).toHaveLength(1);
    expect(november.records).toHaveLength(1);
    expect(october.records[0].timestamp).toBe("2026-10-31T23:59:00.000Z");
    expect(november.records[0].timestamp).toBe("2026-11-01T00:01:00.000Z");
    expect(october.records[0].tokens.output).toBe(15);
    expect(november.records[0].identity).toEqual(october.records[0].identity);
    expect(november.records[0].sourceId).not.toBe(october.records[0].sourceId);
    expect(october.sources.map((s) => s.evidence)).toEqual([
      { first: "2026-10-31T23:59:00.000Z", last: "2026-11-01T00:01:00.000Z" },
      { first: "2026-11-01T00:01:00.000Z", last: "2026-11-01T00:01:00.000Z" },
    ]);
    expect(november.sources).toEqual(october.sources);
  });

  it("reconstructs counters before interval filtering and exposes gaps, resets and fork baseline uncertainty", () => {
    fixture("sessions/a.jsonl", [
      session,
      context,
      codex(counter(100, 20, 10), undefined, "2026-09-30T23:59:00Z"),
      codex(counter(160, 30, 18), counter(60, 10, 8)),
      codex(counter(300, 60, 40), counter(40, 5, 7), "2026-10-07T12:02:00Z"),
      codex(counter(10, 2, 2), undefined, "2026-10-07T12:03:00Z"),
    ]);
    fixture("archived_sessions/fork.jsonl", [
      {
        type: "session_meta",
        payload: { id: "fork", forked_from_id: "parent" },
      },
      context,
      codex(counter(500, 100, 80), counter(20, 5, 3), "2026-10-07T12:04:00Z"),
    ]);
    const report = run(["--provider", "codex", "--codex-root", home]);
    expect(
      report.records.map((r) => [
        r.tokens.input,
        r.tokens.cacheRead,
        r.tokens.output,
      ]),
    ).toEqual([
      [50, 10, 8],
      [35, 5, 7],
      [8, 2, 2],
      [15, 5, 3],
    ]);
    expect(report.sources[0].evidence).toEqual({
      first: "2026-09-30T23:59:00.000Z",
      last: "2026-10-07T12:04:00.000Z",
    });
    expect(report.sources[0]).toMatchObject({
      coverage: "partial",
      replacementSafe: false,
      truncated: false,
    });
    expect(report.sources[0].reasons).toEqual([
      "counter_gap",
      "counter_reset",
      "incomplete_baseline",
    ]);
  });

  it("does not invent missing token categories, tiers, account ownership, or full-line identities", () => {
    const row = claude(10, time, { requestId: undefined });
    delete (row.message.usage as Partial<typeof row.message.usage>)
      .cache_creation;
    delete (row.message.usage as Partial<typeof row.message.usage>)
      .service_tier;
    fixture("projects/private/session.jsonl", [row]);
    const report = run(["--provider", "claude", "--claude-root", home]);
    const record = report.records[0];
    expect(record.tokens).toMatchObject({
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheWriteUnknown: 70,
    });
    expect(record.serviceTier).toEqual({ status: "unknown", value: null });
    expect(record.identity).toMatchObject({
      scope: "source-local",
      kind: "file-position",
    });
    expect(record.identity.key).not.toBe(
      createHash("sha256").update(JSON.stringify(row)).digest("hex"),
    );
    expect(record.warnings).toContain("unknown_cache_lifetime");
    expect(report.sources[0].replacementSafe).toBe(false);
    row.message.usage.input_tokens = -1;
    fixture("projects/private/session.jsonl", [row]);
    expect(
      run(["--provider", "claude", "--claude-root", home]).records[0].tokens
        .input,
    ).toBeNull();
  });

  it.each([
    {
      name: "malformed JSON",
      gap: Buffer.from('{"type":"turn_context",'),
      reason: "malformed_record",
      truncated: false,
    },
    {
      name: "invalid UTF-8",
      gap: Buffer.from([0xc3, 0x28]),
      reason: "malformed_record",
      truncated: false,
    },
    ...[2048, 70000].map((size) => ({
      name: `oversized context with ${size} padding bytes`,
      gap: Buffer.from(
        JSON.stringify({
          type: "turn_context",
          payload: {
            model: "gpt-5.1-codex",
            service_tier: "priority",
            padding: sentinel.repeat(Math.ceil(size / sentinel.length)),
          },
        }),
      ),
      reason: "line_byte_limit",
      truncated: true,
    })),
  ])(
    "invalidates inherited Codex metadata after $name",
    ({ gap, reason, truncated }) => {
      const event = (
        index: number,
        metadata: { model?: string; service_tier?: string } = {},
      ) => {
        const row = codex(
          counter(index * 100, index * 20, index * 10),
          counter(100, 20, 10),
          `2026-10-07T12:0${index}:00Z`,
        );
        return {
          ...row,
          payload: {
            ...row.payload,
            info: { ...row.payload.info, ...metadata },
          },
        };
      };
      const prefix = [session, context, event(1)]
        .map((row) => JSON.stringify(row) + "\n")
        .join("");
      const suffix = [
        event(2),
        event(3, { model: "gpt-5.1-codex" }),
        event(4, { service_tier: "flex" }),
        event(5, { model: "gpt-5.1-codex", service_tier: "flex" }),
        event(6),
        {
          type: "turn_context",
          payload: { model: "gpt-5.2-codex", service_tier: "priority" },
        },
        event(7),
      ]
        .map((row) => JSON.stringify(row) + "\n")
        .join("");
      writeFileSync(
        fixture("sessions/gaps.jsonl", []),
        Buffer.concat([Buffer.from(prefix), gap, Buffer.from("\n" + suffix)]),
      );
      const report = run([
        "--provider",
        "codex",
        "--codex-root",
        home,
        "--max-line-bytes",
        "1024",
      ]);
      expect(
        report.records.map((record) => [
          record.model,
          record.serviceTier.status,
          record.serviceTier.value,
        ]),
      ).toEqual([
        ["gpt-5-codex", "known", "fast"],
        [null, "unknown", null],
        ["gpt-5.1-codex", "unknown", null],
        [null, "known", "flex"],
        ["gpt-5.1-codex", "known", "flex"],
        [null, "unknown", null],
        ["gpt-5.2-codex", "known", "priority"],
      ]);
      for (const record of report.records) {
        expect(record.tokens).toEqual({
          input: 80,
          cacheRead: 20,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          cacheWriteUnknown: 0,
          output: 10,
          reasoning: 0,
        });
        expect(record.contextTokens).toEqual({ status: "known", value: 100 });
      }
      expect(report.records.map((record) => record.warnings)).toEqual([
        [],
        ["unknown_model", "unknown_service_tier"],
        ["unknown_service_tier"],
        ["unknown_model"],
        [],
        ["unknown_model", "unknown_service_tier"],
        [],
      ]);
      expect(report.sources[0]).toMatchObject({
        coverage: "partial",
        replacementSafe: false,
        reasons: [reason],
        truncated,
      });
    },
  );

  it("retains known Codex usage when optional reasoning counters are absent", () => {
    const row = codex(counter(100, 20, 10));
    delete (
      row.payload.info.total_token_usage as Partial<ReturnType<typeof counter>>
    ).reasoning_output_tokens;
    fixture("sessions/legacy.jsonl", [context, row]);
    const report = run(["--provider", "codex", "--codex-root", home]);
    expect(report.records[0].tokens).toMatchObject({
      input: 80,
      cacheRead: 20,
      output: 10,
      reasoning: null,
    });
    expect(report.sources[0].coverage).toBe("partial");
  });

  it("keeps unsupported, missing and unreadable roots distinct from complete empty observations", () => {
    mkdirSync(join(home, "projects"));
    const report = run([
      "--provider",
      "claude,codex,copilot,cursor",
      "--claude-root",
      home,
    ]);
    expect(report.sources.map((s) => [s.provider, s.coverage])).toEqual([
      ["claude", "complete"],
      ["codex", "error"],
      ["copilot", "unsupported"],
      ["cursor", "unsupported"],
    ]);
    expect(report.records).toEqual([]);
    expect(
      report.sources.every(
        (s) => s.evidence.first === null && s.evidence.last === null,
      ),
    ).toBe(true);
    const missing = run([
      "--provider",
      "codex",
      "--codex-root",
      join(home, sentinel),
    ]);
    expect(missing.sources[0]).toMatchObject({
      coverage: "error",
      reasons: ["root_unavailable"],
    });
  });

  it("bounds scans, rejects symlinks and incomplete tails, and notices rewritten files without a stale cache", () => {
    const path = fixture(
      "projects/a/session.jsonl",
      [claude()],
      '{"incomplete":',
    );
    symlinkSync(path, join(home, "projects/a/link.jsonl"));
    const args = ["--provider", "claude", "--claude-root", home];
    const partial = run(args);
    expect(partial.sources[0]).toMatchObject({
      coverage: "partial",
      replacementSafe: false,
      reasons: ["incomplete_tail", "symlink_skipped"],
    });
    expect(partial.records[0].tokens.output).toBe(10);
    fixture("projects/a/session.jsonl", [claude(20)]);
    const rewritten = run(args);
    expect(rewritten.snapshot.id).not.toBe(partial.snapshot.id);
    expect(rewritten.records[0].tokens.output).toBe(20);
    for (const [flag, value, reason] of [
      ["--max-bytes", "10", "byte_limit"],
      ["--max-line-bytes", "10", "line_byte_limit"],
      ["--max-depth", "1", "depth_limit"],
      ["--max-entries", "1", "entry_limit"],
    ]) {
      const bounded = run([...args, flag, value]);
      expect(bounded.sources[0].truncated).toBe(true);
      expect(bounded.sources[0].reasons).toContain(reason);
      expect(bounded.sources[0].replacementSafe).toBe(false);
    }
    fixture("projects/a/second.jsonl", [
      claude(5, time, { requestId: "req_second" }),
      claude(8, time, { requestId: "req_third" }),
    ]);
    for (const flag of ["--max-files", "--max-lines"]) {
      const bounded = run([...args, flag, "1"]);
      expect(bounded.sources[0].truncated).toBe(true);
      expect(bounded.sources[0].replacementSafe).toBe(false);
    }
  });

  it("recovers after malformed lines, uses UTC boundaries, and never renders raw errors or option values", () => {
    fixture(
      "projects/a/session.jsonl",
      [],
      `${sentinel}\n${JSON.stringify(claude())}\n${JSON.stringify(claude(99, to, { requestId: "excluded" }))}\n`,
    );
    const report = run(["--provider", "claude", "--claude-root", home]);
    expect(report.records).toHaveLength(1);
    expect(report.records[0].tokens.output).toBe(10);
    expect(report.sources[0].evidence).toEqual({
      first: time,
      last: "2026-11-01T00:00:00.000Z",
    });
    expect(report.sources[0].reasons).toEqual(["malformed_record"]);
    for (const option of [
      "--allow-keychain-prompt",
      "--allow-claude-inference",
      "--profile-only",
      "--records",
      `--${sentinel}`,
    ]) {
      const result = invoke(["accounting", "--from", from, "--to", to, option]);
      expect(result.status).toBe(2);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain(sentinel);
    }
    expect(
      invoke(["accounting", "--from", "2026-02-30T00:00:00Z", "--to", to])
        .status,
    ).toBe(2);
    const help = invoke(["accounting", "--help"]);
    expect(help.stdout).toContain("normalized records with coverage");
    expect(help.stdout).not.toContain("--records");
    // A path resembling a legacy command/flag is a value, never help or models.
    for (const value of ["models", "--help"]) {
      const result = run([
        "--provider",
        "codex",
        "--codex-root",
        join(home, value),
      ]);
      expect(result.kind).toBe("local-usage-accounting");
    }
  });
});
