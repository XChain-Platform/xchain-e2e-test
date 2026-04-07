<!-- SPDX-License-Identifier: LicenseRef-Dankest-Community -->
<!-- Copyright © 2025 Dankest, LLC -->

# XChain Platform End-to-End Test Suite

<p align="center">
  <img src="https://img.shields.io/badge/version-0.3.1-blue" alt="Version">
  <img src="https://img.shields.io/badge/tests-953%2B%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/coverage-unit%20%7C%20integration%20%7C%20e2e%20%7C%20fuzz%20%7C%20chaos%20%7C%20mutation%20%7C%20boundary%20%7C%20smoke%20%7C%20regression-brightgreen" alt="Coverage">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="Node">
  <img src="https://img.shields.io/badge/license-Dankest%20Community-orange" alt="License">
</p>

End-to-end Mocha test suite for the XChain Platform. Exercises the full platform stack — encoder, decoder, indexer, explorer, hub, UTXO tracker, and regtest miner — against a live regtest deployment. Tests are not mocked; they broadcast real transactions to a regtest coin node and verify that the platform processes them correctly end to end.

## Features

- **27 ACTION test suites** — ISSUE (V0–V5), SEND (V0–V3), MINT, DESTROY, ORDER, DISPENSER, SWAP, DIVIDEND, AIRDROP, FILE, MESSAGE, BROADCAST, ADDRESS, LINK, LIST, CALLBACK, BATCH, SWEEP, SLEEP, COINPAY, STAKE, DEPLOY, EXECUTE, DEPOSIT, WITHDRAW
- **Full transaction lifecycle** — BIP39/BIP32 wallet generation → regtest funding → PSBT construction → signing → broadcast → mining → indexer verification
- **7 service connectors** — BlockchainConnector, XChainUtxoTrackerConnector, XChainEncoderConnector, XChainIndexerConnector, XChainHubConnector, RegtestMinerConnector, and MariaDB Database class
- **Hub auto-discovery** — falls back to xchain-hub for service endpoint resolution when env vars are not set
- **Multi-chain support** — Bitcoin, Litecoin, and Dogecoin on regtest
- **P2SH two-step encoding** — automatic detection and handling of two-transaction P2SH flows for messages exceeding 76 bytes
- **Database polling assertions** — 30+ `waitFor*` methods that poll the indexer MariaDB until ACTION records appear, with configurable timeouts and performance tracking
- **UTXO verification cache** — tracks confirmed UTXOs between transactions to avoid stale mempool entries
- **Wallet memory cleanup** — seed and private key buffers are zeroed during teardown
- **Performance instrumentation** — bootstrap phase timing, per-poll metrics, custom Mocha reporter writing JSON to `perf-results/`
- **Mutation testing** — Stryker Mutator with two-phase config (unit-only and unit+integration)
- **953+ tests** — unit, integration, e2e, smoke, boundary, fuzz, chaos, regression, mutation, and performance

## Documentation

