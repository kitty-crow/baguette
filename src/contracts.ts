/** Process capabilities available to the Bun and Node.js entry points. */
export interface HostProcess {
  argv: string[];
  cwd(): string;
  env: Record<string, string | undefined>;
  execPath: string;
  exit(code?: number): never;
}

/** Configuration for one generated WebAssembly variant. */
export interface BaguetteVariant { name: string; threaded?: boolean; preludeFile?: string; }
