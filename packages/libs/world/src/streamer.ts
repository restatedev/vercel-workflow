import { Ingress } from "@restatedev/restate-sdk-clients";
import type { Streamer } from "@workflow/world";
import { createPubsubClient } from "@restatedev/pubsub-client";

type StreamContent =
  | {
      data_string: string;
    }
  | {
      data_bytes: string;
    }
  | {
      eos: boolean;
    };

export const createStreamer = (client: Ingress): Streamer => {
  const pubsub = createPubsubClient(client, {
    name: "streams",
  });

  return {
    writeToStream: async function (
      name: string,
      chunk: string | Uint8Array | Buffer
    ): Promise<void> {
      if (typeof chunk === "string") {
        await pubsub.publish(name, { data_string: chunk } as StreamContent);
      } else if (chunk instanceof Buffer) {
        await pubsub.publish(name, {
          data_bytes: chunk.toString("base64"),
        } as StreamContent);
      } else {
        await pubsub.publish(name, {
          data_bytes: Buffer.from(chunk).toString("base64"),
        } as StreamContent);
      }
    },
    closeStream: async function (name: string): Promise<void> {
      await pubsub.publish(name, { eos: true } as StreamContent);
    },
    readFromStream: function (
      name: string,
      startIndex?: number
    ): Promise<ReadableStream<Uint8Array>> {
      return Promise.resolve(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              const pullGenerator = pubsub.pull({
                topic: name,
                offset: startIndex,
              });

              for await (const message of pullGenerator) {
                const content = message as StreamContent;

                if ("eos" in content && content.eos) {
                  // End of stream
                  controller.close();
                  break;
                }

                if ("data_string" in content) {
                  // Convert string to Uint8Array
                  const encoder = new TextEncoder();
                  controller.enqueue(encoder.encode(content.data_string));
                } else if ("data_bytes" in content) {
                  // Convert base64 string to Uint8Array
                  const buffer = Buffer.from(content.data_bytes, "base64");
                  controller.enqueue(new Uint8Array(buffer));
                }
              }

              // If the loop completes without explicit eos, close the stream
              controller.close();
            } catch (error) {
              controller.error(error);
            }
          },
        })
      );
    },
  };
};
