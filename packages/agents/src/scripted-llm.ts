/**
 * A deterministic `BaseLlm` implementation.
 *
 * ## Why this exists
 *
 * A streaming UI is mostly *timing*, and timing tests against a real model are
 * flaky by construction: token counts vary, latency varies, the model may or
 * may not call a tool. Every test in this repo — unit, integration, Playwright,
 * eval regression — runs against this class instead. The result is a suite that
 * needs no API key, no network, and produces byte-identical output every run.
 *
 * The real Gemini path (`model.ts`) is still wired up and still exercised
 * manually; it is simply never on the critical path of CI.
 *
 * ## How a script advances
 *
 * ADK calls `generateContentAsync` once per model turn. Between turns it runs
 * whichever tools the previous turn requested and appends their responses to
 * `llmRequest.contents`. So the turn index is recoverable from the request
 * itself: count the `Content` entries carrying at least one `functionResponse`.
 * That keeps this class stateless, which matters because a single instance is
 * shared across every concurrent thread.
 */

import { BaseLlm, type BaseLlmConnection } from '@google/adk';
import type { LlmRequest, LlmResponse } from '@google/adk';
import type { Content } from '@google/genai';

/** One model turn in a script. */
export type ScriptedTurn =
  /** Stream a block of text, then finish the turn. */
  | { kind: 'text'; text: string }
  /** Request one or more tool calls. ADK runs them and calls the model again. */
  | { kind: 'toolCall'; calls: Array<{ name: string; args: Record<string, unknown> }> }
  /** Hand off to a sub-agent via ADK's built-in `transfer_to_agent`. */
  | { kind: 'transfer'; agentName: string }
  /** Fail the turn, so error handling has something to handle. */
  | { kind: 'error'; message: string };

/**
 * A script, plus the prompts it applies to.
 *
 * `match` is tried in array order; the first hit wins. A branch with
 * `match: 'default'` acts as the catch-all and should be last.
 */
export interface ScriptBranch {
  match: RegExp | 'default';
  turns: ScriptedTurn[];
}

export interface ScriptedLlmOptions {
  /** Reported as `model` on responses. Purely cosmetic. */
  model?: string;
  /** Ordered branches. The first whose `match` tests true against the prompt is used. */
  branches: ScriptBranch[];
  /**
   * Delay between streamed chunks, in ms.
   *
   * Non-zero in the running app and in Playwright (so streaming is *visible*
   * and the UI's intermediate states are real), zero in unit tests (so they are
   * fast). Overridable per-process with `SCRIPTED_CHUNK_DELAY_MS`.
   */
  chunkDelayMs?: number;
  /** Words per streamed chunk. Mirrors how a real model batches tokens. */
  wordsPerChunk?: number;
}

