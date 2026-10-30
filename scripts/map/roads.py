"""Граф улиц из путей OpenStreetMap: осевые линии, перекрёстки, прямые участки.

Используется из osm_tool.py (команды layers и straighten), подробно — docs/MAP.md, «Граф улиц».

Как строится граф (всё — в мировых координатах до спрямления, где допуски одинаковы на
экране и в центре, и на окраинах):

1. Коридор: пути OSM выбранных улиц расширяются на CORRIDOR метров и объединяются. Две
   проезжие части одной улицы, островки и развязки сливаются в одну полосу.
2. Осевая линия коридора (медиальная ось) — по диаграмме Вороного точек его границы.
   Отростки к углам коридора отрезаются.
3. Узлы — перекрёстки и концы, рёбра — участки между ними. Сдвоенные перекрёстки
   (где пересекаются двойные проезжие части) стягиваются в один узел, маленькие кольца
   развязок — тоже, у разошедшихся проезжих частей остаётся одна; короткие разрывы
   (мосты с другим названием, недостающие куски) склеиваются.
4. Каждое ребро получает название и свойства ближайших путей OSM (голосованием по точкам
   вдоль ребра): название, ранг, одностороннее движение, трамвай.
5. Штрихи: рёбра соединяются через перекрёсток в «естественные» линии по принципу
   наилучшего продолжения (минимальный поворот). Из штрихов получаются улицы файла.
6. Прямые участки: штрих делится на почти прямые куски (в реальных метрах). Длинные куски
   становятся прямыми линиями карты; их направления группируются — линии одной группы
   на карте строго параллельны. Группы, почти перпендикулярные друг другу, делаются строго
   перпендикулярными (прямоугольная сетка центра).
"""

import heapq
import math
from collections import defaultdict

import numpy as np
import shapely
from shapely import geometry as sg

# ------------------------------------------------------------- параметры

CORRIDOR = 24.0  # полуширина коридора, мировые м: сливает двойные проезжие части
SPUR = 1.6  # отростки короче SPUR·CORRIDOR отрезаются
JOIN = 0.9  # перекрёстки ближе JOIN·CORRIDOR стягиваются в один
GAP = 90.0  # разрывы между концами до GAP мировых м склеиваются
CYCLE = 420.0  # циклы с периметром меньше (мировые м) — развязки, их упрощаем…
CYCLE_COMPACT = 110.0  # …кольцо поперечником меньше стягивается в перекрёсток
SIMPLIFY = 3.0  # допуск упрощения осевых линий, мировые м
STROKE_TURN = 35.0  # штрих продолжается через перекрёсток, если поворот меньше, градусы

LINE_TOLERANCE = 9.0  # прямой участок отклоняется от прямой не больше, реальные м
LINE_MIN_LENGTH = 280.0  # прямые участки короче не выпрямляются, реальные м
LINE_RADIUS = 4500.0  # выпрямляются участки, середина которых ближе, реальные м
BEND = 20.0  # излом между прямыми меньше BEND градусов — пологий
MERGE_TOLERANCE = 15.0  # куски с пологим изломом сливаются, если вместе отклоняются меньше, м
PARALLEL = 3.5  # участки с разницей направлений меньше — параллельны, градусы
PARALLEL_NEAR = 1500.0  # …и если они ближе, реальные м
JOINT = 60.0  # линии одной группы ближе JOINT м встык — короткая получает своё направление
PERPENDICULAR = 2.0  # группы с углом 90° ± PERPENDICULAR делаются перпендикулярными

PROPS = ('name', 'cls', 'oneway', 'tram')  # свойства ребра; улица файла — куски с одинаковыми

# Классы дорог OSM от главных к второстепенным: ребру достаётся главный из соседних путей.
CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential']


# ------------------------------------------------------------ геометрия


def dp_indices(pts, tol):
    """Дуглас — Пекер, возвращает индексы сохраняемых точек."""
    n = len(pts)
    if n < 3:
        return list(range(n))
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy)
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            d = math.hypot(px - ax, py - ay) if L == 0 else abs(dy * (px - ax) - dx * (py - ay)) / L
            if d > best:
                best, idx = d, i
        if best > tol:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return [i for i in range(n) if keep[i]]


