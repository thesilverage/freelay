/**
 * # SettingsStorage Module
 *
 * This module provides a centralized mechanism for components in the codebase
 * to access and manipulate settings stored in a central JSON file.
 *
 * The `SettingsStorage` allows components to:
 *
 * - Read and write settings in a namespaced way.
 * - Subscribe to updates and be notified when changes occur.
 * - Support complex path patterns for accessing nested settings.
 * - Write changes back to the centralized JSON file efficiently.
 *
 * ## Design Goals
 *
 * - **Centralized Settings Management**: Provide a central JSON storage for settings
 *   that can be accessed and modified by various components.
 *
 * - **Namespaced Access**: Allow components to access settings within a specific namespace,
 *   so they can operate on a subset of settings without interfering with others.
 *
 * - **Subscriptions**: Components can subscribe to changes in their namespace and be notified when updates occur.
 *
 * - **Flexible Path Pattern Language**: Provide a flexible path pattern language
 *   that allows for complex queries into the JSON structure, including wildcard and key/value matching within arrays.
 *
 * - **Developer Ergonomics**: The system should be easy and intuitive for developers to use,
 *   with clear APIs and predictable behavior.
 *
 * ## Path Pattern Language
 *
 * The path pattern language allows for specifying paths into the JSON settings object using:
 *
 * - **Slash (`/`) Notation**: Navigate nested properties by separating path segments with slashes `/`.
 * - **Array Item Matching (`[key=value]`)**: Match items within an array based on a specific key-value condition.
 * - **Wildcard Matching (`(pattern)`)**: Use wildcards to match property names using glob-style patterns.
 *
 * ### Syntax Elements
 *
 * - **Slash Notation**:
 *   - Used to navigate nested properties.
 *   - **Example**: `"user/settings"` navigates to `data["user"]["settings"]`.
 *
 * - **Array Item Matching**:
 *   - **Syntax**: `arrayPropertyName/[key=value]`
 *   - **Example**: `"folders/[id=123]"` matches the item in the `folders` array where `id` equals `"123"`.
 *
 * - **Wildcard Matching**:
 *   - **Syntax**: `(pattern)`
 *   - The wildcard `*` matches any sequence of characters.
 *   - **Example**: `"(enable*)"` matches all properties starting with `"enable"`, such as `"enableFeatureX"`, `"enableLogging"`, etc.
 *
 * ### Examples
 *
 * **Accessing a Specific Folder by ID**:
 *
 * ```typescript
 * const folderSettings = new NamespacedSettings(
 *   settings,
 *   "folders/[id=123]",
 *   defaultFolderSettings
 * );
 * ```
 *
 * **Accessing All Feature Flags Starting with `enable`**:
 *
 * ```typescript
 * const featureFlags = new NamespacedSettings(settings, "(enable*)", {});
 * ```
 *
 * **Accessing Nested Properties**:
 *
 * ```typescript
 * const userPreferences = new NamespacedSettings(
 *   settings,
 *   "users/[id=456]/preferences",
 *   defaultPreferences
 * );
 * ```
 *
 * **Subscribing to Updates in a Namespace**:
 *
 * ```typescript
 * folderSettings.subscribe((value) => {
 *   this.log("Folder settings updated:", value);
 * });
 * ```
 *
 * ## Implementation Details
 *
 * The `Settings` class manages the loading and saving of the settings data from a storage adapter.
 *
 * - **Settings<T>**:
 *   - Manages the settings data for type `T`.
 *   - Provides methods to load from and save to the storage adapter.
 *   - Notifies subscribers when the data changes.
 *
 * The `NamespacedSettings` class provides a namespaced view of the settings, supporting complex path patterns.
 *
 * - **NamespacedSettings<T, Parent>**:
 *   - Provides namespaced access to a subset of the settings data.
 *   - Supports pattern matching in paths for flexible data access.
 *   - Allows subscribing to changes within the namespace.
 *
 * ### Storage Adapters
 *
 * - **ObsidianSettingsStorage**: An adapter for Obsidian's storage system.
 * - **MemorySettingsStorage**: An in-memory adapter for testing or temporary storage.
 *
 * ### Error Handling
 *
 * - Errors are handled using the `SettingsError` class, providing informative error messages and the path where the error occurred.
 */

import { Observable, type Unsubscriber } from "./observable/Observable";
import { PostOffice } from "./observable/Postie";

export type PathSegment = string | number;
export type Path = PathSegment[];

