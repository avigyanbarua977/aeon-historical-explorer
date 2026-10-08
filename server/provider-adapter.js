import { generateGroundedExplanation as generateOpenAIExplanation } from './providers/openai.js';

// This is the single provider boundary. Provider-specific formats stay behind this function.
export function generateGroundedExplanation(input, options) {
  return generateOpenAIExplanation(input, options);
}
