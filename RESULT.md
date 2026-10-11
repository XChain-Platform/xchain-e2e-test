# Lane report: cx-xc-4755

## Files touched

- test/integration/parity/anchor_bundle_wire_parity.test.js

The describe callback (146 lines) now calls five named registrars, in the
original test order: registerHubProducerTests (18 lines),
registerIndexerReadbackTest (41), registerSdkReadbackTest (29),
registerParserAgreementTests (36), registerSnapshotBlockTest (25). The test
bodies were moved verbatim; no titles, assertions or helpers changed. The file
is 273 physical lines (limit 400).

## Checks run in this session

- `node --check test/integration/parity/anchor_bundle_wire_parity.test.js`: pass.
- Static title check: 7 `it` titles found; sha256 of the newline-joined
  fullTitles (describe title + space + it title), first 16 hex chars:
  `b790d387ead4d119`, which matches the pinned value.
- Function length check (awk over top-level functions): longest is 41 lines,
  none over 60.

## Not run here (orchestrator should run the Verify command)

- mocha: this hosted container has only xchain-e2e-test checked out. The suite
  requires the sibling repos xchain-documentation, xchain-hub, xchain-indexer and
  xchain-sdk (resolved from `../../../..`), and node_modules is not installed,
  so the 7 tests could not be executed (0 passes, 0 failures recorded here).
- claude/bin/check-code-structure.js is not present in this container, so the
  overLimitFunctions and repo-wide structure checks were not run. Expected
  result: 0 functions over 60 lines, 273 physical lines.

RUN-COMPLETE b2049a06f8bca5ea5cc0ad5fdfc489b9
