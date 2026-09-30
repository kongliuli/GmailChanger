import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMailbox, buildFolders, decodeHeaderValue } from '../src/mailbox.js';
import { createAccountSummary } from '../src/accounts.js';

const envelope = 'From sender@example.com Sat Jan 01 00:00:00 +0000 2022\r\n';
const message = (headers, body = 'body\r\n') => envelope + headers + '\r\n\r\n' + body;
function chunked(text, chunkSize = 7) {
  const blob = new Blob([text]);
  return {
    name: 'All Mail.mbox', size: blob.size,
    stream() {
      let offset = 0;
      return new ReadableStream({ async pull(controller) {
        if (offset >= blob.size) { controller.close(); return; }
        const chunk = await blob.slice(offset, offset + chunkSize).arrayBuffer();
        offset += chunkSize;
        controller.enqueue(new Uint8Array(chunk));
      } });
    },
  };
}

test('streams CRLF and UTF-8, folded quoted labels and sent-only sender identities', async () => {
  const progress = [];
  const source = message('From: Incoming <other@example.org>\r\nX-Gmail-Labels: Inbox, Work') +
    message('From: "Doe, Jane" <ME@Example.org>\r\nX-Gmail-Labels: Sent,"Work, Projects",\r\n\t"中文/家", "A ""quote"""\r\nMessage-ID: <one@example.org>', 'From ordinary body text\r\n>From sender@example.com Sat Jan 01 00:00:00 2022\r\n') +
    message('From: me@example.org\r\nX-Gmail-Labels: 已发送邮件\r\nMessage-ID: <two@example.org>', 'last line');
  const result = await analyzeMailbox(chunked(source, 1), { onProgress: value => progress.push(value) });
  assert.equal(result.messageCount, 3);
  assert.deepEqual(result.senders, [{ email: 'me@example.org', count: 2 }]);
  assert.deepEqual(result.labels, ['A "quote"', 'Inbox', 'Sent', 'Work', 'Work, Projects', '中文/家', '已发送邮件']);
  assert.equal(result.duplicateCount, 0);
  assert.equal(progress.at(-1).bytesRead, new Blob([source]).size);
  assert.equal(progress.at(-1).messageCount, 3);
});

test('duplicates suppress sender counts but retain physical count and all labels', async () => {
  const result = await analyzeMailbox(chunked(
    message('From: me@example.org\r\nMessage-ID: <same@example.org>\r\nX-Gmail-Labels: Sent,First') +
    message('From: me@example.org\r\nMessage-ID: <same@example.org>\r\nX-Gmail-Labels: Sent,Second') +
    message('From: me@example.org\r\nX-Gmail-Labels: Sent')));
  assert.equal(result.messageCount, 3);
  assert.equal(result.duplicateCount, 1);
  assert.deepEqual(result.senders, [{ email: 'me@example.org', count: 2 }]);
  assert.ok(result.labels.includes('Second'));
  assert.ok(result.warnings.some(value => value.includes('does not span files')));
});

test('an unsent first copy does not suppress a later sent copy with the same Message-ID', async () => {
  const result = await analyzeMailbox(new Blob([
    message('From: me@example.org\r\nMessage-ID: <same@example.org>\r\nX-Gmail-Labels: All Mail'),
    message('From: me@example.org\r\nMessage-ID: <same@example.org>\r\nX-Gmail-Labels: Sent'),
    message('From: me@example.org\r\nMessage-ID: <same@example.org>\r\nX-Gmail-Labels: Sent'),
  ]));
  assert.equal(result.messageCount, 3);
  assert.equal(result.duplicateCount, 2);
  assert.deepEqual(result.senders, [{ email: 'me@example.org', count: 1 }]);
});

