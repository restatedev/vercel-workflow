// This is what we "interjected" as methods
interface WorkflowRuntime {
  workflowEntrypoint(workflowCode: string): RequestHandler;

  registerStepFunction(stepId: string, fn: any): void;

  // Restate doesn't need this though!
  stepEntrypoint(workflowCode: string): RequestHandler;
}
// + the symbols stuff



























// Some alternative idea:

interface WorkflowRuntime {
  registerWorkflow(workflowId: string, workflowCode: string): void;

  registerStepFunction(workflowId: string, stepId: string, fn: any): void;

  // Exposes multiple workflows, needs to be mounted as POST/GET with [[...slug]]
  entrypoint(): RequestHandler;
}




























// And then from @workflow/core what is needed?

// * APIs to bootstrap the vm to run the workflow code, where I can provide:
//    * RNG seed
//    * useStep implementation
//    * createHook implementation
//    * ... Pretty much what happens in workflowEntrypoint currently with the node:vm setup
// * Serialization

// Open questions
// * In the prototype I copied over all the node:vm setup.
//   It could effectively be either injected already setup in workflowEntrypoint,
//   or the @workflow/core could provide all the vm setup as function?
// * How to integrate the serialization stack?
// * How promise combinators work?!
// * Hooks scope?
