const MODEL_KEYS = new Set([
  'schemaVersion', 'status', 'shortAnswer', 'shortAnswerEventIds',
  'shortAnswerRelationshipIds', 'statements', 'relationshipClaims', 'path',
  'eventIds', 'relationshipIds', 'uncertainty',
]);
const STATEMENT_KEYS = new Set(['kind', 'text', 'eventIds', 'relationshipIds']);
const CLAIM_KEYS = new Set(['type', 'fromEventId', 'toEventId', 'relationshipIds', 'text']);
const PATH_KEYS = new Set(['fromEventId', 'toEventId', 'type', 'relationshipIds']);
const CAUSAL_LANGUAGE = /\b(caus(?:e|es|ed|ing)|led to|lead to|result(?:ed)? in|because|therefore|produced|triggered)\b/i;

function hasExactKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === allowed.size
    && Object.keys(value).every((key) => allowed.has(key));
}

function uniqueStringArray(value, { min = 0, max = 20 } = {}) {
  return Array.isArray(value) && value.length >= min && value.length <= max
    && value.every((item) => typeof item === 'string' && item.length > 0)
    && new Set(value).size === value.length;
}

export const MODEL_ANSWER_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'status', 'shortAnswer', 'shortAnswerEventIds',
    'shortAnswerRelationshipIds', 'statements', 'relationshipClaims', 'path',
    'eventIds', 'relationshipIds', 'uncertainty',
  ],
  properties: {
    schemaVersion: { type: 'string', enum: ['1'] },
    status: { type: 'string', enum: ['answered', 'insufficient_evidence'] },
    shortAnswer: { type: 'string' },
    shortAnswerEventIds: { type: 'array', items: { type: 'string' } },
    shortAnswerRelationshipIds: { type: 'array', items: { type: 'string' } },
    statements: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['kind', 'text', 'eventIds', 'relationshipIds'],
        properties: {
          kind: { type: 'string', enum: ['dataset_fact', 'explanation'] },
          text: { type: 'string' },
          eventIds: { type: 'array', items: { type: 'string' } },
          relationshipIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    relationshipClaims: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['type', 'fromEventId', 'toEventId', 'relationshipIds', 'text'],
        properties: {
          type: { type: 'string', enum: ['CAUSES', 'RELATED_TO'] },
          fromEventId: { type: 'string' },
          toEventId: { type: 'string' },
          relationshipIds: { type: 'array', items: { type: 'string' } },
          text: { type: 'string' },
        },
      },
    },
    path: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['fromEventId', 'toEventId', 'type', 'relationshipIds'],
        properties: {
          fromEventId: { type: 'string' },
          toEventId: { type: 'string' },
          type: { type: 'string', enum: ['CAUSES', 'RELATED_TO'] },
          relationshipIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    eventIds: { type: 'array', items: { type: 'string' } },
    relationshipIds: { type: 'array', items: { type: 'string' } },
    uncertainty: { type: 'string' },
  },
});

