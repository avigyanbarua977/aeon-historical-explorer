export function validateGroundedAnswer(answer, { events = [], graphData } = {}) {
  const eventIds = new Set(events.map((event) => event.id));
  const relationshipById = new Map((graphData?.edges ?? []).map((edge) => [edge.id, edge]));
  const errors = [];
  if (!answer || typeof answer !== 'object') return { valid: false, errors: ['Answer must be an object.'] };
  const checkEvents = (ids, label) => {
    if (!Array.isArray(ids)) { errors.push(`${label} must list evidence event IDs.`); return; }
    for (const id of ids) if (!eventIds.has(id)) errors.push(`Unknown event ID: ${id}.`);
  };
  checkEvents(answer.eventIds, 'Answer');
  checkEvents(answer.shortAnswerEventIds ?? [], 'Short answer');
  checkEvents(answer.navigation?.timeline?.eventIds ?? [], 'Timeline navigation');
  if (answer.navigation?.graph?.rootEventId && !eventIds.has(answer.navigation.graph.rootEventId)) errors.push(`Unknown graph root event ID: ${answer.navigation.graph.rootEventId}.`);
  for (const candidate of answer.candidates ?? []) if (!eventIds.has(candidate.eventId)) errors.push(`Unknown candidate event ID: ${candidate.eventId}.`);
  for (const id of answer.relationshipIds ?? []) if (!relationshipById.has(id)) errors.push(`Unknown relationship ID: ${id}.`);
  for (const [index, statement] of (answer.factualStatements ?? []).entries()) checkEvents(statement.eventIds, `Factual statement ${index + 1}`);
  for (const [index, claim] of (answer.relationshipClaims ?? []).entries()) {
    if (!Array.isArray(claim.relationshipIds) || !claim.relationshipIds.length) {
      errors.push(`Relationship claim ${index + 1} must cite relationship IDs.`);
      continue;
    }
    for (const id of claim.relationshipIds) {
      const edge = relationshipById.get(id);
      if (!edge) { errors.push(`Unknown relationship ID: ${id}.`); continue; }
      if (edge.type !== claim.type) errors.push(`Relationship ${id} is ${edge.type}, not ${claim.type}.`);
      const pair = new Set([edge.source.id, edge.target.id]);
      const endpointsMatch = edge.type === 'RELATED_TO'
        ? pair.has(claim.fromEventId) && pair.has(claim.toEventId) && claim.fromEventId !== claim.toEventId
        : (!claim.fromEventId || edge.source.id === claim.fromEventId) && (!claim.toEventId || edge.target.id === claim.toEventId);
      if (!endpointsMatch) errors.push(`Relationship ${id} does not connect the stated events in the stated direction.`);
      if (edge.type === 'CAUSES' && claim.fromEventId && edge.source.id !== claim.fromEventId) errors.push(`Causal direction for ${id} does not start at ${claim.fromEventId}.`);
      if (edge.type === 'CAUSES' && claim.toEventId && edge.target.id !== claim.toEventId) errors.push(`Causal direction for ${id} does not end at ${claim.toEventId}.`);
    }
  }
  for (const [index, step] of (answer.path ?? []).entries()) {
    if (!eventIds.has(step.fromEventId)) errors.push(`Path step ${index + 1} has an unknown source event.`);
    if (!eventIds.has(step.toEventId)) errors.push(`Path step ${index + 1} has an unknown target event.`);
    if (!Array.isArray(step.relationshipIds) || !step.relationshipIds.length) { errors.push(`Path step ${index + 1} lacks relationship evidence.`); continue; }
    for (const relationshipId of step.relationshipIds) {
      const edge = relationshipById.get(relationshipId);
      if (!edge) { errors.push(`Unknown relationship ID: ${relationshipId}.`); continue; }
      if (edge.type !== step.type) errors.push(`Path relationship ${relationshipId} has a mismatched type.`);
      const endpointsMatch = edge.type === 'RELATED_TO'
        ? new Set([edge.source.id, edge.target.id]).has(step.fromEventId) && new Set([edge.source.id, edge.target.id]).has(step.toEventId)
        : edge.source.id === step.fromEventId && edge.target.id === step.toEventId;
      if (!endpointsMatch) errors.push(`Path relationship ${relationshipId} does not connect the stated events in the stated direction.`);
    }
  }
  return { valid: errors.length === 0, errors };
}
