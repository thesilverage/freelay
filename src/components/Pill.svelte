<script lang="ts">
	import { Satellite, Layers, Unplug } from "lucide-svelte";
	import type { ConnectionStatus } from "src/HasProvider";
	import type { RemoteSharedFolder } from "src/Relay";
	export let status: ConnectionStatus = "disconnected";
	export let relayId: string | undefined;
	export let remote: RemoteSharedFolder | undefined;
	export let progress = 0;
	export let showProgress = false;
	export let localOnly: boolean = false;
	export let enableDraftMode: boolean = false;
	export let syncStatus: "pending" | "running" | "completed" | "failed" =
		"pending";

	$: effectiveLocalOnly = enableDraftMode && localOnly;
	$: satelliteClass = effectiveLocalOnly
		? "freelay-paused"
		: `freelay-${status}`;
	$: satelliteLabel = effectiveLocalOnly
			? `${remote?.relay.name || "relay"} (paused)`
			: `${remote?.relay.name || "relay"} (${status})`;
</script>

<div class="freelay-folder-icons">
	<!-- Always show progress while running, regardless of completion -->
	{#if showProgress}
		<span class="freelay-progress-text freelay-{syncStatus}" style="opacity: 1">
			{progress}%
		</span>
	{/if}
	{#if relayId}
		<span class="notebook freelay-icon hidden" aria-label="Tracking Changes">
			<Layers class="inline-icon" style="width: 0.8em" />
		</span>
		<span
			class="satellite freelay-icon {satelliteClass}"
			aria-label={satelliteLabel}
		>
			<Satellite class="inline-icon" />
		</span>
	{:else}
		<span class="notebook freelay-icon" aria-label="Tracking Changes">
			<Layers class="inline-icon" style="width: 0.8em" />
		</span>
	{/if}
</div>

<style>
	.freelay-folder-icons {
		display: inline-flex;
		align-items: center;
		vertical-align: middle;
		border-radius: var(--radius-m);
		transition: width 0.3s ease;
		margin-right: 0.6em;
		padding-left: 0.2em;
		padding-right: 0.2em;
		background-color: var(--color-base-05);
		position: relative;
	}

	.freelay-icon {
		margin-right: 0.2em;
		margin-left: 0.2em;
		width: 1em;
		display: flex;
		transition: display 0.3s ease;
	}

	span.freelay-connected {
		color: var(--color-accent);
	}
	span.freelay-disconnected {
		color: var(--color-base-40);
	}
	span.freelay-paused {
		color: var(--color-yellow);
	}
	/* Held deletions read as pending outbound ops: a red count with an
	   outbound arrow ("28↑") beside the folder's ordinary connection icon —
	   the folder itself is neither paused nor disconnected, so the icon
	   stays truthful. The arrow is an SVG sized to the count's font so the
	   pair centers on one text line inside the pill's short row instead of
	   a text arrow glyph riding above the number's line box. */
	.freelay-held-count {
		color: var(--color-red);
		font-size: 0.75em;
		margin-right: 0.35em;
		font-variant-numeric: tabular-nums;
		line-height: 1;
		display: inline-flex;
		align-items: center;
	}
	/* Digits have no descenders, so their ink paints high of the flex
	   center by ~1px at this size; the arrow SVG centers exactly. Nudge
	   only the digits. */
	.freelay-held-digits {
		transform: translateY(1px);
	}
	.freelay-gated-clickable {
		cursor: pointer;
	}
	span.notebook {
		color: var(--color-accent);
	}

	span.hidden {
		display: none;
	}

	.freelay-progress-text {
		margin-right: 0.4em;
		font-size: 0.8em;
		color: var(--color-accent);
		opacity: 1;
		transition: opacity 0.3s ease;
	}

	.freelay-progress-text.completed {
		animation: fadeOutDelay 0.3s ease forwards;
	}

	.freelay-progress-text.failed {
		color: var(--color-red);
	}

	@keyframes fadeOutDelay {
		0%,
		50% {
			opacity: 1;
		}
		100% {
			opacity: 0;
			display: none;
		}
	}
</style>
