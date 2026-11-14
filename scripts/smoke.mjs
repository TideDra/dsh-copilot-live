// Real, minimal inference verification. It calls no local tool and never
// persists request credentials or the opaque provider replay envelope.
import { Context } from '@deepseek-ai/cordis';
import LocalCredentials from '@deepseek-ai/dsh-credentials-local';
import LlmRuntime, { BlockAssembler } from '@deepseek-ai/dsh-llm';
import * as plugin from '../index.js';
import { mkdir, writeFile } from 'node:fs/promises';
const ctx = new Context();
const model = process.env.COPILOT_SMOKE_MODEL ?? 'gemini-4-carbon';
const report = { model, provider: 'github-copilot-live', startedAt: new Date().toISOString() };
try {
  await ctx.plugin(LocalCredentials, { watch: false });
  await ctx.plugin(LlmRuntime);
  // Explicit Add is simulated only in this isolated test Context, never in the
  // running profile. Installation itself must remain dormant.
  await ctx.plugin(plugin, { providers: { [report.provider]: {} } });
  const models = await ctx.llm.listModels(report.provider);
  report.discoveredCount = models.length;
  report.metadata = await ctx.llm.resolveModelInfo(report.provider, model);
  const call = await ctx.llm.prepareCall({ provider: report.provider, model, reasoningEffort: 'low', maxTokens: 1024 });
  const tools = [{ name: 'report_value', description: 'Report the requested fixed test value; this has no external side effect.', parameters: {
    type: 'object', properties: { value: {type:'string'} }, required: ['value'], additionalProperties: false,
  } }];
  const user = { role: 'user', content: [{type:'text',text:'This is a minimal integration test. Call report_value exactly once with value COPILOT_LIVE_OK. Do not write a final answer before the tool call. After the tool result, reply with only COPILOT_LIVE_OK.'}] };
  const collect = async options => {
    const chunks = [];
    for await (const chunk of ctx.llm.stream(options)) chunks.push(chunk);
    const blocks = chunks.filter(chunk=>chunk.type==='block-end').sort((a,b)=>a.index-b.index).map(chunk=>chunk.block);
    const finish = chunks.findLast(chunk=>chunk.type==='finish');
    return { blocks, finish, usage: chunks.findLast(chunk=>chunk.type==='usage')?.usage };
  };
  const first = await collect({ ...call.config, messages: [user], tools, signal: AbortSignal.timeout(90000) });
  report.firstFinish = first.finish ? { kind: first.finish.reason.kind, ...(first.finish.reason.failure ? { code: first.finish.reason.failure.code, status: first.finish.reason.failure.status } : {}) } : null;
  report.firstUsage = first.usage;
  const toolCalls = first.blocks.filter(block=>block.type==='tool-call');
  report.toolCalls = toolCalls.map(block=>({name:block.name,arguments:block.arguments}));
  report.hasOpaqueThoughtSignature = first.finish?.replayState?.blocks?.some(block=>typeof block.thoughtSignature==='string' && block.thoughtSignature.length>0) ?? false;
  if (first.finish?.reason.kind !== 'tool-calls' || toolCalls.length !== 1 || toolCalls[0].name !== 'report_value') throw new Error('Expected exactly one harmless tool call');
  const source = { kind: 'model', provider: report.provider, model, replayState: first.finish.replayState };
  const assistant = { role:'assistant',id:'copilot-smoke-assistant',source,content:first.blocks };
  const results = toolCalls.map(block=>({role:'tool',id:'copilot-smoke-result',source:{kind:'tool',callId:block.id},toolCallId:block.id,content:[{type:'text',text:'COPILOT_LIVE_OK'}]}));
  const second = await collect({ ...call.config, messages:[user,assistant,...results],tools,signal:AbortSignal.timeout(90000) });
  report.secondFinish = second.finish ? { kind: second.finish.reason.kind, ...(second.finish.reason.failure ? { code: second.finish.reason.failure.code, status: second.finish.reason.failure.status } : {}) } : null;
  report.secondUsage = second.usage;
  report.finalText = second.blocks.filter(block=>block.type==='text').map(block=>block.text).join('');
  report.ok = second.finish?.reason.kind === 'stop' && report.finalText.trim() === 'COPILOT_LIVE_OK';
  if (!report.ok) throw new Error('Two-step inference did not complete as expected');
} catch (error) {
  report.ok = false;
  report.error = { code: error?.code ?? error?.name ?? 'UNKNOWN', message: 'Smoke verification failed; see safe finish details.' };
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await ctx.fiber.dispose();
  const artifactsDir = new URL('../artifacts/', import.meta.url);
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(new URL('./smoke-result.json', artifactsDir), JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
