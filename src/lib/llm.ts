import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
});

export interface LLMResponse {
  reasoning: string;
  classification?: string;
  confidence?: number;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * LLM Service for semantic analysis
 */
export class LLMService {
  /**
   * Analyze prompt intent and classify
   */
  static async classifyPromptIntent(promptText: string, context?: string): Promise<LLMResponse> {
    try {
      const systemPrompt = `You are an expert code assessment monitor. Analyze candidate prompts to classify their intent:
- CONCEPTUAL: Asking "how", "what", "explain" - learning oriented
- DEBUGGING: Asking for help with errors, bugs, fixing code
- SOLUTION_REQUEST: Asking for complete code, entire solution, "do it for me"
- CLARIFICATION: Asking for clarification on requirements
- ACCEPTABLE: Standard questions that show thinking

Respond in JSON format:
{
  "classification": "one of the above",
  "confidence": 0-100,
  "reasoning": "brief explanation"
}`;

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Prompt: "${promptText}"\n${context ? `Context: ${context}` : ''}` }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      });

      const result = JSON.parse(response.choices[0].message.content || '{}');
      return {
        reasoning: result.reasoning || '',
        classification: result.classification,
        confidence: result.confidence,
      };
    } catch (error: any) {
      console.error('LLM classification error:', error.message);
      return {
        reasoning: 'Classification failed: ' + error.message,
        classification: 'UNKNOWN',
        confidence: 0,
      };
    }
  }

  /**
   * Analyze code similarity between two snippets
   */
  static async analyzeCodeSimilarity(
    originalCode: string,
    candidateCode: string
  ): Promise<LLMResponse> {
    try {
      const systemPrompt = `You are an expert code analyzer. Compare two code snippets and determine if the candidate copied the original without understanding:
- Analyze structural similarity
- Check if variable names, logic, and structure are identical
- Determine if modifications show understanding or just renaming
- Consider code quality and stylistic differences

Respond in JSON:
{
  "similarity": 0-100,
  "riskLevel": "low/medium/high",
  "reasoning": "explanation",
  "flags": ["list of concerns if any"]
}`;

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Original Code:\n\`\`\`\n${originalCode}\n\`\`\`\n\nCandidate Code:\n\`\`\`\n${candidateCode}\n\`\`\``
          }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      });

      const result = JSON.parse(response.choices[0].message.content || '{}');
      return {
        reasoning: result.reasoning || '',
        confidence: result.similarity,
        riskLevel: result.riskLevel,
      };
    } catch (error: any) {
      console.error('LLM similarity error:', error.message);
      return {
        reasoning: 'Similarity analysis failed: ' + error.message,
        confidence: 0,
      };
    }
  }

  /**
   * Risk assessment based on behavior patterns
   */
  static async assessBehaviorRisk(
    promptCount: number,
    copyEvents: number,
    modifications: number,
    solutionRequests: number,
    sessionDuration: number
  ): Promise<LLMResponse> {
    try {
      const systemPrompt = `You are an expert behavioral analyst. Assess coding assessment behavior patterns:
- Consider AI dependency levels
- Evaluate independence vs reliance
- Factor in code modification rates
- Assess time efficiency

Respond in JSON:
{
  "riskLevel": "low/medium/high/critical",
  "confidence": 0-100,
  "reasoning": "detailed analysis",
  "recommendation": "brief action recommendation"
}`;

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: systemPrompt,
          },
          {
            role: 'user',
            content: `
Metrics:
- Total AI prompts: ${promptCount}
- Code copy events: ${copyEvents}
- Modifications made: ${modifications}
- Solution requests: ${solutionRequests}
- Session duration: ${sessionDuration} minutes

Assess overall risk level.`
          }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      });

      const result = JSON.parse(response.choices[0].message.content || '{}');
      return {
        reasoning: result.reasoning || '',
        confidence: result.confidence,
        riskLevel: result.riskLevel,
      };
    } catch (error: any) {
      console.error('LLM risk assessment error:', error.message);
      return {
        reasoning: 'Risk assessment failed: ' + error.message,
        confidence: 0,
      };
    }
  }

  /**
   * Quick check if the server is configured
   */
  static isConfigured(): boolean {
    return !!process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== '';
  }
}


