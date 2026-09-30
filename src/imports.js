import { Inflate } from 'fflate';

const MAX_ARCHIVE = 512 * 1024 * 1024;
const MAX_ENTRY = 128 * 1024 * 1024;
const MAX_EXPANDED = 256 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_BATCH_EXPANDED = 512 * 1024 * 1024;

function accepted(name) {
  const lower = name.toLowerCase();
  return lower.endsWith('.xml') || lower.endsWith('.mbox') || lower.endsWith('.eml');
}

const sig = (view, offset) => view.getUint32(offset, true);

// Fully validate the single-disk classic ZIP directory and each local header
// before fflate sees the input. ZIP64 is deliberately rejected.
function inspectZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = Math.max(0, bytes.length - 22 - 65535);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= minimum; i--) {
    if (i + 22 <= bytes.length && sig(view, i) === 0x06054b50) {
      const commentLength = view.getUint16(i + 20, true);
      if (i + 22 + commentLength === bytes.length) { eocd = i; break; }
    }
  }
  if (eocd < 0) throw new Error('ZIP end record is missing or malformed');
  if (eocd >= 20 && sig(view, eocd - 20) === 0x07064b50) throw new Error('ZIP64 is not supported');

  const disk = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  const diskCount = view.getUint16(eocd + 8, true);
  const count = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (disk || directoryDisk) throw new Error('Multi-disk ZIP is not supported');
  if (diskCount !== count) throw new Error('ZIP directory size/count mismatch');
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new Error('ZIP64 is not supported');
  if (count > MAX_ENTRIES) throw new Error(`ZIP contains more than ${MAX_ENTRIES} entries`);
  const directoryEnd = directoryOffset + directorySize;
  if (!Number.isSafeInteger(directoryEnd) || directoryEnd !== eocd || directoryOffset > bytes.length) throw new Error('ZIP directory bounds are invalid');

  let cursor = directoryOffset;
  let expanded = 0;
  let acceptedCount = 0;
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > directoryEnd || sig(view, cursor) !== 0x02014b50) throw new Error('Invalid ZIP directory entry');
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressed = view.getUint32(cursor + 20, true);
    const uncompressed = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const startDisk = view.getUint16(cursor + 34, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > directoryEnd) throw new Error('ZIP directory entry exceeds directory bounds');
    if (startDisk || compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff) throw new Error('ZIP64 or multi-disk entry is not supported');
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    // UTF-8 is mandatory only when the ZIP UTF-8 flag is set. Legacy names are
    // decoded lossily for filtering so harmless non-target entries are ignored.
    const name = new TextDecoder('utf-8', { fatal: !!(flags & 0x800) }).decode(nameBytes);
    // Reject ZIP64 extra records even when sentinel fields were forged away.
    for (let p = cursor + 46 + nameLength, end = p + extraLength; p < end;) {
      if (p + 4 > end) throw new Error('Malformed ZIP extra field');
      const id = view.getUint16(p, true), length = view.getUint16(p + 2, true);
      p += 4;
      if (p + length > end) throw new Error('Malformed ZIP extra field bounds');
      if (id === 0x0001) throw new Error('ZIP64 is not supported');
      p += length;
    }
    const isDirectory = name.endsWith('/');
    if (isDirectory && uncompressed) throw new Error('Directory entry contains data');
    const wanted = !isDirectory && accepted(name) && !name.startsWith('__MACOSX/');
    if (wanted) {
      if (uncompressed > MAX_ENTRY) throw new Error(`ZIP entry exceeds ${MAX_ENTRY} bytes`);
      expanded += uncompressed;
      if (expanded > MAX_EXPANDED) throw new Error(`ZIP expanded data exceeds ${MAX_EXPANDED} bytes`);
      acceptedCount++;
      if ((flags & 1) || ![0, 8].includes(method)) throw new Error(`Unsupported ZIP encryption or compression for ${name}`);
      if (method === 0 && compressed !== uncompressed) throw new Error(`Stored ZIP entry size mismatch for ${name}`);
    }
    if (localOffset + 30 > directoryOffset || sig(view, localOffset) !== 0x04034b50) throw new Error(`Invalid local header for ${name}`);
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressed;
    if (dataStart > directoryOffset || dataEnd > directoryOffset || dataEnd < dataStart) throw new Error(`ZIP data bounds are invalid for ${name}`);
    if (localFlags !== flags || localMethod !== method) throw new Error(`ZIP local/central metadata mismatch for ${name}`);
    if (localNameLength !== nameLength || !bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).every((byte, index) => byte === nameBytes[index])) throw new Error(`ZIP local/central filename mismatch for ${name}`);
    if (wanted && !(flags & 8)) {
      const localCrc = view.getUint32(localOffset + 14, true);
      const localCompressed = view.getUint32(localOffset + 18, true);
      const localUncompressed = view.getUint32(localOffset + 22, true);
      if (localCrc !== crc || localCompressed !== compressed || localUncompressed !== uncompressed) throw new Error(`ZIP local/central sizes mismatch for ${name}`);
    }
    entries.push({ name, wanted, localOffset, dataStart, dataEnd, method, crc, uncompressed });
    cursor = next;
  }
  if (cursor !== directoryEnd) throw new Error('ZIP directory size/count mismatch');
  // Local entries must not overlap each other; descriptors occupy bytes after data.
  entries.sort((a, b) => a.localOffset - b.localOffset);
  for (let i = 1; i < entries.length; i++) if (entries[i - 1].dataEnd > entries[i].localOffset) throw new Error('Overlapping ZIP local entries');
  return { count, expanded, acceptedCount, entries };
}

