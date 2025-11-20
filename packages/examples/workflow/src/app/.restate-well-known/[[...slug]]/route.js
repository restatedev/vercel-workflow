// Re-exports file to use [[...slug]]

// Need this to register steps!
// noinspection ES6UnusedImports
import { POST as _ignored } from "../../.well-known/workflow/v1/step/route.js";

import { POST as wf } from "../../.well-known/workflow/v1/flow/route.js";

export const POST = wf;
export const GET = wf;
