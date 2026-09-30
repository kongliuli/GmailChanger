import test from 'node:test';
import assert from 'node:assert/strict';
import { sendersCsv, foldersJson, gapsMarkdown, migrationReadme } from '../src/exports.js';

test('sender CSV escapes spreadsheet formulas and quotes', () => {
  const csv = sendersCsv([{ email: '=1+1@example.com', count: 2 }]);
  assert.match(csv, /^\uFEFF地址,邮件数量/);
  assert.match(csv, /"'=1\+1@example\.com",2/);
});

test('folders manifest filters omitted entries and identifies unverified target', () => {
  const data = JSON.parse(foldersJson([{ label: 'Work', folder: 'Work', notes: [] }, { label: 'Trash', folder: null, notes: ['reserved'] }], { target: 'fastmail' }));
  assert.equal(data.folders.length, 1);
  assert.equal(data.omitted.length, 1);
  assert.equal(data.targetVerifyStatus, 'unverified');
});

test('migration guide calls sender addresses candidates and does not claim mail transfer', () => {
  const doc = migrationReadme({ target: 'generic', files: [{ name: 'rules.sieve', purpose: 'rules' }], folders: [{ label: 'Work', folder: 'Work', notes: [] }] });
  assert.match(doc, /不搬运邮件/);
  assert.match(doc, /候选/);
  assert.match(doc, /测试邮件/);
});

test('manual target guide does not claim Sieve import', () => {
  const doc = migrationReadme({ target: 'outlook', results: [{ id: '1', status: 'skipped', description: 'from=a@example.com → label=Work', issues: [] }] });
  assert.match(doc, /手工配方/);
  assert.match(doc, /Outlook\.com/);
  assert.match(gapsMarkdown([], [{ status: 'approximate', issues: [] }], { target: 'proton' }), /近似（默认禁用/);
});
