import { open, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { buildComparisonEvidence, buildReplayEvidence, evidenceJsonDepth, replayModel } from '../src/export/evidence.ts';
import { ScenarioValidationError } from '../src/engine/simulator.ts';
import { isPolicyArrival, POLICY_ARRIVAL } from '../src/fixtures/policy-comparison.ts';

const maxBytes = 8 * 1024 * 1024;
const invalidFile = 'Expected a regular local evidence file at or below 8 MiB.';
const decoder = new TextDecoder('utf-8', { fatal:true });
const replayLimit = { jobs:10000, artifacts:30000, reads:100000 };
const resultSections = ['runs','slots','trace','eventLog'];
const rowLabels = {runs:'run',slots:'output slot',trace:'incident trace',eventLog:'event'};
const depthLimitMessage = 'Evidence JSON is nested beyond the offline limit of ' + evidenceJsonDepth + ' containers.';
class EvidenceMismatch extends Error {}
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Run only after JSON.parse has established the syntax. It cannot report names
// discarded during parsing, so review the original spelling of object keys.
function checkUniqueMemberNames(text) {
  const scopes = [];
  let previous;
  for (let i = 0; i < text.length; i++) {
    const token = text[i];
    if (token === ' ' || token === '\n' || token === '\r' || token === '\t') continue;
    if (token === '{' || token === '[') {
      if (scopes.length >= evidenceJsonDepth) throw new Error(depthLimitMessage);
      scopes.push(token === '{' ? new Set() : null);
    } else if (token === '}' || token === ']') {
      scopes.pop();
    } else if (token === '"') {
      const start = i++;
      let escaped = false;
      for (; text[i] !== '"'; i++) {
        if (text[i] === '\\') {
          escaped = true;
          i++;
        }
      }
      const members = scopes[scopes.length - 1];
      if (members && (previous === '{' || previous === ',')) {
        const name = escaped ? JSON.parse(text.slice(start,i+1)) : text.slice(start+1,i);
        if (members.has(name)) throw new Error('Evidence JSON repeats a member name in the same object.');
        members.add(name);
      }
    }
    previous = token;
  }
}

function checkJsonValues(value, depth = 0, rejectNonfinite = true) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      if (rejectNonfinite) throw new Error('Evidence contains a number outside the supported finite range.');
      return true;
    }
    return Object.is(value,-0);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return false;
  if (typeof value !== 'object') return true;
  if (depth >= evidenceJsonDepth) throw new Error(depthLimitMessage);
  let requiresNormalization = false;
  if (Array.isArray(value)) {
    for (const item of value) if (checkJsonValues(item,depth+1,rejectNonfinite)) requiresNormalization = true;
  } else {
    requiresNormalization = Object.getPrototypeOf(value) !== Object.prototype;
    for (const key of Object.keys(value)) if (checkJsonValues(value[key],depth+1,rejectNonfinite)) requiresNormalization = true;
  }
  return requiresNormalization;
}

function checkReplayBudget(input) {
  const jobs = input?.jobs;
  const artifacts = input?.preloadedArtifacts;
  if (Array.isArray(jobs) && jobs.length > replayLimit.jobs) throw new Error('Replay exceeds the offline limit of 10,000 jobs.');
  if (Array.isArray(artifacts) && artifacts.length > replayLimit.artifacts) throw new Error('Replay exceeds the offline limit of 30,000 supplied artifacts.');
  let reads = 0;
  if (Array.isArray(jobs)) {
    for (const job of jobs) {
      if (!Array.isArray(job?.inputs)) continue;
      reads += job.inputs.length;
      if (reads > replayLimit.reads) throw new Error('Replay exceeds the offline limit of 100,000 configured reads.');
    }
  }
}

function firstDifferentRow(recorded, reconstructed) {
  if (!Array.isArray(recorded) || !Array.isArray(reconstructed)) return null;
  const limit = Math.min(recorded.length,reconstructed.length);
  let index = 0;
  while (index < limit && isDeepStrictEqual(recorded[index],reconstructed[index])) index++;
  return index < limit || recorded.length !== reconstructed.length ? index + 1 : null;
}

function describeRow(field, label, actual, expected, branch) {
  const row = firstDifferentRow(actual[field],expected[field]);
  return row === null ? '' : ' First mismatched ' + label + ' row' +
    (branch ? ' in ' + branch : '') + ': ' + row + '.';
}

function receiptText(value, limit = 240) {
  const text = String(value);
  let clipped = text;
  if (text.length > limit) {
    // Do not split a Unicode surrogate pair and print a replacement character.
    const end = text.charCodeAt(limit-1);
    const next = text.charCodeAt(limit);
    const splitsPair = end >= 0xd800 && end <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
    clipped = text.slice(0,splitsPair ? limit-1 : limit) + '…';
  }
  return clipped.replace(/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/g, char =>
    '\\u' + char.charCodeAt(0).toString(16).padStart(4,'0'));
}

export async function readEvidenceFile(filename) {
  let input;
  try {
    const candidate = await stat(filename);
    if (!candidate.isFile() || candidate.size > maxBytes) throw new Error(invalidFile);
    input = await open(filename, 'r');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new Error('Evidence file not found. Check the file path.');
    }
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      throw new Error('Cannot access the evidence file. Check local read permissions.');
    }
    throw error;
  }
  try {
    const actual = await input.stat();
    if (!actual.isFile() || actual.size > maxBytes) throw new Error(invalidFile);
    const buffer = Buffer.allocUnsafe(Math.min(actual.size + 1, maxBytes + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await input.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== actual.size || length > maxBytes) throw new Error('Evidence changed size during reading.');
    let text;
    try {
      text = decoder.decode(buffer.subarray(0, length));
    } catch {
      throw new Error('Evidence file is not valid UTF-8.');
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Evidence file is not valid JSON.');
    }
    checkUniqueMemberNames(text);
    return parsed;
  } finally {
    await input.close();
  }
}

