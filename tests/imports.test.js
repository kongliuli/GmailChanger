import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { expandInputs } from '../src/imports.js';

const encoder = new TextEncoder();
const file = (bytes, name = 'test.zip') => new File([bytes], name);
const sig = (view, offset) => view.getUint32(offset, true);
function records(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= 0; i--) if (sig(view, i) === 0x06054b50) { end = i; break; }
  assert.notEqual(end, -1);
  const count = view.getUint16(end + 10, true), central = view.getUint32(end + 16, true);
  const entries = [];
  let cursor = central;
  for (let i = 0; i < count; i++) {
    assert.equal(sig(view, cursor), 0x02014b50);
    entries.push({ central: cursor, local: view.getUint32(cursor + 42, true), nameLength: view.getUint16(cursor + 28, true) });
    cursor += 46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }
  return { view, end, entries, central, directoryEnd: cursor };
}
async function rejected(bytes, phrase) {
  const result = await expandInputs([file(bytes)]);
  assert.equal(result.files.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes(phrase), result.warnings[0]);
}

test('extracts supported files, ignores harmless other files and permits directory entries', async () => {
  const zip = zipSync({ 'Takeout/': new Uint8Array(), 'Takeout/Mail/': new Uint8Array(), 'Takeout/Mail/Sent.mbox': encoder.encode('From x Thu Jan 01 00:00:00 1970\n\n'), 'notes.txt': encoder.encode('ignored'), '__MACOSX/._meta': encoder.encode('ignored') });
  const result = await expandInputs([file(zip, 'takeout.zip')]);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].sourcePath, 'Takeout/Mail/Sent.mbox');
});

test('extracts XML/MBOX and preserves source paths', async () => {
  const zip = zipSync({ 'Takeout/Mail/Sent.mbox': encoder.encode('From x Thu Jan 01 00:00:00 1970\n\n'), 'mailFilters.xml': encoder.encode('<feed/>') });
  const result = await expandInputs([file(zip)]);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.files.length, 2);
  assert.ok(result.files.some(item => item.sourcePath === 'Takeout/Mail/Sent.mbox'));
});

test('accepts standalone EML files and EML entries inside ZIP archives', async () => {
  const eml = encoder.encode('From: a@b.example\r\nSubject: Verify your account\r\n\r\nx\r\n');
  const result = await expandInputs([new File([eml], 'proton-export.eml', { type: 'message/rfc822' })]);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].sourcePath, 'proton-export.eml');
  const zip = zipSync({ 'proton/export000001.eml': eml, 'meta.json': encoder.encode('{}') });
  const zipped = await expandInputs([file(zip)]);
  assert.deepEqual(zipped.warnings, []);
  assert.equal(zipped.files.length, 1);
  assert.equal(zipped.files[0].sourcePath, 'proton/export000001.eml');
});

test('rejects stored payload corruption with matching local and central CRC', async () => {
  const zip = zipSync({ 'good.xml': encoder.encode('<feed/>'), 'bad.mbox': encoder.encode('original data') }, { level: 0 });
  const { view, entries } = records(zip);
  const local = entries[1].local;
  zip[local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)] ^= 1;
  await rejected(zip, 'CRC32 mismatch'); // No partial good.xml output either.
});

test('rejects forged smaller and larger DEFLATE output sizes', async () => {
  const content = encoder.encode('real payload '.repeat(1000));
  for (const size of [0, content.length - 1, content.length + 1]) {
    const zip = zipSync({ 'payload.mbox': content }, { level: 6 });
    const { view, entries } = records(zip);
    const entry = entries[0];
    assert.equal(view.getUint16(entry.central + 10, true), 8);
    view.setUint32(entry.central + 24, size, true);
    view.setUint32(entry.local + 22, size, true);
    await rejected(zip, 'actual expanded size mismatch');
  }
});

test('validates CRC for DEFLATE output, not merely output length', async () => {
  const zip = zipSync({ 'payload.mbox': encoder.encode('payload '.repeat(1000)) }, { level: 6 });
  const { view, entries } = records(zip);
  const entry = entries[0];
  const forgedCrc = (view.getUint32(entry.central + 16, true) ^ 1) >>> 0;
  view.setUint32(entry.central + 16, forgedCrc, true);
  view.setUint32(entry.local + 14, forgedCrc, true);
  await rejected(zip, 'CRC32 mismatch');
});

test('extracts verified bytes including empty entries and multi-chunk DEFLATE', async () => {
  let seed = 42;
  const content = Uint8Array.from({ length: 40000 }, () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed & 255; });
  for (const level of [0, 6]) {
    const zip = zipSync({ 'empty.xml': new Uint8Array(), 'data.mbox': content }, { level });
    const result = await expandInputs([file(zip)]);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.files[0].size, 0);
    assert.deepEqual(new Uint8Array(await result.files[1].arrayBuffer()), content);
  }
});

test('archive failure does not discard a separate valid archive', async () => {
  const bad = zipSync({ 'bad.xml': encoder.encode('bad') }, { level: 0 });
  const { view, entries } = records(bad);
  const local = entries[0].local;
  bad[local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)] ^= 1;
  const good = zipSync({ 'good.xml': encoder.encode('<feed/>') });
  const result = await expandInputs([file(bad, 'bad.zip'), file(good, 'good.zip')]);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, 'good.xml');
});

