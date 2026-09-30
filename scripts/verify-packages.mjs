import { readFile, readdir } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import assert from 'node:assert/strict';
for (const target of ['chrome', 'firefox']) {
  const manifest = JSON.parse(await readFile(`dist/${target}/manifest.json`, 'utf8'));
  assert.equal(manifest.permissions.length, 0);
  assert.equal(manifest.host_permissions.length, 0);
  assert.match(manifest.name, /Gmail/);
  if (target === 'firefox') {
    assert.ok(manifest.background.scripts);
    assert.equal(manifest.background.service_worker, undefined);
  } else assert.ok(manifest.background.service_worker);
  const contents = unzipSync(new Uint8Array(await readFile(`dist/GmailChanger-${target}.zip`)));
  assert.ok(contents['manifest.json'] && contents['index.html'] && contents['background.js']);
  for (const file of await readdir(`dist/${target}/assets`)) assert.ok(contents[`assets/${file}`]);
  console.log(`${target}: valid UTF-8 manifest, zero permissions, ${Object.keys(contents).length} ZIP entries`);
}
