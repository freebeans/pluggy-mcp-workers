/**
 * Formatação: datas, valores, texto de terceiros e TSV.
 * Funções puras, sem I/O, testadas em test/format.test.ts.
 */

// ---- Datas ----------------------------------------------------------------------

/**
 * Converte uma data da Pluggy no dia do calendário (YYYY-MM-DD) no fuso dado.
 *
 * A Pluggy usa duas convenções sem distinguir no tipo:
 * - data/hora real (data da transação): precisa converter para o fuso, senão
 *   uma compra às 23h em São Paulo cai no dia seguinte;
 * - data "pura" gravada como meia-noite UTC (vencimento, fechamento): converter
 *   para São Paulo a jogaria para o dia anterior, então só se corta a string.
 * A decisão é feita por valor (é meia-noite UTC exata?), não por campo.
 */
export function toDay(value: string | null | undefined, timeZone: string): string {
	if (!value) return "";
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return "";
	const utcMidnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
	if (utcMidnight) return d.toISOString().slice(0, 10);
	return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Hoje no fuso dado, YYYY-MM-DD. */
export function today(timeZone: string): string {
	return toDay(new Date().toISOString(), timeZone);
}

/** Soma dias a um YYYY-MM-DD (aritmética de calendário, sem fuso). */
export function addDays(day: string, n: number): string {
	const d = new Date(`${day}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// ---- Valores --------------------------------------------------------------------

/** Duas casas, ponto decimal, sem separador de milhar: fácil de somar por código. */
export function money(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return "";
	return value.toFixed(2);
}

export function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

// ---- Texto de terceiros -------------------------------------------------------------

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI = /[‎‏‪-‮⁦-⁩]/g;

/**
 * Limpa texto escrito por terceiros (descrição de PIX, nome de loja).
 * Qualquer pessoa pode mandar R$0,01 com uma descrição que parece instrução;
 * aqui removemos caracteres de controle e de direção de texto, colapsamos
 * espaços (tab e quebra de linha quebrariam o TSV) e limitamos o tamanho.
 */
export function sanitize(text: string | null | undefined, max = 80): string {
	if (!text) return "";
	const clean = text.replace(CONTROL, " ").replace(BIDI, "").replace(/\s+/g, " ").trim();
	return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

// ---- TSV ------------------------------------------------------------------------

export type Cell = string | number | null | undefined;

function cell(v: Cell): string {
	if (v === null || v === undefined) return "";
	return String(v).replace(/[\t\r\n]+/g, " ");
}

/**
 * Tabela TSV precedida de avisos. Os avisos vêm ANTES do cabeçalho para não
 * passarem despercebidos (ex.: resultado cortado, conexão desatualizada).
 * Sem linhas, devolve uma frase em vez de um cabeçalho solto, para o modelo não
 * ler "zero gastos" quando o filtro simplesmente não achou nada.
 */
export function tsv(headers: string[], rows: Cell[][], notes: string[] = []): string {
	const blocks = notes.filter(Boolean);
	if (rows.length === 0) blocks.push("Nenhum resultado para estes filtros.");
	else blocks.push([headers.join("\t"), ...rows.map((r) => r.map(cell).join("\t"))].join("\n"));
	return blocks.join("\n\n");
}

export function truncationNote(total: number, shown: number): string {
	return (
		`PARCIAL: ${total} linhas encontradas, mostrando ${shown}. ` +
		`NÃO some estas linhas como total: o resultado seria menor que o real. ` +
		`Estreite o período, filtre por conta, ou use resumo_por_categoria para totais.`
	);
}
