<script lang="ts">
	import type { RelayManager } from "../RelayManager";
	export let relayManager: RelayManager;
	export let onConfirm: (url?: string, providerId?: string, organizationId?: string) => Promise<void>;
	let pending = false;
	let error = "";
	async function create() {
		pending = true;
		try { await onConfirm(); }
		catch (e) { error = e instanceof Error ? e.message : "Creation failed"; }
		finally { pending = false; }
	}
</script>
<h2>Create a relay</h2>
<p>Your configured server already hosts Freelay. A server administrator must add your public key to its Owner configuration before you can create a relay.</p>
{#if error}<p role="alert">{error}</p>{/if}
<button disabled={pending || !relayManager.user} on:click={create}>Create relay</button>
