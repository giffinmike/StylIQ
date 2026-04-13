import { Logger } from '@nestjs/common';

console.log('🔥 OutfitAI logger loaded');

const logger = new Logger('OutfitAI');

function isEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.OUTFIT_AI_DEBUG === 'true';
}

function safeStringify(data: unknown, maxLen = 5000): string {
  try {
    const json = JSON.stringify(data);
    return json.length > maxLen ? json.slice(0, maxLen) + '…[truncated]' : json;
  } catch {
    return String(data);
  }
}

function emit(stage: string, requestId: string, data: Record<string, unknown>) {
  console.log('🔥 EMIT CALLED', stage);
  console.log(`[OUTFIT_AI][${stage}]`, { requestId, ...data });
  setImmediate(() => {
    logger.log(`${stage} ${safeStringify({ requestId, ...data })}`);
  });
}

// ── Typed log functions ─────────────────────────────────────────────────────

export function logInput(
  requestId: string,
  data: {
    userId: string;
    query: string;
    mode?: string;
    weather?: unknown;
    userStyle?: unknown;
    lockedItemIds?: string[];
    styleAgent?: string;
    topK?: number;
    isRefinement?: boolean;
    isStartWithItem?: boolean;
  },
) {
  if (!isEnabled()) return;
  emit('INPUT', requestId, data);
}

export function logPrompt(
  requestId: string,
  data: {
    prompt: string;
    model: string;
    constraints?: unknown;
    promptLength?: number;
    catalogSize?: number;
  },
) {
  if (!isEnabled()) return;
  emit('PROMPT', requestId, {
    ...data,
    prompt:
      data.prompt.length > 3000
        ? data.prompt.slice(0, 3000) + '…[truncated]'
        : data.prompt,
    promptLength: data.promptLength ?? data.prompt.length,
  });
}

export function logRawResponse(
  requestId: string,
  data: {
    responseText: string;
    model: string;
    latencyMs: number;
  },
) {
  if (!isEnabled()) return;
  emit('RAW_RESPONSE', requestId, {
    ...data,
    responseText:
      data.responseText.length > 3000
        ? data.responseText.slice(0, 3000) + '…[truncated]'
        : data.responseText,
  });
}

export function logParsed(
  requestId: string,
  data: {
    outfitCount: number;
    slots?: unknown;
    reasoning?: string;
  },
) {
  if (!isEnabled()) return;
  emit('PARSED', requestId, data);
}

export function logFilter(
  requestId: string,
  data: {
    stage: string;
    rejectedCount?: number;
    reason?: string;
    catalogBefore: number;
    catalogAfter: number;
  },
) {
  if (!isEnabled()) return;
  emit('FILTER', requestId, data);
}

export function logOutput(
  requestId: string,
  data: {
    outfits: Array<{ id?: string; title?: string; itemCategories?: string[] }>;
    totalLatencyMs: number;
    itemCounts?: number[];
  },
) {
  if (!isEnabled()) return;
  emit('OUTPUT', requestId, data);
}

export function logContext(
  requestId: string,
  data: {
    formality: number;
    isOutdoor: boolean;
    activityLevel: string;
    tempBand: string | null;
    season: string | null;
    sourceQuery?: string;
  },
) {
  if (!isEnabled()) return;
  emit('CONTEXT', requestId, data);
}

export function logTrace(
  requestId: string,
  data: {
    stage: string;
    [key: string]: unknown;
  },
) {
  if (!isEnabled()) return;
  emit('TRACE', requestId, data);
}
