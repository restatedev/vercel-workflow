/* eslint-disable @typescript-eslint/require-await */
/**
 * Simplest example of a workflow with multiple steps
 */

async function add(a: number, b: number): Promise<number> {
  'use step';
  return a + b;
}

async function multiply(a: number, b: number): Promise<number> {
  'use step';
  return a * b;
}

export async function calculateWorkflow(x: number, y: number) {
  'use workflow';

  const sum = await add(x, y);
  const product = await multiply(x, y);

  return {
    sum,
    product,
    combined: sum + product,
  };
}
