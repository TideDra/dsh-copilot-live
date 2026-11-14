import { createHash } from 'node:crypto';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';

export const NATIVE_PROVIDER = 'github-copilot';
export const COPILOT_RECORD = recordKeyFor(NATIVE_PROVIDER);

function fromRecord(record) {
  if (record?.kind === 'grant') return record.payload;
  if (record?.kind === 'api-key') return { type: 'api_key', ...record.key === undefined ? {} : { key: record.key }, ...record.env === undefined ? {} : { env: record.env } };
  return undefined;
}

// The original sign-in plugin and pi-ai retain ownership of this record format.
// This bridge uses the same serialized credential seam, never a separate token file.
export function createCopilotAuth(credentials) {
  const assertProvider = id => {
    if (id !== NATIVE_PROVIDER) throw new Error('Copilot auth cannot access another provider');
  };
  const store = {
    async read(id) { assertProvider(id); return fromRecord(await credentials.readRecord(COPILOT_RECORD)); },
    async list() {
      const record = await credentials.describeRecord(COPILOT_RECORD);
      return record.configured ? [{ providerId: NATIVE_PROVIDER, type: record.kind === 'grant' ? 'oauth' : 'api_key' }] : [];
    },
    async modify(id, mutate) {
      assertProvider(id);
      const record = await credentials.modifyRecord(COPILOT_RECORD, async current => {
        const next = await mutate(fromRecord(current));
        if (next === undefined) return undefined;
        if (next.type === 'api_key') return { kind: 'api-key', ...next.key === undefined ? {} : { key: next.key }, ...next.env === undefined ? {} : { env: next.env } };
        return { kind: 'grant', payload: JSON.parse(JSON.stringify(next)) };
      });
      return fromRecord(record);
    },
    async delete() { throw new Error('Use the existing Copilot sign-out action to remove credentials'); },
  };
  const authContext = {
    async env(name) { return (await credentials.resolve(credentialRef(name)))?.value; },
    async fileExists() { return false; },
  };
  const injection = { credentials: store, authContext };
  const models = createModels(injection);
  models.setProvider(githubCopilotProvider());
  return {
    injection,
    async fingerprint() {
      const record = await credentials.readRecord(COPILOT_RECORD);
      const credential = fromRecord(record);
      const identity = credential?.type === 'oauth'
        ? ['oauth', credential.refresh, credential.enterpriseUrl ?? '']
        : credential?.type === 'api_key'
          ? ['api_key', credential.key ?? '', credential.env ?? {}]
          : ['ambient', (await credentials.resolve(credentialRef('COPILOT_GITHUB_TOKEN')))?.value ?? ''];
      if (!credential && !identity[1]) return undefined;
      return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    },
    async resolve(signal) {
      const result = await models.getAuth(NATIVE_PROVIDER, { signal });
      if (!result?.auth?.apiKey) {
        const error = new Error('请先在「设置 → GitHub Copilot」登录，或使用 /copilot-login。');
        error.code = 'MISSING_CREDENTIAL';
        throw error;
      }
      return result.auth;
    },
  };
}
