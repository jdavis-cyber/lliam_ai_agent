/**
 * Minimal type declarations for @xenova/transformers.
 * The actual module is dynamically imported and optional.
 */
declare module "@xenova/transformers" {
  export const env: {
    allowRemoteModels: boolean;
    allowLocalModels: boolean;
    backends: Record<string, unknown>;
    [key: string]: unknown;
  };

  export function pipeline(
    task: string,
    model: string,
    options?: Record<string, unknown>
  ): Promise<(text: string, options?: Record<string, unknown>) => Promise<{ data: Float32Array }>>;
}
