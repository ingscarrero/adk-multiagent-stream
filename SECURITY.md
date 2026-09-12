# Security

## Scope, stated plainly

This repository is a reference implementation of a streaming multi-agent feed.
It is **not hardened for exposure to the public internet** as shipped, and it
says so in [docs/LIMITATIONS.md](docs/LIMITATIONS.md):

- **No authentication.** The session id is client-supplied and trusted
  (`PROVIDER_IDENTITY=trusted-header`). Anyone who guesses a session id can
  read that feed and post into its threads. [L9](docs/LIMITATIONS.md#l9).
- **No persistence, no multi-tenancy.** Everything lives in one process's
  memory. [L7](docs/LIMITATIONS.md#l7), [L8](docs/LIMITATIONS.md#l8).

The security boundary the code *does* enforce, and the one a deployment would
need to add, are set out in
[docs/REQUIREMENTS.md — Security](docs/REQUIREMENTS.md#security).

## What is in place

| Control | Where |
|---|---|
| Request bodies validated with zod before use; `64kb` JSON limit | `apps/server/src/app.ts` |
| A thread can only be continued, answered or cancelled from the session that created it; a mismatch is `404`, not `403`, to avoid confirming the id exists | `app.ts` |
| Approval must quote the pending `requestId`; a stale approval is refused (`409`) and ADK fails closed on its side | `app.ts`, `thread-runner.ts` |
| Per-subscriber write ceiling (`SSE_MAX_BUFFERED_BYTES`) and idle-session sweep bound what a client can cost the server | `apps/server/src/sse.ts` |
| `maxLlmCalls: 20` per run caps a runaway agent loop | `thread-runner.ts` |
| CORS restricted to `CORS_ORIGIN` (default `http://localhost:5173`), credentials off | `app.ts` |
| Provider keys are read from the environment only; `.env` is gitignored; CI needs no secrets | `.env.example`, `.github/workflows/ci.yml` |
| The tool that spends money (`requestRefund`) is gated on a human above a threshold, with the arguments shown before approval | `packages/agents/src/tools.ts` |

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's
**private vulnerability reporting** on this repository
(*Security → Report a vulnerability*), or contact the maintainer directly
through the profile at <https://github.com/ingscarrero>.

Include what you found, how to reproduce it, and what you think the impact
is. You will get an acknowledgement within a few days. This is a personal
project maintained in spare time; there is no bug bounty.

## Supported versions

Only `main` is maintained. There are no tagged releases yet.
