# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is the **XChain Platform End-to-End Test Suite** — a Mocha-based integration test suite that validates the XChain platform by exercising all its services together against a live regtest blockchain environment.

## Commands

```bash
# Install dependencies
npm install

# Run all tests
npm test

# Run a specific test file
npx mocha --timeout 0 --require ./test/initialCheck.test.js test/main.test.js

# Run in Docker
docker build -t xchain-e2e-test . && docker run --env-file .env xchain-e2e-test
```

## Configuration

Tests require a `.env` file (gitignored). Either provide all service endpoints directly, or provide `HUB_URL`/`HUB_PORT` and the hub will supply the rest.

**Required env vars (or sourced from hub):**
```
COIN=bitcoin          # or dogecoin, litecoin
NETWORK=regtest       # or testnet, mainnet

NODE_URL=...
NODE_PORT=...
NODE_USER=...
NODE_PASSWORD=...

UTXO_TRACKER_URL=...
UTXO_TRACKER_API_PORT=...

ENCODER_URL=...
ENCODER_API_PORT=...

INDEXER_HOST=...
INDEXER_API_PORT=...
INDEXER_DB_NAME=...
INDEXER_DB_USER=...
INDEXER_DB_PASS=...

REGTEST_MINER_URL=...
REGTEST_MINER_API_PORT=...

# Optional — only needed if above vars are missing
HUB_URL=...
HUB_PORT=...
```

The MariaDB hostname is hardcoded to `"mariadb"` on port `3306` when sourced from the hub (meant for Docker Compose environments). The `DATABASE_URL`/`DATABASE_PORT` env vars are unused by the hub fallback path.

## Architecture

### Service Connectors (`src/`)

Each connector wraps a JSON-RPC API for one XChain platform service:

| File | Service | Key Methods |
|------|---------|-------------|
| `BlockchainConnector.js` | Coin daemon (Bitcoin-style node) | `getNetworkInfo`, `broadcastTx`, `getTransactionHex`, `waitForTx` |
| `XChainUtxoTrackerConnector.js` | UTXO Tracker | `getUtxosFromAddress`, `waitForUtxos` |
| `XChainEncoderConnector.js` | Encoder | `createTx` (builds PSBTs with XChain OP_RETURN data) |
| `XChainIndexerConnector.js` | Indexer | `ping` |
| `XChainHubConnector.js` | Hub (config discovery) | `getAllConfig` |
| `RegtestMinerConnector.js` | Regtest Miner | `sendFunds`, `setMiningTime`, `setDefaultMiningTime` |
| `db.js` | MariaDB (Indexer DB) | `checkIssue`, `waitForIssue`, `checkSend`, `waitForSend` |
| `CryptoNetworks.js` | Static helper | `getBitcoinJsNetwork` — returns bitcoinjs-lib network config for BTC/DOGE/LTC |

### Test Files (`test/`)

- **`initialCheck.test.js`** — Mocha root hooks (`beforeAll`/`afterAll`). Always loaded first via `--require`. Initializes all connectors as globals, pings every service, and speeds up regtest mining to 1s intervals. Restores default mining time in `afterAll`.

- **`main.test.js`** — The actual test cases. Currently tests Issue v0, Issue v1, and Send operations. Tests run **in order** and share state — the Send test depends on the wallet and tick created by the Issue v0 test.

- **`cryptoHelper.js`** — Generates BIP39/BIP32 wallets. Stores wallets in a global `wallets` object keyed by label (e.g., `"ISSUE.V0"`, `"SEND.V0"`), persisting addresses across test cases.

- **`transactionHelper.js`** — Builds and broadcasts transactions. Calls the encoder to create a PSBT, signs it locally with the private key, then broadcasts via the node connector. Handles both standard and P2SH encoding types (P2SH requires a two-transaction flow).

### Test Flow

Each test follows this pattern:
1. Generate a new address via `cryptoHelper.getNewAddress`
2. Fund it via `regtestMinerConnector.sendFunds`
3. Wait for the UTXO to appear in the UTXO tracker
4. Build an XChain protocol message string (pipe-delimited)
5. Create, sign, and broadcast the transaction via `transactionHelper.createAndSendTransaction`
6. Poll the indexer's MariaDB until the expected record appears (via `db.waitForIssue` / `db.waitForSend`)
7. Assert the record exists

### XChain Protocol Messages

Messages are pipe-delimited strings embedded in transactions as OP_RETURN data:
- **Issue v0**: `ISSUE|0|TICK|maxSupply|maxMint|decimals|description|mintSupply|...` (26 fields)
- **Issue v1**: `ISSUE|1|TICK|description`
- **Send v1**: `SEND|1|TICK|amount|destinationAddress|memo`

## Key Notes

- `--timeout 0` disables Mocha's default timeout — tests have their own polling loops with explicit `timeMax` parameters.
- Test ordering matters: do not reorder tests in `main.test.js` without checking cross-test wallet dependencies.
- The `transactionHelper` uses globals (`encoderConnector`, `nodeConnector`, `NETWORK_OBJECT`) injected by `initialCheck.test.js`.
- `CryptoNetworks.getFirstBlock` is a stub (returns hardcoded values) with a TODO to fetch from a server.
