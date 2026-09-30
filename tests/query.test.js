import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGmailQuery, describeTests } from '../src/query.js';

const accepted = [
  ['hello', 'body', 'contains', 'hello'],
  ['"hello world"', 'body', 'contains', 'hello world'],
  ['"say \\"hi\\""', 'body', 'contains', 'say "hi"'],
  ['subject:"say \\"hi\\""', 'subject', 'contains', 'say "hi"'],
  ['subject:News', 'subject', 'contains', 'News'],
  ['from:USER@Example.COM', 'from', 'is', 'user@example.com'],
  ['to:"USER@Example.COM"', 'to', 'is', 'user@example.com'],
  ['cc:USER@Example.COM', 'cc', 'is', 'user@example.com'],
  ['from:Example', 'from', 'contains', 'Example'],
  ['larger:10M', 'size', 'over', 10485760],
  ['smaller:2k', 'size', 'under', 2048],
  ['size:1G', 'size', 'over', 1073741824],
  ['size:100', 'size', 'over', 100],
  ['size:0', 'size', 'over', 0],
  ['size:4294967295', 'size', 'over', 4294967295],
  ['has:attachment', 'attachment', 'is', 'attachment'],
];

for (const [query, field, op, value] of accepted) {
  test(`accept ${query}`, () => {
    assert.deepEqual(parseGmailQuery(query), { tests: [{ field, op, value, raw: query }], negated: [], unsupported: [] });
  });
}

test('implicit AND and parentheses-free simple lists preserve every literal', () => {
  const result = parseGmailQuery('  hello "world news" subject:Update cc:a@example.com  ');
  assert.equal(result.unsupported.length, 0);
  assert.deepEqual(result.tests.map(item => item.value), ['hello', 'world news', 'Update', 'a@example.com']);
});

test('one leading minus moves only that condition into negated', () => {
  const result = parseGmailQuery('hello -subject:"Bad news" -has:attachment -larger:10M');
  assert.equal(result.unsupported.length, 0);
  assert.equal(result.tests.length, 1);
  assert.deepEqual(result.negated.map(item => item.field), ['subject', 'attachment', 'size']);
  assert.equal(result.negated[0].raw, '-subject:"Bad news"');
});

test('escaped backslash is literal data', () => {
  assert.equal(parseGmailQuery('"a\\\\b"').tests[0].value, 'a\\b');
});

test('even identical OR operands fail closed, including normalized and negated identities', () => {
  for (const query of ['hello OR hello', '-hello OR -hello', 'from:A@example.com OR from:a@example.com']) {
    const result = parseGmailQuery(query);
    assert.ok(result.unsupported.some(reason => reason.includes('不支持显式 OR')));
    assert.deepEqual(result.tests, []);
    assert.deepEqual(result.negated, []);
  }
});

const rejected = [
  ['', /为空/], ['   ', /为空/], ['x'.repeat(4097), /4096/],
  ['a\nb', /控制字符/], ['a\u007fb', /控制字符/], ['a\u0085b', /控制字符/], ['a\u2028b', /控制字符/],
  [Array(21).fill('word').join(' '), /20/],
  ['"unterminated', /未闭合/], ['"trailing\\', /未闭合/], ['"bad\\q"', /转义/],
  ['pre"quoted"', /引号拼接/], ['"quoted"tail', /包围完整/], ['plain\\word', /反斜杠/],
  ['-', /前导减号/], ['--word', /前导减号/], ['subject:-word', /嵌套逻辑/],
  ['{one two}', /大括号/], ['(one OR two)', /括号/], ['word*', /通配符/], ['word?', /通配符/],
  ['subject:"a*b"', /通配符/], ['subject:from:abc', /冒号/], ['https://example.com', /不支持 https:/],
  ['subject:', /为空/], ['subject:" "', /为空/],
  ['AND', /逻辑运算符/], ['NOT', /逻辑运算符/], ['"a OR b"', /逻辑运算符/], ['subject:OR', /逻辑运算符/],
  ['from:"Name <a@example.com>"', /邮箱/], ['to:a@example.com,b@example.com', /邮箱/],
  ['larger:1.5M', /非负整数/], ['size:1MB', /非负整数/], ['size:-1', /嵌套逻辑/],
  ['size:4G', /32 位/], ['size:9007199254740992', /32 位/], ['has:drive', /仅支持/],
  ...['label', 'in', 'is', 'list', 'filename', 'bcc', 'after', 'before', 'newer_than', 'older_than', 'category', 'unknown'].map(key => [`${key}:value`, /不支持/]),
  ['hello OR world', /扁平测试/], ['OR', /不支持显式 OR/], ['OR hello', /不支持显式 OR/], ['hello OR', /不支持显式 OR/],
  ['a OR b OR c', /不支持显式 OR/], ['a b OR c', /不支持显式 OR/], ['a OR OR', /不支持显式 OR/],
  ['a -a', /肯定和否定/], ['from:a@example.com from:b@example.com', /冲突/],
  ['larger:1 larger:2', /冲突/], ['larger:10 smaller:5', /上下限|上限与下限/],
];
for (const [query, reason] of rejected) {
  test(`reject ${JSON.stringify(query).slice(0, 80)}`, () => {
    const result = parseGmailQuery(query);
    assert.ok(result.unsupported.some(message => reason.test(message)), result.unsupported.join('; '));
    assert.deepEqual(result.tests, []);
    assert.deepEqual(result.negated, []);
  });
}

test('unsupported tokens never produce a silently narrowed test list', () => {
  for (const [bad] of rejected.filter(([value]) => value.trim())) {
    const result = parseGmailQuery(`from:safe@example.com -subject:spam ${bad}`);
    assert.ok(result.unsupported.length, bad);
    assert.deepEqual(result.tests, [], bad);
    assert.deepEqual(result.negated, [], bad);
  }
});

test('boundary limits and repeated identical tests', () => {
  assert.equal(parseGmailQuery('a'.repeat(4096)).unsupported.length, 0);
  assert.equal(parseGmailQuery(Array(20).fill('a').join(' ')).tests.length, 20);
  assert.equal(parseGmailQuery('larger:1 smaller:10').tests.length, 2);
  assert.equal(parseGmailQuery('from:a@example.com from:a@example.com').tests.length, 2);
});

test('only non-string user input throws', () => {
  for (const value of [undefined, null, 1, true, [], {}, new String('hello')]) {
    assert.throws(() => parseGmailQuery(value), TypeError);
  }
});

test('Sieve-looking text remains data, never emitted executable tokens', () => {
  const result = parseGmailQuery('"discard; stop; \\"payload\\""');
  assert.equal(result.unsupported.length, 0);
  assert.deepEqual(result.tests, [{ field: 'body', op: 'contains', value: 'discard; stop; "payload"', raw: '"discard; stop; \\"payload\\""' }]);
  assert.ok(parseGmailQuery('"x\\"; } discard; #"').unsupported.length);
});

test('Chinese summaries are plain text and retain literal values', () => {
  assert.equal(describeTests([]), '');
  const result = parseGmailQuery('subject:"News update" larger:10M has:attachment');
  assert.equal(describeTests(result.tests), '主题包含"News update"，且大小大于10485760 字节，且含附件');
});
