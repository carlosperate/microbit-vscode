/**
 * What the welcome page's two modes change: the colour theme, and which
 * language's sidebar is pinned to the activity bar. Pure, so the caller applies it.
 */
import type { Language } from './detect';

export type Mode = Language;

/** The six themes `carlosperate.microbit-themes` ships, by the label `workbench.colorTheme` takes. */
export const MICROBIT_THEMES = new Set([
	'micro:bit Pixel Light',
	'micro:bit Pixel Dark',
	'micro:bit Spark Light',
	'micro:bit Spark Dark',
	'micro:bit Halo Light',
	'micro:bit Halo Dark',
]);

// Halo is the purple theme and Spark the pink one.
const THEME_FAMILY: Record<Mode, string> = { micropython: 'Halo', cpp: 'Spark' };

/** Light or dark stays the user's choice: the colour alone says which mode is on. */
export const modeTheme = (mode: Mode, dark: boolean): string => `micro:bit ${THEME_FAMILY[mode]} ${dark ? 'Dark' : 'Light'}`;

const CONTAINERS: Record<Mode, string> = {
	micropython: 'workbench.view.extension.bbcmicrobit-micropython',
	cpp: 'workbench.view.extension.bbcmicrobit-cpp',
};

export const modeContainer = (mode: Mode): string => CONTAINERS[mode];

/** Unpinned rather than removed, so the other language stays one tick away in the activity bar menu. */
export const modePins = (mode: Mode): Record<string, boolean> => ({
	[CONTAINERS.micropython]: mode === 'micropython',
	[CONTAINERS.cpp]: mode === 'cpp',
});

/**
 * Where a mode's starter program may be, as path segments below the folder, likeliest first.
 * C++ has two: its extension wrote main.cpp at the root before it moved it into source/.
 */
export const modeStarters = (mode: Mode, pythonFolder: string[]): string[][] =>
	mode === 'micropython' ? [[...pythonFolder, 'main.py']] : [['source', 'main.cpp'], ['main.cpp']];

// C++ builds from the Explorer, whose micro:bit panel flashes whichever language the files are.
export const modeSidebar = (mode: Mode): string => (mode === 'micropython' ? CONTAINERS.micropython : 'workbench.view.explorer');
