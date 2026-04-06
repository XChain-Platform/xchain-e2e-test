# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
