// Test/probe helper only. Installed plugins use the Harness runtime resolver.
import { registerHooks } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.DSH_RUNTIME_ROOT;
if (!root) throw new Error('Set DSH_RUNTIME_ROOT to the running DSH installation directory');
const parentURL = pathToFileURL(join(resolve(root), 'package.json')).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('@')) throw error;
      return nextResolve(specifier, { ...context, parentURL });
    }
  },
});
