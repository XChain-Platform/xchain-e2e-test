# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `bin/seed-contract-state.js`: drop the non-existent AMOUNT field from the gas ISSUE, and refuse in preflight when the seed contract exceeds the single inline DEPLOY budget .
- `bin/contracts/spvSeed.js`: trimmed 6549 -> 3928 source bytes so it fits one inline DEPLOY; contract comments are on-chain bytes .
- `bin/seed-contract-state.js`: refuse LTC/DOGE up front; they pay the protocol fee in the native coin and the tool attaches no FEE_DESTINATION output, so its actions would be mined and then rejected .

### Added
- `bin/seed-contract-state.js` + `bin/contracts/spvSeed.js`: seed a live chain with real contract state ahead of its armed `contract_state_root` height .
- `test/unit/spvSeedContract.test.js`: run the seed contract under the real VM and BTC gas schedule .

### Fixed
- `test/actions/xchainPriceDerivation.test.js`: render drill prices through `bcformat` so the ORDER wait predicate gets strings, not Decimal objects the DB driver cannot bind.
- `test/actions/xchainPriceDerivation.test.js`: page the hub price-snapshot endpoint to exhaustion, so the newest rounds stay visible on a venue publishing 37 pairs a minute.
- Added a CI workflow with the coin-registry drift-guard job (repo previously had no CI at all).

### Added
- `test/actions/xchainPriceDerivation.test.js`: prove a native fee priced off the derived XCHAIN/USD via the on-chain consensus path, bypassing the wall-clock-anchored `feequote` pre-flight .
- Every XCHAIN/USD seed site is now suppressible via `XCHAIN_E2E_NO_PRICE_SEED`, enforced by `test/unit/xchainPriceSeedGuard.test.js` ( step 8).

### Added
- `test/federation/multiHubLlmOutage.test.js`: Phase-4 llm outage drills (throttled provider_error publication + expiry refund, mid-window recovery, wedged-leader rotation, governance model ladder, hard-kill backstop); MultiValidatorHub accepts `extraP2pConfig`.
- `test/sdk/dexCrossRoyaltyLive.sdk.test.js`: live multi-hub royalty drill asserting the guard legs ride the signed match and the proceeds leg settles the 75/25 split.
- Cross-chain royalty parity suite pins the twin `CROSS_CHAIN_ROYALTY_ACTIVATION` maps against the new canonical in `xchain-documentation/protocol/constants.js`.
- Hub connector sends `x-api-key` from `HUB_API_KEY` when set, so suites run against keyed hubs.

### Fixed
- `test/sdk/dexDogeSetup.js`: anchor oracle price seeding to `max(chain tip time, wall clock)` so seeds pass the 1800s freshness gate on a chain that sat idle.
- Regenerate the field-level golden vectors (`test/codec/fixtures/field-golden-vectors.json`): re-pin ATTEST v0 to its current 10-field form (`+FEE_TICK|FEE_AMOUNT`) and add the 10 previously-unpinned formats (ADDRESS v1, ANCHOR v3, DEPLOY v2/v3/v4, ISSUE v6, NODEPROOF v0, SLASH v0, XCALL v0/v2), re-arming the wire-format tripwire.

## [0.3.8] - 2026-06-20

### Fixed
- Correct the Litecoin dust threshold from `546` to `5460` litoshis across `src/CryptoNetworks.js` and all unit/boundary/regression/integration/e2e suites; test expectations now assert per-chain values (546 for BTC/DOGE, 5460 for LTC).
- `test/sdk/messaging.sdk.test.js`: replace the stub MESSAGE v2 case with a real `sdk.sendMessage()` round-trip (pubkey lookup, ECIES encrypt, encode, broadcast, decrypt verify) so the SDK encode path is actually exercised.
- `src/XChainHubConnector.js`, `test/initialCheck.test.js`: record per-endpoint failure details on `connector.lastFailures` and embed them in the "Can't connect to the XChain Hub" error so multi-endpoint outages give actionable diagnostics.
- `src/XChainHubConnector.js`: read `err.response.data.result` on a non-2xx throw so a live hub with a dead DB pool surfaces a degraded status instead of being masked as fully unreachable; `getAllConfig()` returns `null` for degraded/error bodies.
- `src/XChainHubConnector.js`: `getAllConfig()` now unwraps the hub's `{ configs, seq, watermark }` envelope and returns the flat `coin->network->service` tree callers expect, fixing a `TypeError` that aborted the suite with no diagnostic.

