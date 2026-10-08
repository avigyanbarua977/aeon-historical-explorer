import { buildEvidencePacket, EVIDENCE_LIMITS, loadCanonicalDataset } from './evidence.js';
import { buildGroundingPrompt } from './prompt.js';
import { generateGroundedExplanation } from './provider-adapter.js';
import { validateProviderAnswer } from './answer-schema.js';
import { getDatasetVersion } from '../js/dataset-version.js';
import { interpretQuery } from '../js/query-interpreter.js';
import { retrieveEvents } from '../js/event-retrieval.js';
import { createRelationshipIndex } from '../js/relationship-traversal.js';
import { buildHistoricalAnswer } from '../js/historical-answer.js';
import { createRelationshipEngine } from '../js/relationship-engine.js';
import { isAIEligible } from '../js/ai-eligibility.js';

const API_VERSION = '1';
const MAX_REQUEST_BYTES = 8_000;
const PROVIDER_TIMEOUT_MS = 12_000;
const allowedBodyKeys = new Set(['apiVersion', 'datasetVersion', 'query', 'intent', 'eventIds', 'relationshipIds']);
const allowedIntentKeys = new Set(['type', 'direction', 'depth', 'explanationType']);

function originList(env) {
  return String(env.ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
}

function corsHeaders(origin, env) {
  const headers = new Headers({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  });
  return headers;
}

function jsonResponse(payload, status, headers = new Headers()) {
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(payload), { status, headers });
}

function errorResponse(code, status, headers) {
  return jsonResponse({ apiVersion: API_VERSION, error: { code, message: 'AI explanation is unavailable.' } }, status, headers);
}

async function readRequestBody(request) {
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) throw Object.assign(new Error(), { status: 413, code: 'REQUEST_TOO_LARGE' });
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(new Error(), { status: 400, code: 'INVALID_REQUEST' });
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw Object.assign(new Error(), { status: 413, code: 'REQUEST_TOO_LARGE' });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => { bytes.set(chunk, offset); offset += chunk.byteLength; });
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw Object.assign(new Error(), { status: 400, code: 'INVALID_JSON' }); }
}

function validateRequestShape(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !allowedBodyKeys.has(key))
    || Object.keys(body).length !== allowedBodyKeys.size) throw Object.assign(new Error(), { status: 400, code: 'INVALID_REQUEST' });
  if (body.apiVersion !== API_VERSION || typeof body.datasetVersion !== 'string' || !/^sha256-[a-f0-9]{64}$/.test(body.datasetVersion)) {
    throw Object.assign(new Error(), { status: 400, code: 'INVALID_VERSION' });
  }
  if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 240) throw Object.assign(new Error(), { status: 400, code: 'INVALID_QUERY' });
  if (!body.intent || typeof body.intent !== 'object' || Array.isArray(body.intent)
    || Object.keys(body.intent).length !== allowedIntentKeys.size
    || Object.keys(body.intent).some((key) => !allowedIntentKeys.has(key))) throw Object.assign(new Error(), { status: 400, code: 'INVALID_INTENT' });
  if (!Array.isArray(body.eventIds) || body.eventIds.length < 2 || body.eventIds.length > EVIDENCE_LIMITS.maxEvents
    || body.eventIds.some((id) => typeof id !== 'string') || new Set(body.eventIds).size !== body.eventIds.length) {
    throw Object.assign(new Error(), { status: 400, code: 'INVALID_EVIDENCE' });
  }
  if (!Array.isArray(body.relationshipIds) || body.relationshipIds.length < 1 || body.relationshipIds.length > EVIDENCE_LIMITS.maxRelationships
    || body.relationshipIds.some((id) => typeof id !== 'string') || new Set(body.relationshipIds).size !== body.relationshipIds.length) {
    throw Object.assign(new Error(), { status: 400, code: 'INVALID_EVIDENCE' });
  }
}

function sameSet(left, right) {
  return Array.isArray(left) && left.length === right.length && [...left].sort().every((id, index) => id === [...right].sort()[index]);
}

