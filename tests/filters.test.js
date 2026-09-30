import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFilters, convertFilters } from '../src/filters.js';

const rule = (criteria = { from: 'boss@example.com' }, actions = { label: 'Work' }, extra = {}) => ({ id: 'one', criteria, actions, unknown: [], ...extra });
const convert = (criteria, actions, options) => convertFilters([rule(criteria, actions)], options);
const skipped = result => {
  assert.equal(result.results[0].status, 'skipped');
  assert.doesNotMatch(result.sieve, /\nif |fileinto |redirect |keep;|addflag |require /);
  assert.ok(result.gaps.length);
};

test('label retains Inbox; exact sender and recipient tests combine', () => {
  const result = convert({ from: 'boss@example.com', to: 'me@example.com' }, undefined, { includeApproximate: true });
  assert.equal(result.results[0].status, 'approximate');
  assert.match(result.sieve, /allof \(address :is "from" "boss@example.com", address :is "to" "me@example.com"\)/);
  assert.match(result.sieve, /fileinto "Work";\n  keep;/);
  assert.match(result.sieve, /require \["fileinto"\];/);
});

test('archive with label files only into mapped label', () => {
  const result = convert(undefined, { label: 'Work', shouldArchive: 'true' }, { folderMap: { Work: 'Work/Projects' } });
  assert.match(result.sieve, /fileinto "Work\/Projects";/);
  assert.doesNotMatch(result.sieve, /keep;|fileinto "Archive"/);
  assert.equal(result.results[0].status, 'approximate');
});

test('archive and trash use mapped destinations, never discard', () => {
  for (const [action, destination] of [['shouldArchive', 'Archive'], ['shouldTrash', 'Trash']]) {
    const result = convert(undefined, { [action]: true }, { folderMap: { [destination]: `My ${destination}` } });
    assert.match(result.sieve, new RegExp(`fileinto "My ${destination}";`));
    assert.equal(result.results[0].status, 'approximate');
    assert.doesNotMatch(result.sieve, /discard|keep;/);
  }
});

test('forwarding always retains a local copy', () => {
  const only = convert(undefined, { forwardTo: 'copy@example.com' });
  assert.match(only.sieve, /redirect "copy@example.com";\n  keep;/);
  assert.doesNotMatch(only.sieve, /require /);
  const archived = convert(undefined, { forwardTo: 'copy@example.com', shouldArchive: true, label: 'Work' });
  assert.match(archived.sieve, /fileinto "Work";/);
  assert.match(archived.sieve, /redirect "copy@example.com";/);
  assert.doesNotMatch(archived.sieve, /keep;/);
});

test('flags declare imap4flags exactly once and no stop suppresses later rules', () => {
  const result = convertFilters([
    rule(undefined, { shouldStar: true, shouldMarkAsRead: 'true' }),
    rule(undefined, { label: 'Work' }),
  ], { target: 'fastmail', includeApproximate: true });
  assert.match(result.sieve, /require \["fileinto", "imap4flags"\];/);
  assert.ok(result.sieve.includes('addflag "\\\\Seen";'));
  assert.ok(result.sieve.includes('addflag "\\\\Flagged";'));
  assert.equal((result.sieve.match(/\nif /g) || []).length, 2);
  assert.doesNotMatch(result.sieve, /\bstop\s*;/);
});

test('approximate rules are inert by default, including subject, archive and trash', () => {
  for (const result of [convert({ subject: 'Invoice' }), convert(undefined, { shouldArchive: true }), convert(undefined, { shouldTrash: true })]) {
    assert.equal(result.results[0].status, 'approximate');
    assert.ok(result.sieve.split('\n').every(line => !line || line.startsWith('#')));
    assert.match(result.sieve, /DISABLED/);
    assert.ok(result.gaps.some(gap => gap.includes('disabled by default')));
  }
  assert.match(convert({ subject: 'Invoice' }, undefined, { includeApproximate: true }).sieve, /\nif /);
  assert.doesNotMatch(convert({ subject: 'Invoice' }, undefined, { includeApproximate: 'true' }).sieve, /\nif /);
});

test('matching label then archive rules are both approximate and disabled', () => {
  const filters = [rule(undefined, { label: 'Work' }), rule(undefined, { shouldArchive: true })];
  const result = convertFilters(filters);
  assert.deepEqual(result.results.map(item => item.status), ['approximate', 'approximate']);
  assert.ok(result.results.every(item => item.issues.some(issue => issue.includes('Multiple rules may match'))));
  assert.ok(result.sieve.split('\n').every(line => !line || line.startsWith('#')));
  const enabled = convertFilters(filters, { includeApproximate: true });
  assert.equal((enabled.sieve.match(/\nif /g) || []).length, 2);
  assert.ok(enabled.results.every(item => item.status === 'approximate'));
});

