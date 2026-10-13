import type { Thresholds } from "../../../config/types";

/** Character class for valid hex color characters (`#` and `0-9A-Fa-f`). */
export const HEX_CHAR = "[#0-9A-Fa-f]";

/**
 * Validates that a string is a valid 24-bit truecolor hex string.
 */
export function isValidHex(s: string): boolean {
  return new RegExp(`^#${HEX_CHAR}{6}$`).test(s);
}

/**
 * Validates that TPS thresholds are in strict ascending order:
 * slow < medium < fast < blazing.
 */
export function isAscendingThresholds(thresholds: Thresholds): boolean {
  return (
    thresholds.slow < thresholds.medium &&
    thresholds.medium < thresholds.fast &&
    thresholds.fast < thresholds.blazing
  );
}

/**
 * Returns errors if thresholds are not in ascending order.
 */
export function validateAscending(thresholds: Thresholds): string[] {
  if (isAscendingThresholds(thresholds)) return [];
  return [
    "- TPS thresholds must be in ascending order.",
    `  Found: ${thresholds.slow} < ${thresholds.medium} < ${thresholds.fast} < ${thresholds.blazing}.`,
  ];
}
