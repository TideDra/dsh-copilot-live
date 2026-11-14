import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

/** Preserve Google's opaque tool-call signatures across the OpenAI-compatible
 * Copilot transport. Some pi-ai builds omit this field. Work at public provider
 * hooks only; never patch global fetch, installed packages, or session events. */
export function geminiSignatureOptions(context, options = {}) {
  const outgoing = new Map();
  for (const message of context.messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'toolCall' && typeof block.thoughtSignature === 'string') outgoing.set(block.id, block.thoughtSignature);
    }
  }
  const idsByIndex = new Map();
  const signaturesByIndex = new Map();
  const incoming = new Map();
  return {
    incoming,
    options: {
      ...options,
      async onPayload(original, model) {
        const result = await options.onPayload?.(original, model);
        const payload = result ?? original;
        if (!payload || !Array.isArray(payload.messages)) return payload;
        return {
          ...payload,
          messages: payload.messages.map(message => {
            if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) return message;
            return { ...message, tool_calls: message.tool_calls.map(call => {
              const signature = outgoing.get(call.id);
              if (!signature) return call;
              return { ...call, extra_content: { ...call.extra_content,
                google: { ...call.extra_content?.google, thought_signature: signature } } };
            }) };
          }),
        };
      },
      async onProviderStreamEvent(chunk, model) {
        await options.onProviderStreamEvent?.(chunk, model);
        for (const choice of chunk?.choices ?? []) {
          for (const call of choice?.delta?.tool_calls ?? []) {
            const index = call.index ?? 0;
            if (call.id) idsByIndex.set(index, call.id);
            const signature = call.extra_content?.google?.thought_signature;
            if (typeof signature === 'string' && signature.length) signaturesByIndex.set(index, signature);
            const id = idsByIndex.get(index);
            const current = signaturesByIndex.get(index);
            if (id && current) incoming.set(id, current);
          }
        }
      },
    },
  };
}
export function attachGeminiSignatures(message, signatures) {
  if (!message || !Array.isArray(message.content) || signatures.size === 0) return message;
  return { ...message, content: message.content.map(block => {
    const signature = block.type === 'toolCall' ? signatures.get(block.id) : undefined;
    return signature ? { ...block, thoughtSignature: signature } : block;
  }) };
}
export function wrapGeminiStream(source, signatures, model) {
  const target = createAssistantMessageEventStream();
  void (async () => {
    for await (const event of source) {
      let forwarded = event;
      if (event.partial) forwarded = { ...forwarded, partial: attachGeminiSignatures(event.partial, signatures) };
      if (event.type === 'toolcall_end') {
        const signature = signatures.get(event.toolCall.id);
        if (signature) forwarded = { ...forwarded, toolCall: { ...event.toolCall, thoughtSignature: signature } };
      }
      if (event.type === 'done') forwarded = { ...forwarded, message: attachGeminiSignatures(event.message, signatures) };
      target.push(forwarded);
    }
    target.end();
  })().catch(() => {
    target.push({ type: 'error', reason: 'error', error: {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [], stopReason: 'error', errorMessage: 'Copilot signature replay failed', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } });
    target.end();
  });
  return target;
}
