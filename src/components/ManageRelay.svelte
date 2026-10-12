<script lang="ts">
	import InvitationPanel from "./InvitationPanel.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import { offeredRelayRoles,
		hasPermissionParents,
		type Relay,
		type RelayRole,
		type RemoteSharedFolder,
		type Role,
	} from "src/Relay";
	import type { FolderRoleGrant } from "src/RelayManager";
	import type Live from "src/main";
	import { SharedFolders, type SharedFolder } from "src/SharedFolder";
	import RemoteFolder from "./RemoteFolder.svelte";
	import { Notice, Platform, debounce, normalizePath, setIcon } from "obsidian";
	import { createEventDispatcher, onMount, onDestroy } from "svelte";
	import { derived, writable, get } from "svelte/store";
	import { Edit, Check, Download, X } from "lucide-svelte";
	import Callout from "./Callout.svelte";
	import type { ObservableMap } from "src/observable/ObservableMap";
	import { join } from "path-browserify";
	import SettingsControl from "./SettingsControl.svelte";
	import Lock from "./Lock.svelte";
	import Breadcrumbs from "./Breadcrumbs.svelte";
	import { ShareFolderModal } from "src/ui/ShareFolderModal";
	import { AddToVaultModal } from "src/ui/AddToVaultModal";
	import { FolderSuggestModal } from "src/ui/FolderSuggestModal";
	import SettingItem from "./SettingItem.svelte";
	import SlimSettingItem from "./SlimSettingItem.svelte";
	import SettingGroup from "./SettingGroup.svelte";
	import { uuidv4 } from "lib0/random";

	export let relay: Relay;
	const remoteFolders = relay.folders;
	let viewAsAdmin = writable(false);
	let hintDismissed = writable(false);
	export let plugin!: Live;
	const shouldShowToggle = derived(
		[
			remoteFolders,
			plugin.relayManager.relayRoles,
			plugin.relayManager.folderRoles,
		],
		([$remoteFolders, $relayRoles, $folderRoles]) => {
			const allFolders = Array.from($remoteFolders.values());
			const readableFolders = allFolders.filter((folder) =>
				get(plugin.relayManager.userCan(["folder", "read_content"], folder)),
			);
			const manageableFolders = allFolders.filter((folder) =>
				get(plugin.relayManager.userCan(["folder", "manage_users"], folder)),
			);
			// Show toggle only if the lists would be different
			return readableFolders.length !== manageableFolders.length;
		},
	);

	export let sharedFolders!: SharedFolders;
	const pendingFolderShares = new Map<string, Promise<SharedFolder>>();
	const pendingFolderGuids = new Map<string, string>();
	const pendingRemoteFolders = new Map<string, RemoteSharedFolder>();

	const hasDownloadedFolders = derived(
		[remoteFolders, sharedFolders, plugin.relayManager.folderRoles],
		([$remoteFolders, $sharedFolders]) => {
			const readableFolders = Array.from($remoteFolders.values()).filter(
				(folder) =>
					get(
						plugin.relayManager.userCan(["folder", "read_content"], folder),
					),
			);
			return readableFolders.some((remote) =>
				$sharedFolders.some((sf) => sf.guid === remote.guid),
			);
		},
	);

	function isNewUser(): boolean {
		return false;
	}
	export let relayRoles: ObservableMap<string, RelayRole>;

	import AccountSettingItem from "./AccountSettingItem.svelte";
	import { handleServerError } from "../utils/toastStore";

	import { ownerWin } from "./ownerWindow";
	void plugin.relayManager.refreshRelay(relay).catch(() => undefined);

	function userSort(a: RelayRole, b: RelayRole) {
		if (a.role === "Owner" && b.role === "Owner") {
			return a.userId === plugin.loginManager.user?.id ? -1 : 1;
		}
		if (a.role === "Owner" && b.role !== "Owner") {
			return -1;
		}
		if (a.role !== "Owner" && b.role === "Owner") {
			return 1;
		}
		return a.user.name > b.user.name ? 1 : -1;
	}

	// Offer only roles supported for relay membership.
	const availableRoles = derived([plugin.relayManager.roles], ([$roles]) => {
		return offeredRelayRoles($roles.values()).sort(rolePrioritySort);
	});

	function rolePrioritySort(a: { name: string }, b: { name: string }) {
		const priority: Record<string, number> = { Owner: 0, Member: 1, Reader: 2 };
		return (priority[a.name] ?? 999) - (priority[b.name] ?? 999);
	}

	const roles = $relayRoles.filter((role: RelayRole) => {
		return role.relayId === relay.id;
	});

	let nameValid = writable(true);
	let nameInput: HTMLInputElement;
	onMount(() => {
		if (nameInput && nameInput.value === "") {
			nameInput.focus();
		}
	});
	const dispatch = createEventDispatcher();

	async function handleLeaveRelay() {
		try {
			await plugin.relayManager.leaveRelay(relay);
			dispatch("goBack", { clear: true });
		} catch (error) {
			handleServerError(error);
		}
	}

	async function goBack() {
		dispatch("goBack", { clear: true });
	}

	let isEditingMembers = writable(false);

	let updating = writable(false);

	const updateRelay = plugin.timeProvider.debounce(() => {
		plugin.relayManager.updateRelay(relay).catch(handleServerError).finally(() => {
			updating.set(false);
		});
	}, 500);

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

	function handleNameChange() {
		nameValid.set(isValidObsidianFolderName(nameInput.value));
		if ($nameValid && nameInput.value !== "") {
			updating.set(true);
			updateRelay();
		}
	}

	let confirmDeletion = false;
	let deleting = false;
	async function handleDestroy() {
		if (!confirmDeletion || deleting) return;
		deleting = true;
		try { await plugin.relayManager.destroyRelay(relay); dispatch("goBack", {}); }
		catch (error) { handleServerError(error, "Could not delete relay."); }
		finally { deleting = false; }
	}

	function handleKick(relay_role: RelayRole) {
		plugin.relayManager.kick(relay_role).catch((error) => {
			handleServerError(error, "Failed to remove user");
		});
	}

	async function handleRoleChange(relay_role: RelayRole, newRole: Role) {
		try {
			await plugin.relayManager.updateRelayRole(
				relay_role,
				newRole,
			);
		} catch (error) {
			handleServerError(error, "Failed to change user role.");
			throw error;
		}
	}

	async function handleRoleChangeEvent(event: Event) {
		const target = event.target as HTMLSelectElement;
		const relayRole = $roles.get(target.dataset.roleId!);
		if (relayRole) {
			const originalRole = relayRole.role;
			try {
				await handleRoleChange(relayRole, target.value as Role);
			} catch (e) {
				// Revert dropdown to the original role value
				target.value = originalRole;
			}
		}
	}

	function handleEditMembersToggle(event: KeyboardEvent | MouseEvent) {
		// No instanceof: the settings window has its own event constructors,
		// so events born there never match this realm's classes.
		if (
			event.type === "click" ||
			("key" in event && (event.key === "Enter" || event.key === " "))
		) {
			isEditingMembers.update((value) => !value);
		}
	}

	// Permission stores - direct store subscriptions
	const canCreateFolder = plugin.relayManager.userCan(
		["relay", "create_folder"],
		relay,
	);
	const canManageUsers = plugin.relayManager.userCan(
		["relay", "manage_users"],
		relay,
	);
	const canManageSharing = plugin.relayManager.userCan(
		["relay", "manage_sharing"],
		relay,
	);
	const canRenameRelay = plugin.relayManager.userCan(
		["relay", "rename"],
		relay,
	);
	const canDeleteRelay = plugin.relayManager.userCan(
		["relay", "delete"],
		relay,
	);
	function onChoose(folderPath: string): Promise<SharedFolder>;
	function onChoose(
		folderPath: string,
		folderName: string,
		isPrivate: boolean,
		grants: FolderRoleGrant[],
	): Promise<SharedFolder>;
	// Implementation
	async function onChoose(
		folderPath: string,
		folderName?: string,
		isPrivate?: boolean,
		grants?: FolderRoleGrant[],
	): Promise<SharedFolder> {
		if (!$canCreateFolder) throw new Error("You cannot share folders on this relay.");
		const normalizedPath = normalizePath(folderPath);
		const pending = pendingFolderShares.get(normalizedPath);
		if (pending) return pending;

		const operation = (async () => {
			let folder = sharedFolders.find(
				(folder) => folder.path == normalizedPath,
			);

			if (plugin.vault.getFolderByPath(normalizedPath) === null) {
				await plugin.vault.createFolder(normalizedPath);
			}

			const remoteName =
				folderName || normalizedPath.split("/").pop() || normalizedPath;
			const folderGuid =
				folder?.guid ?? pendingFolderGuids.get(normalizedPath) ?? uuidv4();
			pendingFolderGuids.set(normalizedPath, folderGuid);

			let remote =
				folder?.remote ??
				pendingRemoteFolders.get(normalizedPath) ??
				relay.folders.find((remote) => remote.guid === folderGuid);
			if (!remote) {
				remote = await plugin.relayManager.createRemoteFolder(
					folderGuid,
					remoteName,
					relay,
					isPrivate ?? false,
				);
				pendingRemoteFolders.set(normalizedPath, remote);
			}
			if (!folder) {
				folder = sharedFolders.init(normalizedPath, remote);
			} else {
				folder.remote = remote;
			}

			if (isPrivate && grants && grants.length > 0) {
				for (const grant of grants) await plugin.relayManager.addFolderRole(remote, grant);
			}

			folder.connect();
			plugin.sharedFolders.notifyListeners();
			pendingFolderGuids.delete(normalizedPath);
			pendingRemoteFolders.delete(normalizedPath);

			if (grants && grants.length > 0) {
				ownerWin(rootEl).setTimeout(() => {
					dispatch("manageRemoteFolder", {
						remoteFolder: remote,
					});
				}, 100);
			}
			return folder;
		})();

		pendingFolderShares.set(normalizedPath, operation);
		try {
			return await operation;
		} finally {
			if (pendingFolderShares.get(normalizedPath) === operation) {
				pendingFolderShares.delete(normalizedPath);
			}
		}
	}

	const shareFolderModal = new ShareFolderModal(
		plugin.app,
		relay,
		sharedFolders,
		plugin.relayManager,
		onChoose,
	);

	async function handleAddToVault(remoteFolder: RemoteSharedFolder) {
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
			dispatch("manageRemoteFolder", { remoteFolder: folder.remote });
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

	onDestroy(() => {
		shareFolderModal?.destroy();
	});
	let rootEl: HTMLElement;
</script>

<Breadcrumbs
	items={[
		{
			type: "home",
			onClick: () => dispatch("goBack", { clear: true }),
		},
		{
			type: "relay",
			relay: relay,
		},
	]}
/>

{#if !$hintDismissed && isNewUser() && relay.name}
	{#if $remoteFolders.values().length > 0 && !$hasDownloadedFolders && !$relay.owner}
		<div class="hint-callout-wrapper">
			<Callout title="Hint">
				Click the <Download class="svg-icon hint-icon" /> button below to add a Shared Folder to your vault and start collaborating.
			</Callout>
			<button class="hint-dismiss" on:click={() => hintDismissed.set(true)} aria-label="Dismiss hint">
				<X class="svg-icon" />
			</button>
		</div>
	{:else if $remoteFolders.values().length === 0 && $relay.owner}
		<div class="hint-callout-wrapper">
			<Callout title="Hint">
				Add a Shared Folder to this Freelay.
			</Callout>
			<button class="hint-dismiss" on:click={() => hintDismissed.set(true)} aria-label="Dismiss hint">
				<X class="svg-icon" />
			</button>
		</div>
	{/if}
{/if}

{#if $canRenameRelay}
	<SettingItem name="Name" description="Set the relay's name.">
		<input
			type="text"
			spellcheck="false"
			placeholder="Example: Shared Notes"
			bind:value={relay.name}
			bind:this={nameInput}
			on:input={handleNameChange}
			class={($updating ? "freelay-updating" : "") +
				($nameValid ? "" : " freelay-input-invalid")}
		/>
	</SettingItem>
{/if}

<SettingItemHeading name="Shared Folders on this relay">
	{#if $canManageUsers && $shouldShowToggle}
		<button
			class="admin-toggle-btn"
			on:click={() => viewAsAdmin.update((v) => !v)}
		>
			{$viewAsAdmin ? "View as member" : "View as admin"}
		</button>
	{/if}
</SettingItemHeading>
<SettingGroup>
	{#each $remoteFolders.values() as remote}
		{#if $viewAsAdmin ? get(plugin.relayManager.userCan(["folder", "manage_users"], remote)) : get(plugin.relayManager.userCan(["folder", "read_content"], remote))}
			<SlimSettingItem>
				<RemoteFolder
					remoteFolder={remote}
					slot="name"
					on:manageRemoteFolder={() => {
						dispatch("manageRemoteFolder", {
							remoteFolder: remote,
						});
					}}>{remote.name}</RemoteFolder
				>
				{#if !$sharedFolders.some((sharedFolder) => sharedFolder.guid === remote.guid) && get(plugin.relayManager.userCan(["folder", "read_content"], remote))}
					<SettingsControl
						on:settings={debounce(() => {
							handleAddToVault(remote);
						})}
						label="Add to vault"
						action="add-to-vault"
					>
						<Download
							class="svg-icon lucide-settings"
							props={{ class: "svg-icon lucide-settings" }}
						/>
					</SettingsControl>
				{/if}
				<SettingsControl
					on:settings={debounce(() => {
						dispatch("manageRemoteFolder", {
							remoteFolder: remote,
						});
					})}
					action="manage-folder"
				></SettingsControl>
			</SlimSettingItem>
		{/if}
	{/each}

	{#if $canCreateFolder}
		<SettingItem description="" name="">
			<button
				class="mod-cta"
				data-action="share-folder"
				aria-label="Select a folder to share it with this relay"
				on:click={debounce(() => {
					if (relay.version === 0 && !Platform.isMobile) {
						// For relay version 0, go directly to folder selection.
						// Mobile routes through the share modal instead, whose inline
						// picker replaces the desktop-only suggest overlay.
						const folderModal = new FolderSuggestModal(
							plugin.app,
							"Choose or create folder...",
							new Set(
								sharedFolders.filter((f) => !!f.relayId).map((f) => f.path),
							).add("/"),
							sharedFolders,
							onChoose,
						);
						folderModal.open();
					} else {
						// For relay version > 0, use the full modal with privacy settings
						shareFolderModal.open();
					}
				})}>Share local folder</button
			>
		</SettingItem>
	{/if}
</SettingGroup>

<div class="spacer" bind:this={rootEl}></div>

<div class="users-header">
	<SettingItemHeading name="Users">
		{#if $canManageUsers}
			<div
				class="edit-members-button"
				role="button"
				tabindex="0"
				aria-label={$isEditingMembers ? "Done editing" : "Edit members"}
				on:click={handleEditMembersToggle}
				on:keypress={handleEditMembersToggle}
			>
				{#if $isEditingMembers}
					<Check class="svg-icon" />
				{:else}
					<Edit class="svg-icon" />
				{/if}
			</div>
		{/if}
	</SettingItemHeading>
</div>

<SettingGroup>
	{#each $roles.values().sort(userSort) as item}
		<AccountSettingItem user={item.user}>
			{#if $canManageUsers}
				{#if $isEditingMembers}
					{#if item.userId !== plugin.loginManager.user?.id}
						<button
							class="mod-destructive"
							on:click={debounce(() => {
								handleKick(item);
							})}
						>
							Kick
						</button>
					{/if}
				{:else}
					<div style="display: flex; gap: 8px; align-items: center;">
						<select
							class="dropdown"
							disabled={item.userId === plugin.loginManager.user?.id}
							aria-label={item.userId === plugin.loginManager.user?.id
								? "Cannot modify your own role"
								: undefined}
							value={item.role}
							data-role-id={item.id}
							on:change={handleRoleChangeEvent}
						>
							{#if !$availableRoles.some((role) => role.name === item.role)}
								<option value={item.role} disabled>{item.role}</option>
							{/if}
							{#each $availableRoles as role}
								<option value={role.name}>{role.name}</option>
							{/each}
						</select>
					</div>
				{/if}
			{:else}
				<span class="role-label">{item.role}</span>
			{/if}
		</AccountSettingItem>
	{/each}

	<SettingItem description="" name="">
		<span class="faint"
			>{$roles.values().length} members
		</span>
	</SettingItem>
</SettingGroup>

<!--

    <SettingItem name="" description="">
		<button class="mod-cta freelay-button" on:click={() => handleAddUser()}>
			Add User
		</button>
	</SettingItem>
    -->
{#if $canManageSharing}
	<InvitationPanel {plugin} relayId={relay.id} />
{/if}
{#if !$relay.owner || $relayRoles
		.filter((role) => role.role === "Owner" && role.relayId === relay.id)
		.values().length > 1}
	<SettingItemHeading name="Membership"></SettingItemHeading>
	<SettingGroup>
		<SettingItem
			name="Leave relay"
			description="Leave the relay. Local data is preserved."
		>
			<button
				class="mod-warning"
				data-action="leave-relay"
				on:click={debounce(() => {
					handleLeaveRelay();
				})}
			>
				Leave
			</button>
		</SettingItem>
	</SettingGroup>
{/if}

{#if $canDeleteRelay}
	<SettingItemHeading name="Danger zone"></SettingItemHeading>
	<SettingGroup>
		<SettingItem
			name="Delete relay"
			description="Irreversible. Stops new access now; the administrator’s collector removes stored data after the safety delay. Local files are preserved."
		>
			<div class="confirmation-controls">
				<label class="confirmation">
					<input type="checkbox" bind:checked={confirmDeletion} />
					<span>Permanently delete this relay and every shared folder.</span>
				</label>
				<button class="mod-warning" disabled={!confirmDeletion || deleting} on:click={handleDestroy}>Delete relay</button>
			</div>
		</SettingItem>
	</SettingGroup>
{/if}

<!--SettingItem
			name="Transfer Ownership"
			description="Transfer ownership to another user."
		>
			<button class="mod-warning" on:click={handleTransfer}>
				Transfer
			</button>
		</SettingItem-->

<style>
	div.spacer {
		height: 3em;
	}

	.faint {
		color: var(--text-faint) !important;
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

	/* Share key styling */
	.share-key-container {
		width: 100%;
	}

	.share-key-disabled-notice {
		color: var(--text-error) !important;
		font-size: 0.85em !important;
	}

	.relay-host-check {
		text-align: right;
	}
	input.freelay-updating {
		border: 1px solid var(--color-accent) !important;
	}

	input.freelay-input-invalid {
		border: 1px solid var(--color-red) !important;
	}

	.admin-toggle-btn {
		background: none;
		border: none;
		box-shadow: none;
		color: var(--text-muted);
		font-size: 0.9em;
		cursor: pointer;
		padding: 0;
		margin-left: 8px;
	}

	.admin-toggle-btn:hover {
		color: var(--text-normal);
		text-decoration: underline;
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

	.relay-auth-section {
		margin: 16px 0;
	}

	.loading-message {
		background: var(--background-secondary);
		color: var(--text-muted);
		border: 1px solid var(--background-modifier-border);
		border-radius: var(--radius-s);
		padding: 12px;
		margin: 16px 0;
		font-size: 0.9em;
		text-align: center;
	}

	.error-message {
		background: var(--background-secondary);
		color: var(--text-error);
		border: 1px solid var(--text-error);
		border-radius: var(--radius-s);
		padding: 12px;
		margin: 16px 0;
		font-size: 0.9em;
	}

	.hint-callout-wrapper {
		position: relative;
		margin-bottom: 16px;
	}

	.hint-callout-wrapper :global(.hint-icon) {
		display: inline;
		vertical-align: middle;
		width: 16px;
		height: 16px;
	}

	.hint-dismiss {
		position: absolute;
		top: 8px;
		right: 8px;
		background: none;
		border: none;
		box-shadow: none;
		padding: 4px;
		cursor: pointer;
		color: var(--text-muted);
		border-radius: var(--radius-s);
	}

	.hint-dismiss:hover {
		color: var(--text-normal);
		background-color: var(--background-modifier-hover);
	}
</style>
