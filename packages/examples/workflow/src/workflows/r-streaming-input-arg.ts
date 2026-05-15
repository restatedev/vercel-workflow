async function processInputStream(input: ReadableStream<Uint8Array>) {
  "use step";

  const chunks: Uint8Array[] = [];

  for await (const chunk of input) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

export async function streamProcessingWorkflow(
  inputStream: ReadableStream<Uint8Array>
) {
  "use workflow";

  const result = await processInputStream(inputStream);
  return { length: result.length };
}
