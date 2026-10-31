# pluggy-mcp-workers

Servidor MCP pessoal, **somente leitura**, que dá ao Claude (claude.ai) acesso às suas contas via [Pluggy](https://pluggy.ai) / [Meu Pluggy](https://meu.pluggy.ai). Roda num Cloudflare Worker e usa login pelo GitHub, liberado para **um único usuário**.

## Como funciona

```
claude.ai ──OAuth──▶ Worker (/authorize, /token) ──login──▶ GitHub (só ALLOWED_GITHUB_LOGIN)
claude.ai ──token──▶ Worker (/mcp) ──GET──▶ api.pluggy.ai
```

- **Login:** o claude.ai se registra e pede autorização ao Worker. O Worker manda você ao GitHub e confere o login.
  - Se não for `ALLOWED_GITHUB_LOGIN`, recusa e não emite token.
  - Cada chamada a `/mcp` confere o login de novo.
- **Somente leitura:** o único POST à Pluggy é o `/auth`, que troca clientId e secret por um apiKey válido por cerca de 2h. O apiKey fica em memória e é renovado antes de expirar. Todo o resto é GET (`src/pluggy.ts` não tem outro método).
- **Sem armazenamento de dados bancários:** nada é gravado. O KV `OAUTH_KV` guarda apenas o estado do OAuth (clientes registrados e tokens), que é responsabilidade da biblioteca da Cloudflare.

## Ferramentas

| Ferramenta | O que faz | Endpoints da Pluggy |
|---|---|---|
| `status_conexoes` | status de cada banco, data da última sincronização, erros | `GET /items/{id}`, `GET /accounts` |
| `listar_contas` | contas e cartões: saldo, limite, fechamento e vencimento da fatura aberta | `GET /accounts` |
| `listar_transacoes` | transações por período, com busca por texto, categoria, entrada/saída e faixa de valor | `GET /v2/transactions`, `GET /bills` |
| `listar_faturas` | fatura aberta (datas) e fechadas: total, mínimo, pago, encargos | `GET /bills` |
| `transacoes_da_fatura` | lançamentos de uma fatura, com conferência contra o total do banco; compras novas separadas das parcelas | `GET /bills`, `GET /v2/transactions` |
| `resumo_por_categoria` | saídas, entradas e líquido por categoria. Pagamento de fatura, transferência entre contas próprias e investimentos ficam à parte | `GET /v2/transactions` |
| `listar_investimentos` | posições com saldo, aplicado, rendimento, taxas e total por moeda | `GET /investments` |

A saída é TSV com avisos no topo: `PARCIAL` quando o resultado foi cortado, `ATENÇÃO` quando há conexão com problema.

### Casos especiais tratados

- **Sinal do valor:** sempre negativo = saiu e positivo = entrou, em conta e cartão. A Pluggy inverte o sinal de `amount` entre os dois, então o sinal vem de `type`.
- **Moeda estrangeira:**
  - `valor` usa `amountInAccountCurrency` (já em reais).
  - `valor_orig` mostra o valor original, por exemplo `10.00 USD`.
- **Cartão, data de lançamento ≠ data de compra:**
  - `data` é quando a compra caiu na fatura.
  - `data_compra` aparece quando difere, como nas parcelas.
  - `parcela` mostra `n/N`.
- **Fatura de cada transação:**
  - `fatura` é o vencimento, obtido cruzando o `billId` com `/bills`.
  - Se a fatura ainda está aberta, aparece a previsão `~YYYY-MM`.
  - Previsões inválidas, como `0001-01`, são descartadas.
- **Datas:**
  - Data e hora reais são convertidas para o dia em `TIME_ZONE`. Uma compra às 23h não cai no dia seguinte.
  - Datas "puras" (meia-noite UTC, como vencimentos) não são deslocadas.
- **Conexões com problema:** status diferente de `UPDATED` gera aviso nas respostas.
- **Investimentos:** cópias idênticas da mesma posição (o conector às vezes reemite com outro id) são removidas, com aviso.
- **Descrições de terceiros:** caracteres de controle e de direção de texto são removidos, e o tamanho é limitado. É uma defesa contra prompt injection via descrição de PIX.

## Deploy, passo a passo

Pré-requisitos: Node 20+ e uma conta Cloudflare (o plano gratuito serve).

```bash
npm install
```

```bash
npx wrangler login
```

### 1. Descobrir a URL do Worker

No painel da Cloudflare, abra **Workers & Pages**. Seu subdomínio aparece como `<algo>.workers.dev`. A URL do servidor será:

```
https://pluggy-mcp.<seu-subdominio>.workers.dev
```

### 2. Criar o KV do OAuth

```bash
npx wrangler kv namespace create OAUTH_KV
```

Copie o `id` impresso para `kv_namespaces[0].id` em `wrangler.jsonc`. O id não é segredo.

### 3. Ajustar `wrangler.jsonc`

- `MCP_RESOURCE`: `https://pluggy-mcp.<seu-subdominio>.workers.dev/mcp`
- `ALLOWED_GITHUB_LOGIN`: já está `freebeans`. Troque se for outro usuário.

### 4. Primeiro deploy (ainda sem secrets)

```bash
npx wrangler deploy
```

Isso cria o Worker. Ele ainda não funciona porque faltam os secrets.

### 5. Criar o OAuth App no GitHub

Em GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**:

- **Homepage URL:** `https://pluggy-mcp.<seu-subdominio>.workers.dev`
- **Authorization callback URL:** `https://pluggy-mcp.<seu-subdominio>.workers.dev/callback`

Anote o Client ID e gere um Client secret.

### 6. Cadastrar os secrets

| Secret | Valor |
|---|---|
| `GITHUB_CLIENT_ID` | Client ID do OAuth App |
| `GITHUB_CLIENT_SECRET` | Client secret do OAuth App |
| `COOKIE_ENCRYPTION_KEY` | string aleatória longa, por exemplo a saída de `openssl rand -hex 32` |
| `PLUGGY_CLIENT_ID` | clientId da aplicação "Meu Pluggy" no dashboard da Pluggy |
| `PLUGGY_CLIENT_SECRET` | clientSecret da mesma aplicação |
| `PLUGGY_ITEM_IDS` | ids dos items separados por vírgula: `uuid1,uuid2`. Opcional: nomear cada banco, `Nubank=uuid1,Itau=uuid2` |

**Pelo painel:** Workers & Pages → `pluggy-mcp` → Settings → **Variables and Secrets** → Add. Escolha o tipo **Secret**, não "Text": variáveis de texto são sobrescritas pelo `wrangler.jsonc` a cada deploy, secrets não.

**Ou pelo terminal** (o valor é digitado no prompt e não fica no histórico):

```bash
npx wrangler secret put PLUGGY_CLIENT_SECRET
```

Repita para cada nome da tabela. Para a chave de cookie, dá para gerar e enviar direto:

```bash
openssl rand -hex 32 | npx wrangler secret put COOKIE_ENCRYPTION_KEY
```

Secrets valem na hora, sem novo deploy.

### 7. Conectar no claude.ai

Em Settings → Connectors → **Add custom connector**:

- **URL:** `https://pluggy-mcp.<seu-subdominio>.workers.dev/mcp`
- Deixe os campos de OAuth avançados em branco: o registro do cliente é automático.

Ao conectar, aparece a tela de aprovação do Worker e depois o login do GitHub. Comece testando com "quais são minhas contas?".

### Testar sem o claude.ai (opcional)

```bash
npx @modelcontextprotocol/inspector@latest
```

Informe a URL `/mcp` e faça o login.

## Desenvolvimento

```bash
npm test
```

```bash
npm run type-check
```

```bash
cp .dev.vars.example .dev.vars
```

Preencha o `.dev.vars` (ignorado pelo git) e depois:

```bash
npm run dev
```

Localmente, o OAuth App do GitHub precisa de callback `http://localhost:8788/callback`. O mais simples é criar um segundo OAuth App só para isso.

Depois de mudar `wrangler.jsonc`, regenere os tipos:

```bash
npm run cf-typegen
```

## Limites e observações

- **Sincronização:** os items do MeuPluggy sincronizam sozinhos cerca de 1x por dia. Não dá para forçar pela API (`PATCH /items` retorna 400 para eles), então não existe ferramenta de "atualizar".
- **Período máximo:** 400 dias por consulta.
- **Plano gratuito da Cloudflare:** cada requisição pode fazer até 50 chamadas externas. Cada consulta faz cerca de 2 por banco, mais 1 por página de transações de cada conta, mais 1 por cartão (faturas). Com 2 bancos sobra folga. Se aparecer erro de limite, reduza o período.
- **Taxas de investimento:** vêm como a Pluggy informa, sem conversão. Alguns conectores mandam fração (0.12), outros percentual (12).
- **Trocar de usuário do GitHub:** mude `ALLOWED_GITHUB_LOGIN` e faça deploy. Tokens antigos param de funcionar na hora.

## Créditos

- Estrutura OAuth (`src/github-handler.ts`, `src/utils.ts`, `src/workers-oauth-utils.ts`): template [cloudflare/ai `demos/remote-mcp-github-oauth`](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth), licença MIT, Copyright (c) 2025 Cloudflare, Inc.
- Regras de negócio inspiradas em dois projetos, também sob licença MIT:
  - [brunopedrazza/pluggy-mcp-server](https://github.com/brunopedrazza/pluggy-mcp-server), Copyright (c) 2026 Bruno Pedrazza
  - [Gabrielhsb/mypluggy-MCP](https://github.com/Gabrielhsb/mypluggy-MCP), Copyright (c) 2026 Gabrielhsb

Texto da licença MIT que cobre os três:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
