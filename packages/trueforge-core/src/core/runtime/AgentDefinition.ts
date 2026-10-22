import type { ExecutionStrategy, InflexSettings, TaskCharter } from '../inflex/policy';
import type { ILLM } from '../llm/ILLM';
import type { LLMUserMessage } from '../llm/LLMTypes';
import type { ModelParams } from '../llm/model';
import type { ResponseFormat } from '../llm/responseFormat';
import type { IToolSet } from '../mcp/IMCPServer';

/**
 * Static definition of an agent. Represents the authored configuration,
 * not the execution state. Inherited by sub-agent definitions.
 */
export interface AgentDefinition {
  inflex?: InflexSettings | undefined;
  inflexCharter?: TaskCharter | undefined;
  inflexStrategy?: ExecutionStrategy | undefined;
  modelClient: ILLM;
  modelName: string;
  modelProperties?:
    | {
        /** Maximum combined input/output context for the resolved model, when known. */
        contextLength: number | undefined;
        reasoningEfforts?: readonly string[] | undefined;
      }
    | undefined;
  instruction?: string | undefined;
  messages?: readonly LLMUserMessage[] | undefined;
  modelParams?: ModelParams | undefined;
  /** Same wire shape as AgentSpec.response_format (Zod ResponseFormat). */
  responseFormat?: ResponseFormat | undefined;
  iterationLimit?: number | undefined;

  toolSets?: readonly IToolSet[] | undefined;
}
