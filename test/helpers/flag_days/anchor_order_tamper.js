'use strict';

const { parseAnchorV0 } = require('../anchorVersionHelper');

const SECTION_FIXED_FIELDS = 13;
const HEADER_FIELDS = 5;

function sectionLayout(v0Payload){
    const parsed = parseAnchorV0(v0Payload);
    if(!parsed) throw new TypeError('expected an ANCHOR v0 payload');

    const fields = v0Payload.split('|');
    let cursor = HEADER_FIELDS;
    const sections = parsed.sections.map(section => {
        const start = cursor;
        cursor += SECTION_FIXED_FIELDS + (section.sigs.length * 2);
        return { start, end: cursor };
    });
    return { fields, sections, tailStart: cursor };
}

function reverseSections(v0Payload){
    const layout = sectionLayout(v0Payload);
    const header = layout.fields.slice(0, HEADER_FIELDS);
    const sections = layout.sections.map(({ start, end }) => layout.fields.slice(start, end));
    const tail = layout.fields.slice(layout.tailStart);
    return header.concat(sections.reverse().flat(), tail).join('|');
}

function reverseSectionPairs(v0Payload, sectionIndex){
    const layout = sectionLayout(v0Payload);
    if(!Number.isInteger(sectionIndex) || sectionIndex < 0 || sectionIndex >= layout.sections.length)
        throw new RangeError('sectionIndex is outside the ANCHOR v0 section list');

    const fields = layout.fields.slice();
    const section = layout.sections[sectionIndex];
    const pairStart = section.start + SECTION_FIXED_FIELDS;
    const pairs = [];
    for(let i = pairStart; i < section.end; i += 2) pairs.push(fields.slice(i, i + 2));
    fields.splice(pairStart, pairs.length * 2, ...pairs.reverse().flat());
    return fields.join('|');
}

module.exports = { reverseSections, reverseSectionPairs };
