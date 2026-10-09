<script lang="ts">
	import { onMount } from "svelte";
	import type Live from "../main";
	export let plugin: Live;
	const lm = plugin.loginManager;
	let connected = lm.loggedIn;
	let name = plugin.loginSettings.get().name || "";
	let publicKey = "";
	let fingerprint = "";
	let error = "";
	let pending = false;
	let replacementKey = "";
	let replacementFingerprint = "";
	let replacementInvite = "";
	let replacementStatus = "";
	let confirmReplacement = false;
	let confirmErase = false;
	async function keyAction(operation: () => Promise<void>) {
		if (pending) return;
		pending = true; error = "";
		try { await operation(); }
		catch (e) { error = e instanceof Error ? e.message : "Identity operation failed"; }
		finally { pending = false; }
	}
	function stageReplacement() {
		return keyAction(async () => {
			const keys = lm.replacement().sessions.identity;
			replacementKey = await keys.publicKey();
			replacementFingerprint = await keys.fingerprint();
		});
	}
	function verifyReplacement() {
		return keyAction(async () => {
			const next = lm.replacement();
			if (replacementInvite.trim()) {
				await next.accept(replacementInvite.trim(), name.trim() || "Freelay user");
				replacementInvite = "";
			}
			const profile = await next.me();
			if (!profile.registered) throw new Error("This replacement key has not been registered. Ask the administrator or accept an invitation.");
			const state = await next.state();
			replacementStatus = `Replacement can see ${state.relays.length} relays and ${state.folders.length} shared folders. Check that it has every membership you need.`;
		});
	}
	async function identity() {
		try {
			const keys = lm.identity();
			publicKey = await keys.publicKey();
			fingerprint = await keys.fingerprint();
			error = "";
		} catch (e) { error = e instanceof Error ? e.message : "Identity unavailable"; }
	}
	async function connect() {
		pending = true; error = "";
		try {
			await lm.login();
			if (name.trim()) await lm.setName(name.trim());
		} catch (e) { error = e instanceof Error ? e.message : "Connection failed"; }
		finally { pending = false; }
	}
	onMount(() => {
		const off = lm.on(() => { connected = lm.loggedIn; });
		return off;
	});
</script>

<section>
	<h2>Freelay</h2>
	<p>Relay, but free.</p>
	<button on:click={() => plugin.openEndpointConfigurationModal()}>Configure server</button>
	<label>Display name <input bind:value={name} maxlength="200" /></label>
	<button disabled={pending} on:click={connect}>{connected ? "Reconnect / save name" : "Connect"}</button>
	<button on:click={identity}>Show public key</button>
	{#if publicKey}
		<p>Give this public key to your server administrator to become an Owner. Users only need an invitation.</p>
		<label>Public key <input readonly value={publicKey} on:focus={(e) => e.currentTarget.select()} /></label>
		<p>Fingerprint: <code>{fingerprint}</code></p>
		<p>Your private key stays in Obsidian Secret Storage. There is no key export or import.</p>
	{/if}
	{#if error}<p role="alert">{error}</p>{/if}
	<details>
		<summary>Identity recovery and replacement</summary>
		<p>A replacement is a new principal. It does not inherit memberships. Your administrator must add its public key and repair ownership, or invite it as a User. The current key remains active until you confirm replacement.</p>
		<button disabled={pending} on:click={stageReplacement}>Prepare replacement key</button>
		{#if replacementKey}
			<label>Replacement public key <input readonly value={replacementKey} on:focus={(e) => e.currentTarget.select()} /></label>
			<p>Fingerprint: <code>{replacementFingerprint}</code></p>
			<label>Invitation for replacement (optional) <input type="password" bind:value={replacementInvite} autocomplete="off" /></label>
			<button disabled={pending} on:click={verifyReplacement}>Accept invitation / check replacement access</button>
			{#if replacementStatus}<p>{replacementStatus}</p>{/if}
			<label><input type="checkbox" bind:checked={confirmReplacement} /> I have checked the replacement's memberships.</label>
			<button disabled={pending || !confirmReplacement} on:click={() => keyAction(async () => {
				await lm.activateReplacement(); replacementKey = ""; replacementStatus = ""; publicKey = ""; confirmReplacement = false;
			})}>Activate replacement</button>
		{/if}
		<p>One previous key is retained in Secret Storage for rollback. Server-side revocation still requires the administrator; local erasure cannot revoke a stolen copy.</p>
		<button disabled={pending} on:click={() => keyAction(async () => { await lm.restorePreviousIdentity(); publicKey = ""; })}>Restore previous key</button>
		<label><input type="checkbox" bind:checked={confirmErase} /> Permanently erase this server profile's active, previous, and staged keys. I understand access may be lost.</label>
		<button class="mod-warning" disabled={pending || !confirmErase} on:click={() => keyAction(async () => {
			await lm.eraseLocalIdentity(); publicKey = ""; replacementKey = ""; replacementStatus = ""; confirmErase = false;
		})}>Erase local identity keys</button>
		<p>Obsidian has no public secret-entry deletion API. Erasure overwrites the values; empty entries can be removed in Obsidian's Keychain / Secret Storage settings. It does not erase backups.</p>
	</details>
	{#if connected}
		<p>Connected as {lm.user?.name}.</p>
		<button on:click={() => lm.logout()}>Disconnect</button>
		<slot />
	{/if}
</section>
