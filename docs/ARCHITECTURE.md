# Архитектура

Текущее состояние — каркас. Решения ниже приняты как разумные значения по умолчанию и могут
быть пересмотрены (см. [QUESTIONS.md](QUESTIONS.md)).

## Стек

- **TypeScript** (strict) + **Vite** — сборка статического сайта без сервера.
- **Vitest** — модульные тесты, **Prettier** — форматирование.
- Хостинг — **Cloudflare Pages**, сборка и публикация — **GitHub Actions** (репозиторий остаётся приватным).
- UI-фреймворк и движок отрисовки карты пока не выбраны.

## Слои

```
src/
  core/   — симуляция: состояние, действия, правила, RNG. Без DOM и без браузерных API.
  ui/     — отображение и ввод: экраны, панели, карта.
  main.ts — точка входа: связывает core и ui, игровой цикл.
public/   — статические файлы как есть (картинки, данные, прототип).
tests/    — тесты.
```

Принципы ядра:

1. **Состояние — сериализуемые данные** (`GameState`): только JSON-совместимые значения.
   Сохранения, отладка, реплеи и (в будущем) мультиплеер получаются почти даром.
2. **Изменения — только через действия**: `applyAction(state, action) → newState`.
   UI не меняет состояние напрямую.
3. **Детерминизм**: вся случайность через `core/rng.ts` с seed, хранящимся в состоянии.
   Никакого `Math.random()` и `Date.now()` внутри `core/`.
4. **Данные отдельно от кода**: баланс (бригады, аварии, здания, районы) — в таблицах/JSON,
   чтобы его мог править геймдизайнер.

## Сборка и публикация

| Ветка        | Адрес                                |
| ------------ | ------------------------------------ |
| `main`       | `https://ekbgame.pages.dev/`         |
| любая другая | `https://<ветка>.ekbgame.pages.dev/` |
| прототип     | `<адрес версии>/prototype/`          |

В адресе ветки `/` и прочие символы заменяются на `-`, имя обрезается до 28 символов
(например, `claude/dreamy-ritchie-atas1i` → `claude-dreamy-ritchie-atas1i.ekbgame.pages.dev`).
Если имя `ekbgame.pages.dev` уже занято, Cloudflare добавит суффикс — точные адреса
выводятся в сводке (Summary) каждого запуска workflow.

Workflow [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml):

1. `build` — `npm ci`, `npm run check` (формат, типы, тесты), `npm run build`.
2. `deploy` — создаёт проект `ekbgame` в Cloudflare Pages, если его ещё нет, и выкладывает
   `dist/` через `wrangler pages deploy`. Без секретов шаг пропускается с предупреждением.

Сборка использует относительные пути (`base: './'`). Внизу страницы показаны ветка, коммит
и время сборки.

### Однократная настройка

1. Зарегистрироваться на https://dash.cloudflare.com (бесплатный план).
2. **Account ID**: в панели Cloudflare → Workers & Pages → справа «Account ID» → скопировать.
3. **API-токен**: My Profile → API Tokens → Create Token → Create Custom Token;
   Permissions: `Account` · `Cloudflare Pages` · `Edit`; Create → скопировать токен.
4. В GitHub: репозиторий → Settings → Secrets and variables → Actions → New repository secret:
   `CLOUDFLARE_ACCOUNT_ID` и `CLOUDFLARE_API_TOKEN`.
5. Перезапустить последний workflow (Actions → Build & Deploy → Re-run all jobs) или сделать push.

Закрыть превью-версии паролем можно в Cloudflare: проект → Settings → Access policy
(Cloudflare Access, бесплатно до 50 пользователей).
