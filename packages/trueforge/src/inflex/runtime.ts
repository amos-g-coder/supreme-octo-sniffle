import type {
  AgentCapability,
  AgentInfo,
  InflexSettings,
  InstructionBuilder,
  ToolApprovalPolicyAction,
} from '@truefoundry/trueforge-core/core';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { inflexConfiguration } from '../config';
import type { AvailableModel } from '../schemas/modelProvider';
import { ChatGPTLLM } from './gateway';
import { ManagedMemory } from './managed-memory';
import { sessionConnections } from './mcp-pool';
import { HindsightMemory, projectMemoryBank } from './memory';
import { ChatGPTOAuth, KeychainStore } from './oauth';
import { runProcess } from './process';
import { localConnections } from './stdio';
import { nativeToolSet, NativeToolSource } from './tools';
import { WorktreeManager } from './workspace';

export const chatgptAuth = new ChatGPTOAuth({
  store: new KeychainStore(inflexConfiguration.keychain_helper),
  data_dir: inflexConfiguration.data_dir,
  fetch,
});
export const managedMemory = new ManagedMemory(chatgptAuth, async () => {
  const models = await chatgptModels();
  const model = models.find(candidate => candidate.model_id.includes('mini')) ?? models[0];
  if (!model) {
    throw new Error('Sign in before enabling managed memory');
  }
  return model.model_id;
});
export const inflexMemory = new HindsightMemory({
  url: inflexConfiguration.hindsight_url,
  directory: path.join(inflexConfiguration.data_dir, 'memory-outbox'),
  fetch,
  ...(inflexConfiguration.hindsight_managed ? { start: () => managedMemory.start() } : {}),
});
const CatalogSchema = z.object({
  models: z.array(
    z.object({
      slug: z.string(),
      visibility: z.string().optional(),
      supported_reasoning_levels: z.array(z.object({ effort: z.string() })).optional(),
      context_window: z.number().optional(),
    }),
  ),
});
let catalog: { expires: number; fingerprint: string; models: AvailableModel[] } | undefined;
export async function chatgptModels(): Promise<AvailableModel[]> {
  if (
    process.platform !== 'darwin' ||
    !(await chatgptAuth.status().catch(() => ({ authenticated: false, login_pending: false }))).authenticated
  ) {
    return [];
  }
  const token = await chatgptAuth.accessToken();
  const fingerprint = createHash('sha256').update(token).digest('hex');
  if (catalog && catalog.expires > Date.now() && catalog.fingerprint === fingerprint) {
    return catalog.models;
  }
  const response = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${await chatgptAuth.accessToken()}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Cannot load ChatGPT model catalog (${String(response.status)})`);
  }
  const modelCatalog = CatalogSchema.parse(await response.json());
  const efforts = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  const models: AvailableModel[] = modelCatalog.models
    .filter(model => model.visibility !== 'hidden')
    .map(model => {
      const reasoning = model.supported_reasoning_levels?.flatMap(level => {
        const parsed = efforts.safeParse(level.effort);
        return parsed.success ? [parsed.data] : [];
      });
      return {
        name: `chatgpt/${model.slug}`,
        model_id: model.slug,
        provider: { name: 'chatgpt' },
        properties: {
          ...(model.context_window ? { context_length: model.context_window } : {}),
          ...(reasoning?.length ? { reasoning_efforts: reasoning } : {}),
        },
      };
    });
  catalog = { fingerprint, expires: Date.now() + 300_000, models };
  return models;
}
export async function getEntitledChatGPTModel(name: string): Promise<AvailableModel> {
  const model = (await chatgptModels()).find(candidate => candidate.name === name);
  if (!model) {
    throw new Error('This model is not offered by the authenticated ChatGPT catalog');
  }
  return model;
}
export async function resolveChatGPTModel(input: { name: string; signal: AbortSignal }) {
  const model = await getEntitledChatGPTModel(input.name);
  return {
    modelClient: new ChatGPTLLM({ auth: chatgptAuth, model: model.model_id, fetch, signal: input.signal }),
    defaultModelParams: {},
    modelProperties: {
      contextLength: model.properties.context_length,
      reasoningEfforts: model.properties.reasoning_efforts,
    },
  };
}
export function createInflexDefinitions(input: { session_id: string }) {
  const connectionGroups = new Map<string, ReturnType<typeof sessionConnections>>();
  let connections: ReturnType<typeof localConnections> | undefined;
  const managers = new Map<string, WorktreeManager>();
  const resolve = async (definition: {
    settings: InflexSettings;
    thread_id: string;
    agent_info: AgentInfo | undefined;
    signal: AbortSignal;
    approval_policies: (source_id: string) => Record<string, ToolApprovalPolicyAction> | undefined;
  }) => {
    const configured = await realpath(inflexConfiguration.workspace);
    const requested = await realpath(definition.settings.workspace ?? configured);
    if (requested !== configured && !requested.startsWith(configured + path.sep)) {
      throw new Error('Workspace is outside the user-configured Inflex root');
    }
    let root = requested;
    const charter = definition.agent_info?.charter;
    if (definition.agent_info && !charter) {
      throw new Error('Inflex subagents require an explicit task charter');
    }
    let manager = managers.get(requested);
    if (!manager) {
      const scope = createHash('sha256')
        .update(JSON.stringify([input.session_id, requested]))
        .digest('hex')
        .slice(0, 24);
      manager = new WorktreeManager({
        root: requested,
        storage: path.join(inflexConfiguration.data_dir, 'worktrees', scope),
      });
      managers.set(requested, manager);
    }
    await manager.restore();
    if (charter && !charter.read_only) {
      const id = createHash('sha256')
        .update(JSON.stringify({ session: input.session_id, thread: definition.thread_id }))
        .digest('hex');
      manager.assign({ id, owned_paths: charter.owned_paths });
      const git = await runProcess({
        command: 'git',
        args: ['rev-parse', '--verify', 'HEAD'],
        cwd: requested,
        signal: definition.signal,
      });
      if (git.exit_code === 0) {
        root = await manager.create({ id, owned_paths: charter.owned_paths, signal: definition.signal });
      }
    }
    const servers = (await (connections ??= localConnections())).filter(
      server => !definition.agent_info || server.delegation === 'agent',
    );
    let group = connectionGroups.get(definition.thread_id);
    if (servers.length && !group) {
      group = sessionConnections({
        session_id: `${input.session_id}:${definition.thread_id}:${createHash('sha256').update(JSON.stringify(servers)).digest('hex').slice(0, 12)}`,
        workspace: root,
        signal: definition.signal,
      });
      connectionGroups.set(definition.thread_id, group);
    }
    const external = servers.map(server => {
      if (!group) {
        throw new Error('MCP connection group was not acquired');
      }
      const source = group.pool.source(server);
      return nativeToolSet(source, definition.approval_policies(source.id));
    });
    const projectBank = projectMemoryBank(requested);
    let recalled = '';
    let loaded = false;
    const memoryCapability: AgentCapability = {
      preLLMProcessors: [
        {
          processPreLLM: async function* (execution) {
            if (loaded || definition.agent_info || !inflexMemory.enabled) {
              return;
            }
            loaded = true;
            const task = execution.context.findLast(message => 'role' in message && message.role === 'user');
            try {
              await inflexMemory.flush(definition.signal);
              const query =
                task && 'content' in task ? JSON.stringify(task.content).slice(0, 2000) : 'Relevant project context';
              recalled = JSON.stringify(
                await Promise.all(
                  [inflexConfiguration.hindsight_bank, projectBank].map(bank =>
                    inflexMemory.recall({ bank, query, signal: definition.signal }),
                  ),
                ),
              ).slice(0, 16_000);
            } catch {
              recalled =
                'Long-term memory is currently unavailable; proceed using the current task and local evidence.';
            }
            yield* [];
          },
        },
      ],
      preLLMEphemeralProcessors: [
        {
          processPreLLMEphemeral: messages =>
            recalled
              ? [
                  ...messages,
                  { role: 'user', content: `<recalled_memory untrusted="true">${recalled}</recalled_memory>` },
                ]
              : messages,
        },
      ],
    };
    return {
      extraCapabilities: [
        memoryCapability,
        {
          instructionBuilders: [
            (builder: InstructionBuilder) => {
              builder.addSection(
                'inflex-workspace',
                `Assigned workspace: ${root}. Work only on your charter. Return relative changed paths and verification evidence. The parent uses worktree_list, worktree_diff and worktree_integrate to review actual patches and integrate completed changes. The personal memory bank is ${inflexConfiguration.hindsight_bank}; project memory bank is ${projectBank}. Only the parent curates long-term memory from child summaries. Use memory_retain for concise verified milestones and durable user preferences, never raw transcripts or credentials.`,
              );
            },
          ],
        },
      ],
      toolSets: [
        nativeToolSet(
          new NativeToolSource({
            root,
            artifacts: path.join(inflexConfiguration.data_dir, 'artifacts', input.session_id),
            signal: definition.signal,
            read_only: charter?.read_only ?? false,
            owned_paths: charter?.owned_paths,
            memory: inflexMemory,
            session_id: input.session_id,
            project_bank: projectBank,
            memory_access: definition.agent_info === undefined,
            worktrees: definition.agent_info ? undefined : manager,
          }),
          definition.approval_policies('inflex-native'),
        ),
        ...external,
      ],
    };
  };
  return {
    resolve,
    close: () => {
      for (const group of connectionGroups.values()) {
        group.release();
      }
      connectionGroups.clear();
      return Promise.resolve();
    },
  };
}
