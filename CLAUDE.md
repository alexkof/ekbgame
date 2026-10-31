# Заметки для ИИ-ассистентов

- Язык проекта, интерфейса и документации — русский. Код и идентификаторы — английский.
- Перед коммитом: `npm run check` (prettier, tsc, vitest) должен проходить — CI запускает то же.
- `src/core/` — чистая детерминированная симуляция: без DOM, без `Math.random()`/`Date.now()`;
  состояние только JSON-совместимое, изменения только через `applyAction`.
- `public/prototype/` — исходный прототип, не править (кроме осознанных исправлений).
- Принятые решения записывать в `docs/QUESTIONS.md` → «Решения».
- Карта — `docs/MAP.md`. В `src/map/data/` объекты и модели правятся вручную, а `layers/*`
  генерируются `scripts/map/osm_tool.py` из среза OSM `scripts/map/osm/ekb.osm.pbf` (не править
  руками — перезапишутся; после правки графа улиц `roads.json` — `osm_tool.py straighten`).
- Рисунки зданий — `docs/ART.md`. В `art/<id>/` README, каркасы и `frame.json` генерирует
  `scripts/art/art.py prepare` (заметки и фото — в `info.json`); после правки модели здания —
  снова `prepare` (тесты проверяют отпечаток геометрии). Рисунки из `drawn/` ставит на карту
  CI (`art.yml`) или `art.py import <id>`. Кварталы — `art/quarters/*.json`
  (`osm_tool.py quarter`), задания для Codex — `art/tasks/*.md` (`art.py tasks`), инструкции
  для Codex — `AGENTS.md`.
- Одна ветка `main`; каждый push в неё публикуется на https://alexkof.github.io/ekbgame/
  (`.github/workflows/deploy.yml`).
