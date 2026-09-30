import test from 'node:test';
import assert from 'node:assert/strict';
import { TARGETS, getTarget, capabilityCheck, buildRecipe, defaultFolders } from '../src/targets.js';
import { convertFilters } from '../src/filters.js';

test('target lookup, required fields and honest verification status', () => {
  assert.deepEqual(TARGETS.map(target => target.id), ['generic', 'fastmail', 'proton', 'outlook', 'yahoo', 'unknown']);
  assert.equal(getTarget('fastmail').label, 'Fastmail');
  assert.throws(() => getTarget('not-a-provider'), /未知/);
  for (const target of TARGETS) {
    assert.ok(['sieve', 'recipe'].includes(target.kind));
    assert.ok(['verified', 'unverified', 'manual'].includes(target.verifyStatus));
    assert.ok(Array.isArray(target.extensions));
    for (const field of ['supportsFlags', 'supportsRedirect', 'supportsVariables']) assert.equal(typeof target[field], 'boolean');
    assert.ok(target.maxActiveRules === null || Number.isInteger(target.maxActiveRules));
    assert.equal(typeof target.folderDelimiter, 'string');
    assert.ok(target.notes.length);
    assert.notEqual(target.verifyStatus, 'verified', `${target.id} has not been tested on a real server`);
  }
});

test('candidate support, unknown extensions and missing action prerequisites', () => {
  const result = capabilityCheck(getTarget('fastmail'), {
    extensions: ['fileinto', 'imap4flags', 'future-extension'], actions: ['fileinto', 'addflag', 'redirect', 'unknown-action'], ruleCount: 2,
  });
  assert.equal(result.supported.length, 5);
  assert.equal(result.unsupported.length, 2);
  assert.match(result.unsupported.join('\n'), /future-extension/);
  const generic = capabilityCheck(getTarget('generic'), { extensions: ['imap4flags'], actions: ['addflag', 'set'] });
  assert.equal(generic.supported.length, 0);
  assert.equal(generic.unsupported.length, 3);
  assert.match(generic.unsupported.join('\n'), /需要 imap4flags/);
  assert.deepEqual(capabilityCheck(getTarget('generic')), { supported: [], unsupported: [] });
  assert.deepEqual(capabilityCheck(getTarget('unknown'), { actions: ['fileinto', 'keep'] }), capabilityCheck(getTarget('generic'), { actions: ['fileinto', 'keep'] }));
  assert.equal(capabilityCheck(getTarget('proton'), { actions: ['redirect'], extensions: ['copy'] }).unsupported.length, 2);
  assert.equal(capabilityCheck(getTarget('yahoo'), { actions: ['fileinto', 'keep'], extensions: ['fileinto'] }).unsupported.length, 3);
});

test('Proton conservatively reports free-plan active rule limit with guidance', () => {
  assert.equal(capabilityCheck(getTarget('proton'), { ruleCount: 1 }).unsupported.length, 0);
  const result = capabilityCheck(getTarget('proton'), { ruleCount: 2 });
  assert.match(result.unsupported[0], /上限 1/);
  assert.match(result.unsupported[0], /套餐/);
  assert.equal(capabilityCheck(getTarget('fastmail'), { ruleCount: 100 }).unsupported.length, 0);
});

test('manual recipe retains every converted result and manual review instructions', () => {
  const { results } = convertFilters([
    { id: 'a', criteria: { from: 'sender@example.com' }, actions: { label: 'Work' } },
    { id: 'b', criteria: { hasAttachment: 'true' }, actions: { shouldTrash: 'true' } },
  ], { target: 'outlook' });
  for (const id of ['outlook', 'yahoo']) {
    const target = getTarget(id);
    const recipe = buildRecipe(target, results);
    assert.match(recipe, /没有.*规则文件导入/);
    assert.match(recipe, /未翻译的规则不得静默丢弃/);
    for (const result of results) assert.ok(recipe.includes(result.description));
    for (const heading of ['原始 Gmail 规则', '目标动作', '手工步骤', '注意事项']) assert.equal(recipe.split(`### ${heading}`).length - 1, results.length);
    for (const note of target.notes) assert.ok(recipe.includes(note));
  }
});

test('recipe does not leak addresses from IDs or diagnostic issues', () => {
  const recipe = buildRecipe(getTarget('yahoo'), [{ id: 'private@example.net', status: 'skipped', description: 'from=allowed@example.org → label=Work', issues: ['Unsupported private@example.net'] }]);
  assert.ok(recipe.includes('allowed@example.org'));
  assert.ok(!recipe.includes('private@example.net'));
});

test('conventional default folders include independent reserved lists', () => {
  for (const target of TARGETS) {
    const folders = defaultFolders(target);
    assert.ok(folders.reserved.length > 0);
    assert.ok(folders.reserved.includes(folders.archiveFolder));
    assert.ok(folders.reserved.includes(folders.trashFolder));
    assert.notEqual(folders.reserved, target.reserved);
  }
  assert.equal(defaultFolders(getTarget('outlook')).trashFolder, 'Deleted Items');
  assert.equal(defaultFolders(getTarget('proton')).trashFolder, 'Trash');
});
