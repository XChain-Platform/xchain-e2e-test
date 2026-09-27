'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*/;
const NUMBER_VALUE = /^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|Inf)$/;

function unparseable(lineNumber, reason){
    throw new Error('Metrics text sample line ' + lineNumber + ' is unparseable: ' + reason);
}

function skipSpace(text, at){
    while(at < text.length && (text[at] === ' ' || text[at] === '\t')) at++;
    return at;
}

function readLabelValue(text, at, lineNumber){
    let value = '';
    for(let i = at + 1; i < text.length; i++){
        if(text[i] === '"') return { value, next: i + 1 };
        if(text[i] !== '\\'){
            value += text[i];
            continue;
        }
        const escaped = text[++i];
        if(escaped === 'n') value += '\n';
        else if(escaped === '"' || escaped === '\\') value += escaped;
        else unparseable(lineNumber, 'unsupported label escape');
    }
    return unparseable(lineNumber, 'unterminated label value');
}

function setLabel(labels, name, value, lineNumber){
    if(Object.prototype.hasOwnProperty.call(labels, name)){
        unparseable(lineNumber, 'duplicate label ' + name);
    }
    Object.defineProperty(labels, name, {
        value,
        enumerable: true,
        configurable: true,
        writable: true
    });
}

function parseLabels(text, lineNumber){
    const labels = {};
    let at = 0;
    while(at < text.length){
        at = skipSpace(text, at);
        const nameMatch = LABEL_NAME.exec(text.slice(at));
        if(!nameMatch) unparseable(lineNumber, 'expected a label name');
        const name = nameMatch[0];
        at = skipSpace(text, at + name.length);
        if(text[at] !== '=') unparseable(lineNumber, 'expected = after label ' + name);
        at = skipSpace(text, at + 1);
        if(text[at] !== '"') unparseable(lineNumber, 'expected a quoted value for label ' + name);
        const decoded = readLabelValue(text, at, lineNumber);
        setLabel(labels, name, decoded.value, lineNumber);
        at = skipSpace(text, decoded.next);
        if(at === text.length) break;
        if(text[at] !== ',') unparseable(lineNumber, 'expected a comma after label ' + name);
        at++;
    }
    return labels;
}

function findLabelEnd(text, lineNumber){
    let quoted = false;
    let escaped = false;
    for(let i = 1; i < text.length; i++){
        if(escaped){ escaped = false; continue; }
        if(quoted && text[i] === '\\'){ escaped = true; continue; }
        if(text[i] === '"'){ quoted = !quoted; continue; }
        if(!quoted && text[i] === '}') return i;
    }
    return unparseable(lineNumber, 'unterminated label set');
}

function parseValue(text, lineNumber){
    const match = /^(\S+)(?:[ \t]+[+-]?\d+)?$/.exec(text);
    if(!match) unparseable(lineNumber, 'expected a value and optional timestamp');
    const token = match[1];
    if(token === 'NaN') return NaN;
    if(!NUMBER_VALUE.test(token)) unparseable(lineNumber, 'invalid sample value ' + token);
    if(token === 'Inf' || token === '+Inf') return Infinity;
    if(token === '-Inf') return -Infinity;
    return Number(token);
}

function parseSampleLine(line, lineNumber){
    const nameMatch = METRIC_NAME.exec(line);
    if(!nameMatch) unparseable(lineNumber, 'expected a metric name');
    const name = nameMatch[0];
    let rest = line.slice(name.length);
    let labels = {};
    if(rest[0] === '{'){
        const end = findLabelEnd(rest, lineNumber);
        labels = parseLabels(rest.slice(1, end), lineNumber);
        rest = rest.slice(end + 1);
    }
    if(!/^[ \t]+/.test(rest)) unparseable(lineNumber, 'expected whitespace before the value');
    return { name, labels, value: parseValue(rest.trim(), lineNumber) };
}

function parsePromSamples(text){
    if(typeof text !== 'string') throw new TypeError('Metrics text exposition must be a string');
    const samples = [];
    text.split(/\r\n|\n|\r/).forEach((raw, index) => {
        const line = raw.trim();
        if(line && !line.startsWith('#')) samples.push(parseSampleLine(line, index + 1));
    });
    return samples;
}

function dispatchedSources(samples, metricName){
    const dispatched = new Set();
    for(const sample of samples.filter((entry) => entry.name === metricName)){
        if(Number.isFinite(sample.value) && sample.value > 0) dispatched.add(sample.labels.source);
    }
    return dispatched;
}

function requireSourceDispatches(samples, liveMetric, attemptMetric, requiredSources){
    const dispatched = dispatchedSources(samples, attemptMetric);
    for(const source of requiredSources){
        if(!dispatched.has(source)){
            throw new Error(attemptMetric + ' must prove a fetch was dispatched for source=' + source);
        }
    }
    for(const sample of samples.filter((entry) => entry.name === liveMetric)){
        if(!dispatched.has(sample.labels.source)){
            throw new Error(liveMetric + ' exposed source=' + sample.labels.source +
                ' without dispatch evidence in ' + attemptMetric);
        }
    }
    return dispatched;
}

module.exports = { parsePromSamples, requireSourceDispatches };