Full documentation is available in the [xchain-documentation](https://github.com/XChain-platform/xchain-documentation/tree/master/components/e2e-test) repository:

| Document | Description |
|---|---|
| [README](https://github.com/XChain-platform/xchain-documentation/blob/master/components/e2e-test/README.md) | Overview, architecture, test lifecycle, service connectors |
| [Architecture](https://github.com/XChain-platform/xchain-documentation/blob/master/components/e2e-test/ARCHITECTURE.md) | Data flow, connector classes, bootstrap sequence, polling pattern |
| [Configuration](https://github.com/XChain-platform/xchain-documentation/blob/master/components/e2e-test/CONFIGURATION.md) | Environment variables, hub discovery fallback, Docker setup |
| [Operations](https://github.com/XChain-platform/xchain-documentation/blob/master/components/e2e-test/OPERATIONS.md) | Running tests, Docker execution, troubleshooting, CI integration |

## Quick Start

Clone the repository and install dependencies:

```bash
git clone https://github.com/XChain-platform/xchain-e2e-test.git
cd xchain-e2e-test
npm install
```

Create a `.env` file (or let the suite discover config from xchain-hub):

```env
COIN=bitcoin
NETWORK=regtest
NODE_URL=localhost
NODE_PORT=18443
NODE_USER=rpc
NODE_PASSWORD=rpc
UTXO_TRACKER_URL=localhost
UTXO_TRACKER_API_PORT=3030
ENCODER_URL=localhost
ENCODER_API_PORT=3031
INDEXER_HOST=localhost
INDEXER_API_PORT=3032
INDEXER_DB_NAME=XChain_BTC_Regtest_Indexer
INDEXER_DB_USER=indexer_user
INDEXER_DB_PASS=indexer_pass
REGTEST_MINER_URL=localhost
REGTEST_MINER_API_PORT=3033
```

Run the full action test suite (requires all services running):

```bash
npm test
```

Run tests that don't require live services:

```bash
npm run test:unit
npm run test:regression:p0
```

## Scripts

| Command | Description |
|---|---|
| `npm test` | Full action test suite (27 action types, `--timeout 0`, requires live stack) |
| `npm run test:unit` | Unit tests (360 tests, no services required) |
| `npm run test:integration` | Integration tests (72 tests, stubbed I/O) |
| `npm run test:e2e` | E2E meta-tests (37 tests, validates suite against live services) |
| `npm run test:smoke` | Smoke tests (16 tests, quick bootstrap and connectivity checks) |
| `npm run test:boundary` | Boundary tests (144 tests, edge cases and limits) |
| `npm run test:fuzz` | Fuzz tests (53 tests, property-based via fast-check) |
| `npm run test:fuzz:quick` | Quick fuzz (30s timeout) |
| `npm run test:chaos` | Chaos engineering tests (77 tests, failure injection) |
| `npm run test:chaos:quick` | P0 chaos only |
| `npm run test:regression` | Full regression suite (114 tests, P0+P1+P2) |
| `npm run test:regression:p0` | Regression P0 — critical gate (74 tests, < 500ms) |
| `npm run test:regression:p0p1` | Regression P0+P1 — merge gate (94 tests, < 500ms) |
| `npm run test:perf` | Performance tests with custom reporter |
| `npm run test:perf:actions` | Performance-instrumented action tests |
| `npm run test:perf:e2e` | Performance-instrumented E2E tests |
| `npm run test:mutate` | Mutation testing — Phase 1 (unit tests only) |
| `npm run test:mutate:integration` | Mutation testing — Phase 2 (unit + integration) |
| `npm run perf:gate` | CI performance gate check |
| `npm run perf:report` | Generate performance report |
| `npm run mutate:report` | Generate mutation testing report |

## Test Suite

| Type | Tests | Description |
|---|---|---|
| Unit | ~360 | Connector methods, cryptoHelper, transactionHelper, action helpers, initialCheck logic, perfCollector |
| Integration | ~72 | Bootstrap flow, pipeline wiring, database polling, error propagation, wallet/UTXO cache |
| E2E | ~37 | Full lifecycle validation against live services (bootstrap, transaction pipeline, polling, teardown) |
| Smoke | ~16 | Bootstrap env vars, connector pings, database connectivity, crypto wallet, mining, gas token |
| Boundary | ~144 | WHERE clause construction, connector URL building, polling timeouts, connection pool exhaustion, global state |
| Fuzz | ~53 | Action message mutation, config parsing, connector inputs, crypto inputs, DB filters, type confusion |
| Chaos | ~77 | Bad PSBT, connector timeouts, DB disconnect, gas bootstrap failure, teardown failure, UTXO/wallet races |
| Regression | ~114 | Tagged cross-suite subset — P0 (74), P1 (20), P2 (20) |
| Mutation | 2 phases | Stryker Mutator: Phase 1 (unit), Phase 2 (unit + integration) |
| Performance | 3 modes | Custom Mocha reporter, bootstrap timing, poll instrumentation |
| Actions | ~80 | Full action tests against live regtest (ISSUE, SEND, MINT, etc.) |
| **Total** | **~953+** | |

## Dependencies

### Runtime

| Package | Purpose |
|---|---|
| `axios` | HTTP client for Encoder, Hub, Indexer, and Miner JSON-RPC calls |
| `cross-fetch` | Fetch API for Blockchain Node and UTXO Tracker JSON-RPC calls |
| `bitcoinjs-lib` | Bitcoin primitives — PSBT construction, transaction signing, address generation |
| `bip32` | BIP32 HD wallet key derivation |
| `bip39` | BIP39 mnemonic seed generation |
| `ecpair` | ECDSA key pair creation for PSBT signing |
| `tiny-secp256k1` | Elliptic curve math backend for BIP32 and ECPair |
| `mariadb` | MariaDB client for indexer database polling |
| `mocha` | Test framework (`--timeout 0` for on-chain confirmation polling) |
| `dotenv` | Environment variable loading from `.env` files |

### Development

| Package | Purpose |
|---|---|
| `sinon` | Mocking, stubbing, and spying for unit and integration tests |
| `fast-check` | Property-based (fuzz) testing with automatic shrinking |
| `@stryker-mutator/core` | Mutation testing framework |
| `@stryker-mutator/mocha-runner` | Mocha integration for Stryker |

## Related

- [Regtest Development Guide](https://github.com/XChain-platform/xchain-documentation/blob/master/developer-guide/REGTEST_DEVELOPMENT.md) — setting up a local regtest environment
- [Regtest Miner](https://github.com/XChain-platform/xchain-regtest-miner) — auto-mining service the E2E suite depends on
- [Encoder](https://github.com/XChain-platform/xchain-encoder) — constructs XChain transactions tested by this suite
- [Indexer](https://github.com/XChain-platform/xchain-indexer) — processes transactions and maintains token state verified by this suite
- [Testing Guide](https://github.com/XChain-platform/xchain-documentation/blob/master/developer-guide/TESTING.md) — platform-wide testing philosophy and coverage

---

**Copyright &copy; 2025 Dankest, LLC**

**Based on XChain Platform by Dankest, LLC &ndash; https://dankest.llc**

Licensed under the **Dankest Community License**
(based on the Apache License 2.0 with additional non-commercial and network-disclosure terms).

You may not use, modify, or distribute this material except in compliance with the License.
See [LICENSE](./LICENSE.md) and [NOTICE](./NOTICE.md) for full terms.
A full copy of the License is also available at: [https://dankest.llc/license](https://dankest.llc/license)
