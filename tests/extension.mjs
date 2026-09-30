import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

// Test the packaged build, never a development server. Run npm run build first.
const extensionPath = resolve('dist/chrome');
const profile = await mkdtemp(join(tmpdir(), 'gmailchanger-extension-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  context.setDefaultTimeout(20_000);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  assert.match(id, /^[a-p]{32}$/);
  const origin = `chrome-extension://${id}`;
  const page = await context.newPage();
  const errors = [], workers = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('worker', item => workers.push(item.url()));
  await page.addInitScript(() => {
    globalThis.cspViolations = [];
    document.addEventListener('securitypolicyviolation', event => globalThis.cspViolations.push(`${event.violatedDirective}: ${event.blockedURI}`));
  });
  await page.goto(`${origin}/index.html`);
  assert.match(await page.locator('h1').innerText(), /Gmail/i);

  // Step 1: choose a destination, then advance to import.
  await page.locator('input[name="target"][value="generic"]').check();
  await page.locator('[data-action="next"]').click();
  assert.equal(await page.locator('nav button[aria-current="step"]').getAttribute('data-step'), '1');

  // Step 2: one XML and two MBOX files exercise the local parser Worker.
  const xml = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:apps="http://schemas.google.com/apps/2006"><entry><id>extension-smoke</id><apps:property name="from" value="boss@example.com"/><apps:property name="label" value="Work"/></entry></feed>';
  const mbox = (id, label) => `From me@example.com Mon Jan 01 00:00:00 2024\nFrom: Me <me@example.com>\nTo: friend@example.com\nMessage-ID: <${id}@example.com>\nX-Gmail-Labels: Sent,${label}\nSubject: Extension smoke\n\nLocal fixture.\n`;
  await page.locator('#files').setInputFiles([
    { name: 'mailFilters.xml', mimeType: 'application/xml', buffer: Buffer.from(xml) },
    { name: 'Sent.mbox', mimeType: 'application/mbox', buffer: Buffer.from(mbox('one', 'FirstMailbox')) },
    { name: 'Archive.mbox', mimeType: 'application/mbox', buffer: Buffer.from(mbox('two', 'SecondMailbox')) },
  ]);
  await page.getByRole('status').getByText(/分析完成|Analysis complete/).waitFor();
  const importedText = await page.locator('#app').innerText();
  for (const filename of ['mailFilters.xml', 'Sent.mbox', 'Archive.mbox']) assert.ok(importedText.includes(filename), `Missing import: ${filename}`);
  assert.ok(workers.length, 'Import must use packaged local Workers');
  assert.ok(workers.every(url => url.startsWith(`${origin}/`)), `Non-local Worker: ${workers.join(', ')}`);

  // Step 3: review filter conversion and detected sender.
  await page.locator('[data-action="next"]').click();
  assert.equal(await page.locator('nav button[aria-current="step"]').getAttribute('data-step'), '2');
  assert.match(await page.locator('pre').allTextContents().then(text => text.join('\n')), /boss@example\.com/);
  await page.getByText('me@example.com').waitFor();

  // Step 4: all imported labels appear in mapping.
  await page.locator('[data-action="next"]').click();
  assert.equal(await page.locator('nav button[aria-current="step"]').getAttribute('data-step'), '3');
  const mapping = await page.locator('[data-map]').evaluateAll(inputs => inputs.map(input => input.value));
  for (const folder of ['Work', 'FirstMailbox', 'SecondMailbox']) assert.ok(mapping.some(value => value.includes(folder)), `Missing mapped folder: ${folder}`);

  // Step 5: download and inspect generated local migration files.
  await page.locator('[data-action="next"]').click();
  assert.equal(await page.locator('nav button[aria-current="step"]').getAttribute('data-step'), '4');
  async function download(kind, filename) {
    const pending = page.waitForEvent('download');
    await page.locator(`[data-export="${kind}"]`).click();
    const item = await pending;
    assert.equal(item.suggestedFilename(), filename);
    assert.equal(await item.failure(), null);
    return readFile(await item.path(), 'utf8');
  }
  assert.match(await download('sieve', 'rules.sieve'), /boss@example\.com/);
  const folders = JSON.parse(await download('folders', 'folders.json'));
  for (const label of ['Work', 'FirstMailbox', 'SecondMailbox']) assert.ok(folders.folders.some(folder => folder.gmailLabel === label), `Missing exported folder: ${label}`);
  assert.match(await download('senders', 'senders.csv'), /me@example\.com/);
  assert.deepEqual(await page.evaluate(() => globalThis.cspViolations), [], 'Extension CSP violations');
  assert.deepEqual(errors, [], 'Extension page/console errors');
  console.log('Packaged Chromium extension five-step smoke passed: CSP, local XML/MBOX Workers, mappings and exports.');
} finally {
  try { await context?.close(); }
  finally { await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
}