### Added
- `test/regression/xcallDeliveryLag.regression.test.js`: regression guard asserting that the real hub `CrossChainCallEngine` margin prevents live/replay divergence under a one-block delivery lag (skips if `XCHAIN_HUB_PATH` is unreachable).
- `test/integration/multiHubGovernanceCapReload.integration.test.js`: federation regression guard that drives a governance proposal through propose/vote/tally and asserts all 3 hubs (not just the tally leader) converge on the updated `getMinStake()` value.
- `test/e2e/02-transaction-pipeline.e2e.js`: P2WSH large-payload (multi-chunk) case forcing an ~8 KB `FILE` through the segwit witness path, and a `MAX_ACTION_DATA_LENGTH` enforcement case confirming the encoder rejects over-length payloads at build time.
- `test/e2e/03-chain-specific.e2e.js`: chain-gated cases for Litecoin MWEB "HogEx" integration transactions and Dogecoin AuxPoW headers, each round-tripping an `ISSUE` and skipping when `COIN` does not match.
- `test/transactionHelper.js`: two-transaction reveal flow now also drives `P2WSH` (previously only `P2SH`), with the existing finalizer detecting P2SH vs P2WSH per input.
- `src/XChainDecoderConnector.js`, `src/XChainExplorerConnector.js`: new JSON-RPC connectors for the decoder and explorer; both are now pinged in the `service-pings` bootstrap phase so a crash surfaces immediately with a clear diagnostic.
- `test/actions/attestation.test.js`: integration coverage for retryable ATTEST v1 response statuses (`no_quorum`, `timeout`, `provider_error`), plus a case proving a subsequent `ok` response still flips the request to `fulfilled`.
- `test/sdk/misc.sdk.test.js`: assertion that `sdk.getStatus()` exposes `decoder_tip` and `decoder_lag_blocks` maps with a valid entry per coin and at least one non-null tip.

### Changed
- `README.md`, `test/initialCheck.test.js`, `test/integration/setup/bootstrap-env.test.js`, `test/helpers/multiValidatorHubHelper.js`: renamed `INDEXER_HOST` to `INDEXER_URL` to match the `<SERVICE>_URL` convention used by every other service.
- `package.json`: pinned `mariadb` 3.5.2, `bitcoinjs-lib` 6.1.7, `ecpair` 2.1.0, `bip32` 4.0.0, `tiny-secp256k1` 2.2.4 to exact versions (dropped `^` caret ranges) to guarantee a byte-identical dependency tree across installs.
- `src/BlockchainConnector.js`, `src/XChainUtxoTrackerConnector.js`: migrated from `cross-fetch` to `axios` so all six service connectors use a single HTTP client; `cross-fetch` removed from `package.json`.
- `src/XChainUtxoTrackerConnector.js`: `ping()` now returns `false` on any network error or non-2xx HTTP status instead of throwing, matching every other connector.
- `package.json`: aligned `mariadb` to `^3.5.2` (was `~3.4.5`) to match the range used across the platform.
- `package.json`: raised `bitcoinjs-lib` floor from `^6.1.5` to `^6.1.7`, matching the encoder, decoder, UTXO-tracker, and SDK services.
- `db.js` `checkSweep()` and `sweepFilterArb` now match the three-flag SWEEP schema (`orders`/`swaps`/`dispensers`) instead of the removed `escrows` column; `sweepHelper.test.js` updated to the current six-flag wire format.
- `test/regression/protocol-size-limits.regression.js`: the contract code-size drift guard now also asserts the indexer's `DEPLOY MAX_CODE_SIZE` and the VM isolate's `maxCodeSize` against the canonical protocol constant.
- `CryptoNetworks.getFirstBlock()` for `bitcoin-mainnet` now returns `900000` instead of `844000`, matching the encoder and decoder mainnet ingest floor.
- Dependency installs are now reproducible: `package-lock.json` is committed to the repo and the Docker image is built with `npm ci` instead of `npm install`.
- `test/e2e/02-transaction-pipeline.e2e.js`: new `E2E-EXEC-003` case exercising the live `MULTISIGN` (bare-multisig) encoding path end-to-end with a real compressed public key; `transactionHelper.createAndSendTransaction` and `issueHelper.sendIssueV0` gained optional `compressedPubKey`/`outputType` params.
- `src/XChainIndexerConnector.js`: new `health()` wrapper that calls the indexer's `health` JSON-RPC method and returns the report object, or `null` on failure.

