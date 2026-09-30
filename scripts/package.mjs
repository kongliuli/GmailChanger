import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';

const dist = new URL('../dist/', import.meta.url);
for (const target of ['chrome', 'firefox']) {
  const directory = new URL(`${target}/`, dist);
  await mkdir(directory, { recursive: true });
  for (const file of ['manifest.json', 'background.js', 'index.html']) await cp(new URL(file, dist), new URL(file, directory));
  await cp(new URL('assets/', dist), new URL('assets/', directory), { recursive: true });
}
const manifest = JSON.parse(await readFile(new URL('manifest.json', dist), 'utf8'));
manifest.background = { scripts: ['background.js'] };
manifest.browser_specific_settings = { gecko: { id: 'gmailchanger@local.tools', strict_min_version: '128.0' } };
await writeFile(new URL('firefox/manifest.json', dist), JSON.stringify(manifest, null, 2));
