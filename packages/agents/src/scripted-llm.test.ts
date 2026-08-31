/**
 * Tests for the deterministic model itself.
 *
 * These are about the *contract with ADK*, not about our agents: turn
 * advancement, the streaming partial/final shape, and the exact spelling of
 * the transfer call. Each of those is a silent-failure mode if it drifts.
 */
import { describe, expect, it } from 'vitest';
import type { LlmRequest, LlmResponse } from '@google/adk';
import { ScriptedLlm, type ScriptBranch } from './scripted-llm.ts';

/** Minimal LlmRequest — only `contents` is read by ScriptedLlm. */
function request(contents: LlmRequest['contents']): LlmRequest {
  return { contents, liveConnectConfig: {}, toolsDict: {} };
}

const userTurn = (text: string) => ({ role: 'user', parts: [{ text }] });
const toolResponse = (name: string) => ({
  role: 'user',
  parts: [{ functionResponse: { name, response: { ok: true } } }],
});

async function collect(gen: AsyncGenerator<LlmResponse, void>): Promise<LlmResponse[]> {
  const out: LlmResponse[] = [];
  for await (const response of gen) out.push(response);
  return out;
}

const branches: ScriptBranch[] = [
  {
    match: /order/i,
    turns: [
      { kind: 'toolCall', calls: [{ name: 'lookupOrder', args: { orderId: 'A-1' } }] },
      { kind: 'text', text: 'Your order is on its way' },
    ],
  },
  { match: /handoff/i, turns: [{ kind: 'transfer', agentName: 'kb_agent' }] },
  { match: /explode/i, turns: [{ kind: 'error', message: 'kaboom' }] },
  { match: 'default', turns: [{ kind: 'text', text: 'Hello there' }] },
];

const model = () => new ScriptedLlm({ branches, chunkDelayMs: 0, wordsPerChunk: 2 });

describe('branch selection', () => {
  it('matches in declaration order and falls back to default', () => {
    expect(model().selectBranch('where is my order')?.match).toEqual(/order/i);
    expect(model().selectBranch('anything else')?.match).toBe('default');
  });
});

describe('turn advancement', () => {
  it('starts at turn 0 with no tool responses in the request', async () => {
    const responses = await collect(model().generateContentAsync(request([userTurn('my order')])));
    expect(responses[0]?.content?.parts?.[0]?.functionCall?.name).toBe('lookupOrder');
  });

  it('advances one turn per Content carrying a function response', async () => {
    const responses = await collect(
      model().generateContentAsync(
        request([userTurn('my order'), toolResponse('lookupOrder')]),
        false,
      ),
    );
    expect(responses[0]?.content?.parts?.[0]?.text).toBe('Your order is on its way');
  });

  it('counts one round per Content, so parallel calls advance the script once', async () => {
    // Two responses in a single Content = one round = one script step.
    const parallelRound = {
      role: 'user',
      parts: [
        { functionResponse: { name: 'lookupOrder', response: {} } },
        { functionResponse: { name: 'lookupOrder', response: {} } },
      ],
    };
    const responses = await collect(
      model().generateContentAsync(request([userTurn('my order'), parallelRound]), false),
    );
    expect(responses[0]?.content?.parts?.[0]?.text).toBe('Your order is on its way');
  });

  it('reports script exhaustion instead of emitting silence', async () => {
    const responses = await collect(
      model().generateContentAsync(
        request([userTurn('my order'), toolResponse('lookupOrder'), toolResponse('lookupOrder')]),
        false,
      ),
    );
    expect(responses[0]?.content?.parts?.[0]?.text).toContain('script exhausted');
  });
});

describe('streaming shape', () => {
  it('emits partial chunks then one final non-partial response with the full text', async () => {
    // One word per chunk so "Hello there" produces more than one partial.
    const wordAtATime = new ScriptedLlm({ branches, chunkDelayMs: 0, wordsPerChunk: 1 });
    const responses = await collect(wordAtATime.generateContentAsync(request([userTurn('hi')]), true));

    const partials = responses.filter((r) => r.partial);
    const final = responses.at(-1);

    expect(partials.length).toBeGreaterThan(1);
    expect(final?.partial).toBeUndefined();
    expect(final?.turnComplete).toBe(true);
    // The concatenated partials must equal the final text, or the client's
    // accumulate-then-replace strategy would visibly flicker.
    expect(partials.map((r) => r.content?.parts?.[0]?.text).join('')).toBe('Hello there');
    expect(final?.content?.parts?.[0]?.text).toBe('Hello there');
  });

  it('emits a single full response when streaming is off', async () => {
    const responses = await collect(model().generateContentAsync(request([userTurn('hi')]), false));
    expect(responses).toHaveLength(1);
    expect(responses[0]?.content?.parts?.[0]?.text).toBe('Hello there');
  });

  it('stops mid-stream when the abort signal fires', async () => {
    const controller = new AbortController();
    const slow = new ScriptedLlm({ branches, chunkDelayMs: 5, wordsPerChunk: 1 });
    const gen = slow.generateContentAsync(request([userTurn('hi')]), true, controller.signal);

    const first = await gen.next();
    expect(first.done).toBe(false);
    controller.abort();

    const rest = await collect(gen);
    expect(rest).toHaveLength(0);
  });
});

