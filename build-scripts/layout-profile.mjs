/**
 * VS Code applies profile templates only to new profile storage,
 * preserving any layout changes the user has already made.
 */

// Other names add profile badges to the gear and window title.
const PROFILE_NAME = 'Default';

const ACTIVITY_BAR_KEY = 'workbench.activity.pinnedViewlets2';
const EXPLORER_VIEWS_KEY = 'workbench.explorer.views.state.hidden';

export function profileFromLayout(layout) {
	const storage = {};

	if (layout?.activityBar?.length) {
		// Omitted entries get pinned by VS Code, so hidden entries must stay in the seed.
		storage[ACTIVITY_BAR_KEY] = JSON.stringify(
			layout.activityBar.map((view, order) => ({ id: view.id, pinned: view.hidden !== true, visible: true, order }))
		);
	}

	if (layout?.explorerViews?.length) {
		storage[EXPLORER_VIEWS_KEY] = JSON.stringify(
			layout.explorerViews.map((view, order) => ({ id: view.id, isHidden: view.hidden === true, order }))
		);
	}

	// Seed the same view locations that the manager's Combine button records.
	if (layout?.viewContainers?.length) {
		const viewLocations = {};
		for (const container of layout.viewContainers) {
			for (const view of container.views ?? []) viewLocations[view] = container.id;
			storage[`${container.id}.state.hidden`] = JSON.stringify(
				(container.views ?? []).map((id, order) => ({ id, isHidden: false, order }))
			);
		}
		storage['views.customizations'] = JSON.stringify({
			viewContainerLocations: {},
			viewLocations,
			viewContainerBadgeEnablementStates: {},
		});
	}

	const extensionState = { ...layout?.extensionState };
	// The sidebar's startup focus command would otherwise reveal a hidden view.
	if (layout?.explorerViews?.some((view) => view.id === 'microbitIde.sidebarActions' && view.hidden === true)) {
		extensionState['carlosperate.microbit-ide-sidebar-actions'] = {
			...extensionState['carlosperate.microbit-ide-sidebar-actions'],
			'microbitIde.sidebarActions.expandedOnce': true,
		};
	}
	// Keep each extension's globalState consistent with the seeded layout.
	for (const [extensionId, state] of Object.entries(extensionState)) {
		storage[extensionId] = JSON.stringify(state);
	}

	if (Object.keys(storage).length === 0) return undefined;

	return {
		name: PROFILE_NAME,
		contents: JSON.stringify({ name: PROFILE_NAME, globalState: JSON.stringify({ storage }) }),
	};
}