export async function handleWorkerRequest(request, env = {}, dependencies = {}) {
  const origin = request.headers.get('origin') ?? '';
  const allowed = originList(env);
  if (!origin || !allowed.includes(origin)) return errorResponse('ORIGIN_NOT_ALLOWED', 403, new Headers({ 'Vary': 'Origin' }));
  const headers = corsHeaders(origin, env);
  const url = new URL(request.url);
  if (url.pathname !== '/v1/explain') return errorResponse('NOT_FOUND', 404, headers);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 405, headers);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return errorResponse('UNSUPPORTED_MEDIA_TYPE', 415, headers);

  let body;
  try {
    body = await readRequestBody(request);
    validateRequestShape(body);
  } catch (error) {
    return errorResponse(error.status ? error.code : 'INVALID_REQUEST', error.status ?? 400, headers);
  }

  let dataset;
  try {
    dataset = await (dependencies.loadDataset ?? loadCanonicalDataset)(env.ASSETS, request.url);
  } catch {
    return errorResponse('DATASET_UNAVAILABLE', 503, headers);
  }
  let datasetVersion;
  try { datasetVersion = await getDatasetVersion(dataset); }
  catch { return errorResponse('DATASET_UNAVAILABLE', 503, headers); }
  if (body.datasetVersion !== datasetVersion) return errorResponse('DATASET_VERSION_MISMATCH', 409, headers);

  let graphData;
  let deterministicAnswer;
  let query;
  try {
    const engine = createRelationshipEngine({ events: dataset.events, relationships: dataset.relationships });
    graphData = engine.getGraphData();
    const relationshipIndex = createRelationshipIndex(graphData);
    query = interpretQuery(body.query, { events: dataset.events, eras: dataset.eras });
    const retrieval = retrieveEvents(query, { events: dataset.events, eras: dataset.eras, relationshipIndex });
    deterministicAnswer = buildHistoricalAnswer(query, retrieval, { events: dataset.events, eras: dataset.eras, graphData });
  } catch {
    return errorResponse('EVIDENCE_UNAVAILABLE', 503, headers);
  }
  const expectedIntent = {
    type: query.intent,
    direction: query.direction,
    depth: query.depth,
    explanationType: query.explanationType,
  };
  const intentMatches = Object.keys(expectedIntent).every((key) => body.intent[key] === expectedIntent[key]);
  if (!isAIEligible(query, deterministicAnswer)
    || !intentMatches
    || !sameSet(body.eventIds, deterministicAnswer.eventIds)
    || !sameSet(body.relationshipIds, deterministicAnswer.relationshipIds)) {
    return errorResponse('AI_NOT_ELIGIBLE', 422, headers);
  }
  if (!env.AI_LIMITER?.limit) return errorResponse('RATE_LIMIT_UNAVAILABLE', 503, headers);
  let rateResult;
  try {
    const sourceAddress = request.headers.get('cf-connecting-ip') ?? 'unknown';
    rateResult = await env.AI_LIMITER.limit({ key: sourceAddress });
  } catch {
    return errorResponse('RATE_LIMIT_UNAVAILABLE', 503, headers);
  }
  if (!rateResult?.success) return errorResponse('RATE_LIMITED', 429, headers);

  let evidence;
  try {
    evidence = buildEvidencePacket({ eventIds: body.eventIds, relationshipIds: body.relationshipIds, events: dataset.events, graphData });
  } catch {
    return errorResponse('INVALID_EVIDENCE', 422, headers);
  }
  const prompts = buildGroundingPrompt({ query: body.query, intent: expectedIntent, evidence });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('provider_timeout'), dependencies.timeoutMs ?? PROVIDER_TIMEOUT_MS);
  try {
    const answer = await (dependencies.generateGroundedExplanation ?? generateGroundedExplanation)(prompts, {
      env,
      signal: controller.signal,
      fetchImpl: dependencies.fetchImpl,
    });
    const validation = validateProviderAnswer(answer, { events: dataset.events, graphData, deterministicAnswer });
    if (!validation.valid) return errorResponse('GROUNDING_FAILED', 502, headers);
    return jsonResponse({ apiVersion: API_VERSION, datasetVersion, answer }, 200, headers);
  } catch {
    return errorResponse(controller.signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE', 503, headers);
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  fetch(request, env) {
    return handleWorkerRequest(request, env);
  },
};
