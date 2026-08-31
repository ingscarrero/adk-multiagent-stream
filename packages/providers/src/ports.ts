/**
 * The ports: one interface per capability this app does not implement itself.
 *
 * Each has an emulated adapter so the repo runs with no external services, and
 * a real adapter so the emulation is a choice rather than a limit. What the
 * ports are *for* &mdash; and which parts of this system are genuinely ours
 * versus stood in for &mdash; is documented in docs/PROVIDERS.md.
 *
 * These interfaces are deliberately framework-free: nothing here imports
 * Express, React, or anything from the app. A port that knows about its callers
 * is not a seam, it is a shortcut with an interface drawn around it.
 */

import type { BaseSessionService } from '@google/adk';
import type { EventStream } from './eventstream/port.ts';

/** Conversation state for the agent runtime. ADK's own `BaseSessionService` is the port. */
export interface SessionProvider {
  readonly mode: string;
  /** The service handed to ADK's `Runner`. */
  service(): BaseSessionService;
  /** Releases connections. No-op for in-memory. */
  close(): Promise<void>;
}

/** A document the knowledge tool can ground an answer in. */
export interface KnowledgeArticle {
  id: string;
  title: string;
  body: string;
  tags: string[];
}

/**
 * Retrieval.
 *
 * The emulated adapter is keyword matching over fixtures; a real one is a
 * vector search. The interface is the same either way, which is the point:
 * `searchKnowledgeBase` does not know or care which it is talking to.
 */
export interface KnowledgeProvider {
  readonly mode: string;
  search(query: string, limit: number): Promise<KnowledgeArticle[]>;
  close(): Promise<void>;
}

/** Who a request belongs to. */
export interface Identity {
  /** The feed this request may read and write. */
  sessionId: string;
  /** Authenticated principal, when there is one. Absent under the emulated adapter. */
  subject?: string;
}

/**
 * The minimum an identity provider needs from a request.
 *
 * Structurally satisfied by an Express `Request`, without this package having
 * to know that Express exists.
 */
export interface IdentityRequest {
  header(name: string): string | undefined;
  query: Record<string, unknown>;
}

export interface IdentityProvider {
  readonly mode: string;
  /** Resolves the caller, or null when the request carries no usable identity. */
  resolve(request: IdentityRequest): Promise<Identity | null>;
  close(): Promise<void>;
}

/** Everything resolved for one process. */
export interface Providers {
  sessions: SessionProvider;
  knowledge: KnowledgeProvider;
  identity: IdentityProvider;
  /** Per-session append-only stream: storage, retention, replay and delivery. */
  eventStream: EventStream;
  /** Releases every provider that holds a connection. */
  close(): Promise<void>;
}
