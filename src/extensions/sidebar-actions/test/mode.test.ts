import { describe, expect, it } from 'vitest';

import { MICROBIT_THEMES, modeContainer, modePins, modeSidebar, modeTheme, type Mode } from '../src/mode';

const MODES: Mode[] = ['micropython', 'cpp'];

describe('modeTheme', () => {
	it('picks purple Halo for MicroPython and pink Spark for C++', () => {
		expect(modeTheme('micropython', false)).toBe('micro:bit Halo Light');
		expect(modeTheme('micropython', true)).toBe('micro:bit Halo Dark');
		expect(modeTheme('cpp', false)).toBe('micro:bit Spark Light');
		expect(modeTheme('cpp', true)).toBe('micro:bit Spark Dark');
	});

	it('only ever names a theme the themes extension ships', () => {
		for (const mode of MODES) {
			for (const dark of [false, true]) expect(MICROBIT_THEMES.has(modeTheme(mode, dark))).toBe(true);
		}
	});
});

describe('modePins', () => {
	// Unpinned, the other language stays listed, unticked, in the activity bar's menu.
	it('pins the mode language and unpins the other one', () => {
		expect(modePins('micropython')).toEqual({
			'workbench.view.extension.bbcmicrobit-micropython': true,
			'workbench.view.extension.bbcmicrobit-cpp': false,
		});
		expect(modePins('cpp')).toEqual({
			'workbench.view.extension.bbcmicrobit-micropython': false,
			'workbench.view.extension.bbcmicrobit-cpp': true,
		});
	});
});

describe('modeContainer', () => {
	it("names the mode language's own activity bar container", () => {
		expect(modePins('micropython')[modeContainer('micropython')]).toBe(true);
		expect(modePins('cpp')[modeContainer('cpp')]).toBe(true);
		expect(modeContainer('cpp')).not.toBe(modeContainer('micropython'));
	});
});

describe('modeSidebar', () => {
	it('opens the MicroPython sidebar, or the Explorer for C++', () => {
		expect(modeSidebar('micropython')).toBe('workbench.view.extension.bbcmicrobit-micropython');
		expect(modeSidebar('cpp')).toBe('workbench.view.explorer');
	});
});
