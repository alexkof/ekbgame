# Екатеринбург — игра об управлении городом и выборах мэра

Веб-игра: управление Екатеринбургом на упрощённой, но приближенной к реальности карте города,
с несколькими игровыми механиками и выборами мэра.

## Где поиграть

- Текущая версия (`main`): https://alexkof.github.io/ekbgame/
- Первый прототип «Живой город»: https://alexkof.github.io/ekbgame/prototype/

Публикация происходит автоматически при каждом push в `main` (см. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

## Разработка

Нужен Node.js 22+.

```bash
npm install
npm run dev      # локальный сервер с горячей перезагрузкой
npm run check    # формат + типы + тесты (то же, что в CI)
npm run build    # сборка в dist/
```

## Документация

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — стек, структура кода, публикация.
- [docs/PROTOTYPE.md](docs/PROTOTYPE.md) — разбор прототипа: механики, баланс, техдолг.
- [docs/QUESTIONS.md](docs/QUESTIONS.md) — открытые вопросы и принятые решения.
