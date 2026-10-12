<script lang="ts">
	import type { RelayManager } from "../RelayManager";
	import SettingGroup from "./SettingGroup.svelte";
	import SettingItem from "./SettingItem.svelte";
	export let relayManager: RelayManager;
	export let onConfirm: (url?: string, providerId?: string, organizationId?: string) => Promise<void>;
	let pending = false;
	let error = "";
	async function create() {
		pending = true;
		error = "";
		try { await onConfirm(); }
		catch (e) { error = e instanceof Error ? e.message : "Creation failed"; }
		finally { pending = false; }
	}
</script>

<SettingGroup>
	<SettingItem
		name="Create on this server"
		description="A server administrator must add your public key to the Owner configuration before you can create a relay."
	>
		<button class="mod-cta" disabled={pending || !relayManager.user} aria-busy={pending} on:click={create}>
			Create relay
		</button>
	</SettingItem>
</SettingGroup>
{#if error}<div class="form-error" role="alert">{error}</div>{/if}

<style>
	.form-error {
		color: var(--text-error);
		font-size: var(--font-ui-smaller);
		margin-top: var(--size-4-3);
		overflow-wrap: anywhere;
	}
</style>