test('All Mail copy in one file does not suppress a Sent copy in another file', async () => {
  const seen = new Set();
  const id = '<takeout-copy@example.org>';
  const allMail = await analyzeMailbox(new Blob([
    message(`From: me@example.org\r\nMessage-ID: ${id}\r\nX-Gmail-Labels: All Mail`),
  ]), { seen });
  assert.deepEqual(allMail.senders, []);
  assert.equal(seen.size, 0);

  const sent = await analyzeMailbox(new Blob([
    message(`From: me@example.org\r\nMessage-ID: ${id}\r\nX-Gmail-Labels: Sent`),
  ]), { seen });
  assert.deepEqual(sent.senders, [{ email: 'me@example.org', count: 1 }]);
  assert.equal(sent.crossFileDuplicates, 0);
  assert.deepEqual([...seen], [id]);
});

test('sentHint is explicit; filenames and arbitrary From strings do not establish identity', async () => {
  const source = chunked(message('From: me@example.org'));
  source.name = 'Sent.mbox';
  assert.deepEqual((await analyzeMailbox(source)).senders, []);
  assert.deepEqual((await analyzeMailbox(source, { sentHint: true })).senders, [{ email: 'me@example.org', count: 1 }]);
  const malformed = ['a@example.org, b@example.org', 'a@example.org <b@example.org>', 'Name <a@example.org>, Name <b@example.org>', 'some arbitrary a@example.org text', 'Group: a@example.org;', 'bad..dots@example.org', 'Name <a@example.org> trailing', 'a@example.org\r\nFrom: b@example.org'];
  for (const from of malformed) {
    const result = await analyzeMailbox(chunked(message(`From: ${from}`)), { sentHint: true });
    assert.deepEqual(result.senders, [], from);
    assert.ok(result.warnings.length, from);
  }
});

test('empty, malformed, missing headers and an RFC822 message fail safely', async () => {
  assert.equal((await analyzeMailbox(new Blob([]))).messageCount, 0);
  const invalid = await analyzeMailbox(chunked(message('not a header', 'From: victim@example.org\r\nX-Gmail-Labels: Sent\r\n')));
  assert.equal(invalid.messageCount, 1);
  assert.deepEqual(invalid.senders, []);
  assert.deepEqual(invalid.labels, []);
  const raw = await analyzeMailbox(chunked('From: me@example.org\nX-Gmail-Labels: Sent\n\nbody'));
  assert.equal(raw.messageCount, 1);
  assert.equal(raw.senders[0].email, 'me@example.org');
  assert.ok(raw.warnings.some(value => value.includes('envelope')));
  const emptyHeaders = await analyzeMailbox(chunked(envelope + '\r\nFrom: fake@example.org\r\n'));
  assert.deepEqual(emptyHeaders.senders, []);
  assert.ok(emptyHeaders.warnings.length);
  const garbage = await analyzeMailbox(chunked('garbage preamble\nFrom: fake@example.org\nX-Gmail-Labels: Sent\n\n'));
  assert.equal(garbage.messageCount, 0);
  assert.deepEqual(garbage.senders, []);
});

test('oversized body lines stay bounded and oversized headers are discarded', async () => {
  const huge = 'x'.repeat(300000);
  const result = await analyzeMailbox(chunked(
    message('From: me@example.org\r\nX-Gmail-Labels: Sent', huge + '\n') +
    message('From: me@example.org\r\nX-Gmail-Labels: Sent\r\nX-Huge: ' + huge) +
    message('From: me@example.org\r\nX-Gmail-Labels: Sent'), 8192));
  assert.equal(result.messageCount, 3);
  assert.equal(result.senders[0].count, 2);
  assert.ok(result.warnings.some(value => value.includes('Header limits')));
  const folded = await analyzeMailbox(chunked(message('From: me@example.org\r\nX-Gmail-Labels: Sent\r\nSubject: x' + ('\r\n ' + 'x'.repeat(1000)).repeat(300)), 4096));
  assert.deepEqual(folded.senders, []);
  assert.ok(folded.warnings.some(value => value.includes('Header limits')));
});

test('unterminated CSV quoting is skipped and escaped quotes are supported', async () => {
  const result = await analyzeMailbox(chunked(message('X-Gmail-Labels: "unterminated,Sent') + message('X-Gmail-Labels: "A \\"quote\\"",Work')));
  assert.deepEqual(result.labels, ['A "quote"', 'Work']);
  assert.ok(result.warnings.some(value => value.includes('quoted')));
});

