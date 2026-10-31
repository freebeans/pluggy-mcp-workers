/**
 * Funções do fluxo OAuth com o GitHub (adaptadas do template
 * cloudflare/ai/demos/remote-mcp-github-oauth).
 */

/** Monta a URL de autorização do provedor externo (GitHub). */
export function getUpstreamAuthorizeUrl({
	upstream_url,
	client_id,
	scope,
	redirect_uri,
	state,
}: {
	upstream_url: string;
	client_id: string;
	scope: string;
	redirect_uri: string;
	state?: string;
}) {
	const upstream = new URL(upstream_url);
	upstream.searchParams.set("client_id", client_id);
	upstream.searchParams.set("redirect_uri", redirect_uri);
	upstream.searchParams.set("scope", scope);
	if (state) upstream.searchParams.set("state", state);
	upstream.searchParams.set("response_type", "code");
	return upstream.href;
}

/** Troca o código de autorização do GitHub por um access token. */
export async function fetchUpstreamAuthToken({
	client_id,
	client_secret,
	code,
	redirect_uri,
	upstream_url,
}: {
	code: string | undefined;
	upstream_url: string;
	client_secret: string;
	redirect_uri: string;
	client_id: string;
}): Promise<[string, null] | [null, Response]> {
	if (!code) {
		return [null, new Response("Missing code", { status: 400 })];
	}

	const resp = await fetch(upstream_url, {
		body: new URLSearchParams({ client_id, client_secret, code, redirect_uri }).toString(),
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		method: "POST",
	});
	if (!resp.ok) {
		console.log(await resp.text());
		return [null, new Response("Failed to fetch access token", { status: 500 })];
	}
	const body = await resp.formData();
	const accessToken = body.get("access_token") as string;
	if (!accessToken) {
		return [null, new Response("Missing access token", { status: 400 })];
	}
	return [accessToken, null];
}

/** Login do GitHub de quem está autenticado. Usado só para o controle de acesso. */
export async function fetchGitHubLogin(accessToken: string): Promise<string | null> {
	const resp = await fetch("https://api.github.com/user", {
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${accessToken}`,
			"User-Agent": "pluggy-mcp-workers",
		},
	});
	if (!resp.ok) return null;
	const user = (await resp.json()) as { login?: string };
	return user.login ?? null;
}

/** Logins do GitHub não diferenciam maiúsculas. Sem login configurado, ninguém entra. */
export function isAllowed(login: string | null | undefined, allowed: string | undefined): boolean {
	if (!login || !allowed?.trim()) return false;
	return login.toLowerCase() === allowed.trim().toLowerCase();
}

/**
 * Dados gravados (criptografados) no token emitido ao claude.ai. Só o login:
 * o access token do GitHub não é guardado porque não é usado depois do login.
 */
export type Props = {
	login: string;
};
