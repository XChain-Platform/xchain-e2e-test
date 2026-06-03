# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `src/XChainDecoderConnector.js`, `src/XChainExplorerConnector.js` — JSON-RPC connectors for the decoder and explorer, the two remaining platform stack members that expose a `ping()` handler but were absent from the bootstrap. `initialCheck.test.js` now instantiates both alongside the existing connectors and pings them in the `service-pings` phase, so a crashed decoder (which feeds the indexer) or a crashed explorer (which serves end-user queries) fails bootstrap immediately with a clear "Can't connect to the XChain Decoder/Explorer module" instead of surfacing later as a confusing mid-test data-path failure. The decoder connector also exposes a `health()` wrapper mirroring the indexer connector. The bootstrap smoke tests (`001-bootstrap`, `002-connectivity`) and the env-path integration test (`bootstrap-env`, now asserting all 8 connectors) were extended to cover both. Reads `DECODER_URL`/`DECODER_API_PORT` and `EXPLORER_URL`/`EXPLORER_API_PORT` from the environment.
- `test/actions/attestation.test.js` — integration coverage for the retryable ATTEST v1 response statuses (`no_quorum`, `timeout`, `provider_error`). Each new case fires a fresh request, broadcasts a fully-signed (valid) response carrying the retryable status, and asserts the originating request stays `pending` and no callback EXECUTE is injected — the non-terminal branch of `_parseResponse` that prior tests, which only exercised `status='ok'`, never reached across the hub-to-indexer wire. A fourth case proves a subsequent `ok` response on the same request still flips it to `fulfilled` and fires the callback after an earlier `no_quorum` round, guarding the no-callback / no-status-flip invariant against regression.
- `test/sdk/misc.sdk.test.js` — new assertion that `sdk.getStatus()` exposes the chain-tip reference and indexer lag the explorer now returns. The test requires `node_tip` and `lag_blocks` maps to be present with an entry for every coin in `last_block`, and for each coin asserts that when `node_tip` is non-null the tip is a number at or ahead of `last_block` and `lag_blocks` is a non-negative number (and that `lag_blocks` is `null` whenever `node_tip` is). It also requires at least one coin to report a non-null tip, since the e2e regtest stack co-locates the decoder, so a silent degrade to all-null would be a regression. The existing suite only checked the indexer's own `last_block` position and would not have caught a missing lag signal.

### Fixed
- `src/XChainHubConnector.js`, `test/unit/src/XChainHubConnector.test.js`, `test/chaos/hub-failure.chaos.js` — the hub connector no longer masks a reachable-but-unhealthy hub as fully unreachable. The hub's `ping` endpoint returns HTTP 503 with a valid JSON-RPC `{status:"degraded",db:false}` body when its database pool is down; Axios throws on any non-2xx, and `_call()` discarded the thrown error's `response`, so a live hub with a dead DB pool produced the same `ping() → false` as a crashed one and bootstrap failed with the misleading "Can't connect to the XChain Hub". `_call()` now reads `err.response.data.result` on a non-2xx throw (preferring any fully healthy endpoint first) and surfaces the degraded body instead of `null`; `ping()` therefore reports a degraded hub as reachable (`true`) and logs the degraded state, while `getAllConfig()` returns `null` for a degraded/`{error}` body so bootstrap takes its "couldn't get configs" path instead of indexing into a non-config object. Truly unreachable endpoints (no `err.response`) still return `null`/`false`. The chaos suite gained a block asserting the degraded-503 state is propagated rather than read as total failure.
- `src/XChainHubConnector.js` — `getAllConfig()` now unwraps the hub's `{ configs, seq, watermark }` envelope and returns the flat `coin→network→service` tree that callers expect. The hub's `getallconfigs` method wraps its payload, but this connector returned the wrapper verbatim, so the hub-discovery bootstrap fallback in `initialCheck.test.js` indexed the wrapper as a flat tree and threw `TypeError: Cannot read properties of undefined`, aborting the suite with no useful diagnostic. The unwrap mirrors the explorer and SDK connectors and stays backward-compatible (bare-tree responses pass through unchanged). The `bootstrap-hub.test.js` integration stub now returns the real wrapped shape so the path is exercised against the actual API, and two unit tests cover the unwrap and the null pass-through.

