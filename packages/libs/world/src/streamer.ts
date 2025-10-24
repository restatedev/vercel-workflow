import { Ingress } from "@restatedev/restate-sdk-clients";
import type { Streamer } from "@workflow/world";

export const createStreamer = (client: Ingress): Streamer => {
  return {
    writeToStream: function (
      name: string,
      chunk: string | Uint8Array | Buffer
    ): Promise<void> {
      throw new Error("Function not implemented.");
    },
    closeStream: function (name: string): Promise<void> {
      throw new Error("Function not implemented.");
    },
    readFromStream: function (
      name: string,
      startIndex?: number
    ): Promise<ReadableStream<Uint8Array>> {
      throw new Error("Function not implemented.");
    },
  };
};
