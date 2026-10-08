import { normalize, tokens } from './query-interpreter.js';
import { adjacentRelationships, findHistoricalPath, getChronologicalNeighbors } from './relationship-traversal.js';

const INTENT_WORDS = new Set(['cause', 'causes', 'caused', 'causing', 'consequence', 'consequences', 'result', 'results', 'impact', 'led', 'lead', 'related', 'connection', 'connect', 'connected', 'context', 'before', 'after', 'preceded', 'followed', 'earlier', 'next', 'path', 'between', 'from', 'show', 'events', 'event', 'era', 'period', 'age', 'during', 'tell', 'about', 'what', 'who', 'when', 'where', 'how', 'did', 'does', 'the', 'to', 'of', 'in', 'on', 'and', 'is', 'was', 'are', 'for', 'me']);

function scoreEvent(event, query, queryTokens) {
  const title = normalize(event.title);
  const id = normalize(event.id);
  const normalizedQuery = normalize(query);
  if (title && normalizedQuery.includes(title)) return 120;
  if (id && (normalizedQuery === id || queryTokens.join(' ') === id)) return 115;
  const titleTokens = new Set(tokens(title));
  const descriptionTokens = new Set(tokens(event.description));
  let score = 0;
  for (const token of queryTokens) {
    if (titleTokens.has(token)) score += 12;
    else if (descriptionTokens.has(token)) score += 2;
  }
  const meaningful = queryTokens.filter((token) => titleTokens.has(token));
  if (meaningful.length > 1 && meaningful.length === titleTokens.size) score += 8;
  return score;
}

function mentionedEvents(question, events) {
  const normalizedQuestion = ` ${normalize(question)} `;
  return events.map((event) => {
    const phrases = [normalize(event.id).replaceAll('-', ' '), normalize(event.title)].filter((phrase) => phrase.length > 2);
    const indexes = phrases.map((phrase) => normalizedQuestion.indexOf(` ${phrase} `)).filter((index) => index >= 0);
    return indexes.length ? { event, at: Math.min(...indexes) } : null;
  }).filter(Boolean).sort((left, right) => left.at - right.at || left.event.id.localeCompare(right.event.id));
}

export function rankEventCandidates(question, events, { queryTokens, eraId, timeRange } = {}) {
  const source = Array.isArray(events) ? events : [];
  const qTokens = queryTokens ?? tokens(question).filter((token) => !INTENT_WORDS.has(token));
  let ranked = source.map((event) => ({ event, score: scoreEvent(event, question, qTokens) }))
    .filter((item) => item.score > 0);
  if (!ranked.length && timeRange) {
    ranked = source.filter((event) => event.year >= timeRange.startYear && event.year <= timeRange.endYear)
      .map((event) => ({ event, score: 30 - Math.abs(event.year - timeRange.startYear) / 100000 }));
  }
  if (eraId) ranked = ranked.filter((item) => item.event.era === eraId);
  return ranked.sort((left, right) => right.score - left.score || left.event.year - right.event.year || left.event.id.localeCompare(right.event.id));
}

export function retrieveEvents(query, { events = [], eras = [], relationshipIndex } = {}) {
  if (!query || !Array.isArray(events)) throw new TypeError('A structured query and event records are required.');
  if (query.status !== 'supported') return { status: query.status, candidates: [], target: null, eraEvents: [], relationships: [], path: null, chronology: [] };
  const era = eras.find((item) => item.id === query.eraId);
  if (query.intent === 'era_overview') {
    if (!era) return { status: 'no_match', candidates: [], target: null, eraEvents: [], relationships: [], path: null, chronology: [] };
    const eraEvents = events.filter((event) => event.era === era.id).sort((a, b) => a.year - b.year);
    return { status: eraEvents.length ? 'supported' : 'no_match', candidates: eraEvents.map((event) => ({ event, score: 1 })), target: null, era, eraEvents, relationships: [], path: null, chronology: [] };
  }

  let tokensForRank = query.tokens.filter((token) => !INTENT_WORDS.has(token));
  if (query.timeRange && !tokensForRank.length) tokensForRank = [];
  let ranked = rankEventCandidates(query.raw ?? '', events, { queryTokens: tokensForRank, eraId: query.eraId, timeRange: query.timeRange });
  if (query.intent === 'date_lookup' && query.timeRange) {
    const exactDateMatches = events.filter((event) => event.year >= query.timeRange.startYear && event.year <= query.timeRange.endYear && (!query.eraId || event.era === query.eraId))
      .map((event) => ({ event, score: 150 }));
    if (exactDateMatches.length) ranked = exactDateMatches;
  }
  if (!ranked.length) return { status: 'no_match', candidates: [], target: null, eraEvents: [], relationships: [], path: null, chronology: [] };

  const candidates = ranked.filter((item) => item.score === ranked[0].score);
  let pathIds = null;
  if (query.intent === 'historical_path') {
    const mentions = mentionedEvents(query.raw, events);
    pathIds = mentions.length >= 2
      ? [mentions[0].event.id, mentions.at(-1).event.id]
      : ranked.slice(0, 2).map((item) => item.event.id);
    if (pathIds.length < 2 || pathIds[0] === pathIds[1]) return { status: 'ambiguous', candidates, target: null, eraEvents: [], relationships: [], path: null, chronology: [] };
  } else if (candidates.length > 1) {
    return { status: 'ambiguous', candidates, target: null, eraEvents: [], relationships: [], path: null, chronology: [] };
  }
  const target = ranked[0].event;
  const result = { status: 'supported', candidates: ranked.slice(0, 8), target, era: eras.find((item) => item.id === target.era) ?? null, eraEvents: [], relationships: [], path: null, chronology: [] };
  if (!relationshipIndex) return result;

  if (query.intent === 'cause_explanation') result.relationships = adjacentRelationships(relationshipIndex, target.id, { type: 'CAUSES', direction: 'incoming' });
  else if (query.intent === 'consequence_lookup') result.relationships = adjacentRelationships(relationshipIndex, target.id, { type: 'CAUSES', direction: 'outgoing' });
  else if (query.intent === 'related_events') result.relationships = adjacentRelationships(relationshipIndex, target.id, { type: 'RELATED_TO' });
  else if (query.intent === 'what_after' || query.intent === 'what_before') result.chronology = getChronologicalNeighbors(relationshipIndex, target.id, query.direction);
  else if (query.intent === 'historical_path') {
    result.path = findHistoricalPath(relationshipIndex, pathIds[0], pathIds[1], { maxDepth: query.depth });
  }
  return result;
}
