import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

const COPILOT_OPAQUE_PREFIX = 'copilot-reasoning-opaque:';

export function encodeCopilotOpaque(opaque) {
  return `${COPILOT_OPAQUE_PREFIX}${opaque}`;
}
export function decodeCopilotOpaque(signature) {
  if (typeof signature !== 'string' || !signature.startsWith(COPILOT_OPAQUE_PREFIX)) return undefined;
  const opaque = signature.slice(COPILOT_OPAQUE_PREFIX.length);
  return opaque.length > 0 ? opaque : undefined;
}
function isKimiK3Plus(modelId = '') {
  return /(?:^|[^a-z\d])kimi-k([3-9]|\d{2,})(?:[.\-p]|$)/i.test(modelId) || /(?:^|\/)k([3-9]|\d{2,})(?:[.\-:]|$)/i.test(modelId);
}

/**
 * Build ordered replay plans for assistant messages emitted by pi-ai's
 * convertMessages() into `payload.messages`.
 */
function buildAssistantReplayPlan(contextMessages = [], model) {
  // An assistant turn only becomes historical once a final (non-tool-call)
  // assistant response has completed the task AND a new user turn follows it.
  // Mid-turn user injections in DSH (such as 10-minute time-context samples,
  // background job notices, or user steer messages after tool results) happen
  // before any final non-tool-call reply, so active tool-call rounds keep their
  // `reasoning_opaque` intact (matching VS Code's `continuesCurrentTask` gate).
  let lastHistoricalBoundary = -1;
  for (let i = 0; i < contextMessages.length; i++) {
    const msg = contextMessages[i];
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const hasToolCalls = msg.content.some(block => block?.type === 'toolCall');
    if (!hasToolCalls && contextMessages.slice(i + 1).some(later => later?.role === 'user')) {
      lastHistoricalBoundary = i;
    }
  }

  const plans = [];
  for (let i = 0; i < contextMessages.length; i++) {
    const message = contextMessages[i];
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const isSameModel = message.provider === model.provider && message.api === model.api && message.model === model.id;
    const hasText = message.content.some(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0);
    const hasToolCalls = message.content.some(block => block?.type === 'toolCall');
    if (!hasText && !hasToolCalls) continue;

    let reasoningText = '';
    let reasoningOpaque;
    const googleToolSignatures = new Map();
    if (isSameModel) {
      const thinkingTexts = [];
      for (const block of message.content) {
        if (block?.type === 'thinking') {
          const text = typeof block.thinking === 'string' ? block.thinking : '';
          if (text.trim().length > 0) thinkingTexts.push(text);
          const decoded = decodeCopilotOpaque(block.thinkingSignature);
          if (decoded) reasoningOpaque = decoded;
        } else if (block?.type === 'text') {
          const decoded = decodeCopilotOpaque(block.textSignature);
          if (decoded && !reasoningOpaque) reasoningOpaque = decoded;
        } else if (block?.type === 'toolCall') {
          const decoded = decodeCopilotOpaque(block.thoughtSignature);
          if (decoded) {
            if (!reasoningOpaque) reasoningOpaque = decoded;
          } else if (typeof block.thoughtSignature === 'string' && block.thoughtSignature.length > 0) {
            googleToolSignatures.set(block.id, block.thoughtSignature);
          }
        }
      }
      reasoningText = thinkingTexts.join('\n');
    }

    plans.push({
      isHistorical: i <= lastHistoricalBoundary,
      reasoningOpaque,
      reasoningText,
      googleToolSignatures,
    });
  }
  return plans;
}

/** Preserve Copilot CAPI `reasoning_opaque` + `reasoning_text` pairs and Google
 * `extra_content.google.thought_signature` across OpenAI-compatible Chat
 * Completions using public provider hooks only. */
