'use strict'

// Render drive evidence as JSON; RPC heights and amounts can arrive as BigInt, which
// JSON.stringify refuses, so each BigInt is written as its decimal string.
function bigintAsString(key, value){
    return typeof value === 'bigint' ? value.toString() : value
}

function evidenceJson(value, space){
    return JSON.stringify(value, bigintAsString, space)
}

module.exports = { bigintAsString, evidenceJson }
