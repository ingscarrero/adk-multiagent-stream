/**
 * The capability catalogue: the single source of truth for what is emulated.
 *
 * `GET /api/health` renders this, so the emulated-versus-real boundary is
 * observable at runtime rather than asserted in a document that can drift out
 * of date. docs/PROVIDERS.md explains each entry; this is the machine-readable
 * half of the same table.
 */

export interface Capability {
  /** What a production system would use for this. */
  readonly provider: string;
  /** The mode that needs no external service. */
  readonly emulated: string;
  /** Modes backed by a real provider. */
  readonly real: readonly string[];
  /**
   * Whether the mode can actually be switched today.
   *
   * `false` means the capability is named here for honesty but is still
   * hard-wired &mdash; there is no port yet. Better to show it as a known gap
   * than to omit it and imply the list is complete.
   */
  readonly switchable: boolean;
}

export const CAPABILITIES = {
  model: {
    provider: 'Gemini, Vertex AI, any ADK BaseLlm',
    emulated: 'scripted',
    real: ['gemini'],
    switchable: true,
  },
  sessions: {
    provider: 'Postgres via ADK DatabaseSessionService, or VertexAiSessionService',
    emulated: 'memory',
    real: ['postgres'],
    switchable: true,
  },
  knowledge: {
    provider: 'Vector search: pgvector, Vertex AI Search, Pinecone',
    emulated: 'keyword',
    real: ['vector'],
    switchable: true,
  },
  identity: {
    provider: 'OIDC / JWT',
    emulated: 'trusted-header',
    real: ['jwt'],
    switchable: true,
  },
  eventLog: {
    provider: 'Redis Streams, Kafka, NATS JetStream',
    emulated: 'memory',
    real: ['redis'],
    switchable: false,
  },
  fanout: {
    provider: 'Redis pub/sub, NATS, Postgres LISTEN/NOTIFY',
    emulated: 'inprocess',
    real: ['redis'],
    switchable: false,
  },
} as const satisfies Record<string, Capability>;

export type CapabilityName = keyof typeof CAPABILITIES;

/** One row of the runtime matrix. */
export interface CapabilityStatus {
  capability: CapabilityName;
  mode: string;
  emulated: boolean;
  switchable: boolean;
  /** What this would be in production. */
  provider: string;
  /** Modes available for this capability. */
  options: string[];
}

/**
 * Renders the matrix for the active configuration.
 *
 * Takes the modes rather than the provider instances, so it stays a pure
 * function and can be tested without constructing anything.
 */
export function describeCapabilities(
  modes: Record<CapabilityName, string>,
): CapabilityStatus[] {
  return (Object.keys(CAPABILITIES) as CapabilityName[]).map((capability) => {
    const spec = CAPABILITIES[capability];
    const mode = modes[capability];
    return {
      capability,
      mode,
      emulated: mode === spec.emulated,
      switchable: spec.switchable,
      provider: spec.provider,
      options: [spec.emulated, ...spec.real],
    };
  });
}

/** True when every capability is running its emulated adapter. */
export function isFullyEmulated(statuses: CapabilityStatus[]): boolean {
  return statuses.every((status) => status.emulated);
}
