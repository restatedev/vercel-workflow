import { serve } from "@restatedev/restate-sdk";
import {
  workflow,
  index,
  queue,
  keyValue,
  createPubsubObject,
} from "./index.js";

void serve({
  services: [workflow, index, queue, keyValue, createPubsubObject("streams")],
});
