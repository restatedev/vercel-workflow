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

import type { Hook, HookOptions } from "@workflow/core";

/**
 * Metadata returned when a hook is resumed.
 */
export type HookMetadata = {
  invocationId: string;
};

/**
 * A typed hook interface for type-safe hook creation and resumption.
 */
export interface TypedHook<TInput, TOutput> {
  /**
   * Creates a new hook with the defined output type.
   *
   * Note: This method can only be called inside a workflow function.
   *
   * @param options - Optional hook configuration
   * @returns A Hook that resolves to the defined output type
   */
  create(options?: HookOptions): Hook<TOutput>;

  /**
   * Resumes a hook by sending a payload with the defined input type.
   *
   * @param token - The unique token identifying the hook
   * @param payload - The payload to send; if a `schema` is configured it is validated/transformed before resuming
   * @returns Promise resolving to the hook metadata
   */
  resume(token: string, payload: TInput): Promise<HookMetadata>;
}

/**
 * Standard Schema v1 compatible interface.
 * Accepts any schema that implements the Standard Schema spec (Zod, Valibot, ArkType, etc.)
 */
interface StandardSchema<_TInput, TOutput> {
  "~standard": {
    validate(
      value: unknown
    ):
      | { value: TOutput; issues?: undefined }
      | { issues: readonly unknown[] }
      | Promise<
          | { value: TOutput; issues?: undefined }
          | { issues: readonly unknown[] }
        >;
  };
}

function getIngressUrl(): string {
  const ingress = process.env["RESTATE_INGRESS"];
  if (!ingress) {
    throw new Error(
      "Cannot resume hook. Please set the RESTATE_INGRESS env var."
    );
  }
  // Remove trailing slash if present
  return ingress.replace(/\/+$/, "");
}

/**
 * Resumes a hook by sending a payload to the Restate ingress.
 *
 * This function is called externally (e.g., from an API route or server action)
 * to send data to a hook and resume the associated workflow run.
 *
 * @param token - The unique token identifying the hook
 * @param payload - The data payload to send to the hook
 * @returns Promise resolving to the hook metadata
 *
 * @example
 *
 * ```ts
 * import { resumeHook } from '@restatedev/workflow';
 *
 * export async function POST(request: Request) {
 *   const { token, data } = await request.json();
 *   const metadata = await resumeHook(token, data);
 *   return Response.json({ success: true, invocationId: metadata.invocationId });
 * }
 * ```
 */
export async function resumeHook(
  token: string,
  payload: unknown
): Promise<HookMetadata> {
  const ingress = getIngressUrl();
  const url = `${ingress}/workflowHooks/${encodeURIComponent(token)}/resolve`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Failed to resume hook (token=${token}): ${res.status} ${res.statusText}${body ? ` - ${body}` : ""}`
    );
  }

  return (await res.json()) as HookMetadata;
}

/**
 * Defines a typed hook for type-safe hook creation and resumption.
 *
 * This helper provides type safety by allowing you to define the input and output types
 * for the hook's payload, with optional validation and transformation via a schema.
 *
 * @param schema - Schema used to validate and transform the input payload before resuming
 * @returns An object with `create` and `resume` functions pre-typed with the input and output types
 *
 * @example
 *
 * ```ts
 * import { defineHook } from '@restatedev/workflow';
 *
 * const approvalHook = defineHook<{ approved: boolean; comment: string }>();
 *
 * // In a workflow
 * export async function workflowWithApproval() {
 *   "use workflow";
 *
 *   const hook = approvalHook.create();
 *   const result = await hook; // Fully typed as { approved: boolean; comment: string }
 * }
 *
 * // In an API route
 * export async function POST(request: Request) {
 *   const { token, approved, comment } = await request.json();
 *   await approvalHook.resume(token, { approved, comment });
 *   return Response.json({ success: true });
 * }
 * ```
 */
export function defineHook<TInput, TOutput = TInput>({
  schema,
}: {
  schema?: StandardSchema<TInput, TOutput>;
} = {}): TypedHook<TInput, TOutput> {
  return {
    create(_options?: HookOptions): Hook<TOutput> {
      throw new Error(
        "`defineHook().create()` can only be called inside a workflow function."
      );
    },

    async resume(token: string, payload: TInput): Promise<HookMetadata> {
      if (!schema?.["~standard"]) {
        return await resumeHook(token, payload);
      }

      let result = schema["~standard"].validate(payload);
      if (result instanceof Promise) {
        result = await result;
      }

      if (result.issues) {
        throw new Error(JSON.stringify(result.issues, null, 2));
      }

      return await resumeHook(token, result.value);
    },
  };
}
