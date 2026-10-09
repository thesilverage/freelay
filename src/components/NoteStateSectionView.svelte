<script lang="ts">
	import type { Readable } from "svelte/store";
	import type { NoteStateViewModel } from "../ui/NoteStateSection";

	export let viewModel: Readable<NoteStateViewModel>;
</script>

<div class="freelay-note-state-header">
	<div class="freelay-note-state-title">{$viewModel.title}</div>
	<div class="freelay-note-state-pill freelay-note-state-{$viewModel.verdict.cls}">
		{$viewModel.verdict.label}
	</div>
</div>

{#each $viewModel.rows as row (row.label)}
	<div class="freelay-note-state-row">
		<span class="freelay-note-state-label">{row.label}</span>
		<span
			class:freelay-note-state-ok={row.cls === "ok"}
			class:freelay-note-state-warn={row.cls === "warn"}
			class:freelay-note-state-bad={row.cls === "bad"}
			class:freelay-note-state-muted={row.cls === "muted"}
			class:freelay-note-state-mono={row.mono}
			class="freelay-note-state-value"
		>
			{row.value}
		</span>
	</div>
{/each}
