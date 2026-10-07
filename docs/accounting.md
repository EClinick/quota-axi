# Local accounting prototype

This is a local-only, opt-in prototype, not an accepted upstream product expansion or a released feature.
The existing [VISION](../VISION.md) owns upstream scope; historical token accounting and limited provider coverage need maintainer agreement before upstream submission.
No pricing, billing totals, price downloads, or Dockside consumer are included.
Dockside can apply one centrally selected catalog to the exported records; API-rate estimates are not subscription invoices.

## Invocation

```sh
node dist/bin/quota-axi.js accounting \
  --from 2026-10-01T00:00:00Z --to 2026-11-01T00:00:00Z \
  --codex-root /explicit/codex-profile \
  --claude-root /explicit/claude-profile \
  --records --json
```

`accounting` must be the first command argument.
Run `accounting --help` for the bounded scan controls.
Only explicit roots are read; environment variables and the user's home do not discover roots.
Repeat root flags for additional profiles.
Codex reads only `sessions/` and `archived_sessions/`; Claude reads only `projects/`.
Only regular `.jsonl` files are eligible, known credential/config filenames are excluded, and child symlinks are skipped with partial coverage.
A root can itself be a directory alias; its resolved location establishes the local source identity.
Do not select untrusted or credential-containing directories as usage roots.
Default selected providers are Codex and Claude; `--provider` can also request other quota providers, which explicitly report `unsupported`.
This prototype does not implement Copilot database/WAL or trace accounting, Cursor dashboard history, Pi logs, or other sources.

The command requires an explicit UTC interval, inclusive at `from` and exclusive at `to`.
It reconstructs counter baselines before filtering events, including older files/lines, rather than assuming that a filename's date identifies the accounting period.
The consumer owns timezone/calendar grouping.
`--records` is required to export individual normalized observations; without it the response includes coverage and model-grouped token summaries only.
JSON is the sole format; quota/auth/models flags, credential consent, inference, refresh, TUI, and cache flags are rejected.
An argument error exits 2, an unexpected collection failure exits 1, and a successfully serialized report exits 0 even when a source reports an error or partial coverage.
Consumers must inspect source coverage, not just the process exit status.

## Schema and snapshots

The package exports `AccountingResponse`, `AccountingSource`, `AccountingRecord`, and `AccountingTokens` types.
Accounting has its own `kind: local-usage-accounting`, `schemaVersion: 1`, and `parserVersion: "1"`; it does not reuse quota/auth/models schemas.
Collection start/end are wall-clock evidence timestamps, not event timestamps.
Records carry UTC event timestamps, event precision/source, provider, model, source identity, event identity, revision, token categories, context, service tier, and structured warnings.
Each source also reports the first/last observed event in the interval.
No hostname or transport machine identity is supplied: the consumer already owns that association.

`sourceId` is a one-way digest of provider plus canonical selected root, stable only while that local root identity remains stable.
It is not a vendor account ID, an execution host ID, or proof that two machines share a source.
All historical account ownership remains explicitly `unknown`; today's login cannot label yesterday's events.
There is no credential enrichment, saved-account discovery, or inferred ownership from email/token equality.

The snapshot digest covers interval, source evidence, and normalized records, excluding collection time.
Unchanged same-source reads are idempotent; the collector has no persistent cache and rereads changed/truncated/rewritten files.
`revision` changes when the normalized observation changes, not when prompts or other excluded text change.
Replace a prior **complete source and interval** atomically, keyed by parser/schema version, source ID and interval; never add a poll's totals to a prior poll.
A partial/error/unsupported source cannot delete previously retained records, prove zero usage, or authorize complete replacement.
Retained consumer records require their own stale/coverage labeling.
Compact summaries alone cannot implement record-level partial merging.

Coverage means coverage of selected local files, not proof of full vendor, subscription, account, or machine history.

- `complete`: eligible files were read without a known accounting/traversal gap; an empty selected usage directory is an empty local observation, not an assertion of zero vendor spend.
- `partial`: some evidence may be usable, but malformed records, incomplete baselines/tails, missing token/identity evidence, skipped aliases/symlinks, scan limits, or file mutations prevent replacement.
- `error`: a root was not selected, unavailable, or lacked the expected usage directories.
- `unsupported`: there is no local source parser for that provider, never a fabricated zero total.

