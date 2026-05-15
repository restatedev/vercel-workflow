async function downloadFile(url: string): Promise<ReadableStream<Uint8Array>> {
  "use step";

  const response = await fetch(url);
  return response.body!;
}

async function transformData(
  input: ReadableStream<Uint8Array>
): Promise<ReadableStream<Uint8Array>> {
  "use step";

  return input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
    })
  );
}

async function uploadResult(stream: ReadableStream<Uint8Array>) {
  "use step";

  // Replace with your actual storage endpoint. httpbin.org echoes uploads back,
  // making this example testable without configuring real storage.
  await fetch("https://httpbin.org/post", {
    method: "POST",
    body: stream,
    // @ts-expect-error - duplex is required for streamed bodies in Node fetch
    duplex: "half",
  });
}

export async function fileProcessingWorkflow(fileUrl: string) {
  "use workflow";

  const rawStream = await downloadFile(fileUrl);
  const processedStream = await transformData(rawStream);
  await uploadResult(processedStream);
}
