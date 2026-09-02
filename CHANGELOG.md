# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Fixture stakes are now released when a run ends, so a run leaves the venue's capability set no larger than it found it.
- The suite reports, and can fail on, any staking key a run leaves behind in the shared venue.
- A gate that fails any hand-built STAKE broadcast which bypasses the release ledger.

## [0.11.0] - 2026-08-25

### Changed
- Clarified in the README that Bitcoin, Litecoin, and Dogecoin are the coins the platform runs today, not the definition of the platform.

### Fixed
- Updated the BTC mainnet reward pool address in the vendored coin bundles.
- Corrected the vendored coin bundles' fee-destination comment to say the override is regtest-only.
- Re-pinned the BTC, LTC, and DOGE testnet genesis heights to match the platform's fresh testnet genesis.
- Corrected the NODEPROOF documentation to describe the reward-only validator model.

## [0.10.0] - 2026-08-22

Joins the platform version stream. This component moves from `0.3.9` to
`0.10.0`. **The number is higher but nothing was skipped**: the platform stream
names the train a component shipped in, and this component shipped in v0.10.0.
Versions below this line are its own legacy stream and are not comparable.

### Changed
- Adopted the platform version stream, so the version now matches the `v0.10.0` train tag.
- Sibling checkouts resolve at the release branch when CI builds a release PR, so a train's version bumps are visible to the staged-snapshot guard.

### Fixed
- The staged lockfile snapshot records the train's `xchain-hub` version rather than a superseded one.
- The state-commitment conformance probe carries `doQueryStrict`, which the follower's read path moved to; it previously failed on every coin.
- The batch cost-weighting pair is gated on segwit support, so it no longer attempts a native-segwit address on Dogecoin.

## [0.3.9] - 2026-08-13

### Fixed
- `bin/seed-contract-state.js`: read the deployed contract's index from every `actionWaiter` settle shape and verify it against the explorer before recording it.
- `bin/seed-contract-state.js`: count live contract keys from the paginated read's total instead of the returned page, with an iteration ceiling and a no-progress brake.
- `bin/seed-contract-state.js`: drop a non-existent field from the gas ISSUE and refuse in preflight when the seed contract exceeds the inline DEPLOY budget.
- `bin/contracts/spvSeed.js`: trimmed the contract source so it fits one inline DEPLOY.
- `bin/seed-contract-state.js`: refuse LTC/DOGE up front, since their native-coin protocol fee would get the seed action rejected.

### Added
- `test/unit/seedContractStateHelpers.test.js`: pin the seed tool's parsing helpers against the real settle shapes.
- `bin/seed-contract-state.js` and `bin/contracts/spvSeed.js`: seed a live chain with real contract state ahead of its armed activation height.
- `test/unit/spvSeedContract.test.js`: run the seed contract under the real VM and BTC gas schedule.

### Fixed
- `test/actions/xchainPriceDerivation.test.js`: render drill prices as strings so the ORDER wait predicate can bind them.
- `test/actions/xchainPriceDerivation.test.js`: page the hub price-snapshot endpoint to exhaustion so newer rounds stay visible on a busy venue.
- Added a CI workflow with a coin-registry drift-guard job (the repo previously had no CI at all).

### Added
- `test/actions/xchainPriceDerivation.test.js`: prove a native fee priced off the derived XCHAIN/USD via the on-chain consensus path, bypassing the wall-clock-anchored preflight quote.
- Every XCHAIN/USD seed site is now suppressible via `XCHAIN_E2E_NO_PRICE_SEED`, enforced by `test/unit/xchainPriceSeedGuard.test.js`.

### Added
- `test/federation/multiHubLlmOutage.test.js`: LLM attestation outage drills covering throttled error publication, mid-window recovery, leader rotation, the model fallback ladder, and the hard-kill backstop.
- `test/sdk/dexCrossRoyaltyLive.sdk.test.js`: live multi-hub royalty drill asserting the guard legs ride the signed match and the proceeds leg settles the split.
- Cross-chain royalty parity suite pins the vendored activation map against the canonical source.
- Hub connector sends an API key header when configured, so suites run against keyed hubs.

### Fixed
- `test/sdk/dexDogeSetup.js`: anchor oracle price seeding to the later of chain tip time or wall clock so seeds pass the freshness gate on an idle chain.
- Regenerated the field-level golden vectors, re-pinning several action formats and adding coverage for previously-unpinned ones.

## [0.3.8] - 2026-06-20

### Fixed
- Corrected the Litecoin dust threshold across the codebase and test suites.
- `test/sdk/messaging.sdk.test.js`: replaced the stub MESSAGE case with a real round-trip through the SDK's send/encrypt/decrypt path.
- `src/XChainHubConnector.js`: record per-endpoint failure details so multi-endpoint outages give actionable diagnostics.
- `src/XChainHubConnector.js`: surface a degraded status instead of masking it as fully unreachable when a live hub's DB pool is down.
- `src/XChainHubConnector.js`: unwrap the hub's config envelope correctly, fixing a crash with no diagnostic.

### Added
- `test/regression/xcallDeliveryLag.regression.test.js`: regression guard proving the hub's cross-chain call margin prevents live/replay divergence under a delivery lag.
- `test/integration/multiHubGovernanceCapReload.integration.test.js`: federation guard asserting every hub, not just the tally leader, converges on a governance change.
- `test/e2e/02-transaction-pipeline.e2e.js`: added a large-payload segwit case and an over-length payload rejection case.
- `test/e2e/03-chain-specific.e2e.js`: added chain-gated cases for Litecoin MWEB and Dogecoin AuxPoW headers.
- `test/transactionHelper.js`: the two-transaction reveal flow now also drives P2WSH, not just P2SH.
- Added JSON-RPC connectors for the decoder and explorer services, pinged during bootstrap so a crash surfaces immediately.
- `test/actions/attestation.test.js`: coverage for retryable attestation response statuses and late recovery to fulfilled.
- `test/sdk/misc.sdk.test.js`: assert the SDK status call exposes decoder tip and lag per coin.

