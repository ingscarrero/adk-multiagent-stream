/**
 * The agent graph.
 *
 * Two entrypoints, chosen deliberately to exercise the two multi-agent shapes
 * that stress a streaming feed differently:
 *
 * - **`router`** — an `LlmAgent` with `subAgents`. Control transfers via ADK's
 *   built-in `transfer_to_agent`, so a single thread's events change `author`
 *   mid-stream. The feed must attribute text to the right agent without
 *   starting a new thread.
 *
 * - **`research`** — `SequentialAgent(ParallelAgent(a, b), synthesizer)`. The
 *   two parallel branches emit *interleaved* events on one invocation. This is
 *   the case that breaks naive feeds: without a per-thread sequence number and
 *   a per-message id, two agents streaming at once produce one scrambled
 *   message. See docs/STREAMING-CONTRACT.md.
 *
 * Both are built fresh per call rather than exported as singletons: ADK agents
 * hold a `parentAgent` back-reference, so sharing one instance across two trees
 * corrupts transfer routing.
 *
 * ## A note on the deprecation warning
 *
 * `@google/adk` v2.0.0 logs that `SequentialAgent` and `ParallelAgent` are
 * "deprecated in favor of Workflow". They are kept here on purpose:
 *
 * - The same warning says *"Workflow cannot yet be used as an LlmAgent
 *   sub-agent"*, so the replacement does not yet cover every composition.
 * - These are still the primitives the ADK guides teach, which makes this repo
 *   readable to anyone coming from those docs.
 *
 * The migration is a contained one — `buildResearch` is the only caller — and
 * the feed layer would not change at all, because the adapter consumes ADK
 * `Event`s and `Workflow` emits the same ones (with `nodeInfo` added).
 */

import { LlmAgent, ParallelAgent, SequentialAgent, type BaseAgent, type BaseTool } from '@google/adk';
import type { KnowledgeProvider } from '@feed/providers';
import { createModel, type ModelFactoryOptions } from './model.ts';
import {
  DOCS_RESEARCHER_SCRIPT,
  KB_AGENT_SCRIPT,
  MARKET_RESEARCHER_SCRIPT,
  ORDER_AGENT_SCRIPT,
  ROUTER_SCRIPT,
  SYNTHESIZER_SCRIPT,
} from './scripts.ts';
import {
  checkShippingStatus,
  createSearchKnowledgeBase,
  lookupOrder,
  searchKnowledgeBase,
} from './tools.ts';

/** The agent entrypoints a thread can be started against. */
export const AGENT_IDS = ['router', 'research'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const DEFAULT_AGENT_ID: AgentId = 'router';

/** UI-facing metadata. Keeps agent copy out of the React components. */
export const AGENT_CATALOG: Record<AgentId, { label: string; description: string }> = {
  router: {
    label: 'Support router',
    description: 'Delegates to an order or knowledge-base specialist via agent transfer.',
  },
  research: {
    label: 'Research pipeline',
    description: 'Two researchers run in parallel, then a synthesizer merges their findings.',
  },
};

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value);
}

function buildRouter(options: ModelFactoryOptions, search: BaseTool): BaseAgent {
  const orderAgent = new LlmAgent({
    name: 'order_agent',
    description: 'Answers questions about specific orders, shipping, and delivery tracking.',
    model: createModel('order_agent', ORDER_AGENT_SCRIPT, options),
    instruction:
      'You handle order questions. Look the order up before answering, and check carrier status when the user asks where something is.',
    tools: [lookupOrder, checkShippingStatus],
  });

  const kbAgent = new LlmAgent({
    name: 'kb_agent',
    description: 'Answers policy questions about returns, refunds, and warranty coverage.',
    model: createModel('kb_agent', KB_AGENT_SCRIPT, options),
    instruction:
      'You answer policy questions. Search the knowledge base first and ground your answer in what you find.',
    tools: [search],
  });

  return new LlmAgent({
    name: 'support_router',
    description: 'Front desk. Routes each question to the specialist best suited to answer it.',
    model: createModel('support_router', ROUTER_SCRIPT, options),
    instruction:
      'Classify the user question and transfer it to the best specialist. Answer directly only when no specialist applies.',
    subAgents: [orderAgent, kbAgent],
  });
}

function buildResearch(options: ModelFactoryOptions, search: BaseTool): BaseAgent {
  const marketResearcher = new LlmAgent({
    name: 'market_researcher',
    description: 'Gathers customer-facing signals about delivery and fulfilment.',
    model: createModel('market_researcher', MARKET_RESEARCHER_SCRIPT, options),
    instruction: 'Research what customers care about regarding shipping and delivery.',
    tools: [search],
    // Each parallel branch writes its finding to session state under its own
    // key, which is how the synthesizer reads both without seeing the other
    // branch's raw event stream.
    outputKey: 'market_finding',
  });

  const docsResearcher = new LlmAgent({
    name: 'docs_researcher',
    description: 'Gathers policy and documentation signals.',
    model: createModel('docs_researcher', DOCS_RESEARCHER_SCRIPT, options),
    instruction: 'Research the documented policies relevant to the question.',
    tools: [search],
    outputKey: 'docs_finding',
  });

  const synthesizer = new LlmAgent({
    name: 'synthesizer',
    description: 'Merges the parallel research findings into one recommendation.',
    model: createModel('synthesizer', SYNTHESIZER_SCRIPT, options),
    instruction:
      'Combine the two findings into a single recommendation.\n\nMarket: {market_finding?}\nDocs: {docs_finding?}',
  });

  return new SequentialAgent({
    name: 'research_pipeline',
    description: 'Parallel research followed by synthesis.',
    subAgents: [
      new ParallelAgent({
        name: 'parallel_research',
        description: 'Runs the two researchers concurrently.',
        subAgents: [marketResearcher, docsResearcher],
      }),
      synthesizer,
    ],
  });
}

export interface AgentOptions extends ModelFactoryOptions {
  /**
   * Retrieval backing `searchKnowledgeBase`.
   *
   * Defaults to the emulated keyword provider, so callers that do not care
   * (tests, evals) need not thread one through.
   */
  knowledge?: KnowledgeProvider;
}

/** Builds a fresh agent tree for the given entrypoint. */
export function createAgent(id: AgentId, options: AgentOptions = {}): BaseAgent {
  const search = options.knowledge
    ? createSearchKnowledgeBase(options.knowledge)
    : searchKnowledgeBase;

  switch (id) {
    case 'router':
      return buildRouter(options, search);
    case 'research':
      return buildResearch(options, search);
  }
}
