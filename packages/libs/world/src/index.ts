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

import { connect, type ConnectionOpts } from "@restatedev/restate-sdk-clients";
import { World } from "@workflow/world";
import { createQueue } from "./queue.js";
import { createStorage } from "./storage.js";
import { createStreamer } from "./streamer.js";

export function createWorld(args?: {
  opts: ConnectionOpts;
  deliverTo: string;
}): World & { start(): Promise<void> } {
  const connOpts = args?.opts ?? { url: "http://localhost:8080" };
  const deliverTo = args?.deliverTo ?? "http://localhost:3000";

  const client = connect(connOpts);
  return {
    ...createQueue(client, deliverTo),
    ...createStorage(client),
    ...createStreamer(client),
    start: async () => {
      // TODO: verify subscription
    },
  };
}
