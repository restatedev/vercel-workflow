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

import type { Serde } from "@restatedev/restate-sdk-core";
import { QueuePayloadSchema } from "@workflow/world";

import * as z4 from "zod/v4";

export type { Serde } from "@restatedev/restate-sdk-core";

class ZodSerde<T extends z4.ZodType>
  implements Serde<z4.infer<T>>
{
  contentType? = "application/json";
  jsonSchema?: object | undefined;

  constructor(private readonly schema: T) {
    if ("_zod" in schema) {
      this.jsonSchema = z4.toJSONSchema(schema, {
        unrepresentable: "any",
      });
    } 
    if (
      schema instanceof z4.ZodVoid ||
      schema instanceof z4.ZodUndefined
    ) {
      this.contentType = undefined;
    }
  }

  serialize(
    value: z4.infer<T>
  ): Uint8Array {
    if (value === undefined) {
      return new Uint8Array(0);
    }
    return new TextEncoder().encode(JSON.stringify(value));
  }

  deserialize(
    data: Uint8Array
  ): z4.infer<T> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const js =
      data.length === 0
        ? undefined
        : JSON.parse(new TextDecoder().decode(data));
    if (
      "safeParse" in this.schema &&
      typeof this.schema.safeParse === "function"
    ) {
      const res = this.schema.safeParse(js);
      if (res.success) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return res.data;
      }
      throw res.error;
    } else {
      throw new TypeError("Unsupported data type. Expected 'safeParse'.");
    }
  }
}

export namespace serde {
  /**
   * A Zod-based serde.
   *
   * @param zodType the zod type
   * @returns a serde that will validate the data with the zod schema
   */
  export const zod = <T extends z4.ZodType>(zodType: T): Serde<z4.infer<T>> => {
    return new ZodSerde(zodType);
  };
}

export const QueueParamsSchema = z4.object({
  deliverTo: z4.string(),
  queueName: z4.string(),
  message: QueuePayloadSchema,
  opts: z4
    .object({
      deploymentId: z4.string().optional(),
      idempotencyKey: z4.string().optional(),
    })
    .optional(),
});

export type QueueParams = z4.infer<typeof QueueParamsSchema>;
