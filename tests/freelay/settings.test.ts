import {
	NamespacedSettings,
	Settings,
	type StorageAdapter,
} from "../../src/SettingsStorage";

type Tree = Record<string, unknown>;

class TestStorage implements StorageAdapter<Tree> {
	data: Tree | null = null;

	async loadData(): Promise<Tree | null> {
		return this.data === null ? null : structuredClone(this.data);
	}

	async saveData(data: Tree): Promise<void> {
		this.data = structuredClone(data);
	}
}

test("nested array namespaces persist shared folders and their child settings", async () => {
	const storage = new TestStorage();
	const settings = new Settings<Tree>(storage, {});
	await settings.load();

	const first = new NamespacedSettings<Record<string, unknown>>(
		settings,
		"servers/profile-a/sharedFolders/[guid=folder-a]",
	);
	await first.set({ path: "Shared/A", guid: "folder-a", relayId: "relay-a" });
	const sync = first.getChild<{ documents: boolean }>("sync");
	await sync.set({ documents: true });

	const second = new NamespacedSettings<Record<string, unknown>>(
		settings,
		"servers/profile-a/sharedFolders/[guid=folder-b]",
	);
	await second.set({ path: "Shared/B", guid: "folder-b", relayId: "relay-a" });

	const reloaded = new Settings<Tree>(storage, {});
	await reloaded.load();
	const reloadedFirst = new NamespacedSettings<Record<string, unknown>>(
		reloaded,
		"servers/profile-a/sharedFolders/[guid=folder-a]",
	);
	expect(reloadedFirst.get()).toEqual({
		path: "Shared/A",
		guid: "folder-a",
		relayId: "relay-a",
		sync: { documents: true },
	});

	await reloadedFirst.delete();
	expect(
		new NamespacedSettings<Record<string, unknown>>(
			reloaded,
			"servers/profile-a/sharedFolders/[guid=folder-a]",
		).exists(),
	).toBe(false);
	expect(
		new NamespacedSettings<Record<string, unknown>>(
			reloaded,
			"servers/profile-a/sharedFolders/[guid=folder-b]",
		).get(),
	).toMatchObject({ path: "Shared/B", guid: "folder-b" });

	first.destroy();
	sync.destroy();
	second.destroy();
	reloadedFirst.destroy();
	settings.destroy();
	reloaded.destroy();
});

test("wildcard namespaces continue to update only matching keys", async () => {
	const storage = new TestStorage();
	storage.data = { enableOne: false, enableTwo: false, unrelated: "kept" };
	const settings = new Settings<Tree>(storage, {});
	await settings.load();
	const flags = new NamespacedSettings<Record<string, unknown>>(settings, "(enable*)");

	expect(flags.get()).toEqual({ enableOne: false, enableTwo: false });
	await flags.set({ enableOne: true, unrelated: "discarded" });
	expect(settings.get()).toEqual({
		enableOne: true,
		enableTwo: false,
		unrelated: "kept",
	});

	flags.destroy();
	settings.destroy();
});

test("concurrent namespace writes do not lose a shared-folder registration", async () => {
	const storage = new TestStorage();
	const settings = new Settings<Tree>(storage, {});
	await settings.load();
	const first = new NamespacedSettings<Record<string, unknown>>(
		settings,
		"servers/profile-a/sharedFolders/[guid=folder-a]",
	);
	const second = new NamespacedSettings<Record<string, unknown>>(
		settings,
		"servers/profile-a/sharedFolders/[guid=folder-b]",
	);

	await Promise.all([
		first.set({ guid: "folder-a", path: "Shared/A" }),
		second.set({ guid: "folder-b", path: "Shared/B" }),
	]);

	expect(first.get()).toMatchObject({ guid: "folder-a", path: "Shared/A" });
	expect(second.get()).toMatchObject({ guid: "folder-b", path: "Shared/B" });
	expect(storage.data).toEqual(settings.get());

	first.destroy();
	second.destroy();
	settings.destroy();
});
