// Read-only live pricing verification; no provider config and no inference.
import { Context } from '@deepseek-ai/cordis';
import LocalCredentials from '@deepseek-ai/dsh-credentials-local';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';
import { createCopilotAuth } from '../auth.js';
import { CatalogController } from '../controller.js';
import { Config } from '../index.js';
import { priceView, PRICING_DOCUMENTATION } from '../pricing.js';
import { mkdir, writeFile } from 'node:fs/promises';
const ctx = new Context();
let controller;
try {
  await ctx.plugin(LocalCredentials, { watch: false });
  controller = new CatalogController({ auth: createCopilotAuth(ctx.credentials), config: Config({}),
    knownModels: new Map(githubCopilotProvider().getModels().map(model => [model.id, model])) });
  const snapshot = await controller.refresh(true, AbortSignal.timeout(30000));
  const models = snapshot.priceModels.map(priceView);
  const report = { ok: true, source: `${snapshot.baseURL}/models`, fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
    currency: 'USD', perTokens: 1000000, creditsPerUSD: 100, rawModelCount: snapshot.rawCount,
    chatModelCount: models.length, selectableModelCount: snapshot.details.length,
    documentationURL: PRICING_DOCUMENTATION, models };
  const artifactsDir = new URL('../artifacts/', import.meta.url);
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(new URL('./live-prices.json', artifactsDir), JSON.stringify(report,null,2));
  console.log(JSON.stringify({ok:true,source:report.source,fetchedAt:report.fetchedAt,chatModelCount:models.length,
    selectableModelCount:report.selectableModelCount,
    examples:models.filter(model=>/gemini-4-carbon|gpt-6.1-sol|gpt-5.3-codex/.test(model.id))},null,2));
} catch(error) {
  console.error(JSON.stringify({ok:false,code:error?.code??error?.name??'UNKNOWN',status:error?.status??null}));
  process.exitCode=1;
} finally { controller?.dispose(); await ctx.fiber.dispose(); }
