import {
  Context,
  createServiceHandler,
  rpc,
  service,
} from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk-zod";
import { schemas } from "@restatedev/common";
import { jsonTransport, queueUrl } from "./utils.js";

export const queue = service({
  name: "queueService",
  handlers: {
    queue: createServiceHandler(
      {
        retryPolicy: {
          maxAttempts: 10,
          maxInterval: { seconds: 6 },
          onMaxAttempts: "kill",
        },

        input: serde.zod(schemas.QueueParamsSchema),
      },
      async (ctx: Context, params) => {
        // We use Restate invocation id as the message id
        const messageId = ctx.request().id;

        // Serialize using vercel transport
        const body = jsonTransport.serialize(params.message);

        const response = await fetch(
          queueUrl(params.deliverTo, params.queueName),
          {
            method: "POST",
            body: body as BodyInit,
            headers: {
              "x-vqs-queue-name": params.queueName,
              "x-vqs-message-id": messageId,
              "x-vqs-message-attempt": String(params.attempt),
            },
          }
        );

        if (response.ok) {
          return { status: "delivered" };
        }
        if (response.status === 503) {
          const { retryIn } = (await response.json()) as { retryIn: number };

          // Increment attempt count
          params.attempt += 1;

          ctx.serviceSendClient(queue).queue(
            params,
            rpc.sendOpts({
              delay: { seconds: retryIn },
              input: serde.zod(schemas.QueueParamsSchema),
            })
          );

          return { status: "delayed", retryIn };
        }

        const text = await response.text();
        throw new Error(
          `Queue delivery failed with status ${response.status}:\n${text}`
        );
      }
    ),
  },
});

export type QueueService = typeof queue;
