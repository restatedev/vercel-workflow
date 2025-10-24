import { serve } from "@restatedev/restate-sdk";
import { hooksApi, indexService, queue, workflowApi } from "./services.js";

export type { WorkflowApi } from "./services.js";
export type { HooksApi } from "./services.js";
export type { IndexService } from "./services.js";
export type { QueueService } from "./services.js";

serve({
  services: [workflowApi, hooksApi, indexService, queue],
});
