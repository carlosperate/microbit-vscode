import { describe, expect, it } from 'vitest';

import { compatibleApiVersion } from '../src/managerVersion';

describe('compatibleApiVersion', () => {
	// Below 1.0.0 a minor bump is a breaking change, so only the same minor will do.
	it('accepts the same 0.x minor at or above the wanted patch', () => {
		expect(compatibleApiVersion('0.3.0', '0.3.0')).toBe(true);
		expect(compatibleApiVersion('0.3.7', '0.3.0')).toBe(true);
		expect(compatibleApiVersion('0.3.0', '0.3.2')).toBe(false);
	});

	it('rejects a different 0.x minor either way', () => {
		expect(compatibleApiVersion('0.4.0', '0.3.0')).toBe(false);
		expect(compatibleApiVersion('0.2.9', '0.3.0')).toBe(false);
	});

	it('accepts a newer minor within the same major from 1.0.0', () => {
		expect(compatibleApiVersion('1.2.0', '1.2.0')).toBe(true);
		expect(compatibleApiVersion('1.3.0', '1.2.0')).toBe(true);
		expect(compatibleApiVersion('1.1.9', '1.2.0')).toBe(false);
		expect(compatibleApiVersion('2.0.0', '1.2.0')).toBe(false);
	});

	// The manager refuses nobody, so anything odd it serves must fail closed here.
	it('rejects anything that is not a plain semver string', () => {
		expect(compatibleApiVersion('0.3.0-beta', '0.3.0')).toBe(false);
		expect(compatibleApiVersion('0.3', '0.3.0')).toBe(false);
		expect(compatibleApiVersion(undefined, '0.3.0')).toBe(false);
		expect(compatibleApiVersion(3, '0.3.0')).toBe(false);
	});
});
