import { MODEL_ANSWER_SCHEMA } from '../answer-schema.js';

const RESPONSE_URL = 'https://api.openai.com/v1/responses';
const MAX_PROVIDER_RESPONSE_BYTES = 12_000;
const SAFE_ERROR_TYPES = new Set([
  'invalid_request_error', 'authentication_error', 'permission_error',
  'rate_limit_error', 'insufficient_quota', 'server_error',
  'service_unavailable_error', 'billing_error',
]);
const SAFE_ERROR_CODES = new Set([
  'invalid_api_key', 'model_not_found', 'model_access_denied',
  'rate_limit_exceeded', 'slow_down', 'insufficient_quota',
  'credit_balance_exhausted', 'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded', 'organization_usage_limit_exceeded',
  'server_is_overloaded', 'billing_hard_limit_reached', 'billing_not_active',
]);
const SAFE_ERROR_PARAMS = new Set(['model', 'input', 'text.format', 'text.format.schema', 'max_output_tokens']);
const SAFE_CATEGORIES = new Set([
  'configuration', 'connectivity', 'authentication', 'permission_or_policy',
  'quota_or_billing', 'rate_limit', 'quota_or_rate_limit', 'model_access_or_configuration',
  'request_rejected', 'provider_resource_not_found', 'provider_server', 'provider_http',
  'provider_response_invalid', 'timeout', 'provider_internal',
]);
const QUOTA_CODES = new Set([
  'insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded', 'organization_usage_limit_exceeded',
  'billing_hard_limit_reached', 'billing_not_active',
]);

export class OpenAIProviderError extends Error {
  constructor(diagnostic) {
    super('Provider request failed.');
    this.name = 'OpenAIProviderError';
    this.diagnostic = diagnostic;
  }
}

function safeValue(value, allowed) {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

function classifyProviderFailure(status, type, code, param) {
  if (status === 401) return 'authentication';
  if (status === 403 && (code === 'model_access_denied' || param === 'model')) return 'model_access_or_configuration';
  if (status === 403) return 'permission_or_policy';
  if (status === 429) {
    if (type === 'insufficient_quota' || QUOTA_CODES.has(code)) return 'quota_or_billing';
    if (type === 'rate_limit_error' || code === 'rate_limit_exceeded' || code === 'slow_down') return 'rate_limit';
    return 'quota_or_rate_limit';
  }
  if ((status === 400 || status === 404) && (code === 'model_not_found' || code === 'model_access_denied' || param === 'model')) return 'model_access_or_configuration';
  if (status === 400) return 'request_rejected';
  if (status === 404) return 'provider_resource_not_found';
  if (status >= 500) return 'provider_server';
  return 'provider_http';
}

function createProviderError({ category, status = null, type = null, code = null, param = null, missingSettings = [] }) {
  return new OpenAIProviderError({
    category,
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    type: safeValue(type, SAFE_ERROR_TYPES),
    code: safeValue(code, SAFE_ERROR_CODES),
    param: safeValue(param, SAFE_ERROR_PARAMS),
    missingSettings: missingSettings.filter((name) => ['OPENAI_API_KEY', 'OPENAI_MODEL'].includes(name)),
  });
}

export function getSafeProviderDiagnostic(error, timedOut = false) {
  if (timedOut) return { category: 'timeout', status: null, type: null, code: null, param: null, missingSettings: [] };
  if (!(error instanceof OpenAIProviderError)) {
    return { category: 'provider_internal', status: null, type: null, code: null, param: null, missingSettings: [] };
  }
  const diagnostic = error.diagnostic ?? {};
  return {
    category: SAFE_CATEGORIES.has(diagnostic.category) ? diagnostic.category : 'provider_internal',
    status: Number.isInteger(diagnostic.status) && diagnostic.status >= 100 && diagnostic.status <= 599 ? diagnostic.status : null,
    type: safeValue(diagnostic.type, SAFE_ERROR_TYPES),
    code: safeValue(diagnostic.code, SAFE_ERROR_CODES),
    param: safeValue(diagnostic.param, SAFE_ERROR_PARAMS),
    missingSettings: Array.isArray(diagnostic.missingSettings) ? diagnostic.missingSettings.filter((name) => ['OPENAI_API_KEY', 'OPENAI_MODEL'].includes(name)) : [],
  };
}

async function readBoundedJson(response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_PROVIDER_RESPONSE_BYTES) throw new Error('Provider response exceeded the limit.');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_PROVIDER_RESPONSE_BYTES) throw new Error('Provider response exceeded the limit.');
    return JSON.parse(text);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Provider response exceeded the limit.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => { bytes.set(chunk, offset); offset += chunk.byteLength; });
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function generateGroundedExplanation(input, { env, fetchImpl = fetch, signal } = {}) {
  const missingSettings = [];
  if (typeof env?.OPENAI_API_KEY !== 'string' || !env.OPENAI_API_KEY.trim()) missingSettings.push('OPENAI_API_KEY');
  if (typeof env?.OPENAI_MODEL !== 'string' || !env.OPENAI_MODEL.trim()) missingSettings.push('OPENAI_MODEL');
  if (missingSettings.length) throw createProviderError({ category: 'configuration', missingSettings });
  let response;
  try {
    response = await fetchImpl(RESPONSE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      signal,
      body: JSON.stringify({
        model: env.OPENAI_MODEL,
        store: false,
        max_output_tokens: 800,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: input.systemPrompt }] },
          { role: 'user', content: [{ type: 'input_text', text: input.userPrompt }] },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'aeon_grounded_answer_v1',
            strict: true,
            schema: MODEL_ANSWER_SCHEMA,
          },
        },
      }),
    });
  } catch {
    throw createProviderError({ category: signal?.aborted ? 'timeout' : 'connectivity' });
  }
  if (!response.ok) {
    let providerError = {};
    try { providerError = (await readBoundedJson(response))?.error ?? {}; } catch { /* Keep only status when the body is invalid or oversized. */ }
    const type = safeValue(providerError.type, SAFE_ERROR_TYPES);
    const code = safeValue(providerError.code, SAFE_ERROR_CODES);
    const param = safeValue(providerError.param, SAFE_ERROR_PARAMS);
    throw createProviderError({
      category: classifyProviderFailure(response.status, type, code, param),
      status: response.status,
      type,
      code,
      param,
    });
  }
  let payload;
  try { payload = await readBoundedJson(response); }
  catch { throw createProviderError({ category: 'provider_response_invalid', status: response.status }); }
  const output = payload.output?.flatMap((item) => item.content ?? []).find((item) => item.type === 'output_text')?.text;
  if (typeof output !== 'string') throw createProviderError({ category: 'provider_response_invalid', status: response.status });
  try { return JSON.parse(output); }
  catch { throw createProviderError({ category: 'provider_response_invalid', status: response.status }); }
}
