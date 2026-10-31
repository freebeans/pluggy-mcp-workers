/**
 * Ponto de entrada do Worker.
 *
 * - OAuthProvider (Cloudflare) faz o papel de servidor OAuth para o claude.ai:
 *   /register, /authorize, /token. O login em si é delegado ao GitHub
 *   (github-handler.ts), e só ALLOWED_GITHUB_LOGIN recebe token.
 * - /mcp só responde com token válido. Mesmo assim o login é conferido de novo
 *   aqui, para que trocar ALLOWED_GITHUB_LOGIN invalide tokens antigos na hora.
 */
import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { parseItemIds } from "./finance.ts";
import { GitHubHandler } from "./github-handler.ts";
import { pluggy } from "./pluggy.ts";
import { INSTRUCTIONS, registerTools } from "./tools.ts";
import { isAllowed, type Props } from "./utils.ts";

function createServer() {
	const server = new McpServer({ name: "pluggy-pessoal", version: "0.1.0" }, { instructions: INSTRUCTIONS });
	const items = parseItemIds(env.PLUGGY_ITEM_IDS);
	if (!items.length) throw new Error("PLUGGY_ITEM_IDS não configurado.");
	registerTools(server, {
		p: pluggy({ clientId: env.PLUGGY_CLIENT_ID, clientSecret: env.PLUGGY_CLIENT_SECRET }),
		items,
		tz: env.TIME_ZONE || "America/Sao_Paulo",
	});
	return server;
}

const mcpHandler = createMcpHandler(createServer);

const apiHandler = {
	fetch(request: Request, bindings: Env, ctx: ExecutionContext) {
		const props = (ctx as ExecutionContext & { props?: Props }).props;
		if (!isAllowed(props?.login, bindings.ALLOWED_GITHUB_LOGIN)) {
			return new Response("Forbidden", { status: 403 });
		}
		return mcpHandler(request, bindings, ctx);
	},
} satisfies ExportedHandler<Env>;

export default new OAuthProvider<Env>({
	apiHandler,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
	// Todo token fica preso a esta URL.
	resourceMetadata: { resource: env.MCP_RESOURCE },
});
