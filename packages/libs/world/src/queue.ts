import { MessageId, Queue, ValidQueueName } from "@workflow/world";
import { JsonTransport } from "@vercel/queue";
import z from "zod/v4";
import { Ingress, rpc } from "@restatedev/restate-sdk-clients";
import { serde } from "@restatedev/restate-sdk-zod";
import { QueueService } from "@restatedev/vercel-backend/types";
import { schemas } from "@restatedev/common";

const HeaderParser = z.object({
  "x-vqs-queue-name": ValidQueueName,
  "x-vqs-message-id": MessageId,
  "x-vqs-message-attempt": z.coerce.number(),
});

export function createQueue(client: Ingress, deliverTo: string): Queue {
  const queue: Queue["queue"] = async (name, body, opts?) => {
    const idempotencyKey = opts?.idempotencyKey;

    const res = await client
      .serviceSendClient<QueueService>({ name: "queueService" })
      .queue(
        {
          deliverTo,
          queueName: name,
          message: body,
          attempt: 1,
        },
        rpc.sendOpts({
          idempotencyKey,
          input: serde.zod(schemas.QueueParamsSchema),
        })
      );

    const messageId = res.invocationId as MessageId;

    return { messageId };
  };

  const createQueueHandler: Queue["createQueueHandler"] = (prefix, handler) => {
    return async (req) => {
      const headers = HeaderParser.safeParse(Object.fromEntries(req.headers));
      if (!headers.success || !req.body) {
        return Response.json(
          { error: "Missing required headers" },
          { status: 400 }
        );
      }

      const queueName = headers.data["x-vqs-queue-name"];
      const messageId = headers.data["x-vqs-message-id"];
      const attempt = headers.data["x-vqs-message-attempt"];

      if (!queueName.startsWith(prefix)) {
        return Response.json({ error: "Unhandled queue" }, { status: 400 });
      }

      const body = await new JsonTransport().deserialize(req.body);
      try {
        // Run the queue handler
        const response = await handler(body, { attempt, queueName, messageId });
        const retryIn =
          typeof response === "undefined" ? null : response.timeoutSeconds;

        // 503 is used to notify to retry later
        if (retryIn) {
          return Response.json({ retryIn }, { status: 503 });
        }

        // Processed
        return Response.json({ ok: true });
      } catch (error) {
        // Some error happened
        return Response.json(String(error), { status: 500 });
      }
    };
  };

  // eslint-disable-next-line @typescript-eslint/require-await
  const getDeploymentId: Queue["getDeploymentId"] = async () => {
    return "dpl_restate";
  };

  return { queue, createQueueHandler, getDeploymentId };
}