export interface BasePattern {
	readonly type: string;
	readonly level: number;
}

export interface ArrayMatchPattern extends BasePattern {
	readonly type: "arrayMatch";
	readonly key: string;
	readonly value: string;
}

export interface WildcardPattern extends BasePattern {
	readonly type: "wildcard";
	readonly wildcardPattern: string;
}

export type PathPattern = ArrayMatchPattern | WildcardPattern;

export class SettingsError extends Error {
	constructor(
		message: string,
		public readonly path?: string,
	) {
		super(message);
		this.name = "SettingsError";
	}
}

export interface StorageAdapter<T> {
	loadData(): Promise<T | null>;
	saveData(data: T): Promise<void>;
}

export interface ISettingsStorage {
	getData<T>(): T;
	setData<T>(data: T): Promise<void>;
	updateData<T>(updater: (data: T) => T): Promise<void>;
}

export class ObsidianSettingsStorage implements ISettingsStorage {
	constructor(private plugin: StorageAdapter<unknown>) {}

	getData<T>(): T {
		return this.plugin.loadData() as T;
	}

	async setData<T>(data: T): Promise<void> {
		await this.plugin.saveData(data);
	}

	async updateData<T>(updater: (data: T) => T): Promise<void> {
		const current = this.getData<T>();
		const updated = updater(current);
		await this.setData(updated);
	}
}

export class MemorySettingsStorage implements ISettingsStorage {
	private data: unknown = null;

	getData<T>(): T {
		return this.data as T;
	}

	async setData<T>(data: T): Promise<void> {
		this.data = data;
	}

	async updateData<T>(updater: (data: T) => T): Promise<void> {
		const current = this.getData<T>();
		const updated = updater(current);
		await this.setData(updated);
	}
}

export class Settings<T> extends Observable<T> {
	private data: T;
	private _loaded = false;
	private updateQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly storage: StorageAdapter<T>,
		private readonly defaults: T,
	) {
		super("Settings");
		this.data = { ...defaults };
	}

	async load(): Promise<void> {
		const stored = await this.storage.loadData();
		this.data = {
			...this.defaults,
			...(stored || {}),
		};
		this._loaded = true;
		this.log("Loaded settings from disk:", this.data);
	}

	async save(): Promise<void> {
		if (!this._loaded) {
			this.warn("Attempted to save before loading settings from disk");
			return;
		}
		this.log("Saving settings to disk:", this.data);
		await this.storage.saveData(this.data);
	}

	get(): T {
		return this.data;
	}

	async update(updater: (current: T) => T): Promise<void> {
		if (!this._loaded) {
			this.warn("Attempted to update before loading settings from disk");
			return;
		}

		const operation = this.updateQueue.then(async () => {
			if (!this._loaded) return;
			const updated = updater(this.data);
			const stored = await this.storage.loadData();
			if (JSON.stringify(updated) === JSON.stringify(stored)) {
				this.debug("updated matches disk, no change");
				return;
			}
			this.data = updated;
			await this.save();
			this.notifyListeners();
		});
		this.updateQueue = operation.catch(() => undefined);
		return operation;
	}

	override notifyListeners() {
		for (const listener of this._listeners) {
			listener(this.data);
		}
	}

	override destroy() {
		if (this.destroyed) return;
		super.destroy();
		this.data = null as unknown as typeof this.data;
		this._loaded = false;
		const fields = this as unknown as { storage: unknown; defaults: unknown };
		fields.storage = null;
		fields.defaults = null;
	}
}

export type SettingsTree = Settings<Record<string, unknown>>;

export class NamespacedSettings<
	T extends object,
	Parent extends Record<string, unknown> = Record<string, unknown>,