### Changed
- `src/BlockchainConnector.js`, `src/XChainUtxoTrackerConnector.js` — migrated from `cross-fetch` to `axios`, so all six service connectors now use a single HTTP client. The two were the only remaining `fetch`-based connectors; the other four already used `axios`. Because `axios` rejects automatically on non-2xx, the explicit `if (!response.ok)` guard branches were removed and response bodies are now read from `response.data` instead of `await response.json()`. `broadcastTx()` still surfaces the node's JSON-RPC error body on an HTTP 500 — it now reads it from the thrown error's `response.data` (the same pattern `XChainHubConnector._call()` uses). `UtxoTracker.ping()` keeps returning `false` on any error (reachability probe), consistent with every other connector. `cross-fetch` is dropped from `package.json`/`package-lock.json` as it has no remaining consumers, and the affected unit tests now stub `axios.post` instead of injecting a `cross-fetch` mock via `require.cache`. No production code is touched and the connector method signatures are unchanged.
- `src/XChainUtxoTrackerConnector.js` — `ping()` now returns `false` on any network error or non-2xx HTTP status instead of throwing, matching every other connector in the suite. Previously a non-200 tracker response (429, 503, …) propagated `HTTP error! status: N` out of the caller, masking the intended `Can't connect to the XChain Utxo Tracker module` message at the `initialCheck` ping site. The unit test is updated to expect the `false` return.
- `package.json` — aligned the `mariadb` driver to the `^3.5.2` range used across the platform. The driver was previously pinned to `~3.4.5` (a patch-only range, one minor line behind the `xchain-dashboard` host); the caret range now tracks 3.x minor releases consistently with every other service, removing the version drift and the mix of `~`/`^` range operators across the platform. No source changes.

### Added
- `test/e2e/02-transaction-pipeline.e2e.js` — new `E2E-EXEC-003` case exercising the live `MULTISIGN` (bare-multisig) encoding path end-to-end: it passes a real 33-byte compressed public key, forces `encoding='MULTISIGN'`, broadcasts and mines a short ISSUE, then confirms the decoder picked it up and the action round-tripped (valid ISSUE + Credit rows). The suite previously passed `compressedPubKey=null` everywhere, routing every encode through OP_RETURN or P2SH and leaving the live MULTISIGN path untested. `transactionHelper.createAndSendTransaction` and `issueHelper.sendIssueV0` gained optional `compressedPubKey` (and, for `sendIssueV0`, `outputType`) parameters to drive this path; existing callers are unaffected.
- `src/XChainIndexerConnector.js` — new `health()` wrapper that calls the indexer's `health` JSON-RPC method and returns the report object (sync state + database circuit-breaker status), or `null` on failure. Complements the existing `ping()` wrapper.

### Changed
- Dependency installs are now reproducible: `package-lock.json` is committed to the repo (previously git-ignored) and the Docker image is built with `npm ci` instead of `npm install`. The lockfile is generated with the `file:`-linked `xchain-hub` staged so it captures xchain-hub's transitive dependencies (express, cors, ws, geoip-lite, etc.); `npm ci` then installs that exact tree and fails the build if the lockfile is out of sync with `package.json`, rather than silently resolving newer versions.
- `db.js` `checkSweep()` and the `sweepFilterArb` fuzz generator now match against the three-flag SWEEP schema (`orders` / `swaps` / `dispensers`) instead of the removed `escrows` column. `sweepHelper.test.js` is updated to the current `sendSweepV0()` six-flag wire format (`balances|ownerships|orders|swaps|dispensers`), which had drifted from the helper after the SWEEP restructure.
- `test/regression/protocol-size-limits.regression.js` — the contract code-size drift guard now also asserts the indexer's DEPLOY `MAX_CODE_SIZE` and the VM isolate's `maxCodeSize` against the canonical protocol constant, not just the SDK's copy. Previously those two services' local caps were documented as canonical but unguarded, so a drift in either would not have failed the suite.

## [0.3.8] - 2026-05-29

### Changed
- `CryptoNetworks.getFirstBlock()` for `bitcoin-mainnet` now returns `900000` instead of `844000`, matching the encoder and decoder mainnet ingest floor. Keeps the first-block constant consistent across all three services. The regtest suite (which starts at block 0) is unaffected.

## [0.3.7] - 2026-05-28

### Changed
- `db.js` — `getListAddresses()` error handling now logs the caught error through a single structured `console.error` call (`"Couldn't get a list of addresses from a list:", err`) instead of a bare `console.log(err)` followed by a context-only `console.error`. Matches the error-logging idiom used by every other catch block in the file.

