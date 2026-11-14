import { Context } from '@deepseek-ai/cordis';
import LocalCredentials from '@deepseek-ai/dsh-credentials-local';
import { createCopilotAuth } from '../auth.js';
import { mkdir, writeFile } from 'node:fs/promises';
const ctx = new Context();
try {
  await ctx.plugin(LocalCredentials, { watch: false });
  const auth = await createCopilotAuth(ctx.credentials).resolve(AbortSignal.timeout(25000));
  const baseURL = auth.baseUrl ?? 'https://api.individual.githubcopilot.com';
  const response = await fetch(`${baseURL}/models`, {
    headers: {
      ...auth.headers,
      Accept: 'application/json', Authorization: `Bearer ${auth.apiKey}`,
      'User-Agent': 'GitHubCopilotChat/0.35.0', 'Editor-Version': 'vscode/1.107.0',
      'Editor-Plugin-Version': 'copilot-chat/0.35.0', 'Copilot-Integration-Id': 'vscode-chat',
      'X-GitHub-Api-Version': '2026-06-01',
    },
    signal: AbortSignal.timeout(25000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
  const raw = await response.json();
  // Model-directory data only. Neither request auth nor response headers are saved.
  const artifactsDir = new URL('../artifacts/', import.meta.url);
  await mkdir(artifactsDir, { recursive: true });
  const path = new URL('./live-catalog.json', artifactsDir);
  await writeFile(path, JSON.stringify(raw, null, 2));
  console.log(JSON.stringify({ baseURL, count: raw.data?.length, path: path.pathname,
    gemini: raw.data?.filter(m => /gemini|carbon/i.test(`${m.id} ${m.name}`)),
    otherExamples: raw.data?.filter(m => !/gemini/i.test(m.id)).slice(0, 3) }, null, 2));
} catch (error) {
  // Provider errors can contain credential-bearing bodies; never print them.
  console.error(JSON.stringify({ ok: false, code: error?.code ?? error?.name ?? 'UNKNOWN',
    guidance: 'Copilot catalog probe failed; inspect authentication, connectivity and HTTP status.' }));
  process.exitCode = 1;
} finally { await ctx.fiber.dispose(); }
