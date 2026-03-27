/**
 * Workflow that uses a third-party npm package (ms) in a step.
 * Used to test whether vi.mock() works for third-party dependencies.
 */
import ms from 'ms';

async function formatDuration(duration: number) {
  'use step';
  return ms(duration);
}

export async function durationWorkflow(duration: number) {
  'use workflow';
  const result = await formatDuration(duration);
  return { ms: result };
}
