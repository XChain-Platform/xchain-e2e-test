# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
