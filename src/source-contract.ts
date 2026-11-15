/**
 * Validate an opt-in canonical Thistle kernel build before the Bake stage.
 *
 * Kernel source provenance is not a cosmetic manifest label. A compile that
 * uses src/teto/kernel.ts must not be accepted as a Thistle-origin Teto build.
 * This is scoped to opt-in canonical builds so other Baguette consumers stay
 * kernel-independent.
 */
export interface ThistleSourceContract {
  canonicalSource?: string;
  canonicalRevision?: string;
  productionKernel?: string;
  completeKernel?: boolean;
  entries?: readonly string[];
  canonicalOriginalEntries?: readonly string[];
  canonicalOriginalModules?: readonly string[];
  memory?: { initialPages?: number; maximumPages?: number };
}

const normalise = (path: string): string => path.replaceAll("\\", "/");
const canonical = (path: string): boolean => /(?:^|\/)src\/core\/kernel\.ts$/.test(normalise(path));
const separate = (path: string): boolean => /(?:^|\/)src\/teto\/kernel\.ts$/.test(normalise(path));

export const assertCanonicalThistleSource = (config: ThistleSourceContract): void => {
  if (config.canonicalSource === undefined) return;
  if (config.canonicalSource !== "Thistle") throw new Error("Unknown authoritative kernel source");
  if (!/^[a-f0-9]{40}$/.test(config.canonicalRevision ?? "")) {
    throw new Error("Canonical Thistle build requires an exact immutable upstream source commit");
  }
  if (config.productionKernel !== "Thistle" || config.completeKernel !== true) {
    throw new Error("Canonical Thistle build cannot claim a partial or alternative kernel");
  }
  const entries = config.canonicalOriginalEntries ?? config.entries;
  if (!entries?.some(canonical)) {
    throw new Error("Canonical Thistle build must compile src/core/kernel.ts");
  }
  if (entries.some(separate)) {
    throw new Error("Canonical Thistle build must not compile src/teto/kernel.ts");
  }
  if (config.canonicalOriginalModules?.some(separate)) {
    throw new Error("Canonical Thistle build transitively imports an independently maintained Teto kernel");
  }
  const pages = config.memory?.initialPages;
  const maximum = config.memory?.maximumPages;
  if (!Number.isSafeInteger(pages) || pages === undefined || pages <= 0 ||
      !Number.isSafeInteger(maximum) || maximum === undefined || maximum < pages) {
    throw new Error("Canonical Thistle build requires an explicit, valid kernel memory allocation");
  }
};
