// Exercise the installed Host's exact price handler in an isolated Cordis
// Context. No Web listener, user Session, profile edit or inference is created.
import { Context, Service } from '@deepseek-ai/cordis';
import LocalCredentials from '@deepseek-ai/dsh-credentials-local';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import * as plugin from '../index.js';
import { mkdir, writeFile } from 'node:fs/promises';
const ctx = new Context();
const routes = new Map();
class InProcessConnection extends Service {
  constructor(owner) { super(owner, 'connection'); this.fetch = { register: route => {
    routes.set(route.path, route); return async () => { routes.delete(route.path); };
  } }; }
}
try {
  await ctx.plugin(LocalCredentials, { watch: false });
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(InProcessConnection);
  await ctx.plugin(plugin, { providers: { 'github-copilot-live': {} } });
  const response = await routes.get('/api/copilot-live/prices').fetch(new Request('http://in-process.test/api/copilot-live/prices'));
  const body = await response.json();
  if (response.status !== 200 || !body.ok || !Array.isArray(body.value.models)) throw new Error('Price handler failed');
  const carbon = body.value.models.find(model => model.id === 'gemini-4-carbon');
  if (!carbon?.displayTiers.length) throw new Error('Carbon price missing');
  const report = { ok: true, httpStatus: response.status, isolation: 'in-process Host handler; no GUI Cookie bypass or Web listener',
    source: body.value.source, fetchedAt: body.value.fetchedAt,
    currency: body.value.currency, perTokens: body.value.perTokens,
    chatModelCount: body.value.models.length, selectableModelCount: body.value.models.filter(model => model.selectable).length,
    carbon, registeredModelCount: (await ctx.llm.listModels('github-copilot-live')).length,
  };
  const artifactsDir = new URL('../artifacts/', import.meta.url);
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(new URL('./prices-endpoint.json', artifactsDir), JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} catch(error) {
  console.error(JSON.stringify({ok:false,code:error?.code??error?.name??'UNKNOWN'}));
  process.exitCode=1;
} finally { await ctx.fiber.dispose(); }