## [0.3.7] - 2026-05-28

### Changed
- `db.js`: `getListAddresses()` error handling now logs via a single structured `console.error` call instead of a bare `console.log` followed by a context-only `console.error`.

## [0.3.6] - 2026-05-28

### Security
- Raise the minimum `axios` version from `^1.6.7` to `^1.16.0` to close the GHSA-q8qp-cvcw-x6jj credential-injection/request-hijacking vulnerability on clean installs.

## [0.3.5] - 2026-05-28

### Security
- Pin `qs` to `^6.15.2` via an `overrides` entry to remediate GHSA-q8mj-m7cp-5q26 (DoS via `qs.stringify` with null entries in comma-format arrays).

## [0.3.4] - 2026-05-28

### Fixed
- `cryptoHelper.getNewAddress()` now returns the wallet's stored mnemonic instead of the local `mnemonic` parameter, fixing a null return on subsequent calls that broke the determinism check in `004-crypto.smoke.js`.

## [0.3.3] - 2026-04-06

### Changed
- Move coverage badge to its own line in README.md for cleaner formatting

## [0.3.2] - 2026-04-06

### Changed
- `README.md`: expanded from minimal stub to full component README matching platform conventions: version badge, feature list, documentation links, quick start, scripts table, test suite breakdown, dependency tables, related links

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
- Performance metrics collector (`test/perf/perfCollector.js`), global singleton for bootstrap phase timing and poll tracking
- Poll instrumentation across all 19 `waitFor*` methods and `_waitFor()` in `src/db.js`: tracks poll count, duration, and resolution status per call
- Bootstrap phase timing in `initialCheck.test.js`: measures `env-resolution`, `connector-init`, `service-pings`, `gas-token-check`, and `teardown`
- CI performance gate (`scripts/perf-gate.js`), checks total suite time, per-test max, peak RSS, poll overhead ratio, and unresolved poll count against configurable thresholds
- Markdown report generator (`scripts/perf-report.js`), produces top 10 slowest tests, bootstrap breakdown with bar charts, poll analysis by method, test duration distribution, and memory trend
- `test:perf`, `test:perf:actions`, `test:perf:e2e`, `perf:gate`, and `perf:report` npm scripts

## [0.2.7] - 2026-04-06

### Security
- Mask RPC and database credentials in `printAllEnvironmentalVariables()` diagnostic output
- Remove `console.log(wallet)` that exposed private keys to stdout
- Add mainnet guard, test suite refuses to run against mainnet unless `ALLOW_MAINNET=true` is set
- Redact full transaction hex from logs, show only hex length
- Zero out private keys and seed buffers in `afterAll` teardown
- Close database connection pool in `afterAll` to prevent resource leaks
- Remove verbose error logging in `BlockchainConnector.waitForTx` that could leak connection details
- Stop baking `.env` into Docker image layers, credentials must be passed at runtime via `--env-file`

### Removed
- Unused hardcoded `rpcUser`, `rpcPassword`, and `url` constants from `cryptoHelper.js`

### Fixed
- Resolve 3 npm audit vulnerabilities (diff DoS, serialize-javascript RCE/CPU exhaustion) via overrides for mocha transitive deps

## [0.2.6] - 2026-04-06

