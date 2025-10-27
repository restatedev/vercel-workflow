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

import { QueuePayloadSchema } from "@workflow/world";

import * as z4 from "zod/v4";

/** Bunch of zod schemas we need **/
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace schemas {
  export const QueueParamsSchema = z4.object({
    deliverTo: z4.string(),
    queueName: z4.string(),
    attempt: z4.int(),
    message: QueuePayloadSchema,
    opts: z4
      .object({
        deploymentId: z4.string().optional(),
        idempotencyKey: z4.string().optional(),
      })
      .optional(),
  });

  export type QueueParams = z4.infer<typeof QueueParamsSchema>;
}
