import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const server=await createServer({configFile:'./vite.config.js',server:{host:'127.0.0.1',port:0}});
await server.listen();
let browser;
try {
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();
  const errors=[], external=[];
  page.on('pageerror',error=>errors.push(error.message));
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  page.on('request',request=>{if(!request.url().startsWith(origin)&&!request.url().startsWith('data:'))external.push(request.url());});
  await page.goto(origin);
  const xml=`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:apps="http://schemas.google.com/apps/2006"><entry><id>filter-1</id><apps:property name="from" value="boss@example.com"/><apps:property name="label" value="Work"/></entry></feed>`;
  const checks=await page.evaluate(async source=>{
    const {parseFilters,convertFilters}=await import('/src/filters.js');
    const parse=text=>parseFilters(new DOMParser().parseFromString(text,'application/xml'));
    const duplicateXml='<feed xmlns="http://www.w3.org/2005/Atom" xmlns:apps="http://schemas.google.com/apps/2006"><entry><apps:property name="from" value="a@example.com"/><apps:property name="from" value="b@example.com"/></entry></feed>';
    let doctypeRejected=false;try{parse('<!DOCTYPE feed [<!ENTITY x "hi">]><feed xmlns="http://www.w3.org/2005/Atom"/>');}catch{doctypeRejected=true;}
    return {conversion:convertFilters(parse(source)),duplicates:parse(duplicateXml)[0].unknown.length,doctypeRejected,wrongRoot:(()=>{try{parse('<feed/>');return false;}catch{return true;}})()};
  },xml);
  assert.equal(checks.conversion.results[0].status,'approximate');assert.match(checks.conversion.sieve,/boss@example\.com/);
  assert.equal(checks.duplicates,1);assert.equal(checks.doctypeRejected,true);assert.equal(checks.wrongRoot,true);
  const manifest=await page.evaluate(async()=>(await fetch('/manifest.json')).json());
  assert.equal(manifest.permissions.length,0);assert.equal(manifest.host_permissions.length,0);
  const next=()=>page.locator('[data-action=next]').click();
  const step=index=>page.locator(`[data-step="${index}"]`).click();
  const upload=async(name,contents)=>{
    await page.locator('#files').setInputFiles({name,mimeType:name.endsWith('.xml')?'application/xml':'application/mbox',buffer:Buffer.from(contents)});
    await page.locator('section[aria-busy=false]').waitFor();
    assert.match(await page.locator('#status').innerText(),/分析完成|Analysis complete/);
  };
  const download=async(type)=>{
    const pending=page.waitForEvent('download');await page.locator(`[data-export="${type}"]`).click();
    const item=await pending;return readFile(await item.path(),'utf8');
  };
  assert.equal(await page.locator('[aria-current=step]').getAttribute('data-step'),'0');
  await next();assert.equal(await page.locator('#step-title').evaluate(node=>node===document.activeElement),true);
  await page.locator('[data-action=files]').focus();assert.equal(await page.locator('[data-action=files]').evaluate(node=>node===document.activeElement),true);
  await upload('mailFilters.xml',xml);
  await next();assert.equal(await page.locator('.badge.approximate').count(),1);
  await page.locator('#language').selectOption('en');assert.equal(await page.locator('html').getAttribute('lang'),'en');
  assert.equal(await page.locator('.badge.approximate').innerText(),'Approximate — disabled');
  await next();await page.locator('[data-map="0"]').fill('Projects');await page.locator('[data-map="0"]').press('Tab');
  await page.locator('#language').selectOption('zh');assert.equal(await page.locator('[data-map="0"]').inputValue(),'Projects');
  await next();const sieve=await download('sieve'),folders=JSON.parse(await download('folders'));
  assert.match(sieve,/fileinto "Projects"/);assert.equal(folders.folders[0].targetFolder,'Projects');
  await step(3);await page.locator('[data-map="0"]').fill('');await page.locator('[data-map="0"]').press('Tab');await next();
  assert.equal(await page.locator('[aria-current=step]').getAttribute('data-step'),'3');assert.equal(await page.locator('[data-map="0"]').getAttribute('aria-invalid'),'true');
  await page.locator('[data-map="0"]').fill('Projects');await page.locator('[data-map="0"]').press('Tab');
  await step(0);await page.locator('input[name=target][value=outlook]').check();await step(4);
  assert.equal(await page.locator('[data-export=sieve]').count(),0);assert.equal(await page.locator('[data-action=copy]').count(),0);
  assert.match(await download('recipe'),/手工|manual/i);
  await step(0);await page.locator('input[name=target][value=generic]').check();await step(1);await page.locator('[data-action=reset]').click();
  const mbox='From sender@example.com Thu Jan 01 00:00:00 1970\nFrom: sender@example.com\nMessage-ID: <test@example.com>\nX-Gmail-Labels: Sent,Work\n\nbody\n';
  await upload('Sent.mbox',mbox);await next();assert.match(await page.locator('body').innerText(),/sender@example.com/);await step(4);
  assert.equal(await page.locator('[data-export=sieve]').isDisabled(),true);assert.equal(await page.locator('[data-export=senders]').isEnabled(),true);assert.match(await download('senders'),/sender@example.com/);
  await step(1);await page.locator('[data-action=reset]').click();await upload('subject.xml',xml.replace('name="from" value="boss@example.com"','name="subject" value="invoice"'));
  await step(4);assert.match(await download('sieve'),/# if /);
  // Delay worker output so cancellation can be tested without large fixtures.
  await step(1);await page.route('**/worker.js*',async route=>{await route.fulfill({contentType:'text/javascript',body:'self.onmessage=()=>{}'});});
  await page.locator('#files').setInputFiles({name:'cancel.xml',mimeType:'application/xml',buffer:Buffer.from(xml)});
  await page.locator('[data-action=cancel]').waitFor();assert.equal(await page.locator('[data-action=next]').isDisabled(),true);
  await page.locator('[data-action=cancel]').click();await page.locator('[data-action=reset]').waitFor();assert.match(await page.locator('#status').innerText(),/取消|Cancelled/);
  await page.unroute('**/worker.js*');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('Browser checks passed: DOMParser, five steps, language/state, mapping/download consistency, validation, recipe targets, MBOX-only, disabled approximations, cancel, local resources.');
} finally {await browser?.close();await server.close();}
