import { describe, expect, it } from 'vitest';

import manifest from '../package.json';

describe('the BBC micro:bit IDE panel', () => {
	const lines = manifest.contributes.viewsWelcome[0].contents.split('\n').map((line) => line.trim());
	const loneLink = /^\[[^\]]*\]\([^)]*\)$/;

	// VS Code draws a line that is nothing but a link as a button, and any other as text with links.
	it('shows the two actions as buttons and Show all actions as a link', () => {
		expect(lines.map((line) => loneLink.test(line))).toEqual([true, true, false]);
		expect(lines[2]).toContain('[Show all actions](command:microbitIde.ui.showAllActions)');
	});
});
