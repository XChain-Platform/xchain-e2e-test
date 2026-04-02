# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-04-02

### Added
- COINPay E2E test infrastructure: coinpayHelper, coinpay.test.js with happy path settlement test
- Database polling methods: waitForOrderMatch, waitForCoinpay, waitForCoinpayObligation
- customOutputs parameter support in transactionHelper for native coin payment outputs
