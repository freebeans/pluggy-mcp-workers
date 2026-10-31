/**
 * Regras de negócio: conexões, rótulos, sinal dos valores, fatura de cada
 * transação e o que conta (ou não) como gasto.
 *
 * Os casos especiais aqui vieram de dois projetos MIT lidos como referência:
 * - github.com/brunopedrazza/pluggy-mcp-server (moeda estrangeira, data de
 *   compra x lançamento, fatura por transação, duplicatas de investimento);
 * - github.com/Gabrielhsb/mypluggy-MCP (categorias internas, datas puras).
 */
import { addDays, sanitize, toDay } from "./format.ts";
import type { Account, Bill, Investment, Pluggy, Transaction } from "./pluggy.ts";

export type Ctx = { p: Pluggy; items: ItemRef[]; tz: string };
export type ItemRef = { itemId: string; label?: string };

// ---- Configuração -----------------------------------------------------------------

/**
 * PLUGGY_ITEM_IDS: ids separados por vírgula, opcionalmente com nome:
 * "uuid1,uuid2" ou "Nubank=uuid1,Itau=uuid2".
 */
export function parseItemIds(raw: string | undefined): ItemRef[] {
	return (raw ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((entry) => {
			const eq = entry.lastIndexOf("=");
			return eq > 0 ? { label: entry.slice(0, eq).trim(), itemId: entry.slice(eq + 1).trim() } : { itemId: entry };
		});
}

// ---- Conexões e rótulos ------------------------------------------------------------

export type Connection = {
	itemId: string;
	label: string;
	status: string;
	lastUpdatedAt: string | null;
	error: string | null;
	accounts: Account[];
	accountLabel: Map<string, string>;
};

/** Sufixos jurídicos que não identificam nada e custam tokens em toda linha. */
const BOILERPLATE = [/\s*-\s*institui[çc][ãa]o de pagamento\b.*$/i, /\s*\(conta pr[ée]-paga\)\s*$/i, /\s+s[./]?a\.?\s*$/i, /\s+ltda\.?\s*$/i];

function cleanName(raw: string): string {
	let name = raw.replace(/\s+/g, " ").trim();
	for (const re of BOILERPLATE) name = name.replace(re, "").trim();
	return name || raw.trim();
}

/**
 * Nome do banco. Todo item do MeuPluggy se chama "MeuPluggy", então o nome vem
 * da conta corrente do item (o nome dela costuma ser a instituição). Um nome
 * configurado em PLUGGY_ITEM_IDS tem prioridade.
 */
export function bankName(accounts: Account[], configured: string | undefined, itemId: string): string {
	if (configured) return configured;
	const bank = accounts.find((a) => a.type === "BANK" && a.name?.trim()) ?? accounts.find((a) => a.name?.trim());
	return bank ? cleanName(bank.name) : `Conexão ${itemId.slice(0, 8)}`;
}

/** "Nubank Cartão Mastercard Black", "XP Conta", "XP Conta 2"... numerando repetidos. */
export function accountLabels(accounts: Account[], bank: string): Map<string, string> {
	const labels = new Map<string, string>();
	const seen = new Map<string, number>();
	for (const a of accounts) {
		let base: string;
		if (a.type === "CREDIT") {
			const card = [a.creditData?.brand, a.creditData?.level].filter(Boolean).join(" ") || a.marketingName || "";
			base = `${bank} Cartão${card ? ` ${card}` : ""}`;
		} else {
			base = `${bank} ${a.subtype === "SAVINGS_ACCOUNT" ? "Poupança" : "Conta"}`;
		}
		const n = (seen.get(base) ?? 0) + 1;
		seen.set(base, n);
		labels.set(a.id, n === 1 ? base : `${base} ${n}`);
	}
	return labels;
}

function describeError(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Busca status e contas de cada item configurado. Falha de um item não derruba os outros. */
export async function loadConnections(ctx: Ctx): Promise<Connection[]> {
	return Promise.all(
		ctx.items.map(async ({ itemId, label }) => {
			const [item, accounts] = await Promise.allSettled([ctx.p.item(itemId), ctx.p.accounts(itemId)]);
			const accs = accounts.status === "fulfilled" ? accounts.value : [];
			const bank = bankName(accs, label, itemId);
			const errors: string[] = [];
			if (item.status === "rejected") errors.push(describeError(item.reason));
			else if (item.value.error) errors.push([item.value.error.code, item.value.error.message].filter(Boolean).join(": "));
			if (accounts.status === "rejected") errors.push(`contas indisponíveis: ${describeError(accounts.reason)}`);
			return {
				itemId,
				label: bank,
				status: item.status === "fulfilled" ? item.value.status : "INACESSIVEL",
				lastUpdatedAt: item.status === "fulfilled" ? (item.value.lastUpdatedAt ?? null) : null,
				error: errors.length ? errors.join("; ") : null,
				accounts: accs,
				accountLabel: accountLabels(accs, bank),
			};
		}),
	);
}

export const STATUS_HELP: Record<string, string> = {
	UPDATED: "ok",
	UPDATING: "sincronizando agora",
	LOGIN_ERROR: "credenciais inválidas: reconecte em meu.pluggy.ai",
	OUTDATED: "última sincronização falhou: reconecte em meu.pluggy.ai",
	WAITING_USER_INPUT: "aguardando MFA: resolva em meu.pluggy.ai",
	WAITING_USER_ACTION: "aguardando ação sua em meu.pluggy.ai",
	MERGING: "consolidando dados",
	INACESSIVEL: "não foi possível consultar este item",
};

/**
 * Avisos sobre conexões com problema. Os dados delas ainda são mostrados (a
 * Pluggy serve a última sincronização bem-sucedida), mas o modelo é avisado de
 * que podem estar incompletos.
 */
export function connectionNotes(conns: Connection[], tz: string): string[] {
	const bad = conns.filter((c) => c.status !== "UPDATED" || c.error);
	if (!bad.length) return [];
	const lines = bad.map((c) => {
		const since = c.lastUpdatedAt ? `, última atualização ${toDay(c.lastUpdatedAt, tz)}` : "";
		return `  - ${c.label}: ${c.status}${since}${c.error ? ` (${c.error})` : ""}`;
	});
	return [`ATENÇÃO: conexão(ões) com problema. Os números abaixo podem estar incompletos ou desatualizados:\n${lines.join("\n")}`];
}

/** Filtra contas por rótulo da conta, nome do banco ou id. Sem filtro, todas. */
export function selectAccounts(conns: Connection[], filter?: string, onlyType?: "CREDIT" | "BANK") {
	const needle = filter?.trim().toLowerCase();
	const out: { conn: Connection; account: Account; label: string }[] = [];
	for (const conn of conns) {
		for (const account of conn.accounts) {
			if (onlyType && account.type !== onlyType) continue;
			const label = conn.accountLabel.get(account.id) ?? conn.label;
			if (needle && !(label.toLowerCase().includes(needle) || account.id === filter || conn.itemId === filter)) continue;
			out.push({ conn, account, label });
		}
	}
	return out;
}

// ---- Transações -----------------------------------------------------------------------

/**
 * Valor com sinal normalizado: negativo = dinheiro saiu, positivo = entrou.
 *
 * O sinal de `amount` é invertido entre conta e cartão (compra no cartão vem
 * positiva, na conta vem negativa); `type` é consistente, então ele define o
 * sinal. A magnitude vem de `amountInAccountCurrency` quando existe, porque em
 * compra no exterior `amount` está na moeda da loja (USD, EUR...), não em reais.
 */
export function signedAmount(tx: Pick<Transaction, "type" | "amount" | "amountInAccountCurrency">): number {
	const magnitude = Math.abs(tx.amountInAccountCurrency ?? tx.amount);
	return tx.type === "DEBIT" ? -magnitude : magnitude;
}

/** Valor original em moeda estrangeira, ex.: "49.90 USD". Vazio para compras em reais. */
export function originalAmount(tx: Transaction, accountCurrency: string): string {
	if (tx.amountInAccountCurrency == null) return "";
	if (!tx.currencyCode || tx.currencyCode === accountCurrency) return "";
	return `${Math.abs(tx.amount).toFixed(2)} ${tx.currencyCode}`;
}

export type InternalGroup = "pagamento de fatura" | "transferência entre contas próprias" | "investimentos";

const INVESTMENT_CATEGORIES = new Set(["investments", "fixed income", "mutual funds", "automatic investment", "fixed income investment", "variable income"]);

/**
 * Movimentações que não são gasto nem renda: o dinheiro continua seu, só mudou
 * de lugar. Ficam fora do resumo por categoria (mas aparecem em listar_transacoes).
 * Usa o id da categoria da Pluggy (03 investimentos, 04 mesma titularidade,
 * 05100000 pagamento de fatura) e o nome, como segurança.
 */
export function internalGroup(tx: Pick<Transaction, "categoryId" | "category" | "operationType">): InternalGroup | null {
	const id = tx.categoryId ?? "";
	const name = (tx.category ?? "").toLowerCase();
	if (id.startsWith("05100000") || name === "credit card payment" || tx.operationType === "PAGAMENTO_FATURA") return "pagamento de fatura";
	if (id.startsWith("04") || name === "same person transfer") return "transferência entre contas próprias";
	if (id.startsWith("03") || INVESTMENT_CATEGORIES.has(name)) return "investimentos";
	return null;
}

/** Previsão de fatura "YYYY-MM" válida. A Pluggy já devolveu "0001-01" em dado real. */
const FORECAST = /^20\d{2}-(0[1-9]|1[0-2])$/;

export type TxRow = {
	tx: Transaction;
	conn: Connection;
	account: Account;
	accountLabel: string;
	/** Dia do lançamento no fuso do usuário. No cartão, é quando caiu na fatura, não quando comprou. */
	day: string;
	/** Data original da compra, só quando difere de `day` (parcelas). */
	purchaseDay: string;
	amount: number;
	/** Vencimento da fatura onde caiu (YYYY-MM-DD), ou "~YYYY-MM" se a fatura ainda está aberta. */
	bill: string;
};

export function toRow(tx: Transaction, conn: Connection, account: Account, billDue: ReadonlyMap<string, string>, tz: string): TxRow {
	const meta = tx.creditCardMetadata;
	const day = toDay(tx.date, tz);
	const purchase = meta?.purchaseDate ? toDay(meta.purchaseDate, tz) : "";
	const due = meta?.billId ? billDue.get(meta.billId) : undefined;
	const forecast = meta?.billForecastDate && FORECAST.test(meta.billForecastDate) ? `~${meta.billForecastDate}` : "";
	return {
		tx,
		conn,
		account,
		accountLabel: conn.accountLabel.get(account.id) ?? conn.label,
		day,
		purchaseDay: purchase && purchase !== day ? purchase : "",
		amount: signedAmount(tx),
		bill: account.type === "CREDIT" ? (due ?? forecast) : "",
	};
}

/** billId -> vencimento, para todas as faturas fechadas de um cartão. */
export async function billDueMap(ctx: Ctx, cardId: string): Promise<{ map: Map<string, string>; bills: Bill[] }> {
	const bills = await ctx.p.bills(cardId);
	return { map: new Map(bills.map((b) => [b.id, toDay(b.dueDate, ctx.tz)])), bills };
}

/**
 * Transações de um conjunto de contas entre `de` e `ate` (dias locais, inclusivos).
 * Pede à Pluggy um dia a mais de cada lado e filtra localmente, porque o filtro
 * da Pluggy é em UTC e compras tarde da noite ficariam de fora.
 */
export async function loadTransactions(
	ctx: Ctx,
	selected: ReturnType<typeof selectAccounts>,
	de: string,
	ate: string | null,
): Promise<{ rows: TxRow[]; notes: string[] }> {
	const notes: string[] = [];
	const perAccount = await Promise.all(
		selected.map(async ({ conn, account, label }) => {
			const [txs, bills] = await Promise.all([
				ctx.p.transactions(account.id, addDays(de, -1), ate ? addDays(ate, 1) : undefined),
				account.type === "CREDIT"
					? billDueMap(ctx, account.id).then(
							(r) => r.map,
							(e) => {
								notes.push(`Faturas de ${label} indisponíveis (${describeError(e)}); a coluna fatura usa só a previsão.`);
								return new Map<string, string>();
							},
						)
					: Promise.resolve(new Map<string, string>()),
			]);
			return txs.map((tx) => toRow(tx, conn, account, bills, ctx.tz)).filter((r) => r.day >= de && (!ate || r.day <= ate));
		}),
	);
	const rows = perAccount.flat().sort((a, b) => (a.day === b.day ? 0 : a.day < b.day ? 1 : -1));
	return { rows, notes };
}

export const TX_HEADERS = ["data", "data_compra", "descricao", "valor", "parcela", "total_compra", "valor_orig", "fatura", "categoria", "conta", "situacao"];

export function renderTx(r: TxRow): (string | number)[] {
	const meta = r.tx.creditCardMetadata;
	const total = meta?.totalInstallments ?? 0;
	const n = meta?.installmentNumber ?? 0;
	const parcela = total > 1 && n > 0 ? `${n}/${total}` : "";
	return [
		r.day,
		r.purchaseDay,
		sanitize(r.tx.description || r.tx.descriptionRaw),
		r.amount.toFixed(2),
		parcela,
		parcela && meta?.totalAmount != null ? (-Math.abs(meta.totalAmount)).toFixed(2) : "",
		originalAmount(r.tx, r.account.currencyCode ?? "BRL"),
		r.bill,
		r.tx.category ?? "",
		r.accountLabel,
		r.tx.status === "PENDING" ? "pendente" : "",
	];
}

// ---- Investimentos ----------------------------------------------------------------------

/** Campos que dizem quando a Pluggy viu a posição, não o que ela é. */
const OBSERVATION_FIELDS = new Set(["id", "createdAt", "updatedAt", "date", "transactions"]);

/**
 * Remove posições idênticas campo a campo (exceto id e datas de observação).
 * O conector do MeuPluggy às vezes reemite uma posição com id novo sem apagar a
 * antiga, o que inflaria o total. Só cópias exatas são removidas: duas posições
 * parecidas podem ser dois lotes reais.
 */
export function collapseDuplicates(list: Investment[]): { kept: Investment[]; removed: number } {
	const seen = new Set<string>();
	const kept: Investment[] = [];
	for (const inv of list) {
		const key = JSON.stringify(
			Object.entries(inv)
				.filter(([k]) => !OBSERVATION_FIELDS.has(k))
				.sort(([a], [b]) => a.localeCompare(b)),
		);
		if (!seen.has(key)) {
			seen.add(key);
			kept.push(inv);
		}
	}
	return { kept, removed: list.length - kept.length };
}