test('cancellation rejects before starting and during a pending stream read', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(analyzeMailbox(new Blob([]), { signal: controller.signal }), { name: 'AbortError' });
  const pending = new AbortController();
  let cancelled = false;
  const file = { size: 100, stream: () => new ReadableStream({ pull() { pending.abort(); }, cancel() { cancelled = true; } }) };
  await assert.rejects(analyzeMailbox(file, { signal: pending.signal }), { name: 'AbortError' });
  assert.equal(cancelled, true);
});

test('deduplication is bounded at 100000 IDs with an explicit warning', async () => {
  const records = [];
  for (let i = 0; i <= 100000; i++) records.push(message(`Message-ID: <${i}@example.org>`));
  records.push(message('Message-ID: <0@example.org>'));
  const result = await analyzeMailbox(new Blob(records));
  assert.equal(result.messageCount, 100002);
  assert.equal(result.duplicateCount, 1);
  assert.ok(result.warnings.some(value => value.includes('100000')));
});

test('RFC 2047 decodes B, Q, adjacent words and supported or unknown charsets', () => {
  assert.equal(decodeHeaderValue('plain 中文 text'), 'plain 中文 text');
  assert.equal(decodeHeaderValue('=?utf-8?B?5Lit5paH?='), '中文');
  assert.equal(decodeHeaderValue('=?UTF-8?Q?J=C3=B6rg_Smith?='), 'Jörg Smith');
  assert.equal(decodeHeaderValue('=?utf-8?B?5Lit?= \r\n\t=?utf-8?Q?=E6=96=87?='), '中文');
  assert.equal(decodeHeaderValue('prefix =?us-ascii?Q?Hello?= =?us-ascii?Q?_World?= suffix'), 'prefix Hello World suffix');
  assert.equal(decodeHeaderValue('=?iso-8859-1?Q?Andr=E9?='), 'André');
  assert.equal(decodeHeaderValue('=?iso-8859-1?B?Q2Fm6Q==?='), 'Café');
  assert.equal(decodeHeaderValue('=?unknown-charset?Q?=E4=B8=AD?='), '中');
});

test('malformed encoded words preserve the entire original header', () => {
  for (const value of ['=?utf-8?B?!!!?=', '=?utf-8?B?YQ=?=', '=?utf-8?B?YR==?=', '=?utf-8?Q?bad=ZZ?=', '=?utf-8?Q?bad=?=', '=?utf-8?X?abc?=', '=?utf-8?Q?missing', '=?utf-8?Q??=', '=?utf-8?Q?Good?= =?utf-8?B?bad!?=']) {
    assert.equal(decodeHeaderValue(value), value);
  }
});

test('encoded From and Gmail labels are decoded before parsing', async () => {
  const result = await analyzeMailbox(new Blob([
    message('From: =?utf-8?B?bWVAZXhhbXBsZS5vcmc=?=\r\nX-Gmail-Labels: =?utf-8?Q?Sent=2C?= =?utf-8?B?5Lit5paH?='),
    message('From: =?utf-8?Q?other=40example.org?=\r\nX-Gmail-Labels: =?us-ascii?B?U2VudA==?=, =?iso-8859-1?Q?Caf=E9?='),
  ]));
  assert.deepEqual(result.senders, [{ email: 'me@example.org', count: 1 }, { email: 'other@example.org', count: 1 }]);
  assert.deepEqual(result.labels, ['Café', 'Sent', '中文']);
  assert.deepEqual(result.decodeWarnings, []);
  assert.equal(result.crossFileDuplicates, 0);
});

test('encoded label commas remain inside one label and cannot create Sent metadata', async () => {
  const result = await analyzeMailbox(new Blob([
    message('From: stranger@example.org\r\nX-Gmail-Labels: =?utf-8?Q?Sales=2CSent?='),
  ]));
  assert.deepEqual(result.labels, ['Sales,Sent']);
  assert.deepEqual(result.senders, []);
});

