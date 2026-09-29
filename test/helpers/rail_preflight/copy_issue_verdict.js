'use strict';

// The verdict a user ISSUE of any format gets on a bridged copy such as BTC.<tick>:
// the indexer checks the parent owner (the keyless bridge role) before the tick owner.
const COPY_ISSUE_REFUSED = 'invalid: TICK (parent issued by another address)';

module.exports = { COPY_ISSUE_REFUSED };
