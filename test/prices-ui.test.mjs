import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
let definition;
vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load: value => { definition = value; } } },
});
const client = definition.factory(id => { assert.equal(id, 'react'); return {}; });

test('price viewing uses an authenticated same-origin GET and never writes provider settings', async () => {
  const calls = [];
  const response = await client.fetchPrices(async (url, options) => {
    calls.push({url,method:options.method,credentials:options.credentials,cache:options.cache});
    return {ok:true,json:async()=>({ok:true,value:{currency:'USD',perTokens:1000000,models:[]}})};
  });
  assert.equal(response.ok, true);
  assert.deepEqual(calls, [{url:'/api/copilot-live/prices',method:'GET',credentials:'same-origin',cache:'no-store'}]);
});
test('manual price refresh only adds the fixed read-only refresh query', async () => {
  let requested;
  const result = await client.fetchPrices(async (url, options) => {
    requested={url,method:options.method};
    return {ok:true,json:async()=>({ok:true,value:{models:[]}})};
  }, {force:true});
  assert.equal(result.ok,true);
  assert.deepEqual(requested,{url:'/api/copilot-live/prices?refresh=1',method:'GET'});
});
test('price endpoint refusal is a visible safe error', async () => {
  const result = await client.fetchPrices(async()=>({ok:false,json:async()=>({ok:false,error:'Please sign in to Copilot'})}));
  assert.equal(result.ok,false);
  assert.equal(result.message,'Please sign in to Copilot');
});
test('malformed price payloads and transport exceptions do not leak raw details', async () => {
  const invalid = await client.fetchPrices(async()=>({ok:true,json:async()=>({ok:true,value:{models:null}})}));
  assert.equal(invalid.key,'priceFailed');
  const failed = await client.fetchPrices(async()=>{throw new Error('synthetic-private-transport-value');});
  assert.equal(failed.key,'priceFailed');
  assert(!JSON.stringify(failed).includes('synthetic-private-transport-value'));
  const badJSON = await client.fetchPrices(async()=>({ok:false,json:async()=>{throw new Error('not JSON');}}));
  assert.equal(badJSON.key,'priceFailed');
});
test('a bounded UI price timeout is distinct from a generic fetch failure', async () => {
  const controller = new AbortController();
  controller.abort('price-timeout');
  const result = await client.fetchPrices(async()=>{throw new DOMException('aborted','AbortError');},{signal:controller.signal});
  assert.equal(result.key,'priceTimedOut');
});
