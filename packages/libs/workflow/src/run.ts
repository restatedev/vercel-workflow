/*
 * Copyright (c) TODO: Add copyright holder
 *
 * This file is part of TODO: Add project name,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * TODO: Add repository URL
 */

import { parseWorkflowName } from "./parse-name.js";

export type WorkflowRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

function getIngressUrl(): string {
  const ingress = process.env["RESTATE_INGRESS"];
  if (!ingress) {
    throw new Error("Please set the RESTATE_INGRESS env var.");
  }
  return ingress.replace(/\/+$/, "");
}

function getAdminUrl(): string {
  const admin = process.env["RESTATE_ADMIN_URL"];
  if (!admin) {
    throw new Error("Please set the RESTATE_ADMIN_URL env var.");
  }
  return admin.replace(/\/+$/, "");
}

function resolveServiceName(
  workflow: (...args: unknown[]) => unknown
): string {
  const workflowId = (
    workflow as unknown as { workflowId?: string }
  ).workflowId;

  if (workflowId) {
    const parsed = parseWorkflowName(workflowId);
    if (parsed) {
      return parsed.shortName;
    }
  }

  if (workflow.name) {
    return workflow.name;
  }

  throw new Error(
    "Cannot determine workflow service name. " +
      "The function has no `workflowId` metadata and no `.name` property."
  );
}

/**
 * A handle to a workflow invocation.
 * All operations use Restate's native ingress and admin API endpoints.
 */
export class Run<TResult> {
  /** The Restate invocation ID. */
  readonly runId: string;

  constructor(runId: string) {
    this.runId = runId;
  }

  /**
   * Non-blocking status check.
   */
  get status(): Promise<WorkflowRunStatus> {
    const ingress = getIngressUrl();
    return fetch(
      `${ingress}/restate/invocation/${encodeURIComponent(this.runId)}/output`,
      { headers: { Accept: "application/json" } }
    ).then((res) => {
      if (res.ok) return "completed" as const;
      if (res.status === 470) return "running" as const;
      return "failed" as const;
    });
  }

  /**
   * Block until the workflow completes and return its result.
   */
  get returnValue(): Promise<TResult> {
    const ingress = getIngressUrl();
    return fetch(
      `${ingress}/restate/invocation/${encodeURIComponent(this.runId)}/attach`,
      { headers: { Accept: "application/json" } }
    ).then(async (res) => {
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Workflow failed (runId=${this.runId}): ${res.status}${body ? ` - ${body}` : ""}`
        );
      }
      return (await res.json()) as TResult;
    });
  }

  /**
   * Check whether this invocation exists.
   */
  get exists(): Promise<boolean> {
    const ingress = getIngressUrl();
    return fetch(
      `${ingress}/restate/invocation/${encodeURIComponent(this.runId)}/output`,
      { headers: { Accept: "application/json" } }
    ).then((res) => res.ok || res.status === 470);
  }

  /**
   * Cancel the workflow.
   */
  async cancel(): Promise<void> {
    const admin = getAdminUrl();
    const res = await fetch(
      `${admin}/invocations/${encodeURIComponent(this.runId)}`,
      { method: "DELETE" }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Failed to cancel (runId=${this.runId}): ${res.status}${text ? ` - ${text}` : ""}`
      );
    }
  }

  /**
   * Restart the workflow with the same input (Restate restart-as-new).
   */
  async restart(): Promise<Run<TResult>> {
    const admin = getAdminUrl();
    const res = await fetch(
      `${admin}/invocations/${encodeURIComponent(this.runId)}/restart-as-new`,
      { method: "POST" }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Failed to restart (runId=${this.runId}): ${res.status}${text ? ` - ${text}` : ""}`
      );
    }
    const data = (await res.json()) as { invocationId: string };
    return new Run<TResult>(data.invocationId);
  }
}

/**
 * Start a workflow and return a {@link Run} handle.
 */
export async function start<TArgs extends unknown[], TResult>(
  workflow: (...args: TArgs) => Promise<TResult>,
  args: TArgs
): Promise<Run<TResult>>;
export async function start<TResult>(
  workflow: (...args: []) => Promise<TResult>
): Promise<Run<TResult>>;
export async function start(
  workflow: (...args: unknown[]) => Promise<unknown>,
  args?: unknown[]
): Promise<Run<unknown>> {
  const serviceName = resolveServiceName(workflow);
  const input = args?.[0];
  const ingress = getIngressUrl();

  const res = await fetch(
    `${ingress}/${encodeURIComponent(serviceName)}/run/send`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Failed to start workflow "${serviceName}": ${res.status}${body ? ` - ${body}` : ""}`
    );
  }

  const data = (await res.json()) as { invocationId: string };
  return new Run(data.invocationId);
}

/**
 * Get a {@link Run} handle for an existing invocation.
 */
export function getRun<TResult>(runId: string): Run<TResult> {
  return new Run<TResult>(runId);
}
