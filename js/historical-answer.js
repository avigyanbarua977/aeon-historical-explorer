import { validateGroundedAnswer } from './answer-grounding.js';

function edgeRecords(edge) {
  return { relationshipIds: [...edge.relationshipIds], multiplicity: edge.records.length };
}

export function buildHistoricalAnswer(query, retrieval, { events = [], eras = [], graphData } = {}) {
  const eventById = new Map(events.map((event) => [event.id, event]));
  const intentLabels = {
    event_lookup: 'Event record', date_lookup: 'Events by date', cause_explanation: 'Causes recorded by AEON', consequence_lookup: 'Outcomes recorded by AEON',
    related_events: 'Contextual connections', historical_path: 'Historical connection', what_before: 'Earlier events', what_after: 'Later events', era_overview: 'Era overview',
  };
  let status = retrieval.status;
  let message = '';
  const factualStatements = [];
  const relationshipClaims = [];
  const path = [];
  const evidenceIds = new Set();
  const evidenceRelationshipIds = new Set();
  let selectedEvent = retrieval.target ?? null;

  if (status === 'unsupported') message = 'Try asking about an AEON event, era, cause, consequence, relationship, or historical sequence.';
  else if (status === 'no_match') message = 'I could not match that question to events in AEON’s current dataset.';
  else if (status === 'ambiguous') message = 'I found more than one possible interpretation. Refine the event or connection you mean.';
  else if (query.intent === 'era_overview') {
    const eraEvents = retrieval.eraEvents ?? [];
    for (const event of eraEvents) evidenceIds.add(event.id);
    const eraTitle = eras.find((era) => era.id === query.eraId)?.title ?? 'This era';
    factualStatements.push({ text: `${eraTitle} contains ${eraEvents.length} milestones in AEON’s current dataset.`, eventIds: [...evidenceIds] });
    selectedEvent = eraEvents[0] ?? null;
    message = eraEvents.length ? `A concise view of ${eraTitle}, based on ${eraEvents.length} AEON milestones.` : 'No milestones are currently assigned to this era.';
    if (!eraEvents.length) status = 'no_match';
  } else if (selectedEvent) {
    evidenceIds.add(selectedEvent.id);
    factualStatements.push({ text: `${selectedEvent.title} is dated ${selectedEvent.displayYear}. ${selectedEvent.description}`, eventIds: [selectedEvent.id] });
    message = `${selectedEvent.title} — ${selectedEvent.displayYear}.`;

    if (query.intent === 'date_lookup') {
      const matches = retrieval.candidates.map(({ event }) => event);
      matches.forEach((event) => evidenceIds.add(event.id));
      factualStatements.push({ text: `AEON records ${matches.map((event) => `${event.title} (${event.displayYear})`).join('; ')} for the requested date.`, eventIds: matches.map((event) => event.id) });
    } else if (query.intent === 'cause_explanation' || query.intent === 'consequence_lookup' || query.intent === 'related_events') {
      const records = retrieval.relationships ?? [];
      if (!records.length) {
        status = 'insufficient_evidence';
        message = `AEON does not currently record ${query.intent === 'cause_explanation' ? 'a direct cause for' : query.intent === 'consequence_lookup' ? 'a direct outcome of' : 'a contextual connection for'} ${selectedEvent.title}.`;
      }
      for (const edge of records) {
        const otherId = edge.type === 'CAUSES'
          ? (query.direction === 'incoming' ? edge.source : edge.target)
          : (edge.source === selectedEvent.id ? edge.target : edge.source);
        const other = eventById.get(otherId);
        if (!other) continue;
        evidenceIds.add(other.id);
        edge.relationshipIds.forEach((id) => evidenceRelationshipIds.add(id));
        const fromEventId = edge.type === 'CAUSES' ? edge.source : selectedEvent.id;
        const toEventId = edge.type === 'CAUSES' ? edge.target : other.id;
        relationshipClaims.push({ type: edge.type, fromEventId, toEventId, relationshipIds: edge.relationshipIds, text: edge.type === 'CAUSES'
          ? `${eventById.get(edge.source)?.title} is recorded as contributing to ${eventById.get(edge.target)?.title}.`
          : `${selectedEvent.title} is contextually related to ${other.title}.` });
      }
      if (relationshipClaims.length) message += ` AEON records ${relationshipClaims.length} ${query.intent === 'related_events' ? 'contextual connection' : 'direct relationship'}${relationshipClaims.length === 1 ? '' : 's'}; relationship type and direction are shown below.`;
    } else if (query.intent === 'what_before' || query.intent === 'what_after') {
      const neighbors = retrieval.chronology ?? [];
      neighbors.forEach((event) => evidenceIds.add(event.id));
      if (!neighbors.length) {
        status = 'insufficient_evidence';
        message = 'AEON has no other dated events to show in that direction.';
      } else {
        factualStatements.push({ text: `${neighbors.map((event) => `${event.title} (${event.displayYear})`).join('; ')} ${query.direction === 'forward' ? 'are later-dated milestones' : 'are earlier-dated milestones'} in AEON’s timeline.`, eventIds: neighbors.map((event) => event.id) });
      }
    } else if (query.intent === 'historical_path') {
      const foundPath = retrieval.path;
      if (!foundPath?.found || foundPath.edges.length === 0) {
        status = 'insufficient_evidence';
        message = 'I could not find a supported relationship path between two distinct AEON events. No connection is inferred.';
      } else {
        for (let index = 0; index < foundPath.edges.length; index += 1) {
          const edge = foundPath.edges[index];
          const fromEventId = foundPath.nodes[index];
          const toEventId = foundPath.nodes[index + 1];
          edge.relationshipIds.forEach((id) => evidenceRelationshipIds.add(id));
          evidenceIds.add(fromEventId); evidenceIds.add(toEventId);
          path.push({ fromEventId, toEventId, type: edge.type, relationshipIds: edge.relationshipIds });
          relationshipClaims.push({ type: edge.type, fromEventId, toEventId, relationshipIds: edge.relationshipIds, text: edge.type === 'CAUSES'
            ? `${eventById.get(fromEventId)?.title} is recorded as contributing to ${eventById.get(toEventId)?.title}.`
            : `${eventById.get(fromEventId)?.title} is contextually related to ${eventById.get(toEventId)?.title}.` });
        }
        message = `AEON records a ${path.length}-step connection. Each step retains its recorded relationship type; the path does not imply more than those records establish.`;
      }
    }
  }

  const graphRootId = path[0]?.fromEventId ?? selectedEvent?.id ?? null;
  const answer = {
    query: query.raw,
    intent: query.intent,
    status,
    answerMode: 'deterministic',
    heading: intentLabels[query.intent] ?? 'AEON Historical Explorer',
    shortAnswer: message,
    shortAnswerEventIds: [...evidenceIds],
    factualStatements,
    relationshipClaims,
    path,
    eventIds: [...evidenceIds],
    relationshipIds: [...evidenceRelationshipIds],
    uncertainty: status === 'insufficient_evidence' ? 'AEON’s current dataset does not establish enough evidence for the requested connection.' : null,
    navigation: {
      timeline: { eventIds: [...evidenceIds], eraId: selectedEvent?.era ?? query.eraId ?? null },
      graph: graphRootId ? { rootEventId: graphRootId, depth: query.depth, relationshipTypes: [...new Set(relationshipClaims.map((claim) => claim.type))] } : null,
    },
    candidates: retrieval.candidates.map(({ event, score }) => ({ eventId: event.id, title: event.title, displayYear: event.displayYear, score })),
    evidence: [...evidenceIds].map((id) => {
      const event = eventById.get(id);
      return event ? { eventId: id, title: event.title, displayYear: event.displayYear, era: event.era } : null;
    }).filter(Boolean),
    multiplicity: (retrieval.relationships ?? []).map(edgeRecords),
    sourceScope: 'Claims are grounded in AEON event records and canonical relationships; the dataset does not currently provide an external bibliography.',
  };
  const validation = validateGroundedAnswer(answer, { events, graphData });
  if (!validation.valid) return { ...answer, status: 'invalid_evidence', shortAnswer: 'This result could not be validated against AEON’s records. Please try another question.', errors: validation.errors, eventIds: [], relationshipIds: [], factualStatements: [], relationshipClaims: [], path: [], navigation: { timeline: { eventIds: [], eraId: null }, graph: null }, evidence: [] };
  return answer;
}
