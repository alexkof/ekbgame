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
