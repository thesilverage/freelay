<script lang="ts">
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import InvitationPanel from "./InvitationPanel.svelte";
	import { type Relay, type RelayRole, type FolderRole, type RemoteSharedFolder, type Role } from "../Relay";
	import SettingItem from "./SettingItem.svelte";
	import type Live from "src/main";
	import { SharedFolders, type SharedFolder } from "src/SharedFolder";
	import { debounce, Notice } from "obsidian";
	import { createEventDispatcher, onMount, tick } from "svelte";
	import { derived, writable } from "svelte/store";
	import type { ObservableMap } from "src/observable/ObservableMap";
	import Breadcrumbs from "./Breadcrumbs.svelte";
	import AccountSettingItem from "./AccountSettingItem.svelte";
	import { AddToVaultModal } from "src/ui/AddToVaultModal";
	import { curryLog } from "src/debug";
	import { normalizePath } from "obsidian";
	import { join } from "path-browserify";
	import type {
		SyncCategoryKey,
		SyncSettingsManager,
	} from "src/SyncSettings";

	import Lock from "./Lock.svelte";
	import SlimSettingItem from "./SlimSettingItem.svelte";
	import SettingGroup from "./SettingGroup.svelte";
	import { Check, Edit } from "lucide-svelte";
	import { UserSelectModal } from "src/ui/UserSelectModal";
	import { handleServerError } from "src/utils/toastStore";
	export let plugin: Live;
	export let remoteFolder: RemoteSharedFolder;
	export let sharedFolders: SharedFolders;
	export let relayRoles: ObservableMap<string, RelayRole>;
	export let folderRoles: ObservableMap<string, FolderRole>;

	let displayName: string = remoteFolder.name;

	export let errorLog = curryLog("ManageRemoveFolder.svelte", "error");

	void plugin.relayManager.refreshRemoteFolder(remoteFolder).catch(() => undefined);

	let relayStore = derived(remoteFolder, folder => folder.relay);

	let folderStore = derived($sharedFolders, ($sharedFolders) => {
		return $sharedFolders
			.items()
			.find((folder) => folder.guid === remoteFolder.guid);
	});

	const availableRoles = derived(
		[plugin.relayManager.roles, relayRoles, folderRoles, remoteFolder],
		([$roles, $relayRoles, $folderRoles, $remoteFolder]) => new Map(
			$folderRoles.values()
				.filter(role => role.sharedFolderId === $remoteFolder.id)
				.map(role => {
					const inherited = $relayRoles.find(r => r.relayId === $remoteFolder.relayId && r.userId === role.userId)?.role;
					return [role.userId, $roles.values().filter(r => r.name === "Reader" || (r.name === "Member" && inherited !== "Reader")).sort(rolePrioritySort)] as const;
				}),
		),
	);

	function rolePrioritySort(a: { name: string }, b: { name: string }) {
		const priority: Record<string, number> = { Owner: 0, Member: 1, Reader: 2 };
		return (priority[a.name] ?? 999) - (priority[b.name] ?? 999);
	}

	// Get folder roles for this specific folder
	let virtualFolderRoles = derived(
		[folderRoles, relayRoles, remoteFolder],
		([$folderRoles, $relayRoles, $remoteFolder]) => {
			if ($remoteFolder.private || false) {
				// Manual filtering instead of .filter() to avoid DerivedMap lifecycle issues
				const result = [];
				for (const role of $folderRoles.values()) {
					if (
						role.sharedFolderId === $remoteFolder.id
					) {
						result.push(role);
					}
				}
				return result;
			}
			// Manual filtering for relay roles too
			const result = [];
			for (const role of $relayRoles.values()) {
				if (role.relayId === $remoteFolder.relayId) {
					result.push(role);
				}
			}
			for (const role of $folderRoles.values()) {
				if (role.sharedFolderId === $remoteFolder.id && !result.some(r => r.userId === role.userId)) result.push(role);
			}
			return result;
		},
	);

	let isEditingUsers = writable(false);
	let nameValid = writable(true);
	let nameInput: HTMLInputElement;
	let updating = writable(false);
	let lastSavedName = remoteFolder.name;
	let deletingLocal = false;
	let deletingRemote = false;
	let confirmRemoteDeletion = false;

	// Create a reactive variable for the private flag to ensure breadcrumbs update
	$: isPrivate = $remoteFolder?.private || false;

	onMount(() => {
		if (nameInput && nameInput.value === "") {
			nameInput.focus();
		}
	});

	let syncSettings: SyncSettingsManager | undefined =
		$folderStore?.syncSettingsManager;

	// Type the entries
	type CategoryEntry = [
		SyncCategoryKey,
		{
			name: string;
			description: string;
			enabled: boolean;
			requiresStorage: boolean;
			canToggle: boolean;
		},
	];
	$: settingEntries = syncSettings
		? (Object.entries(syncSettings.getCategories()) as CategoryEntry[])
		: [];

	let isUpdating = false;
	async function handleToggle(name: SyncCategoryKey, value: boolean) {
		if (isUpdating) return;
		if (!syncSettings) return;
		if (name === "markdown") return;
		isUpdating = true;
		try {
			await syncSettings.toggleCategory(name, value);
			settingEntries = Object.entries(
				syncSettings.getCategories(),
			) as CategoryEntry[];
		} catch (error) {
			// pass
		} finally {
			isUpdating = false;
		}
	}

	const dispatch = createEventDispatcher();

	// Permission stores - direct store subscriptions
	const canReadFolder = plugin.relayManager.userCan(
		["folder", "read_content"],
		remoteFolder,
	);
	const canRenameFolder = plugin.relayManager.userCan(
		["folder", "rename"],
		remoteFolder,
	);
	const canDeleteFolder = plugin.relayManager.userCan(
		["folder", "delete"],
		remoteFolder,
	);
	const canManageUsers = plugin.relayManager.userCan(
		["folder", "manage_users"],
		remoteFolder,
	);
	const canMakeFolderPrivate = plugin.relayManager.userCan(
		["folder", "make_private"],
		remoteFolder,
	);

	function handleManageRelay(relay?: Relay) {
		if (!relay) {
			return;
		}
		dispatch("manageRelay", { relay });
	}

	async function handleDeleteMetadata() {
		if ($folderStore) {
			plugin.sharedFolders.delete($folderStore);
		}
		dispatch("goBack", { clear: true });
	}

	async function handleDeleteLocal() {
		if (deletingLocal || !$folderStore) return;
		const folder = plugin.vault.getFolderByPath($folderStore.path);
		if (!folder) return;

		deletingLocal = true;
		try {
			await tick();
			await new Promise<void>((resolve) =>
				window.requestAnimationFrame(() => resolve()),
			);
			await plugin.app.vault.trash(folder, false);
		} catch (error) {
			errorLog("Failed to move shared folder to trash", error);
			new Notice("Failed to move the Shared Folder to trash.");
		} finally {
			deletingLocal = false;
		}
	}

	async function handleDeleteRemote() {
		if (deletingRemote || !confirmRemoteDeletion) return;
		deletingRemote = true;
		try {
			await plugin.relayManager.deleteRemote(remoteFolder);
			const localFolder = $folderStore;
			if (localFolder) {
				localFolder.remote = undefined;
				plugin.sharedFolders.notifyListeners();
				dispatch("manageSharedFolder", { folder: localFolder });
				return;
			}
		} catch (error) {
			errorLog("Failed to delete remote folder:", error);
			handleServerError(error, "Failed to delete folder from relay.");
			return;
		} finally {
			deletingRemote = false;
		}
		dispatch("goBack", {});
	}

	function handleEditUsersToggle(event: KeyboardEvent | MouseEvent) {
		// No instanceof: the settings window has its own event constructors,
		// so events born there never match this realm's classes.
		if (
			event.type === "click" ||
			("key" in event && (event.key === "Enter" || event.key === " "))
		) {
			isEditingUsers.update((value) => !value);
		}
	}

	async function handleRemoveFolderUser(folderRole: FolderRole) {
		try {
			await plugin.relayManager.removeFolderRole(folderRole);
		} catch (error) {
			handleServerError(error, "Failed to remove user from folder.");
		}
	}

	async function handleMakePrivate() {
		try {
			// Make the folder private
			const updated = await plugin.relayManager.updateFolderPrivacy(
				remoteFolder,
				true,
			);
			// Open the add users modal
			handleAddUser();
		} catch (error) {
			handleServerError(
				error,
				"Failed to make folder private. Permission denied.",
			);
		}
	}

	function handleAddUser() {
		const modal = new UserSelectModal(
			plugin.app,
			plugin.relayManager,
			remoteFolder,
			async (grants) =>
				Promise.all(
					grants.map((grant) =>
						plugin.relayManager.addFolderRole(
							remoteFolder,
							grant,
						),
					),
				).then(() => undefined),
		);
		modal.open();
	}

	async function handleFolderRoleChange(folderRole: FolderRole, newRole: Role) {
		try {
			await plugin.relayManager.updateFolderRole(
				folderRole,
				newRole,
			);
		} catch (error) {
			handleServerError(error, "Failed to change user role.");
			throw error;
		}
	}

	async function handleFolderRoleChangeEvent(event: Event) {
		const target = event.target as HTMLSelectElement;
		const folderRole = $virtualFolderRoles.find(
			(role) => role.id === target.dataset.roleId!,
		);
		if (folderRole) {
			const originalRole = folderRole.role;
			try {
				await handleFolderRoleChange(folderRole, target.value as Role);
			} catch (e) {
				// Revert dropdown to the original role value
				target.value = originalRole;
			}
		}
	}

	async function handleAddToVault() {
		async function addToVault(
			remoteFolder: RemoteSharedFolder,
			name: string,
			location: string,
		): Promise<SharedFolder> {
			const vaultRelativePath = normalizePath(join(location, name));
			if (plugin.vault.getFolderByPath(vaultRelativePath) === null) {
				await plugin.vault.createFolder(vaultRelativePath);
			}
			const folder = plugin.sharedFolders.clone(
				vaultRelativePath,
				remoteFolder.guid,
				remoteFolder.relay.guid,
			);
			folder.remote = remoteFolder;
			plugin.sharedFolders.notifyListeners();
			dispatch("manageRemoteFolder", { remoteFolder });
			return folder;
		}
		new AddToVaultModal(
			plugin.app,
			plugin.sharedFolders,
			remoteFolder,
			[],
			addToVault,
		).open();
	}

	function isValidObsidianFolderName(path: string): boolean {
		// Obsidian restricted characters in folder and file names
		const restrictedCharacters = /[\\:*?"<>|]/;

		// Check if the path contains any restricted characters
		if (restrictedCharacters.test(path)) {
			return false;
		}

		// Check for any segment of the path being empty or only '.'
		const segments = path.split("/");
		for (const segment of segments) {
			if (segment === "" || segment === "." || segment === "..") {
				return false;
			}
		}
		return true;
	}

	const updateRemoteFolder = plugin.timeProvider.debounce(async (name) => {
		try {
			// Use RelayManager to update the folder name
			const updated = await plugin.relayManager.updateRemoteFolder(
				remoteFolder,
				{
					name: name,
				},
			);
			lastSavedName = updated.name;
			displayName = updated.name;
			updating.set(false);
		} catch (error) {
			errorLog("Failed to update folder name:", error);
			// If it's a 400 error, mark the name as invalid
			if (error?.status === 400) {
				nameValid.set(false);
			}
			updating.set(false);
		}
	}, 500);

	function handleNameChange() {
		nameValid.set(isValidObsidianFolderName(nameInput.value));
		const currentName = nameInput.value.trim();

		// Only update if the value has actually changed and is valid
		if ($nameValid && currentName !== "" && currentName !== lastSavedName) {
			updating.set(true);
			updateRemoteFolder(currentName);
		}
	}
</script>

<Breadcrumbs
	items={[
		{
			type: "home",
			onClick: () => dispatch("goBack", { clear: true }),
		},
		{
			type: "relay",
			relay: $remoteFolder.relay,
			onClick: () => handleManageRelay($remoteFolder.relay),
		},
		{
			type: "remoteFolder",
			remoteFolder: {
				...$remoteFolder,
				name: displayName,
				private: isPrivate,
			},
		},
	]}
/>

{#if $canRenameFolder}
	<SettingItem
		name="Name"
		description="Set the Shared Folder's default name. A Shared Folder can always be renamed locally."
	>
		<input
			type="text"
			spellcheck="false"
			placeholder="Example: Shared Notes"
			bind:value={displayName}
			bind:this={nameInput}
			on:input={handleNameChange}
			class={($updating ? "freelay-updating" : "") +
				($nameValid ? "" : " freelay-input-invalid")}
		/>
	</SettingItem>
{/if}

{#if !$folderStore && $canReadFolder}
	<SettingItemHeading name="Add to vault"></SettingItemHeading>
	<SettingGroup>
		<SettingItem
			name="Add this folder to your vault"
			description="Download and sync this folder to your local device"
		>
			<button
				class="mod-cta freelay-button"
				data-action="add-to-vault"
				on:click={debounce(handleAddToVault)}
			>
				Add to vault
			</button>
		</SettingItem>
	</SettingGroup>
{/if}

{#if $relayStore}
	<SettingItemHeading
		name="Users with access"
		helpText={isPrivate
			? ""
			: "This folder is accessible to everyone on this relay."}
	>
		{#if $canManageUsers}
			<div
				class="edit-members-button"
				role="button"
				tabindex="0"
				aria-label={$isEditingUsers ? "Cancel editing users" : "Edit users"}
				on:click={handleEditUsersToggle}
				on:keypress={handleEditUsersToggle}
			>
				{#if $isEditingUsers}
					<Check class="svg-icon" />
				{:else}
					<Edit class="svg-icon" />
				{/if}
			</div>
		{/if}
	</SettingItemHeading>

	<SettingGroup>
		{#each $virtualFolderRoles as role}
		<AccountSettingItem user={role.user}>
			{#if "sharedFolder" in role}
				{#if $isEditingUsers}
					<button
						class="mod-destructive"
						on:click={debounce(() => {
							if ("sharedFolder" in role) {
								handleRemoveFolderUser(role);
							}
						})}
					>
						Remove
					</button>
				{:else if $canManageUsers}
					<div style="display: flex; gap: 8px; align-items: center;">
						<select
							class="dropdown"
							value={role.role}
							disabled={!$availableRoles.get(role.userId)?.length}
							data-role-id={role.id}
							on:change={handleFolderRoleChangeEvent}
						>
							{#if !$availableRoles.get(role.userId)?.some((option) => option.name === role.role)}
								<option value={role.role} disabled>{role.role}</option>
							{/if}
							{#each $availableRoles.get(role.userId) ?? [] as option}
								<option value={option.name}>{option.name}</option>
							{/each}
						</select>
					</div>
				{:else}
					<span class="role-label">{role.role}</span>
				{/if}
			{/if}
		</AccountSettingItem>
	{/each}

	{#if isPrivate && $canManageUsers}
		<SettingItem description="" name="">
			<button
				class="mod-cta"
				aria-label="Add user to private folder"
				disabled={$isEditingUsers}
				on:click={debounce(handleAddUser)}
			>
				Add User
			</button>
		</SettingItem>
	{/if}
</SettingGroup>
{/if}

{#if $canManageUsers}
	<InvitationPanel {plugin} relayId={remoteFolder.relayId} folderId={remoteFolder.id} />
{/if}

<div class="spacer"></div>

{#if $folderStore && $syncSettings && $relayStore}
	<div class="local-settings">
		<SettingItemHeading
			name="Sync settings for this device"
			helpText="Choose which content types to sync on this device."
		></SettingItemHeading>

		<SettingGroup>
			{#if displayName !== $folderStore.name}
			<SettingItem
				name="Local path"
				description="This folder has a different name in your Vault"
			>
				/{$folderStore.path}
			</SettingItem>
		{/if}
		{#each settingEntries as [name, category]}
			{@const locked = false}
			{@const on = category.enabled && !locked}
			{@const disabled = isUpdating || !category.canToggle}
			<SlimSettingItem name={category.name} description={category.description}>
				<div
					class="setting-item-control"
					data-sync-category={name}
					data-locked={locked}
				>
					{#if locked}
						<Lock />
					{/if}
					<div
						role="checkbox"
						aria-checked={on}
						aria-disabled={disabled}
						tabindex={disabled ? -1 : 0}
						on:keypress={() => handleToggle(name, !category.enabled)}
						class="checkbox-container"
						class:is-enabled={on}
						on:click={() => handleToggle(name, !category.enabled)}
					>
						<input
							type="checkbox"
							checked={on}
							disabled={disabled}
							on:change={(e) => handleToggle(name, e.currentTarget.checked)}
						/>
						<div class="checkbox-toggle"></div>
					</div>
				</div>
			</SlimSettingItem>
		{/each}
		</SettingGroup>
	</div>
{/if}

<div class="spacer"></div>

{#if $canDeleteFolder || $canMakeFolderPrivate || $folderStore}
	<SettingItemHeading name="Danger zone"></SettingItemHeading>
	<SettingGroup>
		{#if $relayStore}
			{#if $canMakeFolderPrivate}
				{#if !remoteFolder?.private && remoteFolder?.relay.version > 0}
					<SettingItem
						name="Make private"
						description="Convert this folder to a private folder and manage access"
					>
						<button class="mod-destructive" on:click={debounce(handleMakePrivate)}>
							Make private
						</button>
					</SettingItem>
				{/if}
			{/if}
			{#if $canDeleteFolder}
				<SettingItem
					name="Remove from relay"
					description="Irreversible. Stops new access now; server data is collected after the safety delay. Local files are preserved."
				>
					<div class="confirmation-controls">
						<label class="confirmation">
							<input type="checkbox" bind:checked={confirmRemoteDeletion} />
							<span>Permanently delete this shared folder from the server.</span>
						</label>
						<button
							class="mod-destructive"
							disabled={deletingRemote || !confirmRemoteDeletion}
							aria-busy={deletingRemote}
							on:click={handleDeleteRemote}
						>
							Delete shared folder
						</button>
					</div>
				</SettingItem>
			{/if}
		{/if}

		{#if $folderStore}
			<SettingItem
				name="Delete from vault"
				description="Delete the local Shared Folder and all of its contents."
			>
				<button
					class="mod-warning"
					disabled={deletingLocal}
					aria-busy={deletingLocal}
					on:click={handleDeleteLocal}
				>
					Move to trash
				</button>
			</SettingItem>
		{/if}
	</SettingGroup>
{/if}

<style>
	div.spacer {
		height: 3em;
	}

	.local-settings {
		margin-left: -1em;
		padding-left: 1em;
		border-left: 1px solid var(--color-accent);
	}
	.freelay-input-invalid {
		border: 1px solid var(--color-red) !important;
	}

	input.freelay-updating {
		border: 1px solid var(--color-accent) !important;
	}

	.edit-members-button {
		display: flex;
		cursor: pointer;
		padding: 4px;
		margin-bottom: -4px;
		border-radius: var(--radius-s);
		color: var(--icon-color);
		transition:
			color 0.15s ease-in-out,
			background-color 0.15s ease-in-out;
	}

	.edit-members-button:hover {
		color: var(--icon-color-hover);
		background-color: var(--background-modifier-hover);
	}

	.edit-members-button:focus {
		outline: none;
		color: var(--icon-color-focus);
	}

	.confirmation {
		display: flex;
		align-items: flex-start;
		gap: var(--size-4-2);
		max-width: 24rem;
		color: var(--text-muted);
		font-size: var(--font-ui-smaller);
		line-height: var(--line-height-tight);
		white-space: normal;
	}

	.confirmation-controls {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: var(--size-4-2);
		max-width: 100%;
	}

	.confirmation input {
		flex: none;
		margin-top: 0.15em;
	}

	/* Fix for invisible text in disabled dropdown */
	select.dropdown:disabled {
		opacity: 1 !important;
		color: var(--text-muted) !important;
		-webkit-text-fill-color: var(--text-muted) !important;
	}
</style>
