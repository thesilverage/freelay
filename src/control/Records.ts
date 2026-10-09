/** Data-only shape used by upstream's observable collection adapters.
 * This is not a PocketBase client or a wire protocol. */
export interface RecordModel {
	id: string;
	collectionId: string;
	collectionName: string;
	created: string;
	updated: string;
	expand?: Record<string, RecordModel | RecordModel[]>;
	[key: string]: unknown;
}
export type AuthModel = RecordModel | null;
export interface ListResult<T> {items: T[]}
