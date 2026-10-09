<script lang="ts">
	import { onMount } from "svelte";
	import type Live from "src/main";
	import type { Access, InvitationRecord } from "src/control/Client";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import SettingItem from "./SettingItem.svelte";
	import SettingGroup from "./SettingGroup.svelte";
	import SecretText from "./SecretText.svelte";
	export let plugin: Live;
	export let relayId: string;
	export let folderId: string | undefined = undefined;
	const client = plugin.loginManager.control!;
	let access: Access = "write";
	let maxUses = 1;
	let ttlSeconds = 86400;
	let invitations: InvitationRecord[] = [];
	let code = "";
	let createdId = "";
	let busy = false;
	let error = "";
	let active = true;
	async function refresh() {
		const state = await client.state();
		if (active) invitations = state.invitations.filter(i => i.relay === relayId && (i.folder || undefined) === folderId && i.enabled && i.uses < i.maxUses && i.expiresAt * 1000 > Date.now());
	}
	async function perform(operation: () => Promise<void>) {
		busy = true; error = "";
		try { await operation(); await refresh(); }
		catch { if (active) error = "The invitation could not be updated. Refresh and try again."; }
		finally { busy = false; }
	}
	function create() {
		return perform(async () => {
			const invitation = await client.invite(relayId, access, folderId, maxUses, ttlSeconds);
			if (active) { code = invitation.code; createdId = invitation.id; }
		});
	}
	function revoke(id: string) {
		return perform(async () => {
			await client.revokeInvitation(relayId, id);
			if (createdId === id) code = "";
		});
	}
	onMount(() => {
		void perform(async () => {});
		const timer = globalThis.setInterval(() => {
			if (!busy) void refresh().catch(() => { if (active) error = "Could not refresh invitations."; });
		}, 30000);
		return () => { active = false; code = ""; globalThis.clearInterval(timer); };
	});
</script>

<SettingItemHeading name="Invitations" helpText={folderId ? "Invite someone to this shared folder only." : "Invite someone to this relay and its public shared folders."} />
<SettingGroup>
	<SettingItem name="Access" description="Only relay Owners can create invitations.">
		<select class="dropdown" bind:value={access} disabled={busy} aria-label="Invitation access">
			<option value="write">Read and write</option><option value="read">Read only</option>
		</select>
	</SettingItem>
	<SettingItem name="Uses" description="Maximum number of different people who can accept.">
		<input type="number" min="1" max="4294967295" step="1" bind:value={maxUses} disabled={busy} aria-label="Invitation uses" />
	</SettingItem>
	<SettingItem name="Expires after" description="Expiry prevents new acceptances; existing membership remains.">
		<select class="dropdown" bind:value={ttlSeconds} disabled={busy} aria-label="Invitation lifetime">
			<option value={3600}>1 hour</option><option value={86400}>24 hours</option>
		</select>
		<button on:click={create} disabled={busy || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 4294967295}>Create invitation</button>
	</SettingItem>
	{#if code}
		<SettingItem name="Invitation code" description="Copy now and share privately. This code cannot be retrieved later.">
			<SecretText value={code} successMessage="Invitation code copied" />
		</SettingItem>
	{/if}
	{#each invitations as invitation (invitation.id)}
		<SettingItem name={invitation.access === "write" ? "Read and write" : "Read only"} description={`${invitation.uses}/${invitation.maxUses} used; expires ${new Date(invitation.expiresAt * 1000).toLocaleString()}`}>
			<button on:click={() => revoke(invitation.id)} disabled={busy}>Revoke invitation</button>
		</SettingItem>
	{/each}
	{#if error}<p class="mod-warning" role="alert">{error}</p>{/if}
</SettingGroup>
