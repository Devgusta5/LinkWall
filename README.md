# LinkMural

Mural temporário e sem cadastro para compartilhar perfis do LinkedIn em uma turma. A pessoa organizadora cria uma sala com nome, código aleatório e convite. Participantes entram com o código; a sala expira automaticamente.

## Executar localmente

```sh
npm install
npm run dev
```

Para criar salas localmente, copie `.env.example` para `.env.local`, preencha as variáveis e reinicie o Vite. Sem Redis e segredo de sessão, a API não cria nem abre salas.

Gere um segredo aleatório exclusivo para `ROOM_SESSION_SECRET` sem enviá-lo no chat. Com Node.js:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## Variáveis

- `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`: credenciais do banco Upstash Redis já usado pelo projeto.
- `ROOM_SESSION_SECRET`: segredo aleatório de pelo menos 32 caracteres para assinar sessões. Nunca vai ao navegador.
- `ROOM_DEFAULT_TTL_SECONDS`: duração padrão; 86400 (24 horas). A API aceita de 600 a 604800 segundos.
- `ABLY_API_KEY`: opcional para eventos ao vivo. A chave fica no servidor; o navegador recebe um token com `subscribe` apenas para o canal da sala. Sem essa variável, o cliente atualiza por polling a cada 15 segundos.

No projeto LinkMural da Vercel, configure essas variáveis em **Settings → Environment Variables**, selecionando Production e Preview conforme necessário. `ROOM_SESSION_SECRET` é a única variável nova em relação à configuração Redis/Ably existente. Faça novo deploy após atualizar variáveis.

## Segurança e armazenamento

- As chaves deste projeto no Redis sempre começam com `linkwall:`. Uma sala usa `linkwall:room:<roomId>`, `linkwall:room-code:<sha256>` e `linkwall:room:<roomId>:profiles` (mais o índice de duplicatas). Limites de tentativas usam `linkwall:rate-limit:`. O código e a credencial administrativa não são salvos em claro.
- O código de entrada tem 10 caracteres aleatórios e é armazenado no Redis somente como hash. O ID interno da sala é outro valor aleatório.
- A sessão é HMAC assinada e enviada em cookie `HttpOnly`, `SameSite=Lax`, `Secure` em produção, com expiração igual à sala. Há um cookie por sala, então abas diferentes podem participar de salas diferentes.
- A API não usa IDs, códigos de canal ou permissões recebidos do cliente como autorização. O cabeçalho seletor de sala só escolhe o cookie candidato; o servidor valida a assinatura, compara o ID dentro da sessão e confirma que a sala continua ativa.
- A credencial administrativa é aleatória, armazenada no Redis apenas como hash e mantida no `sessionStorage` da aba organizadora para permitir encerramento. Se essa aba e seu armazenamento forem perdidos, a sala ainda expira sozinha.
- Código inválido, expirado ou sala encerrada recebem a mesma resposta. Limites: 12 tentativas de entrada/minuto por IP, 5 criações/minuto e 8 publicações/minuto. O IP usado para limitar tentativas é hasheado antes de virar chave Redis.
- Encerrar marca a sala inativa imediatamente. Os dados permanecem até o TTL, mas as APIs deixam de permitir leitura, publicação ou novo token Ably.
- Qualquer pessoa com o código compartilhado pode entrar enquanto a sala estiver ativa. É controle contra acesso casual, não privacidade forte.

## API

- `POST /api/rooms`: cria sala e devolve código e credencial administrativa uma única vez.
- `POST /api/rooms/join`: valida código e inicia sessão participante.
- `GET /api/rooms/current`: consulta a sala da sessão atual.
- `GET|POST /api/profiles`: lista ou publica perfis da sala autenticada.
- `POST /api/rooms/ably-token`: emite token Ably de leitura da sala autenticada.
- `POST /api/rooms/close`: encerra a sala com sessão organizadora e credencial administrativa.

Todas as rotas de dados validam a sessão no servidor; nenhuma recebe `roomId` no corpo como prova de acesso. Redis é a fonte persistente, Ably apenas distribui eventos e o estado visto/não visto fica no navegador.

## Verificação

```sh
npm run build
```

O build executa o TypeScript e a compilação do Vite. Para o teste entre dispositivos/contas, use a implantação com Redis/Ably configurados: crie salas distintas, entre com dois navegadores, publique em cada uma e confirme o isolamento, o rate limit e o bloqueio após encerrar.