export function geminiSignatureOptions(context, options = {}, targetModel) {
  const idsByIndex = new Map();
  const signaturesByIndex = new Map();
  const incoming = {
    toolSignatures: new Map(),
    reasoningOpaque: undefined,
    get(id) { return this.toolSignatures.get(id); },
    get size() { return this.toolSignatures.size + (this.reasoningOpaque ? 1 : 0); },
  };
  return {
    incoming,
    options: {
      ...options,
      async onPayload(original, model) {
        const result = await options.onPayload?.(original, model);
        const payload = result ?? original;
        if (!payload || !Array.isArray(payload.messages)) return payload;
        const activeModel = model ?? targetModel ?? { provider: 'github-copilot', api: 'openai-completions', id: '' };
        const keepHistoricalThinking = isKimiK3Plus(activeModel.id);
        const emittedPlans = buildAssistantReplayPlan(context?.messages, activeModel);
        let assistantCursor = 0;
        return {
          ...payload,
          messages: payload.messages.map(message => {
            if (message?.role !== 'assistant') return message;
            const plan = emittedPlans[assistantCursor++];
            let next = { ...message };
            let mutated = false;
            const allowThinkingReplay = plan ? (!plan.isHistorical || keepHistoricalThinking) : false;

            if (plan?.reasoningOpaque && allowThinkingReplay) {
              // CAPI contract (CopilotChatEndpoint): emit reasoning_opaque and
              // reasoning_text together whenever an opaque token is present.
              next.reasoning_opaque = plan.reasoningOpaque;
              next.reasoning_text = plan.reasoningText;
              delete next.reasoning;
              delete next.reasoning_content;
              mutated = true;
            } else {
              // CAPI contract: never emit reasoning_text without reasoning_opaque,
              // and omit thinking fields on completed historical turns unless the
              // model family requires historical thinking in Chat Completions.
              for (const field of ['reasoning_text', 'reasoning_opaque', 'reasoning', 'reasoning_content']) {
                if (field in next && (!allowThinkingReplay || field === 'reasoning_text' && !('reasoning_opaque' in next))) {
                  delete next[field];
                  mutated = true;
                }
              }
            }

            if (Array.isArray(next.tool_calls) && plan?.googleToolSignatures.size) {
              next.tool_calls = next.tool_calls.map(call => {
                const signature = plan.googleToolSignatures.get(call.id);
                if (!signature) return call;
                mutated = true;
                return {
                  ...call,
                  extra_content: {
                    ...call.extra_content,
                    google: { ...call.extra_content?.google, thought_signature: signature },
                  },
                };
              });
            }
            return mutated ? next : message;
          }),
        };
      },
      async onProviderStreamEvent(chunk, model) {
        await options.onProviderStreamEvent?.(chunk, model);
        for (const choice of chunk?.choices ?? []) {
          const opaque = choice?.message?.reasoning_opaque ?? choice?.delta?.reasoning_opaque;
          if (typeof opaque === 'string' && opaque.length > 0) {
            incoming.reasoningOpaque = opaque;
          }
          for (const call of choice?.delta?.tool_calls ?? []) {
            const index = call.index ?? 0;
            if (call.id) idsByIndex.set(index, call.id);
            const signature = call.extra_content?.google?.thought_signature;
            if (typeof signature === 'string' && signature.length > 0) signaturesByIndex.set(index, signature);
            const id = idsByIndex.get(index);
            const current = signaturesByIndex.get(index);
            if (id && current) incoming.toolSignatures.set(id, current);
          }
        }
      },
    },
  };
}

function getToolSignatures(signatures) {
  return signatures instanceof Map ? signatures : signatures?.toolSignatures;
}
function getReasoningOpaque(signatures) {
  return signatures instanceof Map ? undefined : signatures?.reasoningOpaque;
}

export function attachGeminiSignatures(message, signatures) {
  if (!message || !Array.isArray(message.content)) return message;
  const toolSignatures = getToolSignatures(signatures);
  const opaque = getReasoningOpaque(signatures);
  const hasToolSigs = (toolSignatures?.size ?? 0) > 0;
  if (!hasToolSigs && !opaque) return message;

  const encodedOpaque = opaque ? encodeCopilotOpaque(opaque) : undefined;
  let opaqueAttached = false;
  let changed = false;

  const hasThinking = message.content.some(block => block?.type === 'thinking');
  const content = message.content.map(block => {
    if (block?.type === 'thinking' && encodedOpaque && !opaqueAttached) {
      opaqueAttached = true;
      changed = true;
      return { ...block, thinkingSignature: encodedOpaque };
    }
    if (block?.type === 'text' && encodedOpaque && !hasThinking && !opaqueAttached) {
      opaqueAttached = true;
      changed = true;
      return { ...block, textSignature: encodedOpaque };
    }
    if (block?.type === 'toolCall') {
      const explicitToolSig = toolSignatures?.get(block.id);
      if (explicitToolSig) {
        changed = true;
        return { ...block, thoughtSignature: explicitToolSig };
      }
      if (encodedOpaque && !hasThinking && !opaqueAttached) {
        opaqueAttached = true;
        changed = true;
        return { ...block, thoughtSignature: encodedOpaque };
      }
    }
    return block;
  });
  return changed ? { ...message, content } : message;
}

export function wrapGeminiStream(source, signatures, model) {
  const target = createAssistantMessageEventStream();
  void (async () => {
    for await (const event of source) {
      let forwarded = event;
      if (event.partial) forwarded = { ...forwarded, partial: attachGeminiSignatures(event.partial, signatures) };
      if (event.type === 'toolcall_end') {
        const signature = getToolSignatures(signatures)?.get(event.toolCall.id);
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