## [0.3.6] - 2026-05-28

### Security
- Raise the minimum `axios` version from `^1.6.7` to `^1.16.0`. The installed version was already patched, but the stale lower bound left a path by which a clean install against an older registry snapshot could resolve a pre-1.8.2 release affected by GHSA-q8qp-cvcw-x6jj (prototype-pollution read-side gadgets in the HTTP adapter enabling credential injection / request hijacking). Tightening the floor closes that gap and silences the recurring audit warning.

## [0.3.5] - 2026-05-28

### Security
- Pin `qs` to `^6.15.2` via an `overrides` entry, remediating GHSA-q8mj-m7cp-5q26 (moderate DoS: `qs.stringify` throws a `TypeError` on null/undefined entries in comma-format arrays when `encodeValuesOnly` is set). The override forces the patched version across all transitive dependency paths.

## [0.3.4] - 2026-05-28

### Fixed
- `cryptoHelper.getNewAddress()` now returns the wallet's stored mnemonic instead of the local `mnemonic` parameter. The parameter is only populated on the first call for a given wallet label, so subsequent calls returned a null mnemonic even though address derivation was unaffected. This broke the determinism check in the crypto smoke test (`004-crypto.smoke.js`). Updated the chaos/integration tests that had pinned the previous null-return behavior.

## [0.3.3] - 2026-04-06

### Changed
- Move coverage badge to its own line in README.md for cleaner formatting

## [0.3.2] - 2026-04-06

### Changed
- `README.md` — expanded from minimal stub to full component README matching platform conventions: version badge, feature list, documentation links, quick start, scripts table, test suite breakdown, dependency tables, related links

## [0.3.1] - 2026-04-06

### Added
- Regression test suite with 114 tests across 7 files in `test/regression/` covering all critical test framework infrastructure
- P0 tests (74): service connectors, crypto/wallet management, transaction pipeline, database polling, bootstrap orchestration
- P1 tests (20): action helper message construction, teardown hooks, error propagation and resilience
- P2 tests (20): cross-chain config resolution, fuzz/boundary regression anchors, SQL injection safety, perfCollector observability
- Three-tier execution model with `[regression:pN]` Mocha grep tags for per-commit (P0), merge-gate (P0+P1), and full (P0+P1+P2) runs
- `test:regression`, `test:regression:p0`, and `test:regression:p0p1` npm scripts

## [0.3.0] - 2026-04-07

### Added
- Mutation testing infrastructure using Stryker Mutator to assess test suite defect-detection capability
- Phase 1 config (`stryker.config.mjs`) targeting src/ connectors, test helpers, and cryptoHelper/transactionHelper against unit tests
- Phase 2 config (`stryker.phase2.config.mjs`) extending Phase 1 with integration tests for broader coverage
- Mutation report generator (`scripts/mutation-report.js`) producing markdown summaries with per-file scores and survived mutant details
- `test:mutate`, `test:mutate:integration`, `test:mutate:dry-run`, and `mutate:report` npm scripts

## [0.2.9] - 2026-04-06

### Added
- Chaos engineering test suite with 12 experiments across 77 tests targeting test infrastructure resilience
- Shared chaos helpers module (`test/chaos/chaos-helpers.js`) with mock connection/pool factories and global save/restore utilities
- P0 experiments: connector timeout cascade, pool exhaustion, GAS token bootstrap failure, teardown failure handling
- P1 experiments: hub auto-discovery total failure, malformed PSBT detection, database mid-query disconnect recovery, UTXO cache isolation, partial hub config validation
- P2 experiments: performance reporter write failure, unhandled promise rejection detection, concurrent wallet access safety
- `test:chaos` and `test:chaos:quick` (P0-only) npm scripts

## [0.2.8] - 2026-04-06

### Added
- Performance testing framework with custom Mocha reporter, poll instrumentation, and CI gate tooling
- Custom performance reporter (`test/reporters/performance-reporter.js`) that captures per-test timing via `process.hrtime.bigint()`, memory snapshots via `process.memoryUsage()`, and writes JSON results to `perf-results/`
- Performance metrics collector (`test/perf/perfCollector.js`) — global singleton for bootstrap phase timing and poll tracking
- Poll instrumentation across all 19 `waitFor*` methods and `_waitFor()` in `src/db.js` — tracks poll count, duration, and resolution status per call
- Bootstrap phase timing in `initialCheck.test.js` — measures `env-resolution`, `connector-init`, `service-pings`, `gas-token-check`, and `teardown`
- CI performance gate (`scripts/perf-gate.js`) — checks total suite time, per-test max, peak RSS, poll overhead ratio, and unresolved poll count against configurable thresholds
- Markdown report generator (`scripts/perf-report.js`) — produces top 10 slowest tests, bootstrap breakdown with bar charts, poll analysis by method, test duration distribution, and memory trend
- `test:perf`, `test:perf:actions`, `test:perf:e2e`, `perf:gate`, and `perf:report` npm scripts