### Added
- Fuzz test suite (170 tests across 6 files) using fast-check property-based testing, run with `npm run test:fuzz`
- Custom fuzz generators module with domain-specific arbitraries for XChain types: type confusion values (null, NaN, Infinity, arrays, objects), string mutations (SQL injection, pipe delimiters, null bytes, oversized), numeric edges, filter objects, ACTION fields, connector inputs, and hub config structures
- Database filter fuzzing: all 34 check* methods fuzzed with 200 random filter objects each, validates no crashes, connection release on query path, and placeholder-to-parameter count consistency across checkIssue, checkSend, checkCredit, checkDebit, checkMint, checkBroadcast, checkList, checkAirdrop, checkDispenser, checkDispense, checkDispenserStatus, checkAddressOption, checkDestroy, checkMessage, checkFile, checkSleep, checkSweep, checkDividend, checkCallback, checkOrder, checkOrderMatch, checkSwap, checkSwapMatch, checkBatch, checkLink, checkCoinpay, checkCoinpayObligation, checkContract, checkExecution, checkDeposit, checkWithdrawal, checkStake, checkUnstake, checkDelegation, and checkRewardClaim
- ACTION message fuzzing: 17 helper methods fuzzed for string construction safety, validates pipe delimiter injection, null/undefined/NaN coercion to string literals, object/array coercion, and Symbol rejection
- Connector fuzzing: all 6 connector constructors fuzzed with random host/port values, hub endpoint parsing with fuzzed HUB_VALIDATORS/HUB_URL/HUB_PORT, hub _call response handling with fuzzed axios responses, and waitForTx/waitForUtxos with fuzzed identifiers
- Crypto input fuzzing: wallet labels (strings, non-string types, Symbol rejection), coin/network combos (all 9 valid + random invalid), addressIndex (0-10000 + negative/float/NaN/Infinity), fuzzed mnemonics, and CryptoNetworks with random input types
- Config parsing fuzzing: hub config destructuring with missing/null/fuzzed-type keys, isNullOrNullString comprehensive type coverage documenting JS loose-equality traps (0, false, [] treated as null-like), env var validation pattern, and Database constructor with fuzzed connection params
- waitFor* polling fuzzed with bounded timeMax values (0, -1, NaN, random integers)
- `test:fuzz` and `test:fuzz:quick` npm scripts
- `fast-check` devDependency

## [0.2.5] - 2026-04-06

### Added
- Boundary test suite (144 tests across 6 files) for testing the test suite's operational limits, run with `npm run test:boundary`
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
- E2E test suite for the test suite itself (28 tests across 6 files), run with `npm run test:e2e`
- Tests validate bootstrap machinery, transaction pipeline (OP_RETURN and P2SH paths), action flow orchestration (issue-then-send chain, negative status detection, batch unpacking), polling reliability under real latency, teardown/cleanup, and result accuracy with false positive prevention
- `test:e2e` npm script with `--timeout 0` and `--require ./test/initialCheck.test.js`

## [0.2.3] - 2026-04-06

### Added
- Smoke test suite (7 files, 12 tests) for fast infrastructure health checks, run with `npm run test:smoke`
- Tests verify bootstrap globals, all 6 service connector pings, database schema presence, BIP39/BIP32 crypto toolchain, regtest mining control, GAS token existence, and a minimal ISSUE+SEND E2E round-trip
- `test:smoke` npm script with `--bail` flag for fast-fail behavior and 30s timeout

## [0.2.2] - 2026-04-06

### Added
- Integration test suite (72 tests) for test suite orchestration, run with `npm run test:integration`
- Tests cover bootstrap lifecycle (env-var and hub-discovery paths), transaction pipeline (OP_RETURN, UTXO caching, address funding), helper-to-DB assertion contracts (issue, send, dispenser, batch), database connection pool management, polling integration, wallet/UTXO state management, and error propagation across all layers
- `test:integration` npm script
- Shared mock fixtures for service responses, database rows, and mariadb ESM injection

## [0.2.1] - 2026-04-06

### Added
- Unit test suite (360 tests) for internal logic, run with `npm run test:unit`
- Tests cover CryptoNetworks, Database query builders/polling, all 21 action helpers, 6 service connectors, cryptoHelper, transactionHelper, and initialCheck bootstrap
- `sinon` dev dependency for test stubs
- `test:unit` npm script

## [0.2.0] - 2026-04-06

### Added
- VM e2e tests (`vm.test.js`), DEPLOY, EXECUTE with counter contract, constructor params
- Staking e2e tests (`staking.test.js`), STAKE, UNSTAKE, DELEGATE, duplicate stake rejection
- VM helper (`vmHelper.js`), sendDeployV0, sendExecuteV0, sendDepositV0, sendWithdrawV0
- Staking helper (`stakeHelper.js`), sendStakeV0, sendUnstakeV0, sendDelegateV0, sendRevokeDelegationV0, sendClaimRewardsV0
- 8 new DB polling methods: waitForContract, waitForExecution, waitForDeposit, waitForWithdrawal, waitForStake, waitForUnstake, waitForDelegation, waitForRewardClaim

## [0.1.0] - 2026-04-02

### Added
- COINPay E2E test infrastructure: coinpayHelper, coinpay.test.js with happy path settlement test
- Database polling methods: waitForOrderMatch, waitForCoinpay, waitForCoinpayObligation
- customOutputs parameter support in transactionHelper for native coin payment outputs
