import { describe, expect, it } from 'vitest';

import { profileFromLayout } from '../build-scripts/layout-profile.mjs';

/** Unwrap the three layers of stringification the profile template format uses. */
const storageOf = (option) => JSON.parse(JSON.parse(option.contents).globalState).storage;

describe('profileFromLayout', () => {
	it('returns nothing when there is no layout to seed', () => {
		expect(profileFromLayout(undefined)).toBeUndefined();
		expect(profileFromLayout({})).toBeUndefined();
		expect(profileFromLayout({ activityBar: [], explorerViews: [] })).toBeUndefined();
	});

	// Other names add profile badges to the gear and window title.
	it('names the profile Default so no profile UI appears', () => {
		const option = profileFromLayout({ activityBar: [{ id: 'a' }] });
		expect(option.name).toBe('Default');
		expect(JSON.parse(option.contents).name).toBe('Default');
	});

	it('numbers the activity bar in the order given', () => {
		const option = profileFromLayout({
			activityBar: [{ id: 'first' }, { id: 'second' }, { id: 'third', hidden: false }],
		});
		expect(JSON.parse(storageOf(option)['workbench.activity.pinnedViewlets2'])).toEqual([
			{ id: 'first', pinned: true, visible: true, order: 0 },
			{ id: 'second', pinned: true, visible: true, order: 1 },
			{ id: 'third', pinned: true, visible: true, order: 2 },
		]);
	});

	it('keeps hidden activity bar entries explicitly unpinned', () => {
		const option = profileFromLayout({
			activityBar: [
				{ id: 'workbench.view.explorer' },
				{ id: 'workbench.view.scm', hidden: true },
				{ id: 'workbench.view.debug', hidden: true },
				{ id: 'workbench.view.extensions' },
			],
		});
		expect(JSON.parse(storageOf(option)['workbench.activity.pinnedViewlets2'])).toEqual([
			{ id: 'workbench.view.explorer', pinned: true, visible: true, order: 0 },
			{ id: 'workbench.view.scm', pinned: false, visible: true, order: 1 },
			{ id: 'workbench.view.debug', pinned: false, visible: true, order: 2 },
			{ id: 'workbench.view.extensions', pinned: true, visible: true, order: 3 },
		]);
	});

	it('numbers explorer views in order and defaults them to shown', () => {
		const option = profileFromLayout({
			explorerViews: [{ id: 'mine' }, { id: 'files' }, { id: 'openEditors', hidden: true }],
		});
		expect(JSON.parse(storageOf(option)['workbench.explorer.views.state.hidden'])).toEqual([
			{ id: 'mine', isHidden: false, order: 0 },
			{ id: 'files', isHidden: false, order: 1 },
			{ id: 'openEditors', isHidden: true, order: 2 },
		]);
	});

	it('suppresses startup expansion for hidden sidebar actions without losing other extension state', () => {
		const storage = storageOf(profileFromLayout({
			explorerViews: [{ id: 'microbitIde.sidebarActions', hidden: true }],
			extensionState: {
				'carlosperate.microbit-ide-sidebar-actions': {
					'microbitIde.sidebarActions.expandedOnce': false,
					other: 'preserved',
				},
			},
		}));
		expect(JSON.parse(storage['carlosperate.microbit-ide-sidebar-actions'])).toEqual({
			'microbitIde.sidebarActions.expandedOnce': true,
			other: 'preserved',
		});
	});

	it.each([undefined, false])('keeps startup expansion for shown sidebar actions (hidden: %s)', (hidden) => {
		const storage = storageOf(profileFromLayout({
			explorerViews: [{ id: 'microbitIde.sidebarActions', hidden }],
		}));
		expect(storage['carlosperate.microbit-ide-sidebar-actions']).toBeUndefined();
	});

	describe('view containers', () => {
		const layout = {
			viewContainers: [
				{
					id: 'workbench.view.extension.bbcmicrobit',
					views: ['bbcmicrobit-manager.board', 'bbcmicrobit-cpp.panel', 'bbcmicrobit-micropython.simulator'],
				},
			],
		};

		it('points every listed view at its container', () => {
			const customizations = JSON.parse(storageOf(profileFromLayout(layout))['views.customizations']);
			expect(customizations.viewLocations).toEqual({
				'bbcmicrobit-manager.board': 'workbench.view.extension.bbcmicrobit',
				'bbcmicrobit-cpp.panel': 'workbench.view.extension.bbcmicrobit',
				'bbcmicrobit-micropython.simulator': 'workbench.view.extension.bbcmicrobit',
			});
			expect(customizations.viewContainerLocations).toEqual({});
			expect(customizations.viewContainerBadgeEnablementStates).toEqual({});
		});

		// Activation order must not decide the view order.
		it('pins the order of the views inside the container', () => {
			const storage = storageOf(profileFromLayout(layout));
			expect(JSON.parse(storage['workbench.view.extension.bbcmicrobit.state.hidden'])).toEqual([
				{ id: 'bbcmicrobit-manager.board', isHidden: false, order: 0 },
				{ id: 'bbcmicrobit-cpp.panel', isHidden: false, order: 1 },
				{ id: 'bbcmicrobit-micropython.simulator', isHidden: false, order: 2 },
			]);
		});
	});

	it('seeds extension state verbatim, stringified', () => {
		const storage = storageOf(
			profileFromLayout({ extensionState: { 'carlosperate.bbcmicrobit-manager': { 'x.combined': true } } })
		);
		expect(JSON.parse(storage['carlosperate.bbcmicrobit-manager'])).toEqual({ 'x.combined': true });
	});

	it('writes only the keys it was given a layout for', () => {
		expect(Object.keys(storageOf(profileFromLayout({ activityBar: [{ id: 'a' }] })))).toEqual([
			'workbench.activity.pinnedViewlets2',
		]);
		expect(Object.keys(storageOf(profileFromLayout({ explorerViews: [{ id: 'a' }] })))).toEqual([
			'workbench.explorer.views.state.hidden',
		]);
	});

	// A missing JSON layer makes the workbench silently ignore the seed.
	it('stringifies every layer the template expects', () => {
		const option = profileFromLayout({ activityBar: [{ id: 'a' }] });
		expect(typeof option.contents).toBe('string');
		expect(typeof JSON.parse(option.contents).globalState).toBe('string');
		expect(typeof storageOf(option)['workbench.activity.pinnedViewlets2']).toBe('string');
	});
});
