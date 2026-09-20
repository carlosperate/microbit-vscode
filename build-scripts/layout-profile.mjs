/**
 * Turns `config/layout.config.json` into the workbench's `profile` construction
 * option.
 *
 * The workbench keeps its layout in profile-scoped storage, and a profile
 * template is the supported way in. VS Code applies one only while that storage
 * is new, so a user's own arrangement is never overwritten.
 */

// Anything else reads as a non-default profile, which badges the Manage gear
// and the window title with the name.
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

	// `isHidden` travels with the order: it is the same stored entry.
	if (layout?.explorerViews?.length) {
		storage[EXPLORER_VIEWS_KEY] = JSON.stringify(
			layout.explorerViews.map((view, order) => ({ id: view.id, isHidden: view.hidden === true, order }))
		);
	}

	// Moving a view between containers is what the manager's Combine button does;
	// `views.customizations` is where the workbench records it.
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

	// An extension's own `globalState`, so a seeded layout and the extension's
	// idea of it agree. Keyed by extension id, exactly as the workbench stores it.
	for (const [extensionId, state] of Object.entries(layout?.extensionState ?? {})) {
		storage[extensionId] = JSON.stringify(state);
	}

	if (Object.keys(storage).length === 0) return undefined;

	return {
		name: PROFILE_NAME,
		contents: JSON.stringify({ name: PROFILE_NAME, globalState: JSON.stringify({ storage }) }),
	};
}
