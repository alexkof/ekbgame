# Лаборатория моделей

Страница для опытов с отрисовкой объектов карты: https://alexkof.github.io/ekbgame/lab/ (локально —
`npm run dev` → `/lab/`). Собирается вместе с игрой, но в саму игру модели отсюда не попадают. Описание приёмов — `docs/MAP.md` → «Модель» и «Лаборатория моделей».

Сейчас здесь мэрия в пяти вариантах:

| Модель                 | Способ                                              |
| ---------------------- | --------------------------------------------------- |
| `city-hall` (из игры)  | примитивы                                           |
| `city-hall-procedural` | процедурные фасады `bays`, портик, вальмовые крыши  |
| `city-hall-photo-raw`  | фасад, выпрямленный с фото, без чистки              |
| `city-hall-photo-kit`  | фасад из чистых пролётов фото, башня-билборд        |
| `city-hall-sprite`     | запечённый спрайт (рендер `photo-kit` + стилизация) |

## Картинки из фото

Варианты на фото сделаны по снимку без свободной лицензии, поэтому картинки
(`models/city-hall/`) и рабочие файлы (`work/`) в git не хранятся. Без них страница
показывает только варианты на примитивах. Пересобрать:

```bash
python3 -m venv .venv && .venv/bin/pip install opencv-python-headless numpy
mkdir -p lab/work/photo lab/work/bake   # фото фасада → lab/work/photo/cityhall.webp
.venv/bin/python lab/scripts/rectify.py         # гомография по 4 точкам → work/tex/raw_*.png
.venv/bin/python lab/scripts/build_textures.py  # чистый фасад, торцы, башня → models/city-hall/
.venv/bin/python lab/scripts/gen_models.py      # JSON вариантов (процедурный и фото)
npm run dev &                                   # затем запекание спрайта:
node lab/scripts/render.cjs lab/work/bake 0 city-hall-photo-kit:color:8 city-hall-photo-kit:lines:8
.venv/bin/python lab/scripts/stylize.py         # → models/city-hall/sprite-painted.webp
```

Точки гомографии и границы пролётов в скриптах подобраны под конкретный снимок. Для другого
фото их нужно указать заново.

Для игры нужны свои снимки или фото с Викисклада (CC BY-SA, с указанием автора).

## Рисунок по каркасу (вариант F)

Художник или генератор изображений рисует поверх каркаса модели, а движок ставит рисунок на
карту пиксель в пиксель.

```bash
npm run dev &
node lab/scripts/render.cjs lab/work/ai-kit 0 city-hall-procedural:color:8 city-hall-procedural:clay:8
.venv/bin/python lab/scripts/prepare_art.py city-hall-procedural   # каркас 1024 px, маска, frame.json
```

В генератор (ChatGPT, Gemini, Qwen-Image-Edit и т. п.) отдаются каркас `lab/work/ai-kit/guide-color.png`,
фото здания и образец стиля, запрос — в `lab/work/ai-kit/prompt.txt`. Готовый рисунок:

```bash
.venv/bin/python lab/scripts/import_art.py путь/к/рисунку.png
```

Скрипт подгоняет размер, выравнивает сдвиг и масштаб по контурам (генераторы слегка
«гуляют»), вырезает фон по силуэту модели и пишет `lab/models/city-hall-art/art.webp` и
`lab/models/city-hall-art.json`. В лаборатории появляется вариант F.

Вариант F вырос в методику рисунков зданий для игры: модель из OSM, каркас и запрос для
генератора, автоматический импорт рисунка — [docs/ART.md](../docs/ART.md), `scripts/art/`,
`art/`. Скрипты `prepare_art.py` и `import_art.py` здесь — первая версия для мэрии.
