# LinkMural

Mural público e sem cadastro para compartilhar perfis do LinkedIn. O modo local funciona sem conta de provedor; Redis e Ably habilitam persistência compartilhada e atualizações ao vivo.

## Executar

```sh
npm install
npm run dev
```

Sem configuração do Redis, a interface funciona em modo local e as publicações ficam no `localStorage` do navegador usado. Com `.env.local` preenchido, `npm run dev` também executa a API local e usa o Redis compartilhado; não precisa da CLI da Vercel.

## Configuração

Copie `.env.example` para `.env.local` e preencha as credenciais server-side:

- `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`: database Redis REST no Upstash. A sala e o índice de URLs expiram após 30 dias sem atividade.
- As chaves deste app usam o namespace `linkwall:` (por exemplo, `linkwall:turma:profiles`) para separar os dados dos outros projetos no Redis compartilhado.
- `ABLY_API_KEY`: chave Ably com permissão para publicar e criar token. O endpoint entrega aos navegadores somente autorização `subscribe` para o canal da sala. Sem esta variável, o cliente consulta Redis a cada 15 segundos.

As salas são determinadas pelo último trecho da URL (`/turma` ou `/workshop-2026`). A sala padrão é `/turma`. O limite por sala é 500 perfis; a API aceita até 8 publicações por IP por minuto. Nome e link são públicos para quem tem o endereço da sala. O estado visto/não visto só existe no navegador e por sala.

## Deploy

Importe o projeto na Vercel, configure as três variáveis server-side no projeto e publique. Configure o domínio final antes de gerar/compartilhar o QR Code. Não há rota para editar ou excluir perfis.

Vercel oferece WebSockets em Functions em beta, com conexões presas a uma instância e limitadas pela duração da Function. O projeto usa Ably para distribuir eventos e mantém polling de 15 segundos como fallback.

## Verificações

```sh
npm run build
```

## Implementado e configuração pendente

- Interface responsiva, formulários, cartões, filtros e estado de leitura local.
- Validação da URL no navegador e servidor, limite de campos, duplicatas, rate limit e TTL no Redis.
- Token Ably restrito à leitura do canal da sala e polling de fallback.
- QR Code e cópia do link.
- Para uso compartilhado, configure Upstash/Ably e as variáveis da Vercel. Nenhuma credencial é necessária no chat.
