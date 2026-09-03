import picomatch from "picomatch";

/** Compile globs once; returns a matcher. Empty list matches nothing. */
export function compileGlobs(globs: readonly string[]): (path: string) => boolean {
  if (globs.length === 0) return () => false;
  const isMatch = picomatch([...globs], { dot: true });
  return (path) => isMatch(path);
}

export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return compileGlobs(globs)(path);
}

/** True when the pattern contains glob metacharacters. */
export function isGlob(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}