test('encoded display-name punctuation does not invalidate its address', async () => {
  const result = await analyzeMailbox(new Blob([
    message('From: =?utf-8?Q?Doe=2C_Jane=3A_Research?= <ME@example.org>\r\nX-Gmail-Labels: Sent'),
  ]));
  assert.deepEqual(result.senders, [{ email: 'me@example.org', count: 1 }]);
  assert.deepEqual(result.decodeWarnings, []);
});

test('shared Message-ID fingerprints suppress cross-file senders separately from local repeats', async () => {
  const seen = new Set();
  const first = message('From: me@example.org\r\nX-Gmail-Labels: Sent\r\nMessage-ID: <same@example.org>');
  assert.deepEqual((await analyzeMailbox(new Blob([first]), { seen })).senders, [{ email: 'me@example.org', count: 1 }]);
  assert.deepEqual([...seen], ['<same@example.org>']);
  const second = await analyzeMailbox(new Blob([
    message('From: me@example.org\r\nX-Gmail-Labels: Sent,Second\r\nMessage-ID:   <same@example.org>  '), first,
  ]), { seen });
  assert.equal(second.messageCount, 2);
  assert.equal(second.duplicateCount, 1);
  assert.equal(second.crossFileDuplicates, 1);
  assert.deepEqual(second.senders, []);
  assert.ok(second.labels.includes('Second'));
  assert.ok(second.warnings.some(value => value.includes('跨文件')));
  const third = await analyzeMailbox(new Blob([first]), { seen });
  assert.equal(third.crossFileDuplicates, 1);
  assert.equal(third.duplicateCount, 0);
  assert.equal(seen.size, 1);
  assert.equal((await analyzeMailbox(new Blob([first]))).senders[0].count, 1);
});

test('missing, malformed and multiple Message-IDs never become fingerprints', async () => {
  const seen = new Set();
  const ids = ['', '\r\nMessage-ID: not-an-id', '\r\nMessage-ID: <two@example.org> <three@example.org>', '\r\nMessage-ID: <a@example.org>\r\nMessage-ID: <b@example.org>'];
  const source = ids.map(id => message('From: me@example.org\r\nSubject: Same\r\nDate: Same' + id));
  for (let i = 0; i < 2; i++) {
    const result = await analyzeMailbox(new Blob([...source, ...source]), { seen, sentHint: true });
    assert.deepEqual(result.senders, [{ email: 'me@example.org', count: 8 }]);
    assert.equal(result.crossFileDuplicates, 0);
    assert.equal(result.duplicateCount, 0);
  }
  assert.equal(seen.size, 0);
});

test('shared IDs are added only when a sender is counted and are bounded', async () => {
  const seen = new Set();
  const id = '\r\nMessage-ID: <counted@example.org>';
  await analyzeMailbox(new Blob([message('From: me@example.org' + id)]), { seen });
  await analyzeMailbox(new Blob([message('From: bad address' + id)]), { seen, sentHint: true });
  assert.equal(seen.size, 0);
  assert.equal((await analyzeMailbox(new Blob([message('From: me@example.org' + id)]), { seen, sentHint: true })).senders[0].count, 1);
  // Fill the caller-owned set directly; do not stream another 100000-message fixture.
  for (let i = 1; i < 100000; i++) seen.add(`<${i}@example.org>`);
  const result = await analyzeMailbox(new Blob([
    message('From: me@example.org\r\nMessage-ID: <untracked@example.org>'),
    message('From: me@example.org' + id),
  ]), { seen, sentHint: true });
  assert.equal(seen.size, 100000);
  assert.equal(seen.has('<untracked@example.org>'), false);
  assert.equal(result.crossFileDuplicates, 1);
  assert.equal(result.senders[0].count, 1);
  assert.ok(result.warnings.some(value => value.includes('跨文件') && value.includes('100000')));
});

