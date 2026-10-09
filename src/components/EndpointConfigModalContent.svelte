<script lang="ts">
	import type Live from "../main";
	export let plugin: Live;
	export let onClose: () => void;
	export let onApply: () => void;
	const manager = plugin.loginManager.getEndpointManager();
	let url = manager.getApiUrl();
	let error = "";
	let pending = false;
	async function save() {
		pending = true; error = "";
		try {
			plugin.loginManager.logout();
			const result = await manager.addTenant(url.trim());
			if (!result.success || !result.tenantId) throw new Error(result.error);
			await manager.switchToTenant(result.tenantId);
			onApply();
		} catch (e) { error = e instanceof Error ? e.message : "Invalid server URL"; }
		finally { pending = false; }
	}
</script>

<h2>Freelay server</h2>
<p>Enter the canonical HTTPS URL supplied by your server administrator. HTTP is permitted only for literal loopback development addresses.</p>
<label>Server URL <input type="url" bind:value={url} placeholder="https://freelay.example/" /></label>
<p>Each server URL has its own key. Changing servers disconnects this session; it does not transfer memberships or content.</p>
{#if error}<p role="alert">{error}</p>{/if}
<button disabled={pending} on:click={save}>Save server</button>
<button on:click={onClose}>Cancel</button>
