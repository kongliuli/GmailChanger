// ponytail: header-only Takeout parser; full MIME/address parsing needs a MIME library.
const MAX_LINE = 64 * 1024;
const MAX_HEADERS = 256 * 1024;
const MAX_IDS = 100000;
const SENT = new Set(['sent', 'sent mail', 'sent messages', '[gmail]/sent mail', '\\sent', '已发送', '已发送邮件', '已寄出', '已寄出的郵件', '寄件備份']);
const SYSTEM = new Set([...SENT, 'inbox', 'all mail', 'allmail', 'draft', 'drafts', 'spam', 'trash', 'bin', 'starred', 'important', 'unread', 'read', 'chats', 'archived', 'archive', '收件箱', '收件匣', '所有邮件', '所有郵件', '草稿', '垃圾邮件', '垃圾郵件', '垃圾箱', '垃圾桶', '已加星标', '已加星號', '重要', '未读', '未讀']);
const ENVELOPE = /^From \S+ (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}(?::\d{2})?\s+(?:\S+\s+)?\d{4}(?:\s.*)?$/;
const HEADER = /^([!-9;-~]+):[ \t]*(.*)$/;
const ADJACENT_WORDS = /=\?[^?\s]+\?[bq]\?[^?\s]+\?=[ \t\r\n]+=\?/i;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** Decode RFC 2047 words; leave the entire value intact if their syntax is malformed. */
export function decodeHeaderValue(value) {
  const original = String(value ?? '');
  let result = '', end = 0;
  try {
    for (const match of original.matchAll(/=\?([^?\s]+)\?([bq])\?([^?\s]+)\?=/gi)) {
      const gap = original.slice(end, match.index);
      if (gap.includes('=?')) return original;
      result += end && /^[ \t\r\n]*$/.test(gap) ? '' : gap;
      const [, charset, encoding, text] = match;
      const bytes = [];
      if (encoding.toLowerCase() === 'b') {
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) return original;
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        let bits = 0, buffer = 0;
        for (const char of text.replace(/=+$/, '')) {
          buffer = (buffer << 6) | alphabet.indexOf(char); bits += 6;
          if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 255); }
        }
        if (buffer & ((1 << bits) - 1)) return original;
      } else {
        if (/[^\x21-\x7e]|=(?![0-9a-f]{2})/i.test(text)) return original;
        for (let i = 0; i < text.length; i++) {
          if (text[i] === '=') { bytes.push(parseInt(text.slice(i + 1, i + 3), 16)); i += 2; }
          else bytes.push(text[i] === '_' ? 32 : text.charCodeAt(i));
        }
      }
      const name = charset.toLowerCase();
      result += new TextDecoder(['utf-8', 'us-ascii', 'iso-8859-1'].includes(name) ? name : 'utf-8').decode(new Uint8Array(bytes));
      end = match.index + match[0].length;
    }
    const tail = original.slice(end);
    return tail.includes('=?') ? original : result + tail;
  } catch {
    return original;
  }
}

/** Commas inside one encoded word are label text ("Sales,Sent"); adjacent encoded
 * words concatenate per RFC 2047, so a comma at that junction separates labels. */
function parseLabels(value, decode = value => value) {
  const parts = [];
  let part = '', quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '"') {
      if (quoted && value[i + 1] === '"') { part += '"'; i++; }
      else quoted = !quoted;
    } else if (char === '\\' && quoted && /["\\]/.test(value[i + 1] || '')) {
      part += value[++i];
    } else if (char === ',' && !quoted) {
      parts.push(part);
      part = '';
    } else part += char;
  }
  if (quoted) return null;
  parts.push(part);
  const labels = [];
  for (const raw of parts) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const decoded = decode(trimmed);
    if (ADJACENT_WORDS.test(trimmed)) {
      for (const piece of decoded.split(',')) if (piece.trim()) labels.push(piece.trim());
    } else labels.push(decoded);
  }
  return labels;
}

function parseSender(value, decode = value => value) {
  let address = value.trim();
  if (!address.includes('<')) address = decode(address);
  if (address.includes('<')) {
    const match = /^(.*?)<([^<>]+)>$/.exec(address);
    if (!match) return null;
    const rawDisplay = match[1].trim();
    const display = decode(rawDisplay);
    if (display && !rawDisplay.includes('=?') && !/^"(?:[^"\\\r\n]|\\[^\r\n])*"$/.test(display) && /[",;<>@:\\]/.test(display)) return null;
    address = match[2].trim();
  }
  if (address.length > 254 || !/^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(address)) return null;
  return address.toLowerCase();
}

/** Analyze one Blob/File locally. messageCount includes duplicates; sender counts do not.
 * seen is caller-owned and stores trimmed, case-preserved Message-IDs only when counted.
 * Local repeats take precedence over cross-file repeats; decodeWarnings contains counted notes.
 */