test('replacement characters and unsupported From values produce counted Chinese notes', async () => {
  const result = await analyzeMailbox(new Blob([
    message('From: =?utf-8?Q?=FF?= <me@example.org>\r\nX-Gmail-Labels: Sent,=?utf-8?B?/w==?='),
    envelope + 'From: non-ascii-用户@example.org\r\nX-Gmail-Labels: ', new Uint8Array([255]), '\r\n\r\n',
    message('From: bad address'),
  ]));
  assert.deepEqual(result.senders, [{ email: 'me@example.org', count: 1 }]);
  assert.equal(result.decodeWarnings.length, 2);
  assert.ok(result.decodeWarnings[0].includes('1 个 Unicode 替换字符'));
  assert.ok(result.decodeWarnings[1].includes('2 个无法保守解析的 From 值'));
  assert.ok(result.decodeWarnings.every(note => result.warnings.includes(note)));
});

const reportOf = snapshot => { const summary = createAccountSummary(); summary.absorb(snapshot); return summary.report(); };

test('aggregates account evidence, demotes marketing and keeps unclassified visible', async () => {
  const result = await analyzeMailbox(new Blob([
    message('From: Acme <no-reply@acme.example>\r\nDate: Sat, 01 Jan 2022 10:00:00 +0000\r\nSubject: Welcome to Acme! Your account is ready\r\nMessage-ID: <w1@acme.example>'),
    message('From: Steam <no-reply@steam.example>\r\nDate: Sun, 02 Jan 2022 10:00:00 +0000\r\nSubject: 482913 is your Steam login code\r\nMessage-ID: <s1@steam.example>'),
    message('From: Weekly <news@weekly.example>\r\nDate: Mon, 03 Jan 2022 10:00:00 +0000\r\nList-Unsubscribe: <https://weekly.example/u>\r\nSubject: Your weekly digest\r\nMessage-ID: <n1@weekly.example>'),
    message('From: Digest <hi@news.example>\r\nDate: Tue, 04 Jan 2022 10:00:00 +0000\r\nList-Unsubscribe: <https://news.example/u>\r\nSubject: Welcome to the digest\r\nMessage-ID: <n2@news.example>'),
    message('From: Mom <mom@family.example>\r\nDate: Wed, 05 Jan 2022 10:00:00 +0000\r\nSubject: Lunch on Sunday?\r\nMessage-ID: <f1@family.example>'),
    message('From: bad address\r\nDate: Thu, 06 Jan 2022 10:00:00 +0000\r\nSubject: Welcome!\r\nMessage-ID: <x1@nowhere>'),
  ]));
  const report = reportOf(result.accounts);
  assert.deepEqual(report.evidence.map(row => row.domain), ['acme.example', 'steam.example']);
  assert.equal(report.evidence[0].counts.welcome, 1);
  assert.equal(report.evidence[0].name, 'Acme');
  assert.equal(new Date(report.evidence[0].first).toISOString(), '2022-01-01T10:00:00.000Z');
  assert.equal(new Date(report.evidence[0].last).toISOString(), '2022-01-01T10:00:00.000Z');
  assert.deepEqual(report.evidence[0].samples, ['<w1@acme.example>']);
  assert.equal(report.evidence[1].counts.security, 1);
  assert.deepEqual(report.mailingOnly.map(row => row.domain).sort(), ['news.example', 'weekly.example']);
  assert.deepEqual(report.unclassified.shown.map(row => row.domain), ['family.example']);
  assert.equal(report.unknownFrom, 1);
});

test('duplicate Message-IDs within a file count once for account evidence', async () => {
  const result = await analyzeMailbox(new Blob([
    message('From: a@acme.example\r\nSubject: Welcome\r\nMessage-ID: <dup@acme.example>'),
    message('From: a@acme.example\r\nSubject: Welcome again\r\nMessage-ID: <dup@acme.example>'),
  ]));
  const report = reportOf(result.accounts);
  assert.equal(report.evidence[0].counts.welcome, 1);
  assert.equal(report.evidence[0].messageCount, 1);
});