### Changed
- Renamed `INDEXER_HOST` to `INDEXER_URL` to match the naming convention used by every other service.
- Pinned several dependencies to exact versions for a reproducible install tree.
- Migrated the remaining HTTP client usage to a single library across all service connectors.
- A connector's `ping()` now returns false on any network error instead of throwing, matching every other connector.
- Aligned a dependency range and a version floor to match the rest of the platform.
- Updated the SWEEP schema handling to match the current wire format.
- The contract code-size drift guard now also checks the indexer and VM isolate limits against the canonical protocol constant.
- The mainnet ingest floor now matches the encoder and decoder.
- Dependency installs are now reproducible: the lockfile is committed and the Docker image installs from it.
- `test/e2e/02-transaction-pipeline.e2e.js`: added a live bare-multisig encoding case with a real compressed public key.
- Added a `health()` wrapper for the indexer connector.

## [0.3.7] - 2026-05-28

### Changed
- `db.js`: simplified an error-logging path to a single structured call.

## [0.3.6] - 2026-05-28

### Security
- Raised the minimum `axios` version to close a credential-injection/request-hijacking vulnerability on clean installs.

## [0.3.5] - 2026-05-28

### Security
- Pinned `qs` to remediate a denial-of-service vulnerability.

## [0.3.4] - 2026-05-28

### Fixed
- `cryptoHelper.getNewAddress()` now returns the wallet's stored mnemonic, fixing a null return on subsequent calls.

## [0.3.3] - 2026-04-06

### Changed
- Moved the coverage badge to its own line in README.md for cleaner formatting.

## [0.3.2] - 2026-04-06

### Changed
- `README.md`: expanded from a minimal stub to a full component README matching platform conventions.

## [0.3.1] - 2026-04-06

### Added
- Regression test suite covering critical test-framework infrastructure.
- A three-tier execution model for per-commit, merge-gate, and full regression runs.

## [0.3.0] - 2026-04-07

### Added
- Mutation testing infrastructure to assess test suite defect-detection capability.
- A mutation report generator producing per-file scores and survived-mutant details.

## [0.2.9] - 2026-04-06

### Added
- Chaos engineering test suite targeting test-infrastructure resilience.
- Shared chaos helpers module with mock connection/pool factories and global save/restore utilities.

## [0.2.8] - 2026-04-06

### Added
- Performance testing framework with a custom Mocha reporter, poll instrumentation, and a CI gate.
- A performance metrics collector for bootstrap phase timing and poll tracking.
- Poll instrumentation across every polling method in `src/db.js`.
- Bootstrap phase timing in `initialCheck.test.js`.
- A CI performance gate checking suite time, per-test max, peak memory, and poll overhead.
- A markdown report generator for slowest tests, bootstrap breakdown, and memory trend.

## [0.2.7] - 2026-04-06

### Security
- Masked RPC and database credentials in diagnostic output.
- Removed a log statement that exposed private keys to stdout.
- Added a mainnet guard so the suite refuses to run against mainnet without an explicit opt-in.
- Redacted full transaction hex from logs, showing only length.
- Zeroed out private keys and seed buffers in teardown.
- Closed the database connection pool in teardown to prevent resource leaks.
- Removed verbose error logging that could leak connection details.
- Stopped baking `.env` into Docker image layers; credentials are now passed at runtime.

### Removed
- Unused hardcoded credential constants from `cryptoHelper.js`.

### Fixed
- Resolved dependency audit vulnerabilities via override pins.

## [0.2.6] - 2026-04-06

### Added
- Fuzz test suite using property-based testing for database filters, action messages, connectors, crypto inputs, and config parsing.
- Custom fuzz generators for XChain-specific types and edge cases.

## [0.2.5] - 2026-04-06

### Added
- Boundary test suite covering polling, connection pool, WHERE-clause construction, identifiers, connectors, global state, and error propagation at operational limits.

## [0.2.4] - 2026-04-06

### Added
- End-to-end test suite for the test harness itself: bootstrap, transaction pipeline, action flow orchestration, polling reliability, teardown, and result accuracy.

## [0.2.3] - 2026-04-06

### Added
- Smoke test suite for fast infrastructure health checks: bootstrap globals, service connector pings, database schema, crypto toolchain, mining control, and a minimal issue-and-send round trip.

## [0.2.2] - 2026-04-06

### Added
- Integration test suite for test-suite orchestration: bootstrap lifecycle, transaction pipeline, helper-to-DB assertion contracts, connection pool management, polling, and state management.
- Shared mock fixtures for service responses, database rows, and driver injection.

## [0.2.1] - 2026-04-06

### Added
- Unit test suite for internal logic: network config, database query builders and polling, action helpers, service connectors, crypto and transaction helpers, and bootstrap.

## [0.2.0] - 2026-04-06

### Added
- VM end-to-end tests: DEPLOY and EXECUTE with a counter contract and constructor params.
- Staking end-to-end tests: STAKE, UNSTAKE, DELEGATE, and duplicate-stake rejection.
- VM and staking test helpers.
- Additional database polling methods for the new action types.

## [0.1.0] - 2026-04-02

### Added
- COINPay end-to-end test infrastructure with a happy-path settlement test.
- Database polling methods for order matching and COINPay obligations.
- Custom-outputs support in the transaction helper for native coin payments.
