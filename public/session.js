// Pure helpers for public/index.html, a classic script like rebase.js, so no ESM
// syntax. Tests evaluate this file in a sandbox, see session.test.mjs.
window.microbitSession = {
	/** The storage a session starts in: the last one, unless it was memfs or lost its folder access. */
	startStorage(remembered, localAccess) {
		if (remembered === 'idbfs') return 'idbfs';
		if (remembered === 'localfs' && localAccess) return 'localfs';
		return 'memfs';
	},

	/** VS Code's stored list of activity bar containers, with those in `changes` pinned or unpinned. */
	setPinned(stored, changes) {
		const containers = stored ? JSON.parse(stored) : [];
		let changed = false;
		for (const [id, pinned] of Object.entries(changes)) {
			const known = containers.find((container) => container.id === id);
			if (known?.pinned === pinned) continue;
			changed = true;
			if (known) known.pinned = pinned;
			else containers.push({ id, pinned, visible: true, order: containers.length });
		}
		return changed ? JSON.stringify(containers) : stored;
	},
};
