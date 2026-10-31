import assert from "node:assert/strict";
import { test } from "node:test";
import {
	accountLabels,
	bankName,
	collapseDuplicates,
	internalGroup,
	originalAmount,
	parseItemIds,
	signedAmount,
	toRow,
	type Connection,
} from "../src/finance.ts";
import { addDays, sanitize, toDay, tsv } from "../src/format.ts";
import { cursorFrom, type Account, type Investment, type Transaction } from "../src/pluggy.ts";
import { pickBill, summarize } from "../src/tools.ts";
import { isAllowed } from "../src/utils.ts";

const TZ = "America/Sao_Paulo";

test("toDay converte data/hora real para o dia em São Paulo", () => {
	// 23:30 em SP = 02:30Z do dia seguinte.
	assert.equal(toDay("2026-03-02T02:30:00.000Z", TZ), "2026-03-01");
	assert.equal(toDay("2026-03-02T15:00:00.000Z", TZ), "2026-03-02");
});

test("toDay não move datas puras (meia-noite UTC)", () => {
	assert.equal(toDay("2026-04-05T00:00:00.000Z", TZ), "2026-04-05");
	assert.equal(toDay("2026-04-05", TZ), "2026-04-05");
	assert.equal(toDay(null, TZ), "");
});

test("addDays atravessa mês e ano", () => {
	assert.equal(addDays("2026-12-31", 1), "2027-01-01");
	assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("signedAmount: negativo = saída em conta e cartão", () => {
	assert.equal(signedAmount({ type: "DEBIT", amount: -100 }), -100); // conta
	assert.equal(signedAmount({ type: "DEBIT", amount: 188.16 }), -188.16); // cartão
	assert.equal(signedAmount({ type: "CREDIT", amount: -4860.4 }), 4860.4); // pagamento no cartão
	assert.equal(signedAmount({ type: "CREDIT", amount: 2000 }), 2000);
});

test("signedAmount usa o valor na moeda da conta em compra no exterior", () => {
	assert.equal(signedAmount({ type: "DEBIT", amount: 10, amountInAccountCurrency: 54.3 }), -54.3);
	const tx = { amount: 10, amountInAccountCurrency: 54.3, currencyCode: "USD" } as Transaction;
	assert.equal(originalAmount(tx, "BRL"), "10.00 USD");
	assert.equal(originalAmount({ amount: 10, currencyCode: "BRL" } as Transaction, "BRL"), "");
});

test("internalGroup identifica movimentações que não são gasto", () => {
	assert.equal(internalGroup({ categoryId: "05100000", category: "Credit card payment" }), "pagamento de fatura");
	assert.equal(internalGroup({ categoryId: null, category: null, operationType: "PAGAMENTO_FATURA" }), "pagamento de fatura");
	assert.equal(internalGroup({ categoryId: "04000000", category: "Same person transfer" }), "transferência entre contas próprias");
	assert.equal(internalGroup({ categoryId: "03010000", category: "Fixed income" }), "investimentos");
	assert.equal(internalGroup({ categoryId: "05080000", category: "Transfer - TED" }), null);
	assert.equal(internalGroup({ categoryId: "08000000", category: "Groceries" }), null);
});

test("parseItemIds aceita ids puros e com nome", () => {
	assert.deepEqual(parseItemIds(" a1 , Nubank=b2,,"), [{ itemId: "a1" }, { label: "Nubank", itemId: "b2" }]);
	assert.deepEqual(parseItemIds(undefined), []);
});

test("rótulos: nome do banco sem sufixo jurídico, contas repetidas numeradas", () => {
	const accs = [
		{ id: "1", type: "BANK", subtype: "CHECKING_ACCOUNT", name: "Nu Pagamentos S.A. - Instituição de Pagamento" },
		{ id: "2", type: "CREDIT", name: "BLACK", creditData: { brand: "Mastercard", level: "Black" } },
		{ id: "3", type: "BANK", subtype: "CHECKING_ACCOUNT", name: "Outra" },
	] as Account[];
	const bank = bankName(accs, undefined, "abcdef123");
	assert.equal(bank, "Nu Pagamentos");
	assert.equal(bankName(accs, "Nubank", "x"), "Nubank");
	const labels = accountLabels(accs, "Nubank");
	assert.deepEqual([...labels.values()], ["Nubank Conta", "Nubank Cartão Mastercard Black", "Nubank Conta 2"]);
});

test("cursorFrom preserva '+' do cursor base64", () => {
	assert.equal(cursorFrom("?accountId=x&after=abc%2Bdef%3D%3D"), "abc+def==");
	assert.equal(cursorFrom("?accountId=x&after=abc+def=="), "abc+def==");
	assert.equal(cursorFrom(null), undefined);
});

test("toRow: data de compra, parcela e fatura", () => {
	const account = { id: "c1", type: "CREDIT", currencyCode: "BRL" } as Account;
	const conn = { label: "Nubank", accountLabel: new Map([["c1", "Nubank Cartão"]]) } as Connection;
	const tx = {
		id: "t",
		accountId: "c1",
		description: "LOJA",
		amount: 100,
		date: "2026-10-20T15:00:00.000Z",
		type: "DEBIT",
		creditCardMetadata: { installmentNumber: 3, totalInstallments: 10, purchaseDate: "2026-08-10T00:00:00.000Z", billId: "b1" },
	} as Transaction;
	const r = toRow(tx, conn, account, new Map([["b1", "2026-11-05"]]), TZ);
	assert.equal(r.day, "2026-10-20");
	assert.equal(r.purchaseDay, "2026-08-10");
	assert.equal(r.amount, -100);
	assert.equal(r.bill, "2026-11-05");

	const open = toRow({ ...tx, creditCardMetadata: { billForecastDate: "2026-12" } }, conn, account, new Map(), TZ);
	assert.equal(open.bill, "~2026-12");
	const bogus = toRow({ ...tx, creditCardMetadata: { billForecastDate: "0001-01" } }, conn, account, new Map(), TZ);
	assert.equal(bogus.bill, "");
});

test("collapseDuplicates remove só cópias idênticas", () => {
	const base = { itemId: "i", name: "LTN 2029", type: "FIXED_INCOME", balance: 1000, quantity: 1 } as Investment;
	const { kept, removed } = collapseDuplicates([
		{ ...base, id: "a", createdAt: "x" },
		{ ...base, id: "b", createdAt: "y" },
		{ ...base, id: "c", quantity: 2 },
	]);
	assert.equal(kept.length, 2);
	assert.equal(removed, 1);
});

test("summarize separa gastos de movimentações internas", () => {
	const account = { id: "a", type: "BANK", currencyCode: "BRL" } as Account;
	const conn = { label: "B", accountLabel: new Map() } as Connection;
	const mk = (amount: number, type: "DEBIT" | "CREDIT", category: string, categoryId: string) =>
		toRow({ id: "x", accountId: "a", description: "d", amount, type, date: "2026-10-10T12:00:00Z", category, categoryId } as Transaction, conn, account, new Map(), TZ);
	const out = summarize(
		[mk(100, "DEBIT", "Groceries", "08000000"), mk(20, "CREDIT", "Groceries", "08000000"), mk(5000, "DEBIT", "Credit card payment", "05100000"), mk(3000, "CREDIT", "Salary", "01010000")],
		"2026-10-01",
		"2026-10-31",
	);
	assert.match(out, /BRL: saídas 100\.00, entradas 3020\.00, líquido 2920\.00/);
	assert.match(out, /pagamento de fatura\tBRL\t5000\.00/);
});

test("pickBill: vazio, vencimento exato e mês", () => {
	const bills = [
		{ id: "2", dueDate: "2026-11-05T00:00:00.000Z", totalAmount: 1 },
		{ id: "1", dueDate: "2026-10-05T00:00:00.000Z", totalAmount: 1 },
	];
	assert.equal(pickBill(bills, "", TZ)?.id, "2");
	assert.equal(pickBill(bills, "2026-10-05", TZ)?.id, "1");
	assert.equal(pickBill(bills, "2026-10", TZ)?.id, "1");
	assert.equal(pickBill(bills, "2026-09", TZ), undefined);
});

test("sanitize e tsv protegem a tabela", () => {
	assert.equal(sanitize("ignore\tas\ninstruções‮"), "ignore as instruções");
	assert.equal(sanitize("x".repeat(100), 10).length, 10);
	assert.equal(tsv(["a", "b"], [["1\t2", 3]]), "a\tb\n1 2\t3");
	assert.equal(tsv(["a"], [], ["AVISO"]), "AVISO\n\nNenhum resultado para estes filtros.");
});

test("isAllowed compara login sem diferenciar maiúsculas e nega sem configuração", () => {
	assert.equal(isAllowed("FreeBeans", "freebeans"), true);
	assert.equal(isAllowed("outro", "freebeans"), false);
	assert.equal(isAllowed("freebeans", ""), false);
	assert.equal(isAllowed(undefined, "freebeans"), false);
});
