import { Platform } from "obsidian";
import { nodeRequestUrl } from "../NodeHttp";
import type { Transport } from "./Session";

/** Auth requests must reject redirects. Obsidian requestUrl cannot promise this
 * on mobile, so use browser fetch there and explicit operator CORS origins. */
export const controlTransport: Transport = async (url, options) => {
	if (!Platform.isDesktopApp) return fetch(url, options);
	const headers: Record<string, string> = {};
	new Headers(options.headers).forEach((value, key) => { headers[key] = value; });
	const response = await nodeRequestUrl({url, method: options.method, headers, body: options.body as string | undefined, throw: false}, {redirect: "error", signal: options.signal ?? undefined, maxResponseBytes: 8 * 1024 * 1024});
	return new Response([204, 304].includes(response.status) ? null : response.arrayBuffer, {status: response.status, headers: response.headers});
};