## [0.2.7] - 2026-04-06

### Security
- Mask RPC and database credentials in `printAllEnvironmentalVariables()` diagnostic output
- Remove `console.log(wallet)` that exposed private keys to stdout
- Add mainnet guard — test suite refuses to run against mainnet unless `ALLOW_MAINNET=true` is set
- Redact full transaction hex from logs, show only hex length
- Zero out private keys and seed buffers in `afterAll` teardown
- Close database connection pool in `afterAll` to prevent resource leaks
- Remove verbose error logging in `BlockchainConnector.waitForTx` that could leak connection details
- Stop baking `.env` into Docker image layers — credentials must be passed at runtime via `--env-file`

### Removed
- Unused hardcoded `rpcUser`, `rpcPassword`, and `url` constants from `cryptoHelper.js`

### Fixed
- Resolve 3 npm audit vulnerabilities (diff DoS, serialize-javascript RCE/CPU exhaustion) via overrides for mocha transitive deps

## [0.2.6] - 2026-04-06

### Added
- Fuzz test suite (170 tests across 6 files) using fast-check property-based testing — run with `npm run test:fuzz`
- Custom fuzz generators module with domain-specific arbitraries for XChain types: type confusion values (null, NaN, Infinity, arrays, objects), string mutations (SQL injection, pipe delimiters, null bytes, oversized), numeric edges, filter objects, ACTION fields, connector inputs, and hub config structures
- Database filter fuzzing: all 34 check* methods fuzzed with 200 random filter objects each — validates no crashes, connection release on query path, and placeholder-to-parameter count consistency across checkIssue, checkSend, checkCredit, checkDebit, checkMint, checkBroadcast, checkList, checkAirdrop, checkDispenser, checkDispense, checkDispenserStatus, checkAddressOption, checkDestroy, checkMessage, checkFile, checkSleep, checkSweep, checkDividend, checkCallback, checkOrder, checkOrderMatch, checkSwap, checkSwapMatch, checkBatch, checkLink, checkCoinpay, checkCoinpayObligation, checkContract, checkExecution, checkDeposit, checkWithdrawal, checkStake, checkUnstake, checkDelegation, and checkRewardClaim
- ACTION message fuzzing: 17 helper methods fuzzed for string construction safety — validates pipe delimiter injection, null/undefined/NaN coercion to string literals, object/array coercion, and Symbol rejection
- Connector fuzzing: all 6 connector constructors fuzzed with random host/port values, hub endpoint parsing with fuzzed HUB_VALIDATORS/HUB_URL/HUB_PORT, hub _call response handling with fuzzed axios responses, and waitForTx/waitForUtxos with fuzzed identifiers
- Crypto input fuzzing: wallet labels (strings, non-string types, Symbol rejection), coin/network combos (all 9 valid + random invalid), addressIndex (0-10000 + negative/float/NaN/Infinity), fuzzed mnemonics, and CryptoNetworks with random input types
- Config parsing fuzzing: hub config destructuring with missing/null/fuzzed-type keys, isNullOrNullString comprehensive type coverage documenting JS loose-equality traps (0, false, [] treated as null-like), env var validation pattern, and Database constructor with fuzzed connection params
- waitFor* polling fuzzed with bounded timeMax values (0, -1, NaN, random integers)
- `test:fuzz` and `test:fuzz:quick` npm scripts
- `fast-check` devDependency

## [0.2.5] - 2026-04-06