test('flags after fileinto cannot silently claim Gmail semantics', () => {
  const result = convertFilters([rule(undefined, { label: 'Work' }), rule(undefined, { shouldMarkAsRead: true })], { target: 'fastmail' });
  assert.ok(result.results.every(item => item.status === 'approximate'));
  assert.ok(result.sieve.split('\n').every(line => !line || line.startsWith('#')));
  assert.match(result.sieve, /#   addflag /);
  assert.doesNotMatch(result.sieve, /^require /m);
});

test('skipped rules do not cause interaction warnings; additive flags alone remain enabled', () => {
  const result = convertFilters([rule(), rule({ hasTheWord: 'query' })]);
  assert.deepEqual(result.results.map(item => item.status), ['approximate', 'skipped']);
  assert.ok(!result.results[0].issues.some(issue => issue.includes('Multiple rules')));
  const flags = convertFilters([rule(undefined, { shouldStar: true }), rule(undefined, { shouldMarkAsRead: true })], { target: 'fastmail' });
  assert.ok(flags.results.every(item => item.status === 'approximate'));
  assert.equal((flags.sieve.match(/# if /g) || []).length, 2);
});

test('supported size units and operators produce exact bytes', () => {
  for (const [unit, multiplier] of [['s_sb', 1], ['s_skb', 1024], ['s_smb', 1048576]]) {
    for (const [operator, sieve] of [['s_sl', 'over'], ['s_ss', 'under']]) {
      const result = convert({ size: '2', sizeUnit: unit, sizeOperator: operator });
      assert.equal(result.results[0].status, 'approximate');
      assert.match(result.sieve, new RegExp(`size :${sieve} ${2 * multiplier}`));
    }
  }
  for (const size of ['1.5', '-1', '1K', 'Infinity', '4294967296']) skipped(convert({ size, sizeUnit: 's_sb', sizeOperator: 's_sl' }));
  skipped(convert({ size: '5', sizeUnit: 'MB', sizeOperator: 's_sl' }));
  skipped(convert({ size: '5', sizeUnit: 's_sb', sizeOperator: 'eq' }));
  skipped(convert({ size: '5' }));
});

test('inactive exported size UI defaults are ignored but never make a condition', () => {
  assert.equal(convert({ from: 'a@example.com', sizeOperator: 's_sl', sizeUnit: 's_smb' }).results[0].status, 'approximate');
  skipped(convert({ sizeOperator: 's_sl', sizeUnit: 's_smb' }));
});

test('plain subjects are visibly approximate; query syntax is rejected', () => {
  const result = convert({ subject: 'Invoice 2026' });
  assert.match(result.sieve, /header :contains "subject" "Invoice 2026"/);
  assert.equal(result.results[0].status, 'approximate');
  assert.ok(result.gaps.some(gap => gap.includes('substring')));
  for (const subject of ['from:x', '{a b}', 'a OR b', '"phrase"', '-spam', 'x*', 'a (b)']) skipped(convert({ subject }));
});

test('complex addresses and forwarding values cannot broaden or inject a rule', () => {
  for (const value of ['bob', '*@example.com', 'a@example.com OR b@example.com', 'a@example.com,b@example.com', 'Bob <a@example.com>', ' a@example.com', 'a@example.com\r\n', 'a@x.com"; discard; #']) {
    skipped(convert({ from: value }));
    skipped(convert({ to: value }));
    skipped(convert(undefined, { forwardTo: value }));
  }
});

test('unsupported criteria and actions skip the entire otherwise valid rule', () => {
  for (const name of ['hasTheWord', 'doesNotHaveTheWord', 'hasAttachment', 'excludeChats', 'unexpected']) skipped(convert({ from: 'a@example.com', [name]: 'true' }));
  for (const name of ['shouldNeverSpam', 'shouldAlwaysMarkAsImportant', 'shouldNeverMarkAsImportant', 'smartLabelToApply', 'unexpected']) skipped(convert(undefined, { label: 'Work', [name]: 'true' }));
  skipped(convertFilters([rule(undefined, undefined, { unknown: ['Unsupported XML property: future'] })]));
});

test('inactive switches are harmless; malformed switches are not', () => {
  assert.equal(convert({ from: 'a@example.com', hasAttachment: false }, { label: 'Work', shouldNeverSpam: 'false' }).results[0].status, 'approximate');
  skipped(convert(undefined, { label: 'Work', shouldArchive: 'yes' }));
  skipped(convert(undefined, { shouldArchive: false }));
  skipped(convert({}, { label: 'Work' }));
  skipped(convert(undefined, {}));
});

test('conflicting delivery actions and invalid mappings skip everything', () => {
  skipped(convert(undefined, { label: 'Work', shouldTrash: true }));
  skipped(convert(undefined, { shouldArchive: true, shouldTrash: true }));
  for (const value of ['', ' ', null, 5, 'Work\nstop;']) skipped(convert(undefined, undefined, { folderMap: { Work: value } }));
});

test('folder quoting escapes quotes and backslashes; IDs never enter script', () => {
  const label = 'Folder"; discard; #\\name';
  const result = convertFilters([rule(undefined, { label }, { id: '"; discard; #' })]);
  assert.equal(result.results[0].status, 'approximate');
  assert.ok(result.sieve.includes('fileinto "Folder\\"; discard; #\\\\name";'));
  assert.doesNotMatch(result.sieve, /# Rule .*discard/);
  for (const character of ['\0', '\t', '\n', '\r', '\x7f', '\x85', '\u2028']) {
    skipped(convert(undefined, { label: `safe${character}bad` }));
    skipped(convertFilters([rule(undefined, undefined, { id: `id${character}` })]));
  }
});

test('provider targets and output shape', () => {
  for (const target of ['generic', 'fastmail', 'proton']) assert.equal(convert(undefined, undefined, { target }).results[0].status, 'approximate');
  for (const target of ['outlook', 'yahoo']) skipped(convert(undefined, undefined, { target }));
  const unknown = convert(undefined, undefined, { target: 'unknown' });
  assert.equal(unknown.results[0].status, 'approximate');
  assert.match(unknown.gaps.join(' '), /generic capability baseline/);
  assert.throws(() => convert(undefined, undefined, { target: 'typo' }));
  assert.deepEqual(Object.keys(convert().results[0]).sort(), ['description', 'generated', 'id', 'issues', 'requiredExtensions', 'status']);
  assert.deepEqual(convertFilters([]).results, []);
  assert.throws(() => convertFilters(null), TypeError);
  assert.throws(() => parseFilters('not a Document'), TypeError);
});

test('query exact mailboxes, cc and sizes compile with AND', () => {
  const result = convert({ hasTheWord: 'from:a@example.com to:b@example.com cc:c@example.com larger:2K smaller:3M' }, { forwardTo: 'copy@example.com' });
  assert.equal(result.results[0].status, 'converted');
  assert.match(result.sieve, /address :is "cc" "c@example.com"/);
  assert.match(result.sieve, /size :over 2048, size :under 3145728/);
  assert.match(result.sieve, /\nif allof /);
});

test('explicit OR queries are skipped by the authoritative parser', () => {
  for (const value of ['from:a@example.com OR from:a@example.com', 'from:a@example.com OR to:b@example.com']) {
    skipped(convert({ hasTheWord: value }, { forwardTo: 'copy@example.com' }));
    skipped(convert({ doesNotHaveTheWord: value }, { forwardTo: 'copy@example.com' }));
  }
});

test('doesNotHaveTheWord negates entire conjunction and preserves inner negation', () => {
  const result = convert({ doesNotHaveTheWord: 'from:a@example.com -to:b@example.com' }, { forwardTo: 'copy@example.com' });
  assert.match(result.sieve, /if not allof \(address :is "from" "a@example.com", not address :is "to" "b@example.com"\)/);
  const double = convert({ doesNotHaveTheWord: '-from:a@example.com' }, { forwardTo: 'copy@example.com' });
  assert.match(double.sieve, /if not not address :is "from" "a@example.com"/);
});

test('query unsupported predicates cannot disappear from mixed rules', () => {
  for (const query of ['from:a@example.com bodyword', 'from:a@example.com has:attachment', 'from:a@example.com OR to:b@example.com', 'from:partial', 'cc:partial', 'label:Work', 'from:a@example.com in:inbox']) {
    for (const name of ['hasTheWord', 'doesNotHaveTheWord']) skipped(convert({ from: 'safe@example.com', [name]: query }));
  }
  const subject = convert({ hasTheWord: 'subject:"Invoice 2026"' }, { forwardTo: 'copy@example.com' });
  assert.equal(subject.results[0].status, 'approximate');
  assert.match(subject.sieve, /# if header :contains "subject" "Invoice 2026"/);
});

test('target capabilities are mandatory even when opting into approximations', () => {
  skipped(convert(undefined, { shouldStar: true }, { target: 'generic', includeApproximate: true }));
  skipped(convert(undefined, { forwardTo: 'copy@example.com' }, { target: 'proton', includeApproximate: true }));
  assert.equal(convert(undefined, { shouldStar: true }, { target: 'fastmail' }).results[0].status, 'approximate');
  for (const target of ['outlook', 'yahoo']) skipped(convert(undefined, { label: 'Work' }, { target, includeApproximate: true }));
  const multiBlock = convertFilters([
    rule({ from: 'one@example.com' }, { shouldStar: true }),
    rule({ from: 'two@example.com' }, { shouldMarkAsRead: true }),
  ], { target: 'proton', includeApproximate: true });
  assert.ok(multiBlock.results.every(result => result.status === 'approximate'));
  assert.equal((multiBlock.sieve.match(/\nif /g) || []).length, 2);
  assert.match(multiBlock.sieve, /require \["imap4flags"\];/);
});

test('explicit system folders override legacy mappings and reject unsafe collisions', () => {
  const archived = convert(undefined, { shouldArchive: true }, { archiveFolder: 'All mail', folderMap: { Archive: 'Legacy' } });
  assert.match(archived.sieve, /fileinto "All mail"/);
  const trashed = convert(undefined, { shouldTrash: true }, { trashFolder: 'Deleted' });
  assert.match(trashed.sieve, /fileinto "Deleted"/);
  const separate = convertFilters([
    rule(undefined, { shouldArchive: true }),
    rule(undefined, { shouldTrash: true }),
  ], { archiveFolder: 'Stored', trashFolder: 'Removed', includeApproximate: true });
  assert.match(separate.sieve, /fileinto "Stored"/);
  assert.match(separate.sieve, /fileinto "Removed"/);
  for (const value of ['', ' ', null, 2, 'bad\nfolder', 'INBOX']) {
    skipped(convert(undefined, { shouldArchive: true }, { archiveFolder: value }));
    skipped(convert(undefined, { shouldTrash: true }, { trashFolder: value }));
  }
  skipped(convert(undefined, { shouldArchive: true }, { archiveFolder: 'same', trashFolder: 'SAME' }));
  skipped(convert(undefined, { shouldTrash: true }, { archiveFolder: 'same', trashFolder: 'SAME' }));
  skipped(convert(undefined, { label: 'Work' }, { folderMap: { Work: 'Shared', Personal: 'shared' } }));
  skipped(convert(undefined, { label: 'Work' }, { folderMap: { Work: 'Trash' } }));
  const mixed = convertFilters([rule(undefined, { label: 'Work' }), rule(undefined, { forwardTo: 'copy@example.com' })], { folderMap: { Work: 'INBOX' } });
  assert.deepEqual(mixed.results.map(result => result.status), ['skipped', 'converted']);
  assert.deepEqual(mixed.results[0].requiredExtensions, ['fileinto']);
});

test('result snippets and extension list are safe standalone previews', () => {
  const output = convert();
  const result = output.results[0];
  assert.equal(result.status, 'approximate');
  assert.deepEqual(result.requiredExtensions, ['fileinto']);
  assert.match(result.generated, /# Needed at script top before enabling: require \["fileinto"\];/);
  assert.ok(result.generated.split('\n').every(line => line.startsWith('#')));
  assert.ok(output.sieve.includes(result.generated));
  assert.match(result.issues.join(' '), /independent message copies/);
  assert.deepEqual(convert(undefined, { forwardTo: 'copy@example.com' }).results[0].requiredExtensions, []);
});

test('XML namespace parsing, duplicates, metadata and malformed XML', { skip: typeof DOMParser === 'undefined' ? 'DOMParser is browser-native; run XML integration checks in the browser.' : false }, () => {
  const parse = body => new DOMParser().parseFromString(body, 'application/xml');
  const feed = entry => `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:a="http://schemas.google.com/apps/2006"><entry><id>gmail-1</id><title>Mail Filter</title>${entry}</entry></feed>`;
  const filters = parseFilters(parse(feed('<a:property name="from" value="a@example.com"/><a:property name="label" value="A &amp; B"/>')));
  assert.deepEqual(filters, [rule({ from: 'a@example.com' }, { label: 'A & B' }, { id: 'gmail-1' })]);
  const duplicate = parseFilters(parse(feed('<a:property name="from" value="a@example.com"/><a:property name="from" value="b@example.com"/><a:property name="label" value="Work"/>')));
  skipped(convertFilters(duplicate));
  const unknown = parseFilters(parse(feed('<a:property name="future" value="false"/>')));
  assert.equal(unknown[0].unknown.length, 1);
  assert.throws(() => parseFilters(parse('<feed>')));
  assert.throws(() => parseFilters(parse('<feed/>')));
  assert.throws(() => parseFilters(parse('<!DOCTYPE feed>' + feed(''))));
});