`replacementSafe` is true only for complete sources.
`truncated` explicitly marks scan-budget loss, independently of other partial-coverage reasons.
Byte/file/line/entry budgets are aggregate across all selected roots, with additional per-line and depth limits.
The time limit is cooperative between local filesystem operations, not a promise to interrupt a stalled kernel/filesystem call.
Scanning records initial file size and checks metadata afterward; live append/rewrite observations are partial rather than a transactional filesystem snapshot.
Use stable local exports when an atomic input snapshot is required.

## Token and identity semantics

All token values are nonnegative safe integers or `null` (unknown); invalid/missing values are never silently zeroed.
Summary categories propagate unknown values and numeric overflow as `null`.
Input is disjoint from cache reads and writes.
Output is separate, and `reasoning` is an informational subset of output, never an extra billable category to add again.

Codex `event_msg/token_count` cumulative totals are differenced, not summed.
`turn_context` supplies model and service tier; context size comes from the last request's input count, not `model_context_window` (a capacity ceiling).
A repeated cumulative observation is ignored.
A first observation counts its `last_token_usage`, with incomplete-baseline evidence when totals disagree or fork metadata is present.
A counter reset or a delta larger than the last request uses the last request observation and marks partial coverage instead of attributing inherited/gapped totals to one model/tier/time.
Missing token fields remain unknown without discarding independently known categories.
Codex identity is deliberately source-local, based on session/counter observation metadata (or a file-position fallback), not a claim of globally unique request identity.

Claude assistant chunks with both `requestId` and `message.id` revise a single request/message observation.
Repeated chunk counters are merged by category maxima, never summed; the earliest chunk timestamp owns interval membership.
Separate cache-creation 5-minute and 1-hour fields are preserved.
When a lifetime breakdown is absent, creation tokens stay in `cacheWriteUnknown`, not an assumed 5-minute rate class.
The context count includes disjoint input, cache read and cache creation counts.
Missing request/message IDs use a source-local file-position surrogate, mark partial coverage, and make no cross-file or cross-host deduplication claim.
No legacy full-line hash is retained or exported.

A Claude vendor request/message identity can identify copied observations across sources, but does not identify where execution happened.
Per-source exported records retain those copies; the summary deduplicates proven vendor-request identities across selected sources.
Consumers must reconcile revisions by identity, retain all observing-source provenance, and mark execution attribution shared/unknown rather than summing per-machine totals.
Matching token counts, current accounts, local row IDs, or source digests do not prove cross-host duplication.
Missing model, tier and context evidence is explicitly unknown, never an assumed standard price.
The collector exports facts for central pricing and no locally estimated dollars.

## Privacy and validation boundary

The accounting execution path does not load credential/provider orchestration and does not read credentials, invoke agents/inference/delegates, access native secure stores, make network requests, or write a cache.
Default quota, auth, models, update, and bare version behavior retain their existing boundaries.
Mixed transcript/usage files necessarily enter local parser memory; this is not a claim that conversation bytes are never read.
Only allowlisted accounting fields leave the parser; prompts, responses, paths, project/session names, raw exceptions, and credentials do not leave through the response.
Model IDs have a bounded model-name grammar, service tiers have a fixed allowlist, identifiers are digested, and errors are fixed structured codes.

`test/accounting.test.ts` owns the shipped-executable contract with synthetic JSONL and isolated homes.
Its preload tripwires terminate on credential reads, out-of-sandbox file reads, writes, child processes, or network attempts, even if application code would swallow an exception.
Independent expected totals cover counter deltas/replays/gaps/resets/forks, repeated chunks, cache lifetimes, missing evidence, UTC filtering, privacy sentinels, malformed/incomplete input, rewritten files, and scan limits.
No live provider, real transcript, host installation, remote probe, or desktop test is required or authorized.
Native Windows and other-platform runtime compatibility are unclaimed until independently exercised.
