/**
 * What switching storage does with the files. Temporary storage is lost when
 * the tab closes, so its files follow the user into browser storage and are
 * copied back out of it; a local folder's files stay on the computer.
 */

export type Storage = 'memfs' | 'idbfs' | 'localfs';

export interface SwitchPlan {
	/** Confirmed before anything changes, so declining leaves the workspace where it is. */
	warning?: 'loseScratch' | 'browserToScratch' | 'browserToFolder';
	copy: boolean;
	/** Empty the new folder first, so temporary storage holds exactly what it was given. */
	replace: boolean;
	/** False keeps a file already there, so a starter nobody edited never replaces saved work. */
	overwrite: boolean;
	/** Unsaved edits are dropped rather than saved, as the files they belong to are left behind. */
	discard: boolean;
}

export function switchPlan(from: Storage, to: Storage, scratchChanged: boolean): SwitchPlan {
	const none: SwitchPlan = { copy: false, replace: false, overwrite: false, discard: false };
	if (from === 'memfs' && to === 'idbfs') return { ...none, copy: true, overwrite: scratchChanged };
	if (from === 'memfs' && to === 'localfs') return { ...none, discard: true, warning: scratchChanged ? 'loseScratch' : undefined };
	if (from === 'idbfs' && to === 'memfs') return { warning: 'browserToScratch', copy: true, replace: true, overwrite: true, discard: false };
	// The IDE reopens browser storage at the next start only while it is the storage in use.
	if (from === 'idbfs' && to === 'localfs') return { ...none, warning: 'browserToFolder' };
	return none;
}

/** Whether a workspace still holds exactly the files, by path and contents, it was left with. */
export function untouched(pristine: ReadonlyMap<string, string>, current: ReadonlyMap<string, string>): boolean {
	if (pristine.size !== current.size) return false;
	for (const [path, contents] of pristine) if (current.get(path) !== contents) return false;
	return true;
}