export function verifyEvidence(bundle) {
  if (isObject(bundle) && !Object.hasOwn(bundle, 'schemaVersion') &&
      typeof bundle.scenarioId === 'string' &&
      resultSections.every(field => Array.isArray(bundle[field]))) {
    throw new Error('This older evidence format contains no replay inputs. Export again from a version that includes them.');
  }
  if (!isObject(bundle) || bundle.schemaVersion !== 1) {
    throw new Error('Expected a version 1 Clockwork Haunt evidence document.');
  }
  if (bundle.replayModel !== replayModel) {
    throw new Error('Evidence replay model is missing or unsupported. This verifier supports ' + replayModel +
      '; use the verifier from the matching release.');
  }
  if (Object.hasOwn(bundle,'kind') && bundle.kind !== 'policy-comparison') {
    throw new Error('Unsupported evidence kind. Export a replay or policy comparison.');
  }
  const requiresNormalization = checkJsonValues(bundle);
  let expected;
  if (bundle.kind === 'policy-comparison') {
    if (!isObject(bundle.runOnSchedule) || !isObject(bundle.waitForFresh)) {
      throw new Error('Policy comparison must contain both recorded policy results.');
    }
    if (!isPolicyArrival(bundle.arrival)) {
      throw new Error('Invalid policy comparison input: arrival must be a whole minute from ' + POLICY_ARRIVAL.min + ' to ' + POLICY_ARRIVAL.max + '.');
    }
    for (const name of ['runOnSchedule','waitForFresh']) {
      const branch = bundle[name];
      if (branch.schemaVersion !== bundle.schemaVersion || branch.replayModel !== bundle.replayModel) {
        throw new Error('Policy comparison branch uses a different evidence version: ' + name + '.');
      }
    }
    expected = buildComparisonEvidence(bundle.arrival);
  } else if (Object.hasOwn(bundle,'input')) {
    if (!isObject(bundle.input)) throw new Error('Replay input must be a JSON object.');
    if (!resultSections.every(field=>Array.isArray(bundle[field]))) {
      throw new Error('Recorded replay is missing a required results array.');
    }
    checkReplayBudget(bundle.input);
    try {
      expected = buildReplayEvidence(bundle.input);
    } catch (error) {
      if (error instanceof ScenarioValidationError) {
        throw new Error('Invalid replay input: ' + error.message, {cause:error});
      }
      throw error;
    }
  } else {
    throw new Error('Evidence has no input to replay. Export a full replay JSON from the app.');
  }
  const label = bundle.kind === 'policy-comparison' ? 'policy comparison' : bundle.scenarioId;
  // Standard finite JSON snapshots can be compared without serializing the
  // reconstruction. Preserve the wire-format comparison when either side
  // has values that serialization would change.
  if (!requiresNormalization && isDeepStrictEqual(bundle,expected)) return label;
  const normalize = requiresNormalization || checkJsonValues(expected,0,false);
  const reconstructed = normalize ? JSON.parse(JSON.stringify(expected)) : expected;
  if (!normalize || !isDeepStrictEqual(bundle,reconstructed)) {
    // Report only verifier-owned labels, never data or user-supplied keys.
    const compareSections = bundle.kind === 'policy-comparison'
      ? ['runOnSchedule', 'waitForFresh']
      : ['scenarioId', 'runs', 'slots', 'trace', 'eventLog'];
    const sections = compareSections.filter(field => !isDeepStrictEqual(bundle[field], reconstructed[field]));
    const detail = sections.length ? ' Mismatched sections: ' + sections.join(', ') + '.' : ' Check the evidence envelope.';
    const location = sections.map(section => {
      if (Object.hasOwn(rowLabels,section)) {
        return describeRow(section,rowLabels[section],bundle,reconstructed);
      }
      if (section === 'runOnSchedule' || section === 'waitForFresh') {
        const actual = bundle[section];
        const expectedBranch = reconstructed[section];
        const rows = resultSections.map(field=>describeRow(field,rowLabels[field],actual,expectedBranch,section)).join('');
        return rows + (isDeepStrictEqual(actual.input,expectedBranch.input) ? '' :
          ' Recorded replay inputs differ in ' + section + '.');
      }
      return '';
    }).join('');
    throw new EvidenceMismatch('The recorded evidence does not match a reconstruction from its inputs.' + detail + location);
  }
  return label;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const usage = 'Usage: node --experimental-strip-types scripts/verify-evidence.mjs <evidence.json>';
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log(usage);
    console.log('Replay model: ' + replayModel + '. Checks reproducibility, not authorship.');
  } else if (process.argv.length !== 3) {
    console.error(usage);
    process.exitCode = 2;
  } else {
    try {
      console.log('Evidence matches the replay: ' + receiptText(verifyEvidence(await readEvidenceFile(process.argv[2]))));
    } catch (error) {
      // Mismatch details contain only verifier-owned labels and bounded row numbers.
      console.error(receiptText(error?.message ?? error,error instanceof EvidenceMismatch ? 800 : 240));
      process.exitCode = 1;
    }
  }
}
