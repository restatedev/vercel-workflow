// This route exists solely to pull the vendored upstream e2e workflow fixtures
// into Next.js's compilation graph. Without these namespace imports, Next.js
// skips files in src/workflows/vendored/ — the workflows would never be
// compiled, registered with Restate, or matched by the e2e test suite.
//
// The route is never invoked; only the imports matter.
import * as _e2e from "../../../workflows/vendored/99_e2e";
import * as _dup from "../../../workflows/vendored/98_duplicate_case";
import * as _react from "../../../workflows/vendored/8_react_render";

void _e2e;
void _dup;
void _react;

export async function GET() {
  return new Response("ok");
}
