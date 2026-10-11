# Lane report: cx-xc-4762

## Files touched

- test/unit/oracle_batch_barrier_testnet_alignment.test.js: no new change this round. The split was already made by the base commit 47d46f5 ("Split oracle barrier alignment describe callbacks into named registrars"), and I checked it again here.
- RESULT.md (this report, committed alone).

## Why attempt 2 failed: the surface file did not cause it

The failed attempt stopped at the final `git diff --exit-code HEAD` step. The diff it printed was in `package-lock.json`, not in the surface file. The hunk near line 9012 is inside the `xchain-sdk` package entry. That package is installed from `file:./xchain-sdk` (package.json line 20), and the entry records the sibling SDK's own devDependencies. The lane's sibling `xchain-sdk` snapshot lists `@modelcontextprotocol/sdk` and `supertest`, but the committed lockfile entry does not, so `npm install`/`npx` rewrote `package-lock.json` while the verify ran. Every check before that step passed: 0 functions over 60 lines and the pinned 26 0 1ca20c756bcdcb63.

`package-lock.json` is outside Surfaces, so I did not edit it. The orchestrator should do one of these:
- sync the sibling `xchain-sdk` snapshot with what the committed lockfile records, or
- install with `npm ci` (which never writes the lockfile) before the verify, or
- open a separate row that refreshes `package-lock.json` for the current SDK snapshot.

## Test commands and results (this hosted session)

- `npm ci --ignore-scripts`: installed 725 packages and left the lockfile unchanged (`git status` clean afterwards).
- Function length (acorn walk over every function node, the same idea as the structure checker): 0 functions over 60 lines, longest 37, file length 512 lines.
- `node --check test/unit/oracle_batch_barrier_testnet_alignment.test.js`: pass.
- `npx mocha --no-config ... test/unit/oracle_batch_barrier_testnet_alignment.test.js`: could not run here. The suite needs the sibling `xchain-hub` checkout (`test/helpers/multiValidatorHubHelper.js` throws "cannot resolve xchain-hub source"), and that checkout is not in this container. So this session has 0 passes and 0 failures recorded from a real mocha run.
- Title check instead: I loaded the file with stub `describe`/`it` globals and unresolvable modules replaced by inert proxies, then collected the full titles in order. Base ab88dbc file: 26 tests, titles sha256 prefix 1ca20c756bcdcb63. Current file: 26 tests, 1ca20c756bcdcb63. Both match the pin.
- `claude/bin/check-code-structure.js` is not present in this container (it lives outside the repository), so that step was not run here.
- `git diff --exit-code HEAD`: clean after `npm ci`.

## Notes for the orchestrator

- Branch: the harness gave this session `claude/run-924e05ae2126-u21ahl` as its push branch, so the result is pushed there. It is built on base commit 47d46f579ffe6d9f5b89e1aed030950bed1c31f2, which I fetched and checked against `claude/base-924e05ae2126`.
- Scratch output went under tmp/, which is not committed.

RUN-COMPLETE d1b7aa0578139f1cf611d95fd7942277