test('rejects multi-disk count/number inconsistencies', async () => {
  const zip = zipSync({ 'one.xml': encoder.encode('<feed/>'), 'two.mbox': encoder.encode('') });
  for (const [offset, value, reason] of [[4, 1, 'Multi-disk'], [6, 1, 'Multi-disk'], [8, 1, 'directory size/count']]) {
    const altered = zip.slice(), r = records(altered);
    r.view.setUint16(r.end + offset, value, true);
    await rejected(altered, reason);
  }
});

test('rejects entry-count, directory-size and directory-bound mismatches', async () => {
  const zip = zipSync({ 'one.xml': encoder.encode('<feed/>'), 'two.mbox': encoder.encode('') });
  const wrongCount = zip.slice();
  let r = records(wrongCount);
  r.view.setUint16(r.end + 10, 1, true);
  await rejected(wrongCount, 'directory size/count');
  const wrongSize = zip.slice();
  r = records(wrongSize);
  r.view.setUint32(r.end + 12, r.view.getUint32(r.end + 12, true) - 1, true);
  await rejected(wrongSize, 'directory bounds');
  const outOfRange = zip.slice();
  r = records(outOfRange);
  r.view.setUint32(r.end + 16, outOfRange.length + 10, true);
  await rejected(outOfRange, 'directory bounds');
});

test('rejects ZIP64 locator, sentinels, and ZIP64 extras', async () => {
  const zip = zipSync({ 'one.xml': encoder.encode('<feed/>') });
  const r = records(zip);
  const locatorOffset = r.end;
  const withLocator = new Uint8Array(zip.length + 20);
  withLocator.set(zip.subarray(0, locatorOffset));
  const view = new DataView(withLocator.buffer);
  view.setUint32(locatorOffset, 0x07064b50, true);
  view.setUint32(locatorOffset + 4, 0, true);
  view.setBigUint64(locatorOffset + 8, BigInt(locatorOffset), true);
  view.setUint32(locatorOffset + 16, 1, true);
  withLocator.set(zip.subarray(locatorOffset), locatorOffset + 20);
  const newEocd = locatorOffset + 20;
  new DataView(withLocator.buffer).setUint32(newEocd + 16, new DataView(zip.buffer).getUint32(r.end + 16, true), true);
  await rejected(withLocator, 'ZIP64');

  const sentinel = zip.slice();
  let x = records(sentinel);
  x.view.setUint32(x.entries[0].central + 24, 0xffffffff, true);
  await rejected(sentinel, 'ZIP64');

  const extra = zip.slice();
  x = records(extra);
  const insertion = x.entries[0].central + 46 + x.entries[0].nameLength;
  const oldDirectorySize = x.view.getUint32(x.end + 12, true);
  const expanded = new Uint8Array(extra.length + 4);
  expanded.set(extra.subarray(0, insertion));
  expanded.set([1, 0, 0, 0], insertion);
  expanded.set(extra.subarray(insertion), insertion + 4);
  const updated = new DataView(expanded.buffer);
  updated.setUint16(x.entries[0].central + 30, 4, true);
  const newEnd = x.end + 4;
  updated.setUint32(newEnd + 12, oldDirectorySize + 4, true);
  await rejected(expanded, 'ZIP64');
});

test('rejects stored-size mismatches and local/central metadata mismatch', async () => {
  const zip = zipSync({ 'stored.xml': encoder.encode('<feed/>') }, { level: 0 });
  const mismatch = zip.slice();
  let r = records(mismatch);
  r.view.setUint32(r.entries[0].central + 24, 1, true);
  await rejected(mismatch, 'size mismatch');
  const local = zip.slice();
  r = records(local);
  r.view.setUint32(r.entries[0].local + 22, 1, true);
  await rejected(local, 'local/central sizes mismatch');
});

test('rejects malformed local headers, names and compressed-data bounds', async () => {
  const zip = zipSync({ 'one.xml': encoder.encode('<feed/>') });
  const badSig = zip.slice();
  let r = records(badSig);
  r.view.setUint32(r.entries[0].local, 0, true);
  await rejected(badSig, 'Invalid local header');
  const badName = zip.slice();
  r = records(badName);
  badName[r.entries[0].local + 30] ^= 1;
  await rejected(badName, 'filename mismatch');
  const badBounds = zip.slice();
  r = records(badBounds);
  r.view.setUint32(r.entries[0].central + 42, r.central - 10, true);
  await rejected(badBounds, 'Invalid local header');
});

test('rejects declared entry and per-archive aggregate limits before decompression', async () => {
  const one = zipSync({ 'one.xml': encoder.encode('<feed/>') });
  const large = one.slice();
  let r = records(large);
  r.view.setUint32(r.entries[0].central + 24, 128 * 1024 * 1024 + 1, true);
  await rejected(large, 'ZIP entry exceeds');
  const three = zipSync({ 'one.xml': encoder.encode('a'), 'two.mbox': encoder.encode('b'), 'three.xml': encoder.encode('c') });
  const total = three.slice();
  r = records(total);
  for (const entry of r.entries) {
    r.view.setUint16(entry.central + 8, r.view.getUint16(entry.central + 8, true) | 8, true);
    r.view.setUint16(entry.local + 6, r.view.getUint16(entry.local + 6, true) | 8, true);
    r.view.setUint32(entry.central + 24, 100 * 1024 * 1024, true);
  }
  await rejected(total, 'expanded data exceeds');
});
