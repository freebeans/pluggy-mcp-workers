/**
 * Secrets do Worker (cadastrados no painel da Cloudflare ou com
 * `npx wrangler secret put`). Ficam fora do wrangler.jsonc de propósito: assim
 * o primeiro deploy funciona antes de eles existirem. Os demais bindings são
 * gerados em worker-configuration.d.ts por `npm run cf-typegen`.
 */
interface Secrets {
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	COOKIE_ENCRYPTION_KEY: string;
	PLUGGY_CLIENT_ID: string;
	PLUGGY_CLIENT_SECRET: string;
	/** Ids dos items, separados por vírgula. Aceita "Nome=id". */
	PLUGGY_ITEM_IDS: string;
}
interface Env extends Secrets {}
declare namespace Cloudflare {
	interface Env extends Secrets {}
}
