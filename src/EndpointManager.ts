import { canonicalUrl } from "./control/Identity";
import type { NamespacedSettings } from "./SettingsStorage";

// Retain field names during the UI port. There is no default vendor endpoint.
export interface TenantConfig { id: string; name: string; tenantUrl: string; isValidated: boolean }
export interface EndpointSettings {
	tenants?: TenantConfig[];
	activeTenantId?: string;
	_lastValidationError?: string;
	_lastValidationAttempt?: number;
}
export class EndpointManager {
	constructor(private settings: NamespacedSettings<EndpointSettings>) {}
	getApiUrl(): string {
		const settings = this.settings.get();
		const url = settings.tenants?.find(t => t.id === settings.activeTenantId)?.tenantUrl;
		return url ? canonicalUrl(url).replace(/\/$/, "") : "";
	}
	getAuthUrl(): string { return this.getApiUrl(); }
	hasValidatedEndpoints(): boolean { return !!this.getApiUrl(); }
	getDefaultUrls(): {apiUrl: string; authUrl: string} { return {apiUrl: "", authUrl: ""}; }
	isStaging(): boolean { return false; }
	clearValidatedEndpoints(): void { void this.settings.update(s => ({...s, activeTenantId: undefined})); }
	async validateAndSetEndpoints(timeoutMs?: number): Promise<{success: boolean; error?: string; licenseInfo?: unknown}> {
		try { return this.getApiUrl() ? {success: true} : {success: false, error: "Configure a server URL first."}; }
		catch { return {success: false, error: "Invalid server URL. Use HTTPS (or literal HTTP loopback for development)."}; }
	}
	async addTenant(value: string): Promise<{success: boolean; error?: string; tenantId?: string}> {
		try {
			const url = canonicalUrl(value);
			await this.settings.update(s => ({...s, tenants: [...(s.tenants || []).filter(t => t.id !== url), {id: url, name: url, tenantUrl: url, isValidated: true}]}));
			return {success: true, tenantId: url};
		} catch { return {success: false, error: "Invalid server URL."}; }
	}
	async switchToTenant(id: string): Promise<{success: boolean; error?: string}> {
		if (!this.settings.get().tenants?.some(t => t.id === id)) return {success: false, error: "Unknown server"};
		await this.settings.update(s => ({...s, activeTenantId: id}));
		return {success: true};
	}
	async removeTenant(id: string): Promise<boolean> {
		await this.settings.update(s => ({...s, tenants: s.tenants?.filter(t => t.id !== id), activeTenantId: s.activeTenantId === id ? undefined : s.activeTenantId}));
		return true;
	}
}
