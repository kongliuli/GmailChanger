// ponytail: flat scalar tests cannot encode anyof. Reject every explicit OR rather
// than silently turn it into AND; add a boolean AST before expanding this subset.
// Parsing is atomic: an unsupported condition invalidates the entire query.
const unsafe = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const names = { from: '发件人', to: '收件人', cc: '抄送', subject: '主题', body: '正文', header: '邮件头', size: '大小', attachment: '附件', label: '标签', is: '状态', list: '邮件列表' };

export function parseGmailQuery(value) {
  if (typeof value !== 'string') throw new TypeError('parseGmailQuery expects a string.');
  const tests = [], negated = [], unsupported = [];
  const reject = reason => unsupported.push(reason);
  const finish = () => ({ tests: unsupported.length ? [] : tests, negated: unsupported.length ? [] : negated, unsupported });
  if (value.length > 4096) reject('查询长度超过 4096 个字符。');
  if (unsafe.test(value)) reject('查询含控制字符或换行分隔符。');
  if (!value.trim()) reject('查询为空，不能生成无条件规则。');
  if (unsupported.length) return finish();

  const tokens = [];
  let start = 0, quoted = false;
  for (let i = 0; i <= value.length; i++) {
    const char = value[i];
    if (quoted && char === '\\') {
      if (value[i + 1] !== '"' && value[i + 1] !== '\\') reject('引号内只支持转义双引号或反斜杠。');
      i++;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (i === value.length || (!quoted && /\s/u.test(char))) {
      if (i > start) tokens.push(value.slice(start, i));
      start = i + 1;
    }
  }
  if (quoted) reject('查询的双引号未闭合。');
  if (tokens.length > 20) reject('查询超过 20 个词元（OR 也计数）。');
  if (unsupported.length) return finish();

  const parsed = tokens.map(raw => {
    if (raw === 'OR') { reject('不支持显式 OR：扁平测试 API 不表示析取，即使两个条件相同也必须跳过整条规则。'); return null; }
    let text = raw, negative = false;
    const fail = reason => { reject(`${raw}：${reason}`); return null; };
    if (text.startsWith('-')) { negative = true; text = text.slice(1); }
    if (!text || text.startsWith('-')) return fail('只支持一个前导减号，且必须有条件。');
    if (/[{}]/u.test(text)) return fail('不支持大括号分组。');
    if (/[()*?]/u.test(text)) return fail('不支持括号分组或通配符 *、?。');
    const keyMatch = /^([a-zA-Z_]+):/u.exec(text);
    const key = keyMatch ? keyMatch[1].toLowerCase() : '';
    if (keyMatch) text = text.slice(keyMatch[0].length);
    let literal = text;
    if (text.startsWith('"')) {
      if (!/^"(?:[^"\\]|\\["\\])*"$/u.test(text)) return fail('引号必须包围完整的单个值。');
      literal = text.slice(1, -1).replace(/\\(["\\])/gu, '$1');
    } else if (/["\\]/u.test(text)) return fail('裸值不支持引号拼接或反斜杠转义。');
    if (!literal.trim()) return fail('条件值为空。');
    if (literal.includes(':')) return fail('值含冒号或嵌套键，不能作为普通字面量。');
    if (/^(?:AND|OR|NOT)$/u.test(literal) || /(?:^|\s)(?:AND|OR|NOT)(?:\s|$)/u.test(literal) || literal.startsWith('-')) return fail('值包含嵌套逻辑运算符。');
    let field = key || 'body', op = 'contains', result = literal;
    if (['from', 'to', 'cc'].includes(key)) {
      if (literal.includes('@')) {
        if (!/^[a-z0-9!#$%&'+/=?^_`~-]+(?:\.[a-z0-9!#$%&'+/=?^_`~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(literal)) return fail('邮箱必须是单个普通地址，不能是列表或显示名。');
        result = literal.toLowerCase();
        op = 'is';
      }
    } else if (['larger', 'smaller', 'size'].includes(key)) {
      const match = /^(\d+)([KMG]?)$/iu.exec(literal);
      if (!match) return fail('大小必须是非负整数，单位仅支持 K、M、G 或字节。');
      result = Number(match[1]) * ({ '': 1, K: 1024, M: 1048576, G: 1073741824 }[match[2].toUpperCase()]);
      if (!Number.isSafeInteger(result) || result > 4294967295) return fail('大小超出 32 位字节范围。');
      field = 'size';
      op = key === 'smaller' ? 'under' : 'over';
    } else if (key === 'has') {
      if (literal !== 'attachment') return fail('has: 仅支持 attachment。');
      field = 'attachment'; op = 'is'; result = 'attachment';
    } else if (key && key !== 'subject') {
      return fail(`不支持 ${key}: 运算符，必须跳过整条规则。`);
    }
    return { negative, test: { field, op, value: result, raw } };
  });

  for (const item of parsed) {
    if (!item) continue;
    const { negative, test } = item;
    const target = negative ? negated : tests;
    const opposite = negative ? tests : negated;
    if (opposite.some(other => other.field === test.field && other.op === test.op && other.value === test.value)) reject(`${test.raw}：同一条件同时肯定和否定，运算符冲突。`);
    if (target.some(other => other.field === test.field && other.op === test.op && other.value !== test.value && (test.op === 'is' || test.field === 'size'))) reject(`${test.raw}：重复字段具有冲突的值或大小运算符。`);
    target.push(test);
  }
  for (const list of [tests, negated]) {
    const over = list.find(test => test.field === 'size' && test.op === 'over');
    const under = list.find(test => test.field === 'size' && test.op === 'under');
    if (over && under && over.value >= under.value) reject('大小上限与下限冲突。');
  }
  return finish();
}

export function describeTests(tests) {
  return tests.map(test => test.field === 'attachment' ? '含附件' : `${names[test.field] || test.field}${({ is: '为', contains: '包含', over: '大于', under: '小于' })[test.op]}${JSON.stringify(test.value)}${test.field === 'size' ? ' 字节' : ''}`).join('，且');
}