export function validateProviderAnswer(answer, { events = [], graphData, deterministicAnswer } = {}) {
  const errors = [];
  if (!hasExactKeys(answer, MODEL_KEYS)) return { valid: false, errors: ['AI answer has an invalid top-level schema.'] };
  const eventById = new Map(events.map((event) => [event.id, event]));
  const edgeById = new Map((graphData?.edges ?? []).map((edge) => [edge.id, edge]));
  const eventScope = new Set(deterministicAnswer?.eventIds ?? []);
  const relationshipScope = new Set(deterministicAnswer?.relationshipIds ?? []);
  const checkIds = (ids, label, known, scope) => {
    if (!uniqueStringArray(ids, { max: 20 })) { errors.push(`${label} must be a bounded list of unique IDs.`); return; }
    for (const id of ids) {
      if (!known.has(id)) errors.push(`${label} contains an unknown ID: ${id}.`);
      if (!scope.has(id)) errors.push(`${label} contains an ID outside the validated evidence scope: ${id}.`);
    }
  };
  const checkCitations = (text, eventIds, relationshipIds, label) => {
    if (typeof text !== 'string' || text.trim().length < 8 || text.length > 650) errors.push(`${label} text is empty or exceeds the output limit.`);
    if (!uniqueStringArray(eventIds, { min: 1, max: 12 })) errors.push(`${label} must cite one or more unique event IDs.`);
    else checkIds(eventIds, `${label} event references`, eventById, eventScope);
    if (!uniqueStringArray(relationshipIds, { max: 24 })) errors.push(`${label} relationship references must be a bounded unique list.`);
    else checkIds(relationshipIds, `${label} relationship references`, edgeById, relationshipScope);
    if (text && CAUSAL_LANGUAGE.test(text)) {
      const causalEdges = (relationshipIds ?? []).map((id) => edgeById.get(id)).filter((edge) => edge?.type === 'CAUSES');
      if (!causalEdges.length) errors.push(`${label} uses causal wording without a cited CAUSES relationship.`);
      else if (eventIds && !causalEdges.some((edge) => eventIds.includes(edge.source?.id) && eventIds.includes(edge.target?.id))) {
        errors.push(`${label} causal evidence does not connect its cited events.`);
      }
    }
  };

  if (answer.schemaVersion !== '1') errors.push('Unsupported answer schema version.');
  if (!['answered', 'insufficient_evidence'].includes(answer.status)) errors.push('Invalid answer status.');
  if (!Array.isArray(answer.statements) || !Array.isArray(answer.relationshipClaims) || !Array.isArray(answer.path)
    || !Array.isArray(answer.eventIds) || !Array.isArray(answer.relationshipIds)) {
    return { valid: false, errors: [...errors, 'AI answer contains a field with an invalid list type.'] };
  }
  checkCitations(answer.shortAnswer, answer.shortAnswerEventIds, answer.shortAnswerRelationshipIds, 'Short answer');
  if (answer.statements.length < 1 || answer.statements.length > 6) errors.push('AI answer must contain between one and six statements.');
  for (const [index, statement] of answer.statements.entries()) {
    const label = `Statement ${index + 1}`;
    if (!hasExactKeys(statement, STATEMENT_KEYS) || !['dataset_fact', 'explanation'].includes(statement.kind)) {
      errors.push(`${label} has an invalid schema or kind.`);
      continue;
    }
    checkCitations(statement.text, statement.eventIds, statement.relationshipIds, label);
    if (statement.kind === 'dataset_fact') {
      const exactRecordText = statement.eventIds.length === 1 && eventById.has(statement.eventIds[0])
        ? `${eventById.get(statement.eventIds[0]).title} — ${eventById.get(statement.eventIds[0]).displayYear}. ${eventById.get(statement.eventIds[0]).description}`
        : '';
      if (statement.text !== exactRecordText) errors.push(`${label} must reproduce a cited AEON event record exactly.`);
    }
  }
  if (answer.relationshipClaims.length > 12) errors.push('Too many relationship claims.');
  for (const [index, claim] of answer.relationshipClaims.entries()) {
    const label = `Relationship claim ${index + 1}`;
    if (!hasExactKeys(claim, CLAIM_KEYS) || !['CAUSES', 'RELATED_TO'].includes(claim.type)) {
      errors.push(`${label} has an invalid schema or relationship type.`);
      continue;
    }
    checkCitations(claim.text, [claim.fromEventId, claim.toEventId], claim.relationshipIds, label);
    const fromTitle = eventById.get(claim.fromEventId)?.title;
    const toTitle = eventById.get(claim.toEventId)?.title;
    const canonicalClaimText = claim.type === 'CAUSES'
      ? `${fromTitle} is recorded by AEON as contributing to ${toTitle}.`
      : `${fromTitle} is contextually related to ${toTitle} in AEON records.`;
    if (claim.text !== canonicalClaimText) errors.push(`${label} text must match the validated relationship template.`);
    for (const id of claim.relationshipIds) {
      const edge = edgeById.get(id);
      if (!edge) continue;
      if (edge.type !== claim.type) errors.push(`${label} type does not match relationship ${id}.`);
      const endpointsMatch = edge.type === 'CAUSES'
        ? edge.source.id === claim.fromEventId && edge.target.id === claim.toEventId
        : new Set([edge.source.id, edge.target.id]).has(claim.fromEventId)
          && new Set([edge.source.id, edge.target.id]).has(claim.toEventId)
          && claim.fromEventId !== claim.toEventId;
      if (!endpointsMatch) errors.push(`${label} endpoints or direction do not match relationship ${id}.`);
      if (edge.type === 'RELATED_TO' && CAUSAL_LANGUAGE.test(claim.text)) errors.push(`${label} presents RELATED_TO as causal evidence.`);
    }
  }
  if (answer.path.length > 8) errors.push('Path exceeds the maximum output length.');
  for (const [index, step] of answer.path.entries()) {
    const label = `Path step ${index + 1}`;
    if (!hasExactKeys(step, PATH_KEYS) || !['CAUSES', 'RELATED_TO'].includes(step.type)) {
      errors.push(`${label} has an invalid schema or relationship type.`);
      continue;
    }
    checkIds([step.fromEventId, step.toEventId], `${label} event references`, eventById, eventScope);
    if (!uniqueStringArray(step.relationshipIds, { min: 1, max: 24 })) { errors.push(`${label} must cite relationship IDs.`); continue; }
    checkIds(step.relationshipIds, `${label} relationship references`, edgeById, relationshipScope);
    for (const id of step.relationshipIds) {
      const edge = edgeById.get(id);
      if (!edge) continue;
      const joins = edge.type === 'CAUSES'
        ? edge.source.id === step.fromEventId && edge.target.id === step.toEventId
        : new Set([edge.source.id, edge.target.id]).has(step.fromEventId) && new Set([edge.source.id, edge.target.id]).has(step.toEventId);
      if (edge.type !== step.type || !joins) errors.push(`${label} type, endpoints, or direction do not match relationship ${id}.`);
    }
    if (index > 0 && answer.path[index - 1]?.toEventId !== step.fromEventId) errors.push(`${label} breaks path continuity.`);
  }
  checkIds(answer.eventIds, 'Answer event references', eventById, eventScope);
  checkIds(answer.relationshipIds, 'Answer relationship references', edgeById, relationshipScope);
  if (answer.uncertainty !== '' && (typeof answer.uncertainty !== 'string' || answer.uncertainty.length > 360)) errors.push('Uncertainty text is invalid or too long.');
  if (answer.status === 'answered' && answer.uncertainty !== '') errors.push('An answered result cannot contain uncertainty text.');
  if (answer.status === 'insufficient_evidence' && answer.uncertainty.trim().length < 8) errors.push('Insufficient-evidence status requires an uncertainty explanation.');

  const expectedPath = deterministicAnswer?.path ?? [];
  if (answer.path.length !== expectedPath.length) errors.push('AI path differs from the validated deterministic path.');
  answer.path.forEach((step, index) => {
    const expected = expectedPath[index];
    if (!expected || step.fromEventId !== expected.fromEventId || step.toEventId !== expected.toEventId || step.type !== expected.type
      || JSON.stringify(step.relationshipIds) !== JSON.stringify(expected.relationshipIds)) {
      errors.push(`AI path step ${index + 1} differs from the validated deterministic path.`);
    }
  });
  if (expectedPath.length && answer.path.length) {
    if (answer.path[0].fromEventId !== expectedPath[0].fromEventId
      || answer.path.at(-1).toEventId !== expectedPath.at(-1).toEventId) errors.push('AI path endpoints differ from the requested path.');
  }
  return { valid: errors.length === 0, errors };
}
