/**
 * Whether a served API version satisfies the one we were built against, read as
 * npm's caret: same major, never older, and below 1.0.0 the same minor as well.
 */
export function compatibleApiVersion(served: unknown, wanted: string): boolean {
	const have = parse(served);
	const need = parse(wanted);
	if (!have || !need) return false;
	if (have[0] !== need[0]) return false;
	if (have[0] === 0 && have[1] !== need[1]) return false;
	return compare(have, need) >= 0;
}

const parse = (version: unknown): number[] | undefined =>
	typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version.split('.').map(Number) : undefined;

const compare = (a: number[], b: number[]): number => a.map((part, at) => part - b[at]).find((diff) => diff !== 0) ?? 0;
