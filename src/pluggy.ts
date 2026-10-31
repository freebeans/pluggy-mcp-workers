/**
 * Cliente mínimo da API da Pluggy.
 *
 * SOMENTE LEITURA: a única requisição que não é GET é o POST /auth, que troca
 * clientId + clientSecret por um apiKey. Não há nenhum outro método aqui, de
 * propósito, então não existe caminho no código que altere dados na Pluggy.
 */

const BASE_URL = "https://api.pluggy.ai";
/** Renova o apiKey (JWT de ~2h) com folga, antes de ele expirar no meio de uma consulta. */
const RENEW_MARGIN_MS = 10 * 60 * 1000;
/** Freio contra paginação sem fim: 20 páginas de 500 = 10 mil linhas por conta. */
const MAX_PAGES = 20;

export type PluggyCredentials = { clientId: string; clientSecret: string };

// ---- Tipos: só os campos que este servidor lê. --------------------------------

export type Item = {
	id: string;
	status: string;
	executionStatus?: string | null;
	lastUpdatedAt?: string | null;
	error?: { code?: string; message?: string } | null;
};

export type Account = {
	id: string;
	itemId: string;
	type: "BANK" | "CREDIT" | string;
	subtype?: string | null;
	name: string;
	marketingName?: string | null;
	balance: number;
	currencyCode?: string | null;
	creditData?: {
		brand?: string | null;
		level?: string | null;
		creditLimit?: number | null;
		availableCreditLimit?: number | null;
		balanceCloseDate?: string | null;
		balanceDueDate?: string | null;
		minimumPayment?: number | null;
	} | null;
};

export type Transaction = {
	id: string;
	accountId: string;
	description: string;
	descriptionRaw?: string | null;
	currencyCode?: string | null;
	amount: number;
	amountInAccountCurrency?: number | null;
	date: string;
	type: "DEBIT" | "CREDIT";
	status?: "POSTED" | "PENDING" | null;
	category?: string | null;
	categoryId?: string | null;
	operationType?: string | null;
	creditCardMetadata?: {
		installmentNumber?: number | null;
		totalInstallments?: number | null;
		totalAmount?: number | null;
		purchaseDate?: string | null;
		billId?: string | null;
		billForecastDate?: string | null;
	} | null;
};

export type Bill = {
	id: string;
	dueDate: string;
	billClosingDate?: string | null;
	totalAmount: number;
	totalAmountCurrencyCode?: string | null;
	minimumPaymentAmount?: number | null;
	financeCharges?: { type: string; amount: number; additionalInfo?: string | null }[] | null;
	payments?: { amount: number; paymentDate?: string | null }[] | null;
};

export type Investment = {
	id: string;
	itemId: string;
	name: string;
	type: string;
	subtype?: string | null;
	balance: number;
	currencyCode?: string | null;
	amountOriginal?: number | null;
	amountProfit?: number | null;
	annualRate?: number | null;
	lastTwelveMonthsRate?: number | null;
	dueDate?: string | null;
	issuer?: string | null;
	status?: string | null;
	[key: string]: unknown;
};

type Page<T> = { results: T[]; page?: number; totalPages?: number };
type CursorPage<T> = { results: T[]; next: string | null };

/** Erro com a mensagem que a Pluggy devolveu, sem o apiKey nem a URL completa. */
export class PluggyError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
		this.name = "PluggyError";
	}
}

// ---- apiKey em cache ------------------------------------------------------------
//
// Fica em memória no isolate do Worker. Um isolate atende várias requisições
// seguidas, então na prática o /auth é chamado poucas vezes por dia. Se o
// isolate for reciclado, o próximo pedido apenas autentica de novo.

let cached: { apiKey: string; expiresAt: number; clientId: string } | null = null;
let pending: Promise<string> | null = null;

function jwtExpiry(token: string): number {
	try {
		const payload = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
		if (typeof payload.exp === "number") return payload.exp * 1000;
	} catch {
		// Formato inesperado: cai no padrão abaixo.
	}
	return Date.now() + 60 * 60 * 1000;
}

