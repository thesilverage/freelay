<script lang="ts">
	import { onMount } from "svelte";
	import type Live from "../main";
	import SettingGroup from "./SettingGroup.svelte";
	import SettingItem from "./SettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
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
	let recoveryOpen = false;

	function dismissKeyboard(event: KeyboardEvent) {
		if (event.key === "Enter") {
			event.preventDefault();
			(event.currentTarget as HTMLInputElement).blur();
		}
	}

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

<section class="freelay-profile-settings">
	<SettingItemHeading name="Freelay" helpText="Relay, but free." />
	<SettingGroup>
		<SettingItem
			name="Server"
			description={lm.getEndpointManager().getApiUrl() || "No server configured."}
		>
			<button on:click={() => plugin.openEndpointConfigurationModal()}>Configure</button>
		</SettingItem>
		<SettingItem
			name="Display name"
			description="The name other members see for this identity."
		>
			<input
				class="profile-input"
				bind:value={name}
				maxlength="200"
				enterkeyhint="done"
				on:keydown={dismissKeyboard}
			/>
		</SettingItem>
		<SettingItem
			name={connected ? "Connection" : "Connect to server"}
			description={connected
				? `Connected as ${lm.user?.name || name || "Freelay user"}.`
				: "Authenticate this device with its key and load your memberships."}
		>
			<div class="inline-controls">
				<button class:mod-cta={!connected} disabled={pending} aria-busy={pending} on:click={connect}>
					{connected ? "Reconnect / save name" : "Connect"}
				</button>
				{#if connected}<button on:click={() => lm.logout()}>Disconnect</button>{/if}
			</div>
		</SettingItem>
		<SettingItem
			name="Public key"
			description="Give this key to the server administrator to become an Owner. Users only need an invitation."
		>
			<button disabled={pending} on:click={identity}>{publicKey ? "Refresh" : "Show public key"}</button>
		</SettingItem>
		{#if publicKey}
			<SettingItem name="Device public key" description="Select the field to copy the complete key.">
				<input
					class="key-input"
					readonly
					value={publicKey}
					on:focus={(event) => event.currentTarget.select()}
				/>
			</SettingItem>
			<SettingItem name="Fingerprint" description="A shorter value for comparing this key through another channel.">
				<code class="fingerprint">{fingerprint}</code>
			</SettingItem>
			<SettingItem
				name="Private key"
				description="The private key stays in Obsidian Secret Storage. Freelay does not provide key export or import."
			/>
		{/if}
	</SettingGroup>

	{#if error}<div class="form-error" role="alert">{error}</div>{/if}

	<SettingItemHeading name="Identity recovery" />
	<SettingGroup>
		<SettingItem
			name="Replace or erase this identity"
			description="Use these controls only when recovering access or intentionally replacing this device's key."
		>
			<button on:click={() => recoveryOpen = !recoveryOpen} aria-expanded={recoveryOpen}>
				{recoveryOpen ? "Hide controls" : "Show controls"}
			</button>
		</SettingItem>
		{#if recoveryOpen}
			<SettingItem
				name="Prepare replacement"
				description="A replacement is a new principal and does not inherit memberships. Keep the current key active until you have checked the replacement's access."
			>
				<button disabled={pending} on:click={stageReplacement}>Prepare replacement key</button>
			</SettingItem>
			{#if replacementKey}
				<SettingItem name="Replacement public key" description="Give this key to the administrator, or register it with an invitation below.">
					<input
						class="key-input"
						readonly
						value={replacementKey}
						on:focus={(event) => event.currentTarget.select()}
					/>
				</SettingItem>
				<SettingItem name="Replacement fingerprint" description="Compare this value before changing server access.">
					<code class="fingerprint">{replacementFingerprint}</code>
				</SettingItem>
				<SettingItem
					name="Invitation"
					description="Optional. Accept an invitation with the replacement key, then verify its access."
				>
					<div class="inline-controls">
						<input
							class="profile-input"
							type="password"
							bind:value={replacementInvite}
							autocomplete="off"
							enterkeyhint="done"
							on:keydown={dismissKeyboard}
						/>
						<button disabled={pending} on:click={verifyReplacement}>Check access</button>
					</div>
				</SettingItem>
				{#if replacementStatus}
					<SettingItem name="Access check" description={replacementStatus} />
				{/if}
				<SettingItem
					name="Activate replacement"
					description="The previous key is retained locally for one rollback. Server-side revocation still requires the administrator."
				>
					<div class="stacked-controls">
						<label class="confirmation">
							<input type="checkbox" bind:checked={confirmReplacement} />
							<span>I have checked the replacement's memberships.</span>
						</label>
						<button disabled={pending || !confirmReplacement} on:click={() => keyAction(async () => {
							await lm.activateReplacement(); replacementKey = ""; replacementStatus = ""; publicKey = ""; confirmReplacement = false;
						})}>Activate replacement</button>
					</div>
				</SettingItem>
			{/if}
			<SettingItem
				name="Restore previous key"
				description="Restore the one previous identity retained in Secret Storage."
			>
				<button disabled={pending} on:click={() => keyAction(async () => { await lm.restorePreviousIdentity(); publicKey = ""; })}>
					Restore previous key
				</button>
			</SettingItem>
			<SettingItem
				name="Erase local identity keys"
				description="Permanently overwrite this server profile's active, previous, and staged keys. This does not revoke stolen copies or erase backups. Empty entries can be removed in Obsidian's Keychain / Secret Storage settings."
			>
				<div class="stacked-controls">
					<label class="confirmation">
						<input type="checkbox" bind:checked={confirmErase} />
						<span>I understand that access may be lost.</span>
					</label>
					<button class="mod-warning" disabled={pending || !confirmErase} on:click={() => keyAction(async () => {
						await lm.eraseLocalIdentity(); publicKey = ""; replacementKey = ""; replacementStatus = ""; confirmErase = false;
					})}>Erase local keys</button>
				</div>
			</SettingItem>
		{/if}
	</SettingGroup>

	{#if connected}<slot />{/if}
</section>

<style>
	.profile-input,
	.key-input {
		box-sizing: border-box;
		min-width: 0;
		max-width: 100%;
	}

	.inline-controls {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--size-4-2);
		max-width: 100%;
	}

	.stacked-controls {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: var(--size-4-2);
		max-width: 100%;
	}

	.profile-input {
		width: min(18rem, 100%);
	}

	.key-input {
		width: min(28rem, 100%);
		font-family: var(--font-monospace);
		font-size: var(--font-ui-smaller);
	}

	.fingerprint {
		font-size: var(--font-ui-smaller);
		overflow-wrap: anywhere;
		user-select: text;
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

	.confirmation input {
		flex: none;
		margin-top: 0.15em;
	}

	.form-error {
		color: var(--text-error);
		font-size: var(--font-ui-smaller);
		margin: var(--size-4-2) 0;
		overflow-wrap: anywhere;
	}
</style>