// fflate's CRC implementation is private. ZIP uses standard reflected CRC-32.
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function extractVerified(archive, declared, batchExpanded) {
  const verified = [];
  let actualExpanded = 0;
  for (const entry of declared.entries) {
    if (!entry.wanted) continue;
    const chunks = [];
    let size = 0, crc = 0xffffffff;
    const consume = chunk => {
      size += chunk.byteLength;
      actualExpanded += chunk.byteLength;
      if (size > MAX_ENTRY || actualExpanded > MAX_EXPANDED || batchExpanded + actualExpanded > MAX_BATCH_EXPANDED) throw new Error(`ZIP actual expanded size exceeds safety limits for ${entry.name}`);
      if (size > entry.uncompressed) throw new Error(`ZIP actual expanded size mismatch for ${entry.name}: exceeds declared ${entry.uncompressed} bytes`);
      for (const byte of chunk) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
      chunks.push(chunk);
    };
    if (entry.method === 0) consume(archive.subarray(entry.dataStart, entry.dataEnd));
    else {
      const inflater = new Inflate(consume);
      // Bound transient expansion per push; never use the attacker-declared size
      // as an output buffer (unzipSync can silently truncate that buffer).
      const step = 4096;
      if (entry.dataStart === entry.dataEnd) throw new Error(`Empty DEFLATE stream for ${entry.name}`);
      for (let offset = entry.dataStart; offset < entry.dataEnd; offset += step) {
        const end = Math.min(offset + step, entry.dataEnd);
        inflater.push(archive.subarray(offset, end), end === entry.dataEnd);
      }
    }
    if (size !== entry.uncompressed) throw new Error(`ZIP actual expanded size mismatch for ${entry.name}: expected ${entry.uncompressed}, received ${size} bytes`);
    if (((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw new Error(`ZIP CRC32 mismatch for ${entry.name}: decompressed data is corrupted`);
    verified.push({ entry, chunks });
  }
  if (actualExpanded !== declared.expanded) throw new Error('ZIP actual/declaration expanded size mismatch');
  // Construct and return files only after every wanted entry has passed integrity
  // checks. A bad later entry must not leak a partial archive into the result.
  const files = verified.map(({ entry, chunks }) => {
    const lower = entry.name.toLowerCase();
    const extracted = new File(chunks, entry.name.split('/').pop(), { type: lower.endsWith('.xml') ? 'application/xml' : lower.endsWith('.eml') ? 'message/rfc822' : 'application/mbox' });
    extracted.sourcePath = entry.name;
    return extracted;
  });
  return { files, actualExpanded };
}

export async function expandInputs(files) {
  const output = [];
  const warnings = [];
  let batchExpanded = 0;
  for (const file of files) {
    const name = file.sourcePath || file.webkitRelativePath || file.name;
    const lower = name.toLowerCase();
    if (accepted(lower)) {
      output.push(Object.assign(file, { sourcePath: name }));
      continue;
    }
    if (!lower.endsWith('.zip')) {
      warnings.push(`${name}：不支持该文件类型，请使用 XML、MBOX、EML、ZIP 或已解压文件夹。`);
      continue;
    }
    if (file.size > MAX_ARCHIVE) {
      warnings.push(`${name}：压缩包超过 512 MiB，请解压后直接选择 XML/MBOX 文件。`);
      continue;
    }
    try {
      const archive = new Uint8Array(await file.arrayBuffer());
      const declared = inspectZip(archive);
      if (batchExpanded + declared.expanded > MAX_BATCH_EXPANDED) throw new Error('本次选择的 ZIP 总解压大小超过 512 MiB');
      const extracted = extractVerified(archive, declared, batchExpanded);
      batchExpanded += extracted.actualExpanded;
      output.push(...extracted.files);
      if (!declared.acceptedCount) warnings.push(`${name}：没有找到 XML、MBOX 或 EML。`);
    } catch (error) {
      warnings.push(`${name}：ZIP 读取失败（${error.message}）。`);
    }
  }
  return { files: output, warnings };
}

export function parseXml(text) {
  const document = new DOMParser().parseFromString(text, 'application/xml');
  const error = document.querySelector('parsererror');
  if (error) throw new Error('XML 格式无效');
  return document;
}