const sleep = (ms: number) =>
  ms <= 0 ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * ADK's marker for a rewritten peer-agent turn.
 *
 * When control transfers, ADK does not hand the new agent the raw event log.
 * It rewrites the previous agent's tool calls and results into synthetic *user*
 * messages prefixed with this string (see ADK's `content_processor_utils`).
 * Those frames must be skipped when choosing a branch, or every agent
 * downstream of a transfer selects on the text "For context: ... Transfer
 * queued" rather than on what the human actually asked.
 */
const ADK_CONTEXT_PREFIX = 'For context:';

/** The text of the most recent genuine user message, which selects the branch. */
function latestUserText(contents: readonly Content[]): string {
  for (let i = contents.length - 1; i >= 0; i -= 1) {
    const content = contents[i];
    if (content?.role !== 'user') continue;

    const parts = content.parts ?? [];
    // Skip ADK's synthetic cross-agent context frames.
    if ((parts[0]?.text ?? '').startsWith(ADK_CONTEXT_PREFIX)) continue;

    const text = parts
      .map((part) => part.text ?? '')
      .join('')
      .trim();
    // Skip synthetic user turns that only carry function responses.
    if (text) return text;
  }
  return '';
}

/** The tool names a branch can produce — the only responses that advance it. */
function toolNamesIn(branch: ScriptBranch): Set<string> {
  const names = new Set<string>();
  for (const turn of branch.turns) {
    if (turn.kind === 'toolCall') for (const call of turn.calls) names.add(call.name);
    if (turn.kind === 'transfer') names.add('transfer_to_agent');
  }
  return names;
}

/**
 * How many tool round-trips have already happened, which is the turn index.
 *
 * Two subtleties, both learned from real ADK behaviour rather than guessed:
 *
 * 1. Counts *Content entries* rather than individual responses, so a turn that
 *    requested three parallel tool calls still advances the script by one.
 * 2. Only counts responses for tools *this branch* can call. When the router
 *    transfers, the receiving agent inherits the whole conversation — including
 *    the `transfer_to_agent` response. Counting that would start the specialist
 *    at turn 1 and silently skip its first tool call.
 */
function completedToolRounds(contents: readonly Content[], ownToolNames: Set<string>): number {
  return contents.filter((content) =>
    (content.parts ?? []).some(
      (part) => part.functionResponse && ownToolNames.has(part.functionResponse.name ?? ''),
    ),
  ).length;
}

/** Splits text into chunk-sized groups of words, keeping the whitespace intact. */
function chunkText(text: string, wordsPerChunk: number): string[] {
  const tokens = text.match(/\S+\s*/g) ?? [];
  const chunks: string[] = [];
  for (let i = 0; i < tokens.length; i += wordsPerChunk) {
    chunks.push(tokens.slice(i, i + wordsPerChunk).join(''));
  }
  return chunks.length > 0 ? chunks : [text];
}

export class ScriptedLlm extends BaseLlm {
  private readonly branches: ScriptBranch[];
  private readonly chunkDelayMs: number;
  private readonly wordsPerChunk: number;
  /** Derived from the model name; namespaces function-call ids per agent. */
  private readonly callIdPrefix: string;

  /** Registered so ADK's registry can resolve `scripted/*` model ids if asked. */
  static override readonly supportedModels: Array<string | RegExp> = [/^scripted\/.*$/];

  constructor(options: ScriptedLlmOptions) {
    super({ model: options.model ?? 'scripted/deterministic' });
    this.branches = options.branches;
    this.chunkDelayMs =
      options.chunkDelayMs ?? Number(process.env['SCRIPTED_CHUNK_DELAY_MS'] ?? 25);
    this.wordsPerChunk = options.wordsPerChunk ?? 3;
    // `this.model` is the resolved name, including BaseLlm's default.
    this.callIdPrefix = this.model.replace(/[^a-zA-Z0-9]+/g, '_');
  }

  /** Resolves the branch for a prompt. Exposed so tests can assert routing directly. */
  selectBranch(prompt: string): ScriptBranch | undefined {
    return this.branches.find(
      (branch) => branch.match === 'default' || branch.match.test(prompt),
    );
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const prompt = latestUserText(llmRequest.contents);
    const branch = this.selectBranch(prompt);
    const turnIndex = branch ? completedToolRounds(llmRequest.contents, toolNamesIn(branch)) : 0;
    const turn = branch?.turns[turnIndex];

    if (!turn) {
      // Running off the end of a script means the agent looped further than the
      // author expected. Say so loudly rather than emitting empty text.
      yield {
        content: {
          role: 'model',
          parts: [
            {
              text: branch
                ? `[scripted] script exhausted at turn ${turnIndex} for prompt: ${prompt}`
                : `[scripted] no branch matched prompt: ${prompt}`,
            },
          ],
        },
        turnComplete: true,
      };
      return;
    }

    switch (turn.kind) {
      case 'error':
        yield { errorCode: 'SCRIPTED_ERROR', errorMessage: turn.message, turnComplete: true };
        return;

      case 'toolCall':
        yield {
          content: {
            role: 'model',
            parts: turn.calls.map((call, index) => ({
              functionCall: {
                // The model name is part of the id, not decoration. Two agents
                // in a `ParallelAgent` run the same script position at the same
                // time; without the agent in the id they mint identical call
                // ids, and anything correlating results to calls by id merges
                // two distinct tool calls into one.
                id: `${this.callIdPrefix}-${turnIndex}-${index}-${call.name}`,
                name: call.name,
                args: call.args,
              },
            })),
          },
          turnComplete: true,
        };
        return;

      case 'transfer':
        yield {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: `${this.callIdPrefix}-transfer-${turnIndex}`,
                  name: 'transfer_to_agent',
                  // adk-js names this argument `agentName`; adk-python uses
                  // `agent_name`. Getting it wrong fails silently as a no-op
                  // transfer, so it is asserted in scripted-llm.test.ts.
                  args: { agentName: turn.agentName },
                },
              },
            ],
          },
          turnComplete: true,
        };
        return;

      case 'text': {
        if (!stream) {
          yield {
            content: { role: 'model', parts: [{ text: turn.text }] },
            turnComplete: true,
          };
          return;
        }

        // Mirror GoogleLlm's streaming shape: N partial responses carrying only
        // the new chunk, then one final non-partial response carrying the whole
        // text. ADK forwards partials to the caller and persists only the final
        // one, which is exactly the behaviour the feed adapter is written against.
        let accumulated = '';
        for (const chunk of chunkText(turn.text, this.wordsPerChunk)) {
          if (abortSignal?.aborted) return;
          await sleep(this.chunkDelayMs);
          if (abortSignal?.aborted) return;
          accumulated += chunk;
          yield {
            content: { role: 'model', parts: [{ text: chunk }] },
            partial: true,
          };
        }
        yield {
          content: { role: 'model', parts: [{ text: accumulated }] },
          turnComplete: true,
        };
        return;
      }
    }
  }

  override connect(): Promise<BaseLlmConnection> {
    // Live/bidi is out of scope: ADK's StreamingMode.BIDI throws today anyway.
    return Promise.reject(new Error('ScriptedLlm does not support live connections.'));
  }
}
