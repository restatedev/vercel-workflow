import { serve } from "@restatedev/restate-sdk";
import { index, keyValue, workflow } from "./services.js";
import { queue } from "./queue.js";

export type { WorkflowApi } from "./services.js";
export type { IndexApi } from "./services.js";
export type { QueueService } from "./queue.js";

serve({
  services: [workflow, index, queue, keyValue],
});
