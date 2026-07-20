/** Indexes into `arr` with a runtime bounds check. This project's tsconfig sets
 * `noUncheckedIndexedAccess`, so TS already treats `arr[i]` as possibly undefined everywhere;
 * every call site of this helper holds an invariant that makes the index genuinely always valid
 * (e.g. iterating a loop bound by the same array's own length) — this throws a clear error
 * instead of silently continuing with `undefined` if that invariant is ever violated, rather than
 * scattering non-null assertions through the pipeline's logic. */
export function at<T>(arr: T[], index: number): T {
  const value = arr[index];
  if (value === undefined) {
    throw new Error(`Index ${index} out of bounds (length ${arr.length}).`);
  }
  return value;
}
