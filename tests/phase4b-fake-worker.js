import { handleWorkerRequest } from '../server/worker.js';

function createGroundedFixture({ events, relationships }) {
  if (!events.length || relationships.some((edge) => edge.type !== 'CAUSES')) {
    throw new Error('The local fake provider supports only a causal path fixture.');
  }

  const eventById = new Map(events.map((event) => [event.id, event]));
  const groups = new Map();
  for (const edge of relationships) {
    const key = `${edge.sourceEventId}\u0000${edge.targetEventId}`;
    const group = groups.get(key) ?? { fromEventId: edge.sourceEventId, toEventId: edge.targetEventId, type: edge.type, relationshipIds: [] };
    group.relationshipIds.push(edge.id);
    groups.set(key, group);
  }

  const steps = [...groups.values()];
  const stepsBySource = new Map();
  const targets = new Set(steps.map((step) => step.toEventId));
  for (const step of steps) {
    const outgoing = stepsBySource.get(step.fromEventId) ?? [];
    outgoing.push(step);
    stepsBySource.set(step.fromEventId, outgoing);
  }

  let current = events.find((event) => stepsBySource.has(event.id) && !targets.has(event.id))?.id;
  const path = [];
  const visited = new Set();
  while (current && !visited.has(current)) {
    visited.add(current);
    const next = (stepsBySource.get(current) ?? []).sort((left, right) =>
      eventById.get(left.toEventId).year - eventById.get(right.toEventId).year)[0];
    if (!next) break;
    path.push(next);
    current = next.toEventId;
  }
  if (path.length !== steps.length) throw new Error('The local fake provider could not form a continuous evidence path.');

  const relationshipClaims = steps.map((step) => {
    const source = eventById.get(step.fromEventId);
    const target = eventById.get(step.toEventId);
    return {
      ...step,
      text: `${source.title} is recorded by AEON as contributing to ${target.title}.`,
    };
  });
  const eventIds = events.map((event) => event.id);
  const relationshipIds = relationships.map((edge) => edge.id);
  const fact = events[0];

  return {
    schemaVersion: '1',
    status: 'answered',
    shortAnswer: 'AEON records a path across the selected events.',
    shortAnswerEventIds: eventIds,
    shortAnswerRelationshipIds: relationshipIds,
    statements: [
      { kind: 'dataset_fact', text: `${fact.title} — ${fact.displayYear}. ${fact.description}`, eventIds: [fact.id], relationshipIds: [] },
      { kind: 'explanation', text: 'The selected sequence follows the recorded relationships in AEON.', eventIds, relationshipIds },
    ],
    relationshipClaims,
    path,
    eventIds,
    relationshipIds,
    uncertainty: '',
  };
}

async function generateFakeExplanation(input) {
  const { evidence } = JSON.parse(input.userPrompt);
  return createGroundedFixture(evidence);
}

export default {
  fetch(request, env) {
    const failGrounding = request.headers.get('X-AEON-Test-Grounding-Failure') === '1';
    const generateGroundedExplanation = failGrounding
      ? async (input) => ({ ...(await generateFakeExplanation(input)), eventIds: ['invented-test-event'] })
      : generateFakeExplanation;
    return handleWorkerRequest(request, env, { generateGroundedExplanation });
  },
};