describe('framework call shapes', () => {
  it('spells the transfer argument `agentName`, as adk-js expects', async () => {
    // adk-python uses `agent_name`; getting this wrong makes transfer a silent
    // no-op rather than an error. See agent_transfer_llm_request_processor.
    const responses = await collect(
      model().generateContentAsync(request([userTurn('handoff please')])),
    );
    const call = responses[0]?.content?.parts?.[0]?.functionCall;
    expect(call?.name).toBe('transfer_to_agent');
    expect(call?.args).toEqual({ agentName: 'kb_agent' });
  });

  it('gives every function call a stable id for call/result correlation', async () => {
    const responses = await collect(model().generateContentAsync(request([userTurn('my order')])));
    expect(responses[0]?.content?.parts?.[0]?.functionCall?.id).toBe(
      'scripted_deterministic-0-0-lookupOrder',
    );
  });

  it('namespaces call ids by model, so parallel agents do not collide', async () => {
    // Regression: two agents inside a `ParallelAgent` reach the same script
    // position simultaneously. With ids like `call-0-0-searchKnowledgeBase`,
    // both emitted the same id and the UI merged two tool calls into one.
    const a = new ScriptedLlm({ model: 'scripted/market', branches, chunkDelayMs: 0 });
    const b = new ScriptedLlm({ model: 'scripted/docs', branches, chunkDelayMs: 0 });

    const [ra] = await collect(a.generateContentAsync(request([userTurn('my order')])));
    const [rb] = await collect(b.generateContentAsync(request([userTurn('my order')])));

    expect(ra?.content?.parts?.[0]?.functionCall?.id).not.toBe(
      rb?.content?.parts?.[0]?.functionCall?.id,
    );
  });

  it('surfaces scripted errors as an errorCode response', async () => {
    const responses = await collect(model().generateContentAsync(request([userTurn('explode')])));
    expect(responses[0]?.errorCode).toBe('SCRIPTED_ERROR');
    expect(responses[0]?.errorMessage).toBe('kaboom');
  });
});

describe('turn counting ignores foreign tool responses', () => {
  it('does not let an inherited transfer response skip the first script turn', async () => {
    // Regression: after `transfer_to_agent`, the receiving agent inherits the
    // transfer's own function response in `contents`. Counting it started the
    // specialist at turn 1, silently skipping its first tool call.
    const inherited = {
      role: 'user',
      parts: [{ functionResponse: { name: 'transfer_to_agent', response: { result: 'Transfer queued' } } }],
    };
    const responses = await collect(
      model().generateContentAsync(request([userTurn('my order'), inherited]), false),
    );
    expect(responses[0]?.content?.parts?.[0]?.functionCall?.name).toBe('lookupOrder');
  });
});

describe('ADK cross-agent context frames', () => {
  it('selects the branch from the real user prompt, not ADK\'s rewritten frames', async () => {
    // Regression: on transfer, ADK rewrites the previous agent's tool call and
    // result into synthetic *user* messages prefixed "For context:". Reading
    // the latest user text naively picked those up, so every agent downstream
    // of a transfer matched on "Transfer queued" and fell to its default branch.
    const contextFrames = [
      userTurn('my order please'),
      {
        role: 'user',
        parts: [
          { text: 'For context:' },
          { text: '[support_router] called tool `transfer_to_agent` with parameters: {"agentName":"order_agent"}' },
        ],
      },
      {
        role: 'user',
        parts: [
          { text: 'For context:' },
          { text: '[support_router] tool `transfer_to_agent` returned result: {"result":"Transfer queued"}' },
        ],
      },
    ];
    const responses = await collect(model().generateContentAsync(request(contextFrames), false));
    expect(responses[0]?.content?.parts?.[0]?.functionCall?.name).toBe('lookupOrder');
  });
});

