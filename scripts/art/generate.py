#!/usr/bin/env python3
"""Рисунок здания генератором OpenAI по каркасу, фото и запросу → art/<id>/drawn/.

    OPENAI_API_KEY=… python scripts/art/generate.py <id> [<id> …] [--model gpt-image-1]

Входы — те же, что для ChatGPT вручную (docs/ART.md): каркас art/<id>/guide.png первой
картинкой, фото art/<id>/photos/* (до трёх), образец стиля art/style-ref.png (если есть)
последней, запрос art/<id>/prompt.txt. Ответ — PNG размера каркаса в
art/<id>/drawn/<модель>-<время>.png. На карту его ставит art.py import (в CI — сам, после
попадания в main). Только стандартная библиотека Python.
"""

import argparse
import base64
import datetime as dt
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / 'art'
API = os.environ.get('OPENAI_BASE_URL', 'https://api.openai.com/v1').rstrip('/') + '/images/edits'


def multipart(fields, files):
    boundary = uuid.uuid4().hex
    body = bytearray()
    for name, value in fields:
        body += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n'
            f'Content-Type: text/plain; charset=utf-8\r\n\r\n{value}\r\n'
        ).encode()
    for name, path in files:
        mime = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
        body += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{path.name}"\r\n'
            f'Content-Type: {mime}\r\n\r\n'
        ).encode()
        body += path.read_bytes() + b'\r\n'
    body += f'--{boundary}--\r\n'.encode()
    return bytes(body), f'multipart/form-data; boundary={boundary}'


def generate(mid, model, quality, fidelity, key):
    d = ART / mid
    frame = json.loads((d / 'frame.json').read_text(encoding='utf-8'))
    prompt = (d / 'prompt.txt').read_text(encoding='utf-8')
    images = [d / 'guide.png']
    photos = sorted(p for p in (d / 'photos').glob('*') if p.suffix.lower() in ('.jpg', '.jpeg', '.png', '.webp'))
    images += photos[:3]
    style = ART / 'style-ref.png'
    if style.exists():
        images.append(style)
        prompt += '\nПоследняя картинка — образец стиля (art/style-ref.png).\n'
    size = f'{frame["size"][0]}x{frame["size"][1]}'
    fields = [('model', model), ('prompt', prompt), ('size', size), ('quality', quality), ('n', '1')]
    if fidelity:
        fields.append(('input_fidelity', fidelity))
    body, ctype = multipart(fields, [('image[]', p) for p in images])
    req = urllib.request.Request(
        API, data=body, headers={'Authorization': f'Bearer {key}', 'Content-Type': ctype}
    )
    print(f'{mid}: {model}, {size}, картинок на входе: {len(images)} …', file=sys.stderr)
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            answer = json.load(r)
    except urllib.error.HTTPError as e:
        text = e.read().decode('utf-8', 'replace')
        if fidelity and 'input_fidelity' in text:  # модель не знает этот параметр
            return generate(mid, model, quality, None, key)
        sys.exit(f'{mid}: ошибка API {e.code}: {text[:800]}')
    data = base64.b64decode(answer['data'][0]['b64_json'])
    out = d / 'drawn' / f'{model}-{dt.datetime.now().strftime("%Y%m%d-%H%M%S")}.png'
    out.parent.mkdir(exist_ok=True)
    out.write_bytes(data)
    print(f'{mid}: {out.relative_to(ROOT)}', file=sys.stderr)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument('ids', nargs='+')
    ap.add_argument('--model', default=os.environ.get('OPENAI_IMAGE_MODEL', 'gpt-image-1'))
    ap.add_argument('--quality', default='high', choices=['low', 'medium', 'high', 'auto'])
    ap.add_argument('--fidelity', default='high', help='input_fidelity (пусто — не передавать)')
    a = ap.parse_args()
    key = os.environ.get('OPENAI_API_KEY')
    if not key:
        sys.exit('Нужен ключ OpenAI в переменной OPENAI_API_KEY')
    for mid in a.ids:
        if not (ART / mid / 'frame.json').exists():
            sys.exit(f'Нет каркаса art/{mid}/ — сначала python scripts/art/art.py prepare {mid}')
        generate(mid, a.model, a.quality, a.fidelity or None, key)


if __name__ == '__main__':
    main()
