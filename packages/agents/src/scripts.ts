/**
 * Scripts for the deterministic model, one table per agent.
 *
 * Read these as "what the model would do if it behaved". They are the fixture
 * that the eval expectations in `packages/eval/evalsets` are written against —
 * change a script and the eval will tell you.
 *
 * Prompt→branch matching is regex-based and first-match-wins, so the ordering
 * inside each array is significant; `default` is always last.
 */

import type { ScriptBranch } from './scripted-llm.ts';

/**
 * The router. Its only job is to classify and hand off, so every branch is
 * either a `transfer` or a direct answer for things needing no tools.
 */
export const ROUTER_SCRIPT: ScriptBranch[] = [
  // Before the generic order branch: a *follow-up* has to reach the same
  // specialist as the turn it follows, and "when will it arrive" shares no
  // vocabulary with the opening question.
  { match: /\bwhen will it arrive\b|\beta\b/i, turns: [{ kind: 'transfer', agentName: 'order_agent' }] },
  // Before the policy branch, which also matches "refund": asking *about* the
  // refund policy is a question for the knowledge base, while asking *for* a
  // refund on a named order is an action, and only actions need approving.
  { match: /\brefund\b[\s\S]*\bA-\d{4}\b/i, turns: [{ kind: 'transfer', agentName: 'order_agent' }] },
  { match: /\b(order|shipping|shipped|delivery|track)\b/i, turns: [{ kind: 'transfer', agentName: 'order_agent' }] },
  { match: /\b(return|refund|warranty|policy)\b/i, turns: [{ kind: 'transfer', agentName: 'kb_agent' }] },
  { match: /\bfail\b/i, turns: [{ kind: 'error', message: 'Simulated upstream model failure.' }] },
  {
    match: 'default',
    turns: [
      {
        kind: 'text',
        text: 'I can help with orders, shipping, returns, and warranty questions. Which one do you need?',
      },
    ],
  },
];

/** Order specialist: looks the order up, then optionally checks the carrier. */
export const ORDER_AGENT_SCRIPT: ScriptBranch[] = [
  /**
   * The follow-up branch, and the reason it uses no tools.
   *
   * `completedToolRounds` counts tool responses across the *whole* session, not
   * just the current turn. A follow-up branch that shared a tool name with the
   * turn before it would therefore start at turn 1 and silently skip its own
   * first step -- the same hazard the transfer comment in `scripted-llm.ts`
   * describes. A tool-free branch has an empty own-tool set, so it always
   * starts at turn 0 however much history precedes it.
   *
   * It is also the honest scripting of the behaviour: answering "when will it
   * arrive" from what the previous turn already established is exactly what
   * conversation history is for.
   */
  {
    match: /\bwhen will it arrive\b|\beta\b/i,
    turns: [
      {
        kind: 'text',
        text: 'Order A-1001 is still on track for 2 September 2026. It cleared the regional hub and is with the local carrier for final delivery.',
      },
    ],
  },
  /**
   * The refund branch: one gated tool call, then an answer.
   *
   * $129.99 is over `REFUND_APPROVAL_THRESHOLD`, so `requireConfirmation`
   * returns true and ADK pauses instead of running the tool. Turn 1 is only
   * reached once someone approves and the tool actually returns.
   */
  {
    match: /\brefund\b/i,
    turns: [
      {
        kind: 'toolCall',
        calls: [
          {
            name: 'requestRefund',
            args: { orderId: 'A-1001', amount: 129.99, reason: 'Arrived damaged' },
          },
        ],
      },
      {
        kind: 'text',
        text: 'Refund of $129.99 approved and applied to order A-1001. Your confirmation number is RF-A-1001, and the amount should appear within five business days.',
        // Reached when the approval is denied: ADK returns the call refused
        // instead of running it, and an answer that claimed otherwise would be
        // the demo contradicting the feature.
        rejectedText:
          'No problem, I have not applied the refund on order A-1001. Let me know if you would like to review the order first or take a different action.',
      },
    ],
  },
  {
    match: /\b(track|shipping|shipped|delivery|where)\b/i,
    turns: [
      { kind: 'toolCall', calls: [{ name: 'lookupOrder', args: { orderId: 'A-1001' } }] },
      { kind: 'toolCall', calls: [{ name: 'checkShippingStatus', args: { orderId: 'A-1001' } }] },
      {
        kind: 'text',
        text: 'Order A-1001 (Mechanical keyboard) has shipped and departed the regional hub. Estimated delivery is 2 September 2026.',
      },
    ],
  },
  {
    match: 'default',
    turns: [
      { kind: 'toolCall', calls: [{ name: 'lookupOrder', args: { orderId: 'A-1002' } }] },
      {
        kind: 'text',
        text: 'Order A-1002 is still processing. It contains a USB-C hub and a cable, with an estimated delivery of 5 September 2026.',
      },
    ],
  },
];

/** Knowledge-base specialist: one search, then an answer grounded in the result. */
export const KB_AGENT_SCRIPT: ScriptBranch[] = [
  {
    match: /\bwarranty\b/i,
    turns: [
      { kind: 'toolCall', calls: [{ name: 'searchKnowledgeBase', args: { query: 'warranty', limit: 2 } }] },
      {
        kind: 'text',
        text: 'Hardware is covered by a two year limited warranty for manufacturing defects. Accidental damage is not included.',
      },
    ],
  },
  {
    match: 'default',
    turns: [
      { kind: 'toolCall', calls: [{ name: 'searchKnowledgeBase', args: { query: 'return refund policy', limit: 2 } }] },
      {
        kind: 'text',
        text: 'Unopened items can be returned within 30 days for a full refund. Opened items are subject to a 15 percent restocking fee.',
      },
    ],
  },
];

/**
 * The research pipeline's three agents.
 *
 * `market_researcher` and `docs_researcher` run inside a `ParallelAgent`, so
 * their events interleave on the wire — which is precisely the case the feed's
 * ordering guarantee has to survive. Their scripts are deliberately different
 * lengths so the interleaving is uneven.
 */
export const MARKET_RESEARCHER_SCRIPT: ScriptBranch[] = [
  {
    match: 'default',
    turns: [
      { kind: 'toolCall', calls: [{ name: 'searchKnowledgeBase', args: { query: 'shipping delivery', limit: 3 } }] },
      {
        kind: 'text',
        text: 'Market signal: customers weigh delivery speed heavily. Standard shipping runs three to five business days, with next business day available on express orders placed before 2pm.',
      },
    ],
  },
];

export const DOCS_RESEARCHER_SCRIPT: ScriptBranch[] = [
  {
    match: 'default',
    turns: [
      { kind: 'toolCall', calls: [{ name: 'searchKnowledgeBase', args: { query: 'warranty return', limit: 3 } }] },
      {
        kind: 'text',
        text: 'Documentation signal: the two year hardware warranty covers defects only, and the 30 day return window is the most cited policy article.',
      },
    ],
  },
];

export const SYNTHESIZER_SCRIPT: ScriptBranch[] = [
  {
    match: 'default',
    turns: [
      {
        kind: 'text',
        text: 'Synthesis: delivery speed and policy clarity are the two levers. Lead with express shipping availability, then reassure on the 30 day return window and the two year warranty.',
      },
    ],
  },
];
