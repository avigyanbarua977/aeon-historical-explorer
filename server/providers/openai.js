import { MODEL_ANSWER_SCHEMA } from '../answer-schema.js';

const RESPONSE_URL = 'https://api.openai.com/v1/responses';
const MAX_PROVIDER_RESPONSE_BYTES = 12_000;

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
  if (!env?.OPENAI_API_KEY || !env?.OPENAI_MODEL) throw new Error('Provider configuration is unavailable.');
  const response = await fetchImpl(RESPONSE_URL, {
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
  if (!response.ok) throw new Error(`Provider request failed with status ${response.status}.`);
  const payload = await readBoundedJson(response);
  const output = payload.output?.flatMap((item) => item.content ?? []).find((item) => item.type === 'output_text')?.text;
  if (typeof output !== 'string') throw new Error('Provider response did not contain structured output.');
  return JSON.parse(output);
}
