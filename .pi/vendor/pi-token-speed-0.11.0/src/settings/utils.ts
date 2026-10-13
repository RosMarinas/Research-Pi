/** Group prefixes that have nested tier/color sub-items. */
export const GROUP_PREFIXES = [
  "thresholds",
  "colors",
  "displayColors",
] as const;

/**
 * Returns the group prefix if `id` belongs to one, or null.
 *
 * @param id The setting identifier to check.
 * @returns The matching group prefix, or null if `id` is a scalar field.
 */
export function getGroupPrefix(
  id: string,
): (typeof GROUP_PREFIXES)[number] | null {
  for (const prefix of GROUP_PREFIXES) {
    if (id === prefix || id.startsWith(`${prefix}.`)) return prefix;
  }
  return null;
}

/**
 * Returns true if `id` is a scalar (non-group) setting field.
 *
 * @param id The setting identifier to check.
 * @returns True if the id does not belong to a group.
 */
export function isScalarField(id: string): boolean {
  return !GROUP_PREFIXES.some((p) => id === p || id.startsWith(`${p}.`));
}