export async function analyzeMailbox(file, { onProgress = () => {}, signal, sentHint = false, seen } = {}) {
  if (!file || typeof file.stream !== 'function') throw new TypeError('Expected a Blob or File with stream().');
  const labels = new Set(), senders = new Map(), warnings = new Set(), ids = new Set(), senderIds = new Set();
  let messageCount = 0, duplicateCount = 0, crossFileDuplicates = 0, bytesRead = 0;
  let replacementCount = 0, invalidFromCount = 0;
  const decode = raw => {
    const decoded = decodeHeaderValue(raw);
    // Only stream-level invalid UTF-8 counts; U+FFFD produced by decoding encoded words stays part of the value.
    replacementCount += raw.split('\uFFFD').length - 1;
    return decoded;
  };
  let active = false, preambleSeen = false, inHeaders = false, valid = true, headerSize = 0, headerCount = 0;
  let fields = new Map(), field = '', value = '';
  let line = '', oversized = false;
  const warn = text => warnings.add(text);
  const abort = () => { if (signal?.aborted) throw signal.reason ?? new DOMException('Analysis cancelled', 'AbortError'); };
  const progress = () => onProgress({ bytesRead, totalBytes: file.size ?? 0, messageCount });

  function flushField() {
    if (['from', 'message-id', 'x-gmail-labels'].includes(field)) {
      const values = fields.get(field) || [];
      values.push(value);
      fields.set(field, values);
    }
    field = ''; value = '';
  }
  function finishHeaders() {
    if (!inHeaders) return;
    flushField(); inHeaders = false;
    if (!valid || !headerCount) {
      warn('Some messages have malformed or missing headers; their labels and sender statistics were skipped.');
      fields.clear(); return;
    }
    const messageLabels = [];
    for (const raw of fields.get('x-gmail-labels') || []) {
      const parsed = parseLabels(raw, decode);
      if (parsed) messageLabels.push(...parsed);
      else warn('An unterminated quoted X-Gmail-Labels header was skipped.');
    }
    for (const label of messageLabels) labels.add(label);
    const rawIds = fields.get('message-id') || [];
    const id = rawIds.length === 1 && /^<[^<>\s]+@[^<>\s]+>$/.test(rawIds[0].trim()) ? rawIds[0].trim() : null;
    let duplicate = false;
    if (id) {
      if (ids.has(id)) { duplicateCount++; duplicate = true; }
      else if (ids.size < MAX_IDS) ids.add(id);
      else warn('Message-ID deduplication is limited to the first 100000 distinct IDs per file; later untracked IDs may inflate sender counts.');
    }
    const from = fields.get('from') || [];
    const parsedFrom = from.map(value => parseSender(value, decode));
    invalidFromCount += parsedFrom.filter(email => !email).length;
    if (sentHint || messageLabels.some(label => SENT.has(label.toLowerCase()))) {
      const email = from.length === 1 ? parsedFrom[0] : null;
      if (!email) warn('Some sent messages have missing, multiple, or unsupported From addresses; these were not counted as sender identities.');
      else if (id && senderIds.has(id)) { /* already counted for this sender file */ }
      else if (id && seen?.has(id)) { if (!duplicate) crossFileDuplicates++; }
      else {
        senders.set(email, (senders.get(email) || 0) + 1);
        if (id) {
          if (senderIds.size < MAX_IDS) senderIds.add(id);
          else warn('文件内发件人 Message-ID 去重仅记录前 100000 个不同 ID；未记录的后续 ID 可能导致发件人计数偏高。');
          if (seen) {
            if (seen.size < MAX_IDS) seen.add(id);
            else warn('跨文件 Message-ID 去重仅记录前 100000 个不同 ID；未记录的后续 ID 可能导致发件人计数偏高。');
          }
        }
      }
    }
    fields.clear();
  }
  function startMessage() {
    finishHeaders();
    active = true; inHeaders = true; valid = true;
    headerSize = 0; headerCount = 0; fields = new Map(); field = ''; value = '';
    messageCount++;
  }
  function consumeLine(text, tooLong) {
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (!active && text.startsWith('\uFEFF')) text = text.slice(1);
    if (!tooLong && ENVELOPE.test(text)) { startMessage(); return; }
    if (!active) {
      if (!preambleSeen && !tooLong && HEADER.test(text)) {
        startMessage();
        warn('Input contains a message without an mbox envelope; it was treated as a single RFC 822 message.');
      } else {
        if (text || tooLong) {
          preambleSeen = true;
          warn('Text outside an mbox message was ignored.');
        }
        return;
      }
    }
    if (!inHeaders) return;
    headerSize += text.length + 2;
    if (tooLong || headerSize > MAX_HEADERS) {
      valid = false;
      warn('Header limits exceeded (64 KiB per line, 256 KiB per message, measured as decoded characters); affected message statistics were skipped.');
      finishHeaders(); return;
    }
    if (!text) { finishHeaders(); return; }
    if (/^[ \t]/.test(text)) {
      if (!field) { valid = false; finishHeaders(); }
      else value += ' ' + text.trim();
      return;
    }
    const match = HEADER.exec(text);
    if (!match) { valid = false; finishHeaders(); return; }
    flushField();
    headerCount++; field = match[1].toLowerCase(); value = match[2];
  }
  function consumeText(text) {
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf('\n', start);
      const end = newline === -1 ? text.length : newline;
      if (!oversized) {
        const remaining = MAX_LINE - line.length;
        line += text.slice(start, Math.min(end, start + remaining));
        if (end - start > remaining) oversized = true;
      }
      if (newline === -1) return;
      consumeLine(line, oversized); line = ''; oversized = false;
      start = newline + 1;
    }
  }

  abort();
  const reader = file.stream().getReader();
  // Cancel a pending read too, not just the next chunk.
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    progress();
    const decoder = new TextDecoder('utf-8');
    while (true) {
      abort();
      const { value: chunk, done } = await reader.read();
      abort();
      if (done) break;
      bytesRead += chunk.byteLength;
      consumeText(decoder.decode(chunk, { stream: true }));
      progress();
    }
    consumeText(decoder.decode());
    if (line || oversized) consumeLine(line, oversized);
    finishHeaders();
    if (duplicateCount) warn(seen
      ? '文件内重复的 Message-ID 已从发件人计数中排除；邮件总数仍包含这些邮件，标签已合并。'
      : 'Repeated Message-IDs within this file were excluded from sender counts; messageCount includes them and labels are merged. Deduplication does not span files.');
    if (crossFileDuplicates) warn(`已排除 ${crossFileDuplicates} 封跨文件重复邮件的发件人计数；邮件总数与标签不受影响。`);
    const decodeWarnings = [];
    if (replacementCount) decodeWarnings.push(`解码后的邮件头中发现 ${replacementCount} 个 Unicode 替换字符（可能存在无效 UTF-8）；请检查原始编码。`);
    if (invalidFromCount) decodeWarnings.push(`发现 ${invalidFromCount} 个无法保守解析的 From 值；未将其计入发件人身份。`);
    decodeWarnings.forEach(warn);
    progress();
    return { messageCount, labels: [...labels].sort(compare), senders: [...senders].map(([email, count]) => ({ email, count })).sort((a, b) => b.count - a.count || compare(a.email, b.email)), warnings: [...warnings], duplicateCount, crossFileDuplicates, decodeWarnings };
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** System labels are omitted; provider-reserved labels retain a note with folder: null. */
export function buildFolders(labels, { reserved = [] } = {}) {
  const mappings = [], used = new Map();
  const reservedNames = new Set(reserved.map(name => name.normalize('NFC').trim().toLowerCase()));
  for (const label of [...new Set(labels)].sort(compare)) {
    if (typeof label !== 'string') continue;
    const normalized = label.normalize('NFC').trim();
    const lower = normalized.toLowerCase();
    if (SYSTEM.has(lower) || SYSTEM.has(lower.replace(/^\[gmail\]\//, '')) || /^category:|^categories\/|^\\(?:inbox|drafts?|junk|trash|flagged|all|important|seen)$/i.test(normalized)) continue;
    if (reservedNames.has(lower)) {
      mappings.push({ label, folder: null, notes: ['与目标服务商的保留文件夹名称冲突；已跳过此标签。'] });
      continue;
    }
    const notes = [];
    const parts = normalized.split('/').map(part => {
      const clean = part.trim().replace(/[\x00-\x1f\x7f\\:*?"<>|]/g, '_').replace(/[ .]+$/g, '');
      return !clean || clean === '.' || clean === '..' ? '_' : clean;
    });
    let folder = parts.join('/');
    if (folder !== label) notes.push('Normalized Unicode, whitespace, or unsafe/empty path segments; review the target folder name.');
    if (parts.length > 1) notes.push('Nested label preserved with /; confirm the target provider hierarchy delimiter.');
    if (folder.length > 255) notes.push('Long folder name; confirm the target provider length limit.');
    const base = folder;
    let suffix = 2;
    while (used.has(folder.toLowerCase()) || reservedNames.has(folder.normalize('NFC').trim().toLowerCase())) folder = `${base} (${suffix++})`;
    if (folder !== base) notes.push('Case-insensitive, normalized, or provider-reserved name collision; a numeric suffix was added.');
    used.set(folder.toLowerCase(), label);
    mappings.push({ label, folder, notes });
  }
  return mappings;
}