> extends Observable<T> {
	private readonly path: string[];
	private unsub?: Unsubscriber;
	private lastKnown?: T;

	constructor(
		public readonly settings: SettingsTree,
		namespace: string,
	) {
		super(`NamespacedSettings[${namespace}]`);
		this.validatePath(namespace);
		this.path = namespace.split("/").filter(Boolean);
		this.lastKnown = this.getNestedValue(this.settings.get());
		this.setupSubscription();
	}

	private validatePath(path: string): void {
		if (!path) {
			throw new SettingsError("Path cannot be empty");
		}
		if (path.startsWith("/") || path.endsWith("/")) {
			throw new SettingsError(`Invalid path format: ${path}`);
		}
	}

	private createPatternRegex(pattern: string): string {
		return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\*", ".*");
	}

	private setupSubscription(): void {
		this.unsub = this.settings.subscribe(() => {
			const newValue = this.getNestedValue(this.settings.get());
			if (this.lastKnown === undefined && newValue === undefined) return;
			if (JSON.stringify(this.lastKnown) !== JSON.stringify(newValue)) {
				this.lastKnown = newValue;
				this.notifyListeners();
			}
		});
	}

	destroy() {
		if (this.destroyed) return;

		if (this.unsub) {
			this.unsub();
			this.unsub = undefined;
		}

		this._listeners.clear();
		this.destroyed = true;
	}

	get(): T {
		if (this.destroyed) {
			throw new SettingsError("Cannot use destroyed settings", this.getPath());
		}

		const data = this.settings.get();
		if (!data) {
			return {} as T;
		}

		const value = this.getNestedValue(data);
		if (value === undefined) {
			return {} as T;
		}

		return value;
	}

	async set(value: T): Promise<void> {
		if (this.destroyed) {
			throw new SettingsError("Cannot use destroyed settings", this.getPath());
		}

		if (value === undefined) {
			throw new SettingsError("Cannot set undefined value", this.getPath());
		}

		try {
			await this.settings.update((data) => {
				return this.setNestedValue(data, value);
			});
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";
			throw new SettingsError(
				`Failed to set value at path ${this.getPath()}: ${errorMessage}`,
				this.getPath(),
			);
		}
	}

	async update(updater: (current: T) => T, force = false): Promise<void> {
		if (this.destroyed) {
			throw new SettingsError("Cannot use destroyed settings", this.getPath());
		}

		const current = this.get();
		const updated = updater(current);

		if (!force && JSON.stringify(current) === JSON.stringify(updated)) {
			return;
		}

		await this.set(updated);
	}

	async flush(): Promise<void> {
		if (this.destroyed) {
			throw new SettingsError("Cannot use destroyed settings", this.getPath());
		}

		await this.update((current) => current, true);
	}

	private getNestedValue(obj: Record<string, unknown>): T | undefined {
		let current: unknown = obj;
		for (let index = 0; index < this.path.length; index++) {
			const segment = this.path[index];
			const arrayMatch = this.parseArrayMatch(segment);
			const wildcard = this.parseWildcard(segment);

			if (arrayMatch) {
				if (!Array.isArray(current)) return undefined;
				current = current.find(
					(item) => this.isRecord(item) && item[arrayMatch.key] === arrayMatch.value,
				);
			} else if (wildcard) {
				if (index !== this.path.length - 1 || !this.isRecord(current)) {
					return undefined;
				}
				const filtered: Record<string, unknown> = {};
				for (const [key, entry] of Object.entries(current)) {
					if (wildcard.test(key)) filtered[key] = entry;
				}
				current = filtered;
			} else {
				if (!this.isRecord(current)) return undefined;
				current = current[segment];
			}

			if (current === undefined) return undefined;
		}

		return current as T;
	}

	private setNestedValue(
		obj: Record<string, unknown>,
		value: T,
	): Record<string, unknown> {
		return this.setPathValue(obj, 0, value) as Record<string, unknown>;
	}

	private setPathValue(current: unknown, index: number, value: unknown): unknown {
		if (index === this.path.length) return value;

		const segment = this.path[index];
		const arrayMatch = this.parseArrayMatch(segment);
		const wildcard = this.parseWildcard(segment);

		if (arrayMatch) {
			const entries = Array.isArray(current) ? [...current] : [];
			const matchIndex = entries.findIndex(
				(item) => this.isRecord(item) && item[arrayMatch.key] === arrayMatch.value,
			);
			const existing = matchIndex >= 0 && this.isRecord(entries[matchIndex])
				? entries[matchIndex]
				: { [arrayMatch.key]: arrayMatch.value };
			let updated = index === this.path.length - 1 && this.isRecord(value)
				? { ...existing, ...value }
				: this.setPathValue(existing, index + 1, value);
			if (this.isRecord(updated)) {
				updated = { ...updated, [arrayMatch.key]: arrayMatch.value };
			}
			if (matchIndex >= 0) entries[matchIndex] = updated;
			else entries.push(updated);
			return entries;
		}

		if (wildcard) {
			if (index !== this.path.length - 1 || !this.isRecord(value)) {
				throw new SettingsError("Wildcard paths must be terminal object paths", this.getPath());
			}
			const result = this.isRecord(current) ? { ...current } : {};
			for (const [key, entry] of Object.entries(value)) {
				if (wildcard.test(key)) result[key] = entry;
			}
			return result;
		}

		const result = this.isRecord(current) ? { ...current } : {};
		result[segment] = this.setPathValue(result[segment], index + 1, value);
		return result;
	}

	private deletePathValue(current: unknown, index: number): [unknown, boolean] {
		if (index >= this.path.length) return [current, false];

		const segment = this.path[index];
		const arrayMatch = this.parseArrayMatch(segment);
		const wildcard = this.parseWildcard(segment);

		if (arrayMatch) {
			if (!Array.isArray(current)) return [current, false];
			if (index === this.path.length - 1) {
				const filtered = current.filter(
					(item) => !this.isRecord(item) || item[arrayMatch.key] !== arrayMatch.value,
				);
				return [filtered, filtered.length !== current.length];
			}
			const matchIndex = current.findIndex(
				(item) => this.isRecord(item) && item[arrayMatch.key] === arrayMatch.value,
			);
			if (matchIndex < 0) return [current, false];
			const [updated, changed] = this.deletePathValue(current[matchIndex], index + 1);
			if (!changed) return [current, false];
			const entries = [...current];
			entries[matchIndex] = updated;
			return [entries, true];
		}

		if (wildcard) {
			if (index !== this.path.length - 1 || !this.isRecord(current)) {
				return [current, false];
			}
			const result = { ...current };
			let changed = false;
			for (const key of Object.keys(result)) {
				if (wildcard.test(key)) {
					delete result[key];
					changed = true;
				}
			}
			return [result, changed];
		}

		if (!this.isRecord(current) || !(segment in current)) return [current, false];
		const result = { ...current };
		if (index === this.path.length - 1) {
			delete result[segment];
			return [result, true];
		}
		const [updated, changed] = this.deletePathValue(result[segment], index + 1);
		if (!changed) return [current, false];
		result[segment] = updated;
		return [result, true];
	}

	private parseArrayMatch(segment: string): { key: string; value: string } | undefined {
		const match = segment.match(/^\[(\w+)=(.+)\]$/);
		return match ? { key: match[1], value: match[2] } : undefined;
	}

	private parseWildcard(segment: string): RegExp | undefined {
		const match = segment.match(/^\((.+?)\)$/);
		return match ? new RegExp(`^${this.createPatternRegex(match[1])}$`) : undefined;
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	getParent(): NamespacedSettings<Parent> {
		if (this.destroyed) {
			throw new SettingsError("Cannot use destroyed settings", this.getPath());
		}

		const parentPath = this.path.slice(0, -1).join("/");
		return new NamespacedSettings<Parent>(this.settings, parentPath);
	}

	getChild<
		C extends object,
		R extends NamespacedSettings<C> = NamespacedSettings<C>,
	>(
		childPath: string,
		factory?: (settings: SettingsTree, path: string) => R,
	): R {
		const fullPath = [...this.path, childPath].join("/");
		if (factory) {
			return factory(this.settings, fullPath);
		}
		this.log("getChild", this.path, childPath, fullPath);
		return new NamespacedSettings<C>(this.settings, fullPath) as R;
	}

	getPath(): string {
		return this.path.join("/");
	}

	exists(): boolean {
		if (this.destroyed) {
			throw new SettingsError("Cannot use destroyed settings", this.getPath());
		}

		const data = this.settings.get();
		return this.getNestedValue(data) !== undefined;
	}

	async delete(): Promise<void> {
		if (this.destroyed) {
			throw new SettingsError("Cannot use destroyed settings", this.getPath());
		}

		await this.settings.update((data) => {
			const [updated, changed] = this.deletePathValue(data, 0);
			return changed ? updated as Record<string, unknown> : data;
		});
	}

	subscribe(run: (value: T) => void): Unsubscriber {
		if (this.destroyed) {
			throw new SettingsError("Cannot use destroyed settings", this.getPath());
		}

		this._listeners.add(run);
		run(this.get());
		return () => {
			this._listeners.delete(run);
			PostOffice.peekInstance()?.cancel(run);
		};
	}

	override notifyListeners() {
		if (this.destroyed) {
			return;
		}

		const value = this.get();
		for (const listener of this._listeners) {
			listener(value);
		}
	}
}
