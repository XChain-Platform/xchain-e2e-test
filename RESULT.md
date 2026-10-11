# Lane report: cx-xc-4756

## Files touched
- test/integration/parity/anchor_reward_parity.test.js

## Change
- The 87-line ANCHOR_REWARD describe callback now calls registerAnchorConstantChecks (42 lines) and registerAnchorCanonicalChecks (45 lines).
- The 69-line ARCHIVE_REWARD describe callback now calls registerArchiveConstantChecks (24 lines) and registerArchiveCanonicalChecks (34 lines).
- hubArchXancpub and archiveFixtures moved from inside the archive describe to module scope, with no change to their bodies.
- Test titles, order and assertions are unchanged. The file is 252 physical lines, down from the 400 limit. Its longest function is 45 lines.

## Test commands
- `node --check test/integration/parity/anchor_reward_parity.test.js`: pass.
- Title check: I loaded the base and changed files with stubbed describe/it and stubbed sibling-repo requires. Both register 11 tests, and the sha256 of the joined full titles is fee877a5db7dabcb in both. That matches the pinned value.
- The full Verify command was NOT run in this session. It needs the sibling repos (xchain-hub, xchain-indexer, xchain-documentation) and claude/bin/check-code-structure.js, and none of them exist in this container. node_modules is not installed either, so the mocha pass/fail counts (pinned 11 0) were not measured here. The orchestrator should run Verify in the full workspace.

## Notes
- The harness named claude/anchor-reward-parity-split-u2dycs as the session branch. Per the run contract, the work was pushed to claude/run-647ba9a0fa1e only.

RUN-COMPLETE 4260ea6951728f04663c467fb6700829