def fit_line(pts):
    """Прямая по точкам (метод главных компонент): центр, направление, макс. отклонение."""
    P = np.asarray(pts, dtype=float)
    c = P.mean(axis=0)
    _, _, vt = np.linalg.svd(P - c)
    d = vt[0]
    dev = np.abs((P - c) @ vt[1])
    return c, d, float(dev.max())


def axis_angle(d):
    """Направление прямой (без учёта стороны), градусы в [0, 180)."""
    return math.degrees(math.atan2(d[1], d[0])) % 180.0


def angle_diff(a, b):
    """Разница направлений прямых, градусы в [0, 90]."""
    x = abs(a - b) % 180.0
    return min(x, 180.0 - x)


def densify(pts, step):
    out = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        L = math.dist(a, b)
        n = max(1, int(L // step))
        for i in range(1, n + 1):
            t = i / n
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out


def polyline_length(pts):
    return sum(math.dist(a, b) for a, b in zip(pts, pts[1:]))


# ---------------------------------------------------------------- граф


class Graph:
    """Неориентированный граф: узлы с координатами, рёбра с полилиниями и свойствами."""

    def __init__(self):
        self.xy = {}  # id узла → (x, y)
        self.edges = {}  # id ребра → {'a', 'b', 'pts', ...}
        self.inc = defaultdict(set)  # id узла → id рёбер
        self._next_node = 0
        self._next_edge = 0

    def add_node(self, p):
        i = self._next_node
        self._next_node += 1
        self.xy[i] = (float(p[0]), float(p[1]))
        return i

    def add_edge(self, a, b, pts, **props):
        i = self._next_edge
        self._next_edge += 1
        pts = [self.xy[a], *pts[1:-1], self.xy[b]]
        self.edges[i] = {'a': a, 'b': b, 'pts': pts, **props}
        self.inc[a].add(i)
        self.inc[b].add(i)
        return i

    def remove_edge(self, e):
        ed = self.edges.pop(e)
        self.inc[ed['a']].discard(e)
        self.inc[ed['b']].discard(e)

    def remove_node(self, n):
        for e in list(self.inc[n]):
            self.remove_edge(e)
        self.inc.pop(n, None)
        self.xy.pop(n, None)

    def degree(self, n):
        return len(self.inc[n])

    def other(self, e, n):
        ed = self.edges[e]
        return ed['b'] if ed['a'] == n else ed['a']

    def pts_from(self, e, n):
        """Полилиния ребра, начиная от узла n."""
        ed = self.edges[e]
        return ed['pts'] if ed['a'] == n else ed['pts'][::-1]

    def length(self, e):
        return polyline_length(self.edges[e]['pts'])

    def direction_from(self, e, n, reach=30.0):
        """Направление выхода ребра из узла (по точке на расстоянии reach)."""
        pts = self.pts_from(e, n)
        p0 = pts[0]
        acc = 0.0
        q = pts[-1]
        for a, b in zip(pts, pts[1:]):
            L = math.dist(a, b)
            if acc + L >= reach:
                t = (reach - acc) / L
                q = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
                break
            acc += L
        dx, dy = q[0] - p0[0], q[1] - p0[1]
        L = math.hypot(dx, dy) or 1.0
        return dx / L, dy / L

    def move_node(self, n, p):
        self.xy[n] = (float(p[0]), float(p[1]))
        for e in self.inc[n]:
            ed = self.edges[e]
            if ed['a'] == n:
                ed['pts'][0] = self.xy[n]
            if ed['b'] == n:
                ed['pts'][-1] = self.xy[n]

    def merge_nodes(self, keep, drop):
        """Узел drop сливается с keep: его рёбра переходят к keep."""
        for e in list(self.inc[drop]):
            ed = self.edges[e]
            if ed['a'] == drop:
                ed['a'] = keep
                ed['pts'][0] = self.xy[keep]
            if ed['b'] == drop:
                ed['b'] = keep
                ed['pts'][-1] = self.xy[keep]
            self.inc[keep].add(e)
            if ed['a'] == ed['b']:
                self.remove_edge(e)
        self.inc.pop(drop, None)
        self.xy.pop(drop, None)

    def contract_degree2(self, same):
        """Убрать узлы степени 2 между рёбрами с одинаковыми свойствами (same(e1, e2))."""
        changed = True
        while changed:
            changed = False
            for n in list(self.xy):
                if n not in self.xy or self.degree(n) != 2:
                    continue
                e1, e2 = list(self.inc[n])
                if e1 == e2 or not same(self.edges[e1], self.edges[e2]):
                    continue
                a = self.other(e1, n)
                b = self.other(e2, n)
                if a == b:
                    continue
                pts = self.pts_from(e1, a) + self.pts_from(e2, n)[1:]
                props = {k: v for k, v in self.edges[e1].items() if k not in ('a', 'b', 'pts')}
                self.remove_node(n)
                self.add_edge(a, b, pts, **props)
                changed = True


# ------------------------------------------------------------- скелет


def skeleton_graph(lines, half_width, step=3.0):
    """Медиальная ось коридора вокруг линий: граф из отрезков Вороного."""
    corridor = shapely.unary_union([shapely.buffer(ln, half_width, quad_segs=4) for ln in lines])
    corridor = corridor.simplify(0.5)
    boundary = shapely.segmentize(shapely.boundary(corridor), step)
    pts = shapely.get_coordinates(boundary)
    edges = shapely.voronoi_polygons(sg.MultiPoint(pts), only_edges=True)
    segs = np.array(list(edges.geoms), dtype=object)
    inner = corridor.buffer(-0.3)
    shapely.prepare(inner)
    segs = segs[shapely.contains(inner, segs)]

    g = Graph()
    index = {}

    def node(p):
        k = (round(p[0], 2), round(p[1], 2))
        if k not in index:
            index[k] = g.add_node(p)
        return index[k]

    seen = set()
    for s in segs:
        c = list(s.coords)
        for p, q in zip(c, c[1:]):
            a, b = node(p), node(q)
            if a == b or (a, b) in seen:
                continue
            seen.add((a, b))
            seen.add((b, a))
            g.add_edge(a, b, [p, q])
    return g, corridor


def prune_spurs(g, max_len):
    """Отрезать висячие цепочки короче max_len, идущие от узлов ветвления."""
    for _ in range(8):
        removed = False
        for n in list(g.xy):
            if n not in g.xy or g.degree(n) != 1:
                continue
            path = [n]
            total = 0.0
            prev_e = None
            cur = n
            while True:
                es = [e for e in g.inc[cur] if e != prev_e]
                if len(es) != 1:
                    break
                e = es[0]
                total += g.length(e)
                cur = g.other(e, cur)
                prev_e = e
                path.append(cur)
                if g.degree(cur) != 2 or total >= max_len:
                    break
            if total < max_len and g.degree(cur) >= 3:
                for k in path[:-1]:
                    g.remove_node(k)
                removed = True
        if not removed:
            break
    for n in [n for n in g.xy if g.degree(n) == 0]:
        g.remove_node(n)


def collapse_chains(g):
    """Цепочки узлов степени 2 → одно ребро с полилинией."""
    g.contract_degree2(lambda e1, e2: True)


# --------------------------------------------------------- свойства рёбер


def label_edges(g, ways, half_width, tram_lines):
    """Название, ранг, одностороннее движение и трамвай для каждого ребра — по ближайшим путям."""
    tree = shapely.STRtree([w['line'] for w in ways])
    tram_tree = shapely.STRtree(tram_lines) if tram_lines else None
    for e, ed in g.edges.items():
        pts = densify(ed['pts'], 6.0)
        L = polyline_length(ed['pts'])
        # Около перекрёстков ближе может оказаться поперечная улица — их точки не учитываем.
        trim = min(half_width * 1.2, L * 0.3)
        acc = [0.0]
        for a, b in zip(pts, pts[1:]):
            acc.append(acc[-1] + math.dist(a, b))
        inner = [p for p, s in zip(pts, acc) if trim <= s <= L - trim] or pts
        _, wi = tree.query_nearest(shapely.points(np.asarray(inner)), max_distance=half_width * 1.6)
        votes = defaultdict(float)
        best = len(CLASSES) - 1
        for w in wi:
            way = ways[w]
            votes[way['name']] += 1
            hw = way['highway'].replace('_link', '')
            best = min(best, CLASSES.index(hw) if hw in CLASSES else len(CLASSES) - 1)
        if not votes:
            ed.update(name='', cls=CLASSES[-1], oneway=0, tram=False)
            continue
        name = max(votes.items(), key=lambda kv: (kv[1], kv[0] != ''))[0]
        # Одностороннее движение: все пути этой улицы вдоль ребра идут в одну сторону.
        # У двойной проезжей части есть пути в обе стороны — ребро двустороннее.
        near = tree.query(
            shapely.points(np.asarray(inner)), predicate='dwithin', distance=half_width * 1.3
        )
        dirs = set()
        for k, w in zip(*near.tolist()):
            way = ways[w]
            if way['name'] != name:
                continue
            if not way['oneway']:
                dirs.update((1, -1))
                continue
            p = inner[k]
            ln = way['line']
            s = ln.project(sg.Point(p))
            q1 = ln.interpolate(max(0.0, s - 3))
            q2 = ln.interpolate(min(ln.length, s + 3))
            k2 = min(k + 1, len(inner) - 1)
            k1 = max(k2 - 1, 0)
            ex = inner[k2][0] - inner[k1][0]
            ey = inner[k2][1] - inner[k1][1]
            dirs.add(1 if (q2.x - q1.x) * ex + (q2.y - q1.y) * ey >= 0 else -1)
        oneway = next(iter(dirs)) if len(dirs) == 1 else 0
        tram = False
        if tram_tree is not None:
            near = tram_tree.query(
                shapely.points(np.asarray(inner)), predicate='dwithin', distance=half_width
            )
            tram = len(set(near[0].tolist())) >= 0.6 * len(inner)
        ed.update(name=name, cls=CLASSES[best], oneway=oneway, tram=tram)


# ------------------------------------------------------------- чистка


def join_close_junctions(g, dist):
    """Стянуть узлы ветвления, соединённые ребром короче dist (сдвоенные перекрёстки)."""
    changed = True
    while changed:
        changed = False
        for e in sorted(g.edges, key=g.length):
            if e not in g.edges:
                continue
            ed = g.edges[e]
            a, b = ed['a'], ed['b']
            if a == b or g.length(e) >= dist or g.degree(a) < 3 or g.degree(b) < 3:
                continue
            pa, pb = g.xy[a], g.xy[b]
            g.remove_edge(e)
            g.move_node(a, ((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2))
            g.merge_nodes(a, b)
            changed = True
    drop_duplicate_edges(g)


def drop_duplicate_edges(g, max_len=200.0):
    """Из параллельных рёбер между одной парой узлов (петли развязок) оставить кратчайшее."""
    pairs = defaultdict(list)
    for e, ed in g.edges.items():
        pairs[tuple(sorted((ed['a'], ed['b'])))].append(e)
    for es in pairs.values():
        if len(es) < 2:
            continue
        es.sort(key=g.length)
        for e in es[1:]:
            if g.length(e) < max_len * 3:
                g.remove_edge(e)


def shortest_alternative(g, a, b, skip, limit):
    """Кратчайший путь a → b, не проходящий по ребру skip (рёбра пути), если короче limit."""
    dist = {a: 0.0}
    prev = {}
    heap = [(0.0, a)]
    while heap:
        d, u = heapq.heappop(heap)
        if u == b:
            path = []
            while u != a:
                path.append(prev[u])
                u = g.other(prev[u], u)
            return d, path
        if d > dist.get(u, math.inf) or d > limit:
            continue
        for e in g.inc[u]:
            if e == skip:
                continue
            v = g.other(e, u)
            nd = d + g.length(e)
            if nd < dist.get(v, math.inf):
                dist[v] = nd
                prev[v] = e
                heapq.heappush(heap, (nd, v))
    return None


def remove_small_cycles(g, perimeter, compact):
    """Маленькие циклы — кольцевые развязки и разошедшиеся проезжие части — упрощаются.

    Компактный цикл (поперечник меньше compact) стягивается в один перекрёсток, у вытянутого
    (две проезжие части разошлись дальше ширины коридора) убирается самое длинное ребро.
    """
    changed = True
    while changed:
        changed = False
        for e in sorted(g.edges, key=g.length, reverse=True):
            if e not in g.edges:
                continue
            a, b = g.edges[e]['a'], g.edges[e]['b']
            alt = shortest_alternative(g, a, b, e, perimeter - g.length(e))
            if alt is None:
                continue
            cycle = [e, *alt[1]]
            nodes = {g.edges[c]['a'] for c in cycle} | {g.edges[c]['b'] for c in cycle}
            pts = [g.xy[n] for n in nodes]
            span = max(math.dist(p, q) for p in pts for q in pts)
            if span < compact:
                cx = sum(p[0] for p in pts) / len(pts)
                cy = sum(p[1] for p in pts) / len(pts)
                keep = a
                for c in cycle:
                    if c in g.edges:
                        g.remove_edge(c)
                for n in nodes - {keep}:
                    g.merge_nodes(keep, n)
                g.move_node(keep, (cx, cy))
            else:
                g.remove_edge(max(cycle, key=g.length))
            changed = True
            break
    drop_duplicate_edges(g)


def bridge_gaps(g, gap):
    """Склеить разрывы: два конца улиц неподалёку, смотрящие друг на друга."""
    leaves = [n for n in g.xy if g.degree(n) == 1]
    used = set()
    pairs = []
    for a in leaves:
        e = next(iter(g.inc[a]))
        da = g.direction_from(e, a)
        out = (-da[0], -da[1])  # куда «смотрит» конец
        for b in leaves:
            if b <= a:
                continue
            d = math.dist(g.xy[a], g.xy[b])
            if d > gap or d < 1e-6:
                continue
            v = ((g.xy[b][0] - g.xy[a][0]) / d, (g.xy[b][1] - g.xy[a][1]) / d)
            eb = next(iter(g.inc[b]))
            db = g.direction_from(eb, b)
            outb = (-db[0], -db[1])
            if out[0] * v[0] + out[1] * v[1] > math.cos(math.radians(35)) and -(
                outb[0] * v[0] + outb[1] * v[1]
            ) > math.cos(math.radians(35)):
                pairs.append((d, a, b))
    for d, a, b in sorted(pairs):
        if a in used or b in used:
            continue
        used.update((a, b))
        ea = g.edges[next(iter(g.inc[a]))]
        g.add_edge(a, b, [g.xy[a], g.xy[b]], **{k: ea[k] for k in PROPS})


def simplify_edges(g, tol):
    for ed in g.edges.values():
        idx = dp_indices(ed['pts'], tol)
        ed['pts'] = [ed['pts'][i] for i in idx]


# ------------------------------------------------------------- штрихи


def build_strokes(g):
    """Штрихи: цепочки рёбер с наилучшим продолжением через узлы.

    В каждом узле рёбра попарно соединяются, начиная с пары с наименьшим поворотом
    (поворот < STROKE_TURN; рёбра с разными названиями соединяются неохотнее).
    """
    link = {}  # (узел, ребро) → ребро-продолжение
    for n in g.xy:
        es = list(g.inc[n])
        if len(es) < 2:
            continue
        cand = []
        for i in range(len(es)):
            for j in range(i + 1, len(es)):
                d1 = g.direction_from(es[i], n)
                d2 = g.direction_from(es[j], n)
                cos = max(-1.0, min(1.0, d1[0] * d2[0] + d1[1] * d2[1]))
                turn = 180.0 - math.degrees(math.acos(cos))
                same = g.edges[es[i]]['name'] == g.edges[es[j]]['name']
                cost = turn + (0 if same else 12)
                if turn < STROKE_TURN:
                    cand.append((cost, es[i], es[j]))
        taken = set()
        for _, a, b in sorted(cand):
            if a in taken or b in taken:
                continue
            taken.update((a, b))
            link[(n, a)] = b
            link[(n, b)] = a
    strokes = []
    seen = set()

    def walk(n, e):
        """От узла n по ребру e до конца штриха: список (ребро, узел-начало)."""
        out = []
        while e not in seen:
            seen.add(e)
            out.append((e, n))
            m = g.other(e, n)
            nxt = link.get((m, e))
            if nxt is None:
                break
            n, e = m, nxt
        return out

    for e in sorted(g.edges):
        if e in seen:
            continue
        ed = g.edges[e]
        # найти начало штриха: идём назад от a
        n, cur = ed['a'], e
        guard = 0
        while True:
            prev = link.get((n, cur))
            if prev is None or guard > 100000:
                break
            n2 = g.other(prev, n)
            n, cur = n2, prev
            guard += 1
            if cur == e:
                break
        # cur — первое ребро, n — его дальний конец; идём вперёд
        strokes.append(walk(n, cur))
    return strokes


# -------------------------------------------------------- прямые участки


def straight_runs(points, tol, min_len):
    """Деление полилинии (реальные метры) на почти прямые куски.

    Возвращает пары индексов (i, j) — куски points[i..j], которые отклоняются от
    прямой не больше tol и длиннее min_len.
    """
    n = len(points)
    if n < 2:
        return []
    cum = [0.0]
    for a, b in zip(points, points[1:]):
        cum.append(cum[-1] + math.dist(a, b))
    runs = []
    i = 0
    while i < n - 1:
        # жадно растим кусок, пока он остаётся прямым
        j = i + 1
        while j + 1 < n and fit_line(points[i : j + 2])[2] <= tol:
            j += 1
        if cum[j] - cum[i] >= min_len:
            runs.append((i, j))
            i = j
        else:
            i += 1
    return runs


def group_directions(lines, tol, perp_tol, near):
    """Группы параллельных линий и пары перпендикулярных групп.

    lines — [{'angle', 'length', 'seg' (LineString в реальных метрах)}]. Линия входит в группу,
    если её направление отличается от среднего по группе не больше tol и она ближе near
    к какой-нибудь линии группы: параллельность важна для соседних улиц, а далёкие друг от
    друга улицы оставляем со своими направлениями. Перпендикулярными делаются группы с углом
    90° ± perp_tol, линии которых пересекаются (сетка кварталов).
    """
    def mean_angle(members):
        sx = sy = 0.0
        for k in members:
            t = math.radians(2 * lines[k]['angle'])
            sx += lines[k]['length'] * math.cos(t)
            sy += lines[k]['length'] * math.sin(t)
        return (math.degrees(math.atan2(sy, sx)) / 2) % 180.0

    def by_angle(members):
        """Деление по направлению (от длинных линий к коротким), без учёта расстояния."""
        out = []
        for k in sorted(members, key=lambda k: -lines[k]['length']):
            best = min(out, key=lambda gr: angle_diff(lines[k]['angle'], gr['angle']), default=None)
            if best is not None and angle_diff(lines[k]['angle'], best['angle']) <= tol:
                best['members'].append(k)
                best['angle'] = mean_angle(best['members'])
            else:
                out.append({'angle': lines[k]['angle'], 'members': [k]})
        return out

    # Связные компоненты: линии связаны, если почти параллельны и стоят рядом.
    parent = list(range(len(lines)))

    def find(k):
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    for i in range(len(lines)):
        for j in range(i + 1, len(lines)):
            if angle_diff(lines[i]['angle'], lines[j]['angle']) <= tol and (
                lines[i]['seg'].distance(lines[j]['seg']) <= near
            ):
                parent[find(i)] = find(j)
    comps = defaultdict(list)
    for k in range(len(lines)):
        comps[find(k)].append(k)
    groups = []
    for members in comps.values():
        a0 = mean_angle(members)
        if all(angle_diff(lines[k]['angle'], a0) <= tol for k in members):
            groups.append({'angle': a0, 'members': members})
        else:  # цепочка с дрейфом направления — делим по направлениям
            groups.extend(by_angle(members))
    groups.sort(key=lambda gr: -sum(lines[k]['length'] for k in gr['members']))
    perp = {}
    for i, gi in enumerate(groups):
        for j in range(i + 1, len(groups)):
            gj = groups[j]
            if i in perp or j in perp:
                continue
            if abs(angle_diff(gi['angle'], gj['angle']) - 90.0) > perp_tol:
                continue
            if any(
                lines[a]['seg'].intersects(lines[b]['seg'])
                for a in gi['members']
                for b in gj['members']
            ):
                perp[i] = j
                perp[j] = i
    return groups, perp


# ------------------------------------------------------ узлы, улицы, линии


class Network:
    """Результат: узлы (мировые координаты до спрямления), улицы, прямые линии, группы."""

    def __init__(self):
        self.nodes = []  # [(x, y)]
        self.streets = []  # {'name', 'cls', 'oneway', 'tram', 'nodes': [индексы]}
        self.lines = []  # {'group', 'nodes': [индексы]}
        self.groups = []  # {'angle' (реальный, градусы от оси x), 'perpendicular': индекс | None}


def strokes_to_sequences(g, strokes):
    """Штрихи → последовательности вершин. Промежуточные точки рёбер тоже становятся узлами.

    Возвращает (координаты вершин, множество id узлов графа, список штрихов, где штрих —
    список вершин и список свойств отрезков между ними).
    """
    coords = []
    index = {}

    def graph_node(n):
        if ('g', n) not in index:
            index[('g', n)] = len(coords)
            coords.append(g.xy[n])
        return index[('g', n)]

    seqs = []
    for stroke in strokes:
        verts = []
        props = []
        for e, n in stroke:
            ed = g.edges[e]
            pts = g.pts_from(e, n)
            p = {k: ed[k] for k in PROPS}
            if ed['a'] != n and p['oneway']:
                p['oneway'] = -p['oneway']
            if not verts:
                verts.append(graph_node(n))
            for q in pts[1:-1]:
                verts.append(len(coords))
                coords.append(q)
                props.append(p)
            verts.append(graph_node(g.other(e, n)))
            props.append(p)
        seqs.append((verts, props))
    junctions = {index[('g', n)] for n in g.xy if ('g', n) in index}
    return coords, junctions, seqs


def build_lines(coords, junctions, seqs, to_real, center_dist):
    """Прямые участки штрихов, их группы по направлению; лишние промежуточные точки убираются.

    to_real(x, y) — реальные метры; center_dist(x, y) — реальное расстояние до центра.
    """
    real = [to_real(*p) for p in coords]
    lines = []
    for si, (verts, _) in enumerate(seqs):
        pts = [real[v] for v in verts]
        # Соседние куски с пологим изломом сливаем, если вместе они ещё почти прямые.
        runs = []
        for i, j in straight_runs(pts, LINE_TOLERANCE, LINE_MIN_LENGTH):
            if runs and runs[-1][1] == i:
                h = runs[-1][0]
                a = axis_angle(fit_line(pts[h : i + 1])[1])
                b = axis_angle(fit_line(pts[i : j + 1])[1])
                if angle_diff(a, b) < BEND and fit_line(pts[h : j + 1])[2] <= MERGE_TOLERANCE:
                    runs[-1] = (h, j)
                    continue
            runs.append((i, j))
        for i, j in runs:
            mid = coords[verts[(i + j) // 2]]
            if center_dist(*mid) > LINE_RADIUS:
                continue
            angle = axis_angle(fit_line(pts[i : j + 1])[1])
            seg = sg.LineString([pts[i], pts[j]])
            lines.append(
                {'seq': si, 'i': i, 'j': j, 'angle': angle, 'length': seg.length, 'seg': seg}
            )
    groups, perp = group_directions(lines, PARALLEL, PERPENDICULAR, PARALLEL_NEAR)
    for gi, gr in enumerate(groups):
        for k in gr['members']:
            lines[k]['group'] = gi
            lines[k]['angle'] = gr['angle']

    # Узел на двух почти параллельных линиях (излом меньше BEND) не может лечь на обе:
    # их пересечение далеко или его нет. Узел остаётся у длинной линии, короткая
    # укорачивается или делится. Узел на пересечении непараллельных линий — нормально.
    def resolve_one():
        at = defaultdict(list)
        for k, ln in enumerate(lines):
            verts = seqs[ln['seq']][0]
            for t in range(ln['i'], ln['j'] + 1):
                at[verts[t]].append((k, t))
        for occ in at.values():
            for x in range(len(occ)):
                for y in range(x + 1, len(occ)):
                    (k1, t1), (k2, t2) = occ[x], occ[y]
                    if angle_diff(lines[k1]['angle'], lines[k2]['angle']) >= BEND:
                        continue
                    k, t = (k2, t2) if lines[k1]['length'] >= lines[k2]['length'] else (k1, t1)
                    ln = lines[k]
                    if t == ln['i']:
                        ln['i'] += 1
                    elif t == ln['j']:
                        ln['j'] -= 1
                    else:
                        lines.append({**ln, 'i': t + 1})
                        ln['j'] = t - 1
                    return True
        return False

    while resolve_one():
        pass
    lines = [ln for ln in lines if ln['j'] > ln['i']]

    # После укорачивания: обрезки выбрасываем, отклонившиеся по направлению — из группы вон.
    def own_group(ln):
        groups.append({'angle': ln['angle'], 'members': []})
        ln['group'] = len(groups) - 1

    def measure(ln):
        pts = [real[v] for v in seqs[ln['seq']][0][ln['i'] : ln['j'] + 1]]
        ln['seg'] = sg.LineString([pts[0], pts[-1]])
        ln['length'] = ln['seg'].length
        own = axis_angle(fit_line(pts)[1])
        if angle_diff(own, ln['angle']) > PARALLEL:
            ln['angle'] = own
            own_group(ln)

    for ln in lines:
        measure(ln)
    lines = [ln for ln in lines if ln['length'] >= LINE_MIN_LENGTH / 2]

    # Две линии одной группы встык (продолжение улицы после излома) параллельными быть не
    # могут — между ними получится уступ. Короткая получает собственное направление.
    for a in sorted(range(len(lines)), key=lambda k: lines[k]['length']):
        la = lines[a]
        for b, lb in enumerate(lines):
            if b == a or lb['group'] != la['group'] or lb['length'] < la['length']:
                continue
            if la['seg'].distance(lb['seg']) < JOINT:
                verts = seqs[la['seq']][0][la['i'] : la['j'] + 1]
                la['angle'] = axis_angle(fit_line([real[v] for v in verts])[1])
                own_group(la)
                break

    # Промежуточные точки внутри прямых кусков не нужны: линия рисуется прямой.
    drop = defaultdict(set)
    for ln in lines:
        verts = seqs[ln['seq']][0]
        for k in range(ln['i'] + 1, ln['j']):
            if verts[k] not in junctions:
                drop[ln['seq']].add(k)
    net = Network()
    net.groups = [
        {'angle': gr['angle'], 'perpendicular': perp.get(gi)} for gi, gr in enumerate(groups)
    ]
    used = {}

    def nid(v):
        if v not in used:
            used[v] = len(net.nodes)
            net.nodes.append(coords[v])
        return used[v]

    keep_map = {}
    for si, (verts, props) in enumerate(seqs):
        keep = [k for k in range(len(verts)) if k not in drop[si]]
        keep_map[si] = {k: n for n, k in enumerate(keep)}
        # улицы: куски штриха с одинаковыми свойствами
        cur = None
        for a, b in zip(keep, keep[1:]):
            p = props[a]
            if cur is None or any(cur[k] != p[k] for k in PROPS):
                cur = {**p, 'nodes': [nid(verts[a])]}
                net.streets.append(cur)
            cur['nodes'].append(nid(verts[b]))
    for ln in lines:
        verts = seqs[ln['seq']][0]
        ids = [nid(verts[k]) for k in range(ln['i'], ln['j'] + 1) if k not in drop[ln['seq']]]
        net.lines.append({'group': ln['group'], 'nodes': ids})
    return net


# --------------------------------------------------------------- сборка


def same_props(e1, e2):
    return all(e1.get(k) == e2.get(k) for k in PROPS)


def build(ways, tram_lines, to_real, center_dist):
    """Граф улиц.

    ways — пути OSM: {'name', 'highway', 'oneway' (bool), 'line' (LineString в мировых
    координатах до спрямления)}; tram_lines — трамвайные пути в тех же координатах;
    to_real(x, y) — мировые координаты → реальные метры, center_dist(x, y) — реальное
    расстояние до центра. Возвращает Network (узлы — в мировых координатах до спрямления).
    """
    g, _ = skeleton_graph([w['line'] for w in ways], CORRIDOR)
    prune_spurs(g, SPUR * CORRIDOR)
    collapse_chains(g)
    label_edges(g, ways, CORRIDOR, tram_lines)
    join_close_junctions(g, JOIN * CORRIDOR)
    remove_small_cycles(g, CYCLE, CYCLE_COMPACT)
    bridge_gaps(g, GAP)
    prune_spurs(g, SPUR * CORRIDOR)
    g.contract_degree2(same_props)
    simplify_edges(g, SIMPLIFY)
    for n in [n for n in g.xy if g.degree(n) == 0]:
        g.remove_node(n)
    coords, junctions, seqs = strokes_to_sequences(g, build_strokes(g))
    return build_lines(coords, junctions, seqs, to_real, center_dist)
