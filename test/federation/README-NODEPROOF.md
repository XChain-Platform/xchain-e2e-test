# NODEPROOF federation e2e - `multiHubNodeProof.test.js`

End-to-end proof of the verified-full-node tier (`NODEPROOF.md`) on a live
regtest federation: two FULL validators (each with a coin node) get verified by
the possession challenge; a LIGHT validator (no coin node) cannot answer, so it
accrues no passing epochs and earns no full-node tranche.

The tier is REWARD-ONLY. A validator that does not run a coin node is never
penalised for it: no failed-challenge slash exists, and its stake is untouched.
Eligibility is a participation RATE over a trailing window, so a single missed
epoch costs nothing.

> **Status:** venue-green on a live regtest federation. Needs the regtest stack
> plus a coin-node RPC, which a dev Mac does not host, so it skips without
> `FULLNODE_BTC_RPC_URL`.

## Prerequisites (venue: regtest)

The standard federation prerequisites (same as `test:federation`):
- regtest stack up: bitcoind + xchain-decoder + xchain-indexer + MariaDB
- `E2E_REQUIRE_FEDERATION=1` and the federation env (`HUB_DB_*`,
  `BTC_INDEXER_API_URL`, indexer DB vars) - see `test/initialCheck.test.js`

Plus **one NODEPROOF-specific var**:
- `FULLNODE_BTC_RPC_URL` - the regtest **bitcoind JSON-RPC** endpoint *with
  credentials*, e.g. `http://user:pass@127.0.0.1:18443`. The two full hubs use
  it to compute the possession answer (`getblockhash` + `getblock <hash> 2`).
  Absent ⇒ the test skips.

## Run

```bash
cd xchain-e2e-test
FULLNODE_BTC_RPC_URL='http://user:pass@127.0.0.1:18443' npm run test:federation:nodeproof
```

## What it does

1. Generates 3 fixed validator identities; hubs 0+1 are FULL (wired to
   `FULLNODE_BTC_RPC_URL`) and are the bootstrap `GENESIS_VERIFIERS`; hub 2 is
   LIGHT (no coin RPC).
2. Stakes all 3 pubkeys at `2500` XCHAIN (≥ `full_node` MIN_STAKE 2000), so all
   three are capability claimants; advances past activation.
3. Wires a shared publisher as the NODEPROOF verdict broadcast hook.
4. Mines across a challenge epoch (cadence 5 blocks, depth 2 - regtest-tuned via
   the helper's `fullnode` config). The `FullNodeChallengeRound` on each full hub
   derives the challenge, answers it, runs the sign round, and the leader posts
   the `NODEPROOF` verdict on-chain.

### Asserts
- `full_node_verifications` has `passed=1` rows for **both full** pubkeys.
- The **light** pubkey is **not** verified.
- Both full pubkeys accrue at least 2 DISTINCT passing epochs (a positive
  participation rate) while the light pubkey accrues none, so it earns no
  tranche. No slash is asserted, because none is issued.

## Out of scope here (covered elsewhere)
- **Two-tranche reward split** (`oracle_base` + `oracle_full_node`): a pure
  deterministic function, covered exhaustively by the indexer unit tests
  (`price.test.js` → `two-tranche full-node split` + `reward derivation is
  order-independent`). Driving a real PRICE oracle round needs the oracle
  subsystem, which `MultiValidatorHub` skips.
- **Sync-mirror data parity**: `xchain-sync`'s own e2e (`test/e2e/lifecycle.test.js`)
  covers replica byte-parity; `full_node_verifications` is registered in
  `replicatedTables.js`, so a real sync client receives the verdict rows.

## Caveats to verify on the venue
- **EQUIV regtest activation must match across copies.** The NODEPROOF canonical
  is EQUIV-wrapped at/above `EQUIV_HEADER_ACTIVATION.regtest` (currently `120` in
  the hub copy). The hub (`FullNodeChallengeRound`) and indexer (`nodeproof.js`)
  must agree on that threshold, or signature verification fails. Ensure the chain
  is past the threshold (or that both copies use the same value) before asserting.
- **Harness support is additive**: `multiValidatorHubHelper.js` gained
  `opts.fullnode`, `opts.coinRpcUrls`, and `setNodeProofBroadcastHook()` - no
  behavior change for existing federation tests when unused.
