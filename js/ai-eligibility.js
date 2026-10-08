export function isAIEligible(query, answer) {
  return query?.status === 'supported'
    && query.intent === 'historical_path'
    && answer?.status === 'supported'
    && Array.isArray(answer.path)
    && answer.path.length > 0
    && Array.isArray(answer.eventIds)
    && answer.eventIds.length >= 2
    && Array.isArray(answer.relationshipIds)
    && answer.relationshipIds.length > 0;
}
