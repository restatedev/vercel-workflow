import { FatalError } from "workflow";

async function produceStream(): Promise<ReadableStream<number>> {
  "use step";

  return new ReadableStream<number>({
    start(controller) {
      controller.enqueue(1);
      controller.enqueue(2);
      controller.error(new Error("Stream failed"));
    },
  });
}

async function consumeStream(stream: ReadableStream<number>) {
  "use step";

  try {
    for await (const value of stream) {
      console.log(value);
    }
  } catch {
    // Stream errors don't trigger automatic retries, so wrap as FatalError.
    throw new FatalError("Stream failed");
  }
}

export async function streamErrorWorkflow() {
  "use workflow";

  const stream = await produceStream();
  await consumeStream(stream);
}
