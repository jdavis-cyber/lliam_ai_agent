/**
 * Minimal type declaration for isolated-vm (optional dependency).
 * The full API surface is typed internally in src/plugin/sandbox.ts.
 */
declare module "isolated-vm" {
  const ivm: unknown;
  export default ivm;
}