async function apiKey(creds: PluggyCredentials): Promise<string> {
	if (cached && cached.clientId === creds.clientId && cached.expiresAt - RENEW_MARGIN_MS > Date.now()) {
		return cached.apiKey;
	}
	// Chamadas simultâneas compartilham a mesma autenticação.
	pending ??= (async () => {
		try {
			const res = await fetch(`${BASE_URL}/auth`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ clientId: creds.clientId, clientSecret: creds.clientSecret }),
			});
			if (!res.ok) throw new PluggyError(res.status, `Falha ao autenticar na Pluggy (HTTP ${res.status}). Confira PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET.`);
			const { apiKey: key } = (await res.json()) as { apiKey: string };
			cached = { apiKey: key, expiresAt: jwtExpiry(key), clientId: creds.clientId };
			return key;
		} finally {
			pending = null;
		}
	})();
	return pending;
}

// ---- GET ------------------------------------------------------------------------

async function get<T>(creds: PluggyCredentials, path: string, params: Record<string, string | undefined> = {}): Promise<T> {
	const url = new URL(path, BASE_URL);
	for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);

	for (let attempt = 0; ; attempt++) {
		const res = await fetch(url, { headers: { "X-API-KEY": await apiKey(creds), Accept: "application/json" } });
		if (res.ok) return (await res.json()) as T;

		// apiKey recusado (revogado ou expirado antes do previsto): autentica de novo, uma vez.
		if (res.status === 401 && attempt === 0) {
			cached = null;
			continue;
		}
		// Limite de requisições: espera um pouco e tenta de novo, no máximo duas vezes.
		if (res.status === 429 && attempt < 2) {
			await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
			continue;
		}
		let detail = "";
		try {
			const body = (await res.json()) as { message?: string; codeDescription?: string };
			detail = [body.codeDescription, body.message].filter(Boolean).join(": ");
		} catch {
			// corpo não é JSON
		}
		throw new PluggyError(res.status, `Pluggy GET ${url.pathname} respondeu HTTP ${res.status}${detail ? ` (${detail})` : ""}`);
	}
}

/** Endpoints paginados por número de página (accounts, bills, investments). */
async function getAllPages<T>(creds: PluggyCredentials, path: string, params: Record<string, string | undefined>): Promise<T[]> {
	const out: T[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const data = await get<Page<T>>(creds, path, { ...params, page: String(page), pageSize: "500" });
		out.push(...data.results);
		if (!data.totalPages || page >= data.totalPages) break;
	}
	return out;
}

/**
 * Extrai o cursor `after` do campo `next` ("?accountId=...&after=...").
 * Não usa URLSearchParams porque ele transforma "+" em espaço, e o cursor é
 * base64, que pode conter "+".
 */
export function cursorFrom(next: string | null | undefined): string | undefined {
	const raw = next?.match(/[?&]after=([^&]*)/)?.[1];
	return raw ? decodeURIComponent(raw) : undefined;
}

// ---- API pública ------------------------------------------------------------------

export function pluggy(creds: PluggyCredentials) {
	return {
		item: (itemId: string) => get<Item>(creds, `/items/${encodeURIComponent(itemId)}`),

		accounts: (itemId: string) => getAllPages<Account>(creds, "/accounts", { itemId }),

		bills: (accountId: string) => getAllPages<Bill>(creds, "/bills", { accountId }),

		investments: (itemId: string) => getAllPages<Investment>(creds, "/investments", { itemId }),

		/**
		 * GET /v2/transactions, seguindo o cursor. O /transactions (v1, por página)
		 * está depreciado. dateFrom/dateTo no formato YYYY-MM-DD; dateTo é opcional.
		 */
		async transactions(accountId: string, dateFrom: string, dateTo?: string): Promise<Transaction[]> {
			const out: Transaction[] = [];
			let after: string | undefined;
			for (let page = 0; page < MAX_PAGES; page++) {
				const data = await get<CursorPage<Transaction>>(creds, "/v2/transactions", { accountId, dateFrom, dateTo, after });
				out.push(...data.results);
				after = cursorFrom(data.next);
				if (!after) break;
			}
			return out;
		},
	};
}

export type Pluggy = ReturnType<typeof pluggy>;
