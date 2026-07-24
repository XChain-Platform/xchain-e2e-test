#!/usr/bin/env bash
#*********************************************************************
#
# Copyright © 2025-2026 Dankest, LLC
# Based on XChain Platform by Dankest, LLC - https://dankest.llc
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# This file is part of XChain Platform. Licensed under the GNU Affero
# General Public License v3.0 or later; see LICENSE.md. A commercial
# license (without AGPL source-disclosure terms) is available -
# contact legal@dankest.llc.
#
#*********************************************************************

# Background block-nudger for test-host BTC-regtest: mines 1 block every few
# seconds so SDK submitAction txs confirm (the stack's auto-miner is idle).
# Reuses a single mining address. Node creds sourced from the container env at
# runtime; never echoed. Stop via the pidfile written by the caller.
set -uo pipefail
CT=xchain-node-bitcoin-regtest-xchain-encoder
geti(){ docker inspect "$CT" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -m1 "^$1=" | cut -d= -f2-; }
NU="$(geti NODE_USER)"; NP="$(geti NODE_PASSWORD)"
rpc(){ curl -s --user "$NU:$NP" --data-binary "{\"jsonrpc\":\"1.0\",\"method\":\"$1\",\"params\":$2}" -H 'content-type:text/plain' http://127.0.0.1:3020/; }
ADDR="$(rpc getnewaddress '[]' | sed -E 's/.*"result":"([^"]+)".*/\1/')"
echo "nudger mining to $ADDR every 5s"
while true; do
  rpc generatetoaddress "[1,\"$ADDR\"]" >/dev/null 2>&1
  sleep 5
done
