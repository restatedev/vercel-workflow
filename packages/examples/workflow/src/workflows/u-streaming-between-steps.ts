async function generateData(): Promise<ReadableStream<number>> {
  "use step";

  return new ReadableStream<number>({
    start(controller) {
      for (let i = 0; i < 10; i++) {
        controller.enqueue(i);
      }
      controller.close();
    },
  });
}

async function consumeData(readable: ReadableStream<number>) {
  "use step";

  const values: number[] = [];
  for await (const value of readable) {
    values.push(value);
  }
  return values;
}

export async function streamPipelineWorkflow() {
  "use workflow";

  const stream = await generateData();
  const results = await consumeData(stream);

  return { count: results.length };
}
