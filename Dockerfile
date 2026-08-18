# Pin Node 22 (bookworm, not alpine): the platform requires Node 22 exactly.
# node:latest resolves to Node 24+, which can't build isolated-vm, and alpine's
# musl breaks native addon builds. Matches xchain-indexer's base image.
FROM node:22-bookworm

RUN mkdir /XChainE2ETest/
# xchain-hub is staged into the build context by xchain-node's install
# path (LIBRARY_BUNDLES). multiValidatorHubHelper requires its source
# directly; the file: link in package.json pulls in xchain-hub's
# transitive npm deps (express, cors, ws, etc.) into the e2e image.
# Must precede the package.json COPY so npm ci can resolve the
# file:./xchain-hub dep.
COPY ./xchain-hub /XChainE2ETest/xchain-hub
# xchain-sdk is staged the same way (LIBRARY_BUNDLES) so the test:sdk
# suites can resolve it via the file: dep inside the image.
COPY ./xchain-sdk /XChainE2ETest/xchain-sdk
COPY ./package.json /XChainE2ETest/package.json
COPY ./package-lock.json /XChainE2ETest/package-lock.json
WORKDIR /XChainE2ETest
# Deliberately a bare `npm ci`, not `npm ci --omit=dev` like the service images
# (regtest-miner, utxo-tracker). This is the test-harness image: mocha, chai,
# stryker and the rest of the runner live in devDependencies, so omitting them
# leaves an image with nothing to run. The consequence to keep in mind when
# reading an audit report against this image is that dev-only advisories ARE in
# its layers, unlike every service image on the platform. That is why the
# dev-only pins in package.json's overrides block are held at the patched
# versions rather than left to float.
RUN npm ci

COPY ./src /XChainE2ETest/src
COPY ./test /XChainE2ETest/test

# xchain-contracts is staged into the build context by xchain-node's install
# path (LIBRARY_BUNDLES), same as xchain-hub/xchain-sdk above. It is plain
# contract-template source (no npm deps), so it lands after npm ci to avoid
# invalidating the dependency cache layer. The template suites resolve it via
# XCHAIN_CONTRACTS_DIR=/XChainE2ETest/xchain-contracts (set by ConfigService);
# at runtime a missing checkout makes those suites skip rather than abort the run.
COPY ./xchain-contracts /XChainE2ETest/xchain-contracts

# xchain-indexer is staged into the build context by xchain-node's install path
# (LIBRARY_BUNDLES), same as xchain-hub/xchain-sdk/xchain-contracts above. Several
# e2e suites share the indexer's consensus-critical primitives by requiring its
# source directly (test/helpers/attestationHelper.js, test/integration/**,
# test/integration/parity/**, test/regression/**). Those requires use
# '../../../xchain-indexer/src/...' (and path.join(ROOT,'xchain-indexer/...')) which
# resolve to the MONOREPO ROOT locally but to the IMAGE ROOT here - because the test
# tree lives under /XChainE2ETest, three levels up from test/helpers lands at /.
# So the COPY target MUST be /xchain-indexer (image root), NOT /XChainE2ETest/xchain-indexer.
# Plain JS source (its npm deps that the loaded files need - e.g. mathjs@15.2.0 for
# stake_weighted_quorum.js - are already satisfied by xchain-hub/xchain-sdk's pinned
# deps via npm ci), so it lands after npm ci to avoid invalidating the dependency cache.
COPY ./xchain-indexer /xchain-indexer

# Node resolves a module's OWN `require('pkg')` by walking node_modules up from the
# requiring FILE's directory - for /xchain-indexer/src/*.js that's /xchain-indexer/
# node_modules then /node_modules, NEVER /XChainE2ETest/node_modules where npm ci
# installed the deps. So the bundled indexer can't see mathjs (which stake_weighted_
# quorum.js requires) without help. Symlink its node_modules to the image's installed
# tree: mathjs@15.2.0 is present there (via xchain-hub/xchain-sdk's pinned deps), so
# the consensus-primitive files the e2e suites load resolve. Indexer files that need
# deps absent here (xchain-vm, express, ws) still fail if loaded - none are on the
# default attestation path, and they were already unreachable before this change.
RUN ln -s /XChainE2ETest/node_modules /xchain-indexer/node_modules

# xchain-sync is staged into the build context by xchain-node's install path
# (LIBRARY_BUNDLES) for ONE suite: consensusHashConformance recomputes each block's
# hashes with sync's BlockHasher and compares them to the indexer's committed values,
# which is the only place the two implementations meet over real stack data. Its
# requires use '../../../xchain-sync/src/...', so the COPY target MUST be image root,
# exactly as for xchain-indexer above. Staging alone was not enough: without this the
# require threw, the suite SKIPPED rather than failed, and the drift-lock reported
# green while never once running.
COPY ./xchain-sync /xchain-sync

# Same node_modules resolution problem as the bundled indexer: /xchain-sync/src/db.js
# requires mariadb, which npm ci installed under /XChainE2ETest. Sync files needing
# deps absent here (express, ws, helmet) still fail if loaded; none are on the
# drift-lock path.
RUN ln -s /XChainE2ETest/node_modules /xchain-sync/node_modules

# .env is NOT copied into the image to avoid baking credentials into layers.
# Pass credentials via docker run --env-file or environment variables at runtime.

CMD ["npm", "test"]