/**
 * One tool call, rendered as a collapsed step.
 *
 * Collapsed by default because tool payloads are long and rarely what the
 * reader wants; expandable because when something goes wrong they are exactly
 * what the reader wants. `<details>` gives us that for free, keyboard and
 * screen-reader support included.
 */

import type { ToolInvocation } from './reducer.ts';

export function ToolStep({ tool }: { tool: ToolInvocation }) {
  const pending = tool.state === 'pending';

  return (
    <details className="tool" data-testid="tool-step" data-tool={tool.name} data-state={tool.state}>
      <summary className="tool__summary">
        <span className={`tool__dot ${pending ? 'tool__dot--pending' : ''}`} aria-hidden="true" />
        <code className="tool__name">{tool.name}</code>
        <span className="tool__state">{pending ? 'running…' : 'done'}</span>
      </summary>
      <div className="tool__body">
        <p className="tool__label">Arguments</p>
        <pre className="tool__pre">{JSON.stringify(tool.args, null, 2)}</pre>
        {tool.state === 'done' ? (
          <>
            <p className="tool__label">Result</p>
            <pre className="tool__pre">{JSON.stringify(tool.result, null, 2)}</pre>
          </>
        ) : null}
      </div>
    </details>
  );
}
