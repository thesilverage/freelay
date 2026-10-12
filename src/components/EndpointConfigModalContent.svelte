<script lang="ts">
	import type Live from "../main";
	import SettingGroup from "./SettingGroup.svelte";
	import SettingItem from "./SettingItem.svelte";
	export let plugin: Live;
	export let onClose: () => void;
	export let onApply: () => void;
	const manager = plugin.loginManager.getEndpointManager();
	let url = manager.getApiUrl();
	let error = "";
	let pending = false;
	let urlInput: HTMLInputElement;
	function dismissKeyboard(event: KeyboardEvent) {
		if (event.key === "Enter") {
			event.preventDefault();
			urlInput?.blur();
		}
	}

	async function save() {
		if (pending) return;
		urlInput?.blur();
		pending = true;
		error = "";
		try {
			const result = await manager.addTenant(url.trim());
			if (!result.success || !result.tenantId) throw new Error(result.error);
			plugin.loginManager.logout();
			await manager.switchToTenant(result.tenantId);
			onApply();
		} catch (e) {
			error = e instanceof Error ? e.message : "Invalid server URL";
		} finally {
			pending = false;
		}
	}
</script>

<form on:submit|preventDefault={save}>
	<SettingGroup>
		<SettingItem
			name="Server URL"
			description="Enter the canonical HTTPS URL supplied by your server administrator. HTTP is allowed only for a literal loopback address."
		>
			<input
				class="server-url"
				type="url"
				bind:this={urlInput}
				bind:value={url}
				placeholder="https://freelay.example/"
				enterkeyhint="done"
				autocapitalize="none"
				autocomplete="url"
				spellcheck="false"
				disabled={pending}
				on:keydown={dismissKeyboard}
			/>
		</SettingItem>
		<SettingItem
			name="Server identity"
			description="Each server URL has its own key. Changing servers disconnects this session; it does not transfer memberships or content."
		/>
	</SettingGroup>

	{#if error}
		<div class="form-error" role="alert">{error}</div>
	{/if}

	<div class="button-row">
		<button type="button" disabled={pending} on:click={onClose}>Cancel</button>
		<button class="mod-cta" type="submit" disabled={pending || !url.trim()} aria-busy={pending}>
			Save server
		</button>
	</div>
</form>

<style>
	.server-url {
		box-sizing: border-box;
		min-width: 0;
		width: min(28rem, 100%);
	}

	.form-error {
		color: var(--text-error);
		font-size: var(--font-ui-smaller);
		line-height: var(--line-height-tight);
		margin-top: var(--size-4-3);
		overflow-wrap: anywhere;
	}

	.button-row {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--size-4-2);
		margin-top: var(--size-4-4);
	}
</style>
