import { createWriteStream } from 'node:fs';
import { readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const require = createRequire(import.meta.url);
let yazl;
try { yazl = require('yazl'); } catch { throw new Error('Missing yazl ZIP writer'); }

async function files(directory, root = directory) {
  const output = [];
  for (const name of await readdir(directory)) {
    const full = path.join(directory, name);
    const info = await stat(full);
    if (info.isDirectory()) output.push(...await files(full, root));
    else output.push({ full, name: path.relative(root, full).replaceAll('\\', '/') });
  }
  return output;
}
for (const target of ['chrome', 'firefox']) {
  const zip = new yazl.ZipFile();
  for (const file of await files(`dist/${target}`)) zip.addFile(file.full, file.name);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(`dist/GmailChanger-${target}.zip`));
}
const checksums = [];
for (const target of ['chrome', 'firefox']) {
  const filename = `GmailChanger-${target}.zip`;
  const digest = createHash('sha256').update(await readFile(`dist/${filename}`)).digest('hex');
  checksums.push(`${digest}  ${filename}`);
}
await writeFile('dist/SHA256SUMS.txt', checksums.join('\n') + '\n');
