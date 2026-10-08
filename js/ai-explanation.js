import { validateProviderAnswer } from '../server/answer-schema.js';
import { requestGroundedExplanation } from './provider-client.js';
import { isAIEligible } from './ai-eligibility.js';

export { isAIEligible } from './ai-eligibility.js';

export async function getAIEnhancedAnswer({ query, deterministicAnswer, datasetVersion, events, graphData, requestExplanation = requestGroundedExplanation, signal } = {}) {
  if (!isAIEligible(query, deterministicAnswer)) return { answer: deterministicAnswer, usedAI: false, fallback: false };
  if (typeof datasetVersion !== 'string' || !/^sha256-[a-f0-9]{64}$/.test(datasetVersion)) {
    return { answer: deterministicAnswer, usedAI: false, fallback: true };
  }
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort('request_timeout'), 14_000);
  if (signal) {
    if (signal.aborted) timeoutController.abort(signal.reason);
    else signal.addEventListener('abort', () => timeoutController.abort(signal.reason), { once: true });
  }
  try {
    const response = await requestExplanation({
      apiVersion: '1',
      datasetVersion,
      query: query.raw,
      intent: {
        type: query.intent,
        direction: query.direction,
        depth: query.depth,
        explanationType: query.explanationType,
      },
      eventIds: deterministicAnswer.eventIds,
      relationshipIds: deterministicAnswer.relationshipIds,
    }, { signal: timeoutController.signal });
    if (response?.apiVersion !== '1' || response.datasetVersion !== datasetVersion) {
      throw new Error('AI response version does not match the loaded AEON dataset.');
    }
    const modelAnswer = response?.answer;
    const validation = validateProviderAnswer(modelAnswer, {
      events,
      graphData,
      deterministicAnswer,
    });
    if (!validation.valid) throw new Error('AI answer did not pass AEON evidence validation.');

    const eventById = new Map(events.map((event) => [event.id, event]));
    const citedIds = [...new Set([
      ...modelAnswer.eventIds,
      ...modelAnswer.shortAnswerEventIds,
      ...modelAnswer.statements.flatMap((statement) => statement.eventIds),
    ])];
    const evidence = citedIds.map((eventId) => {
      const event = eventById.get(eventId);
      return event ? { eventId, title: event.title, displayYear: event.displayYear, era: event.era } : null;
    }).filter(Boolean);
    return {
      answer: {
        ...deterministicAnswer,
        answerMode: 'ai',
        status: modelAnswer.status === 'insufficient_evidence' ? 'insufficient_evidence' : 'supported',
        shortAnswer: modelAnswer.shortAnswer,
        shortAnswerEventIds: modelAnswer.shortAnswerEventIds,
        statements: modelAnswer.statements,
        relationshipClaims: modelAnswer.relationshipClaims,
        path: modelAnswer.path,
        eventIds: citedIds,
        relationshipIds: modelAnswer.relationshipIds,
        uncertainty: modelAnswer.uncertainty,
        evidence,
      },
      usedAI: true,
      fallback: false,
    };
  } catch {
    return { answer: deterministicAnswer, usedAI: false, fallback: true };
  } finally {
    clearTimeout(timeout);
  }
}