test('evidenceSeen suppresses cross-file account counting and records counted IDs', async () => {
  const evidenceSeen = new Set();
  const first = await analyzeMailbox(new Blob([message('From: a@acme.example\r\nSubject: Welcome\r\nMessage-ID: <one@acme.example>')]), { evidenceSeen });
  assert.deepEqual([...evidenceSeen], ['<one@acme.example>']);
  assert.equal(reportOf(first.accounts).evidence[0].counts.welcome, 1);
  const second = await analyzeMailbox(new Blob([message('From: a@acme.example\r\nSubject: Welcome back\r\nMessage-ID: <one@acme.example>')]), { evidenceSeen });
  const merged = createAccountSummary();
  merged.absorb(first.accounts);
  merged.absorb(second.accounts);
  const record = merged.report().evidence[0];
  assert.equal(record.counts.welcome, 1);
  assert.equal(record.messageCount, 1);
});

test('single option accepts a standalone RFC822 file without an envelope warning', async () => {
  const raw = 'From: a@acme.example\r\nSubject: Verify your account\r\nMessage-ID: <e1@acme.example>\r\n\r\nbody\r\n';
  const quiet = await analyzeMailbox(new Blob([raw]), { single: true });
  assert.equal(quiet.messageCount, 1);
  assert.ok(!quiet.warnings.some(value => value.includes('envelope')));
  assert.equal(reportOf(quiet.accounts).evidence[0].counts.verify, 1);
  const warned = await analyzeMailbox(new Blob([raw]));
  assert.ok(warned.warnings.some(value => value.includes('envelope')));
});

test('account aggregation tolerates invalid Date headers', async () => {
  const result = await analyzeMailbox(new Blob([message('From: a@acme.example\r\nDate: not a date\r\nSubject: Welcome\r\nMessage-ID: <d1@acme.example>')]));
  const record = reportOf(result.accounts).evidence[0];
  assert.equal(record.first, null);
  assert.equal(record.last, null);
});

test('provider-reserved names omit folder creation and retain an explanatory mapping', () => {
  const mappings = buildFolders(['Inbox', 'ArchiveBox', 'Cafe\u0301', 'Work'], { reserved: ['archivebox', 'CAFÉ'] });
  assert.equal(mappings.length, 3);
  for (const label of ['ArchiveBox', 'Cafe\u0301']) {
    const mapping = mappings.find(value => value.label === label);
    assert.equal(mapping.folder, null);
    assert.ok(mapping.notes.some(note => note.includes('保留') && note.includes('跳过')));
  }
  assert.equal(mappings.find(value => value.label === 'Work').folder, 'Work');
  assert.deepEqual(buildFolders(['Work']), buildFolders(['Work'], {}));
  assert.equal(buildFolders(['ArchiveBox'])[0].folder, 'ArchiveBox');
});

test('sanitized folder names cannot collide with provider-reserved names', () => {
  const mappings = buildFolders(['Vault.', 'Vault', 'Folder/Vault.'], { reserved: ['Vault'] });
  assert.equal(mappings.find(value => value.label === 'Vault').folder, null);
  assert.equal(mappings.find(value => value.label === 'Vault.').folder, 'Vault (2)');
  assert.equal(mappings.find(value => value.label === 'Folder/Vault.').folder, 'Folder/Vault');
});

test('folder mappings omit system labels, preserve nesting, sanitize and resolve collisions', () => {
  const mappings = buildFolders(['Inbox', 'Sent', '已发送', '[Gmail]/Trash', 'Category:Social', 'Work/Projects', 'Work', 'work', 'a\\b', 'a:b', '../x', 'Cafe\u0301', 'Café', 'Work']);
  assert.equal(mappings.length, 8);
  assert.equal(mappings.find(value => value.label === 'Work/Projects').folder, 'Work/Projects');
  assert.ok(mappings.find(value => value.label === 'Work/Projects').notes.length);
  assert.equal(new Set(mappings.map(value => value.folder.toLowerCase())).size, mappings.length);
  assert.equal(mappings.find(value => value.label === '../x').folder, '_/x');
  assert.ok(mappings.some(value => value.notes.some(note => note.includes('collision'))));
  assert.ok(mappings.every(value => Array.isArray(value.notes)));
});