### Added
- Boundary test suite (144 tests across 6 files) for testing the test suite's operational limits — run with `npm run test:boundary`
- Polling timeout boundaries: validates waitFor* methods with timeMax of 0, -1, 1ms, and Number.MAX_SAFE_INTEGER; covers Database, BlockchainConnector, and UtxoTracker
- Connection pool boundaries: tests pool exhaustion with 15 concurrent calls, multi-failure retry recovery, connection release guarantees on success/error/empty results, and transactionConnection bypass
- WHERE clause construction boundaries: validates all-null filters (graceful SQL error handling), single/multiple field combinations, empty strings as valid filter values, very long strings, SQL metacharacter safety, numeric zero inclusion, and placeholder-to-parameter count consistency
- Identifier & string boundaries: tests wallet labels (empty, special chars, unicode, 10K chars), cache idempotency, case sensitivity, addressIndex derivation (0, 999, determinism), cross-network address generation, and multi-address accumulation
- Connector boundaries: validates URL construction, waitForTx/waitForUtxos error recovery and zero-timeout behavior, HubConnector endpoint parsing (HUB_VALIDATORS, HUB_URL, HUB_API_HOST fallback chain, empty/whitespace/missing values), and multi-endpoint fallback ordering
- Global state & service discovery boundaries: tests all 9 CryptoNetworks configurations (dustThreshold consistency), getFirstBlock defaults, isNullOrNullString JS loose-equality edge cases (0, false), wallet cache stress (100 rapid labels), and hub multi-endpoint failover
- Error propagation boundaries: tests sendFunds null/throw, waitForTx false/throw, waitForUtxos false/throw, Database check* SQL errors returning null, waitFor* timeout-then-null, intermittent error recovery, zero-timeout + error combinations, and wallet cache integrity after funding failures
- `test:boundary` npm script

## [0.2.4] - 2026-04-06

### Added
- E2E test suite for the test suite itself (28 tests across 6 files) — run with `npm run test:e2e`
- Tests validate bootstrap machinery, transaction pipeline (OP_RETURN and P2SH paths), action flow orchestration (issue-then-send chain, negative status detection, batch unpacking), polling reliability under real latency, teardown/cleanup, and result accuracy with false positive prevention
- `test:e2e` npm script with `--timeout 0` and `--require ./test/initialCheck.test.js`

## [0.2.3] - 2026-04-06

### Added
- Smoke test suite (7 files, 12 tests) for fast infrastructure health checks — run with `npm run test:smoke`
- Tests verify bootstrap globals, all 6 service connector pings, database schema presence, BIP39/BIP32 crypto toolchain, regtest mining control, GAS token existence, and a minimal ISSUE+SEND E2E round-trip
- `test:smoke` npm script with `--bail` flag for fast-fail behavior and 30s timeout

## [0.2.2] - 2026-04-06

### Added
- Integration test suite (72 tests) for test suite orchestration — run with `npm run test:integration`
- Tests cover bootstrap lifecycle (env-var and hub-discovery paths), transaction pipeline (OP_RETURN, UTXO caching, address funding), helper-to-DB assertion contracts (issue, send, dispenser, batch), database connection pool management, polling integration, wallet/UTXO state management, and error propagation across all layers
- `test:integration` npm script
- Shared mock fixtures for service responses, database rows, and mariadb ESM injection

## [0.2.1] - 2026-04-06

### Added
- Unit test suite (360 tests) for internal logic — run with `npm run test:unit`
- Tests cover CryptoNetworks, Database query builders/polling, all 21 action helpers, 6 service connectors, cryptoHelper, transactionHelper, and initialCheck bootstrap
- `sinon` dev dependency for test stubs
- `test:unit` npm script

## [0.2.0] - 2026-04-06

### Added
- VM e2e tests (`vm.test.js`) — DEPLOY, EXECUTE with counter contract, constructor params
- Staking e2e tests (`staking.test.js`) — STAKE, UNSTAKE, DELEGATE, duplicate stake rejection
- VM helper (`vmHelper.js`) — sendDeployV0, sendExecuteV0, sendDepositV0, sendWithdrawV0
- Staking helper (`stakeHelper.js`) — sendStakeV0, sendUnstakeV0, sendDelegateV0, sendRevokeDelegationV0, sendClaimRewardsV0
- 8 new DB polling methods: waitForContract, waitForExecution, waitForDeposit, waitForWithdrawal, waitForStake, waitForUnstake, waitForDelegation, waitForRewardClaim

## [0.1.0] - 2026-04-02

### Added
- COINPay E2E test infrastructure: coinpayHelper, coinpay.test.js with happy path settlement test
- Database polling methods: waitForOrderMatch, waitForCoinpay, waitForCoinpayObligation
- customOutputs parameter support in transactionHelper for native coin payment outputs
