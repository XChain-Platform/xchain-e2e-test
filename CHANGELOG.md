# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
