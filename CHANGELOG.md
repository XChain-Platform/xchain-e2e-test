# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
