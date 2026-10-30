"""Поле спрямления: поправка к радиальному сжатию, после которой прямые улицы прямые.

Радиальное сжатие (projection.ts) сохраняет направления от центра, но прямую, не идущую
через центр, изгибает дугой и поворачивает: Луначарского в реальности отклоняется от прямой
на ~12 м, а после сжатия — на ~60 м; длинные улицы на краю сетки кварталов поворачиваются
на 3–5° и перестают быть параллельными. Поэтому к сжатию добавлена поправка — плавное поле
смещений D на мировой плоскости:

    мир = W(x) + D(W(x)),  W — радиальное сжатие.

Поле одно для всех слоёв: улицы, трамвай, вода, парки и объекты сдвигаются согласованно.

Задача: найти самое плавное поле D, при котором
  - каждая прямая линия графа улиц (roads.py) лежит на прямой;
  - линии одной группы параллельны, а перпендикулярные группы перпендикулярны;
  - центр остаётся крупнее, как задумано сжатием: площадь внутри каждого круга с центром на
    Плотинке не меняется, поэтому средний масштаб на каждом кольце — как у сжатия, а в центре
    масштаб 1:1. Без этого условия спрямление сжимает центр: сжатие выгибает улицы серединой
    наружу, и прямая «по средней» тянет середины к центру.
Положения и направления прямых не задаются заранее — они ищутся вместе с полем, поэтому
улицы сдвигаются и поворачиваются ровно настолько, насколько нужно. «Плавность» — минимум
энергии  |ε(D)|² + AREA²·(div D)² + SMOOTH²·|∇²D|² + |D|²/DECAY², где ε — деформация
(растяжение и сдвиг без поворота, как в теории упругости): участки карты могут чуть
повернуться, но почти не искажаются; div D — местное изменение площади (местный масштаб
держится близко к замыслу); тонкая пластина убирает изломы, затухание возвращает поле к нулю
вдали от улиц.

Условие «точка на прямой» линейно по D и сдвигу прямой c (n·(p + D(p)) = c), направление
прямой линеаризуется (метод Гаусса — Ньютона, несколько итераций). Условие ставится только
на поперечную составляющую — вдоль линии точка движется свободно, поэтому на перекрёстках
условия двух улиц не спорят.

Сетка хранится в src/map/data/layers/straighten.json, в TS поле читается билинейной
интерполяцией (src/map/projection.ts).
"""

import base64
import math

import numpy as np
from scipy import sparse
from scipy.sparse import linalg as splinalg

CELL = 60.0  # шаг сетки, мировые м
MARGIN = 1200.0  # запас вокруг линий, мировые м (на краю сетки поле равно нулю)
SMOOTH = 100.0  # на каком расстоянии сглаживаются изломы поля, мировые м
DECAY = 900.0  # на каком расстоянии от улиц поле затухает, мировые м
AREA = 2.0  # во сколько раз местное изменение площади дороже искажения формы
KEEP_SCALE = True  # площадь внутри каждого круга с центром на Плотинке не меняется
RING_STEP = 100.0  # шаг этих кругов, мировые м
SAMPLE = 15.0  # шаг точек-условий вдоль линий, реальные м
W_SAMPLE = 3.0  # вес условия в точке вдоль линии
W_NODE = 30.0  # вес условия в узле (после решения узлы ещё и точно кладутся на прямые — snap)
ITERATIONS = 3  # итерации Гаусса — Ньютона по направлениям
UNIT = 0.01  # точность хранения, м


def rot90(v):
    return np.array([-v[1], v[0]])


def line_samples(real_pts, to_world0, step=SAMPLE):
    """Точки вдоль реальной полилинии (через step м) в мировых координатах до спрямления."""
    out = []
    for a, b in zip(real_pts, real_pts[1:]):
        L = math.dist(a, b)
        n = max(1, int(math.ceil(L / step)))
        for i in range(n):
            t = i / n
            out.append(to_world0(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    out.append(to_world0(*real_pts[-1]))
    return np.array(out)


def direction_classes(groups):
    """Группы с общим направлением: перпендикулярные пары поворачиваются вместе.

    Возвращает (класс группы, поворот группы относительно класса: 0 или 90°).
    """
    cls = [-1] * len(groups)
    quarter = [0] * len(groups)
    k = 0
    for gi, gr in enumerate(groups):
        if cls[gi] >= 0:
            continue
        cls[gi] = k
        pj = gr.get('perpendicular')
        if pj is not None:
            cls[pj] = k
            quarter[pj] = 1
        k += 1
    return cls, quarter, k


def initial_angles(lines, groups, samples, cls, quarter, nclass):
    """Начальные направления классов — по объединённому разбросу точек их линий."""
    S = [np.zeros((2, 2)) for _ in range(nclass)]
    R = np.array([[0.0, -1.0], [1.0, 0.0]])
    for j, ln in enumerate(lines):
        g = ln['group']
        P = samples[j] - samples[j].mean(axis=0)
        M = P.T @ P
        if quarter[g]:
            M = R.T @ M @ R
        S[cls[g]] += M
    out = []
    for M in S:
        _, v = np.linalg.eigh(M)
        n = v[:, 0]  # нормаль: направление наименьшего разброса
        out.append(math.atan2(n[1], n[0]))
    return out


def normal_of(theta, quarter):
    t = theta + quarter * math.pi / 2
    return np.array([math.cos(t), math.sin(t)])


class Grid:
    def __init__(self, bbox, cell=CELL, margin=MARGIN):
        self.cell = cell
        self.x0 = math.floor((bbox[0] - margin) / cell) * cell
        self.y0 = math.floor((bbox[1] - margin) / cell) * cell
        self.nx = int(math.ceil((bbox[2] + margin - self.x0) / cell)) + 1
        self.ny = int(math.ceil((bbox[3] + margin - self.y0) / cell)) + 1
        # неизвестные — внутренние узлы (край сетки закреплён нулём), по две компоненты
        self.var = np.full((self.ny, self.nx), -1, dtype=np.int64)
        self.N = (self.ny - 2) * (self.nx - 2)
        self.var[1:-1, 1:-1] = np.arange(self.N).reshape(self.ny - 2, self.nx - 2)

    def bilinear(self, P):
        """Для точек P: четыре (номер неизвестной или −1, вес) на точку."""
        fx = (P[:, 0] - self.x0) / self.cell
        fy = (P[:, 1] - self.y0) / self.cell
        i = np.floor(fx).astype(int)
        j = np.floor(fy).astype(int)
        tx = fx - i
        ty = fy - j
        return [
            (self.var[j + dj, i + di], wb)
            for dj, di, wb in (
                (0, 0, (1 - tx) * (1 - ty)),
                (0, 1, tx * (1 - ty)),
                (1, 0, (1 - tx) * ty),
                (1, 1, tx * ty),
            )
        ]

    def field(self, x):
        D = np.zeros((self.ny, self.nx, 2))
        D[1:-1, 1:-1, 0] = x[: self.N].reshape(self.ny - 2, self.nx - 2)
        D[1:-1, 1:-1, 1] = x[self.N : 2 * self.N].reshape(self.ny - 2, self.nx - 2)
        return (self.x0, self.y0, self.nx, self.ny, self.cell, D)


def smoothness_rows(grid):
    """Строки энергии плавности поля на сетке.

    Деформация (симметричная часть градиента D, как в теории упругости) — по ячейкам: поворот
    участка карты не штрафуется, штрафуются растяжение и сдвиг. Вторые разности (тонкая
    пластина) — по узлам, обе компоненты. Затухание — по узлам.
    """
    ny, nx, var, N = grid.ny, grid.nx, grid.var, grid.N
    h = grid.cell
    R, C, V = [], [], []
    r0 = 0

    def add(rows_terms, m):
        """rows_terms — [(J, I, comp, coef)]: строки r0..r0+m−1, слагаемые coef·D_comp[J, I]."""
        nonlocal r0
        for J, I, comp, coef in rows_terms:
            c = var[J, I]
            ok = c >= 0
            R.append(r0 + np.nonzero(ok)[0])
            C.append(c[ok] + comp * N)
            V.append(np.broadcast_to(coef, c.shape)[ok])
        r0 += m

    # ячейки: производные в центре ячейки по четырём углам
    J, I = np.mgrid[0 : ny - 1, 0 : nx - 1]
    J = J.ravel()
    I = I.ravel()
    m = J.size
    corners = ((0, 0), (0, 1), (1, 0), (1, 1))

    # Производные, умноженные на шаг сетки (безразмерные разности): ∂/∂x ≈ Σ ±D / (2h).
    def ddx(comp, scale):
        return [(J + dj, I + di, comp, scale * (0.5 if di else -0.5)) for dj, di in corners]

    def ddy(comp, scale):
        return [(J + dj, I + di, comp, scale * (0.5 if dj else -0.5)) for dj, di in corners]

    add(ddx(0, 1.0), m)  # ε_xx
    add(ddy(1, 1.0), m)  # ε_yy
    s = math.sqrt(0.5)
    add(ddy(0, s) + ddx(1, s), m)  # √2·ε_xy, ε_xy = (∂Dx/∂y + ∂Dy/∂x) / 2
    # Местное изменение площади (дивергенция D) штрафуется дополнительно: поле спрямляет
    # больше сдвигом и поворотом, а местный масштаб остаётся близким к замыслу.
    add(ddx(0, AREA) + ddy(1, AREA), m)

    # узлы: вторые разности и затухание
    J, I = np.mgrid[1 : ny - 1, 1 : nx - 1]
    J = J.ravel()
    I = I.ravel()
    m = J.size
    ts = SMOOTH / h
    for comp in (0, 1):
        add([(J, I - 1, comp, ts), (J, I, comp, -2 * ts), (J, I + 1, comp, ts)], m)
        add([(J - 1, I, comp, ts), (J, I, comp, -2 * ts), (J + 1, I, comp, ts)], m)
        q = ts * math.sqrt(0.5) * 0.5
        corners2 = ((-1, -1, q), (-1, 1, -q), (1, -1, -q), (1, 1, q))
        add([(J + dj, I + di, comp, c) for dj, di, c in corners2], m)
        add([(J, I, comp, h / DECAY)], m)
    return np.concatenate(R), np.concatenate(C), np.concatenate(V).astype(float), r0


def solve_normal(A, b, nd, C=None):
    """Наименьшие квадраты A·x ≈ b при точных условиях C·x[:nd] = 0.

    Первые nd неизвестных — сетка (разреженная часть). Остальные (сдвиги и повороты прямых:
    их немного, но каждая связана с сотнями узлов сетки) и множители Лагранжа условий C
    исключаются через дополнение Шура, чтобы разложение оставалось разреженным.
    """
    K = (A.T @ A).tocsc()
    f = A.T @ b
    Kdd = K[:nd, :nd].tocsc()
    Kde = K[:nd, nd:].toarray()
    Kee = K[nd:, nd:].toarray()
    lu = splinalg.splu(Kdd)
    Y = lu.solve(Kde)
    x0 = lu.solve(f[:nd])
    if C is None:
        xe = np.linalg.solve(Kee - Kde.T @ Y, f[nd:] - Kde.T @ x0)
        return np.concatenate([x0 - Y @ xe, xe])
    # Условия Kdd·xd + Kde·xe + Cᵀλ = fd, Kedᵀ·xd + Kee·xe = fe, C·xd = 0
    Z = lu.solve(C.T.toarray())
    ne = Kee.shape[0]
    m = C.shape[0]
    M = np.zeros((ne + m, ne + m))
    M[:ne, :ne] = Kee - Kde.T @ Y
    M[:ne, ne:] = -Kde.T @ Z
    M[ne:, :ne] = -(C @ Y)
    M[ne:, ne:] = -(C @ Z)
    rhs = np.concatenate([f[nd:] - Kde.T @ x0, -(C @ x0)])
    sol = np.linalg.solve(M, rhs)
    xe, lam = sol[:ne], sol[ne:]
    return np.concatenate([x0 - Y @ xe - Z @ lam, xe])


def ring_constraints(grid, step=RING_STEP):
    """Условия «площадь внутри круга не меняется» для кругов с центром в начале координат.

    По теореме о дивергенции изменение площади внутри круга — это поток поля через окружность,
    поэтому условие: среднее радиальное смещение точек окружности равно нулю. Тогда средний
    масштаб на каждом кольце остаётся как у радиального сжатия — центр крупнее, как задумано.
    """
    x1 = grid.x0 + (grid.nx - 1) * grid.cell
    y1 = grid.y0 + (grid.ny - 1) * grid.cell
    rmax = min(-grid.x0, -grid.y0, x1, y1) - grid.cell
    rows, cols, vals = [], [], []
    k = 0
    for rho in np.arange(step, rmax, step):
        n = max(16, int(2 * math.pi * rho / 15))
        t = np.linspace(0, 2 * math.pi, n, endpoint=False)
        P = np.column_stack((rho * np.cos(t), rho * np.sin(t)))
        rad = P / rho
        for var, wb in grid.bilinear(P):
            ok = var >= 0
            for comp in (0, 1):
                rows.append(np.full(ok.sum(), k))
                cols.append(var[ok] + comp * grid.N)
                vals.append((wb * rad[:, comp])[ok] / n)
        k += 1
    if k == 0:
        return None
    C = sparse.csr_matrix(
        (np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(k, 2 * grid.N)
    )
    C.sum_duplicates()
    return C


def build(nodes_real, lines, groups, to_world0):
    """Поле спрямления для графа улиц.

    nodes_real — узлы в реальных метрах; lines — [{'group', 'nodes'}]; groups —
    [{'perpendicular'}]; to_world0(x, y) — радиальное сжатие (мир до спрямления, Y на юг).
    Возвращает (поле, нормали групп, сдвиги линий).
    """
    samples = [line_samples([nodes_real[k] for k in ln['nodes']], to_world0) for ln in lines]
    cls, quarter, nclass = direction_classes(groups)
    theta = initial_angles(lines, groups, samples, cls, quarter, nclass)

    # точки-условия: (точка, линия, вес)
    pts, line_of, wts = [], [], []
    for j, ln in enumerate(lines):
        for p in samples[j]:
            pts.append(p)
            line_of.append(j)
            wts.append(W_SAMPLE)
        for k in ln['nodes']:
            pts.append(to_world0(*nodes_real[k]))
            line_of.append(j)
            wts.append(W_NODE)
    P = np.array(pts, dtype=float)
    line_of = np.array(line_of)
    wts = np.array(wts)
    grid = Grid((P[:, 0].min(), P[:, 1].min(), P[:, 0].max(), P[:, 1].max()))
    N = grid.N
    L = len(lines)
    ncol = 2 * N + L + nclass
    rings = ring_constraints(grid) if KEEP_SCALE else None
    Rs, Cs, Vs, nsmooth = smoothness_rows(grid)
    stencil = grid.bilinear(P)
    g_of = np.array([ln['group'] for ln in lines])[line_of]
    c_of = np.array(cls)[g_of]
    q_of = np.array(quarter)[g_of]
    rows = np.arange(len(P))
    x = np.zeros(ncol)
    for _ in range(ITERATIONS):
        # n·(p + D(p)) − c = 0, n = n0 + δθ·r0 (линеаризация по углу, D·δθ отброшено)
        n0 = np.array([normal_of(theta[c], q) for c, q in zip(c_of, q_of)])
        r0 = np.stack([-n0[:, 1], n0[:, 0]], axis=1)
        R, C, V = [Rs], [Cs], [Vs]
        for var, wb in stencil:
            ok = var >= 0
            for comp in (0, 1):
                R.append(nsmooth + rows[ok])
                C.append(var[ok] + comp * N)
                V.append((wb * n0[:, comp] * wts)[ok])
        R.append(nsmooth + rows)
        C.append(2 * N + line_of)
        V.append(-wts)
        R.append(nsmooth + rows)
        C.append(2 * N + L + c_of)
        V.append(np.einsum('ij,ij->i', r0, P) * wts)
        # слабая привязка сдвигов и поворотов (группа без линий не делает задачу вырожденной)
        nrow = nsmooth + len(P)
        extra = np.arange(L + nclass)
        R.append(nrow + extra)
        C.append(2 * N + extra)
        V.append(np.full(extra.size, 1e-6))
        b = np.zeros(nrow + extra.size)
        b[nsmooth:nrow] = -np.einsum('ij,ij->i', n0, P) * wts
        A = sparse.csr_matrix(
            (np.concatenate(V), (np.concatenate(R), np.concatenate(C))),
            shape=(nrow + extra.size, ncol),
        )
        x = solve_normal(A, b, 2 * N, rings)
        for k in range(nclass):
            theta[k] += x[2 * N + L + k]
    field = grid.field(x)
    normals = [normal_of(theta[cls[g]], quarter[g]) for g in range(len(groups))]
    offsets = [float(c) for c in x[2 * N : 2 * N + L]]
    return field, normals, offsets


def sample_field(field, p):
    """Билинейная интерполяция поля (как в projection.ts)."""
    x0, y0, nx, ny, cell, D = field
    fx = (p[0] - x0) / cell
    fy = (p[1] - y0) / cell
    i = int(math.floor(fx))
    j = int(math.floor(fy))
    if i < 0 or j < 0 or i >= nx - 1 or j >= ny - 1:
        return np.zeros(2)
    tx = fx - i
    ty = fy - j
    return (
        D[j, i] * (1 - tx) * (1 - ty)
        + D[j, i + 1] * tx * (1 - ty)
        + D[j + 1, i] * (1 - tx) * ty
        + D[j + 1, i + 1] * tx * ty
    )


def crop(field, tol=0.02):
    """Обрезать края сетки, где поле практически нулевое (за сеткой поле считается нулём)."""
    x0, y0, nx, ny, cell, D = field
    big = np.linalg.norm(D, axis=2) > tol
    if not big.any():
        return field
    rows = np.nonzero(big.any(axis=1))[0]
    cols = np.nonzero(big.any(axis=0))[0]
    j0, j1 = max(rows[0] - 1, 0), min(rows[-1] + 1, ny - 1)
    i0, i1 = max(cols[0] - 1, 0), min(cols[-1] + 1, nx - 1)
    D = D[j0 : j1 + 1, i0 : i1 + 1]
    return (x0 + i0 * cell, y0 + j0 * cell, i1 - i0 + 1, j1 - j0 + 1, cell, D)


def invert(field, X, iterations=60):
    """Точка y, для которой y + D(y) = X (простая итерация: поле плавное, |∇D| < 1)."""
    X = np.asarray(X, dtype=float)
    y = X.copy()
    for _ in range(iterations):
        y = X - sample_field(field, y)
    return y


def snap(world0, lines, normals, offsets, field):
    """Узлы линий — точно на свои прямые (поле спрямляет с точностью до метра-двух).

    Для узла на одной линии — проекция на прямую, на пересечении линий — точка пересечения.
    Возвращает новые координаты узлов в мире до спрямления (их и надо сохранить).
    """
    targets = {}
    for j, ln in enumerate(lines):
        for k in ln['nodes']:
            targets.setdefault(k, []).append((normals[ln['group']], offsets[j]))
    out = [np.asarray(p, dtype=float) for p in world0]
    for k, cs in targets.items():
        q = out[k] + sample_field(field, out[k])
        A = np.array([n for n, _ in cs])
        b = np.array([c for _, c in cs])
        # ближайшая к q точка, лежащая на всех прямых узла (по наименьшим квадратам)
        eps = 1e-6
        t = np.linalg.solve(A.T @ A + eps * np.eye(2), A.T @ b + eps * q)
        out[k] = invert(field, t)
    return [tuple(p) for p in out]


def encode(field):
    """Сетка → JSON: смещения в сантиметрах, Int16 little-endian, base64 (dx, dy по строкам)."""
    x0, y0, nx, ny, cell, D = field
    q = np.round(D / UNIT)
    if np.abs(q).max() > 32767:
        raise ValueError('смещение больше 327 м — проверьте линии')
    return {
        'x0': float(x0),
        'y0': float(y0),
        'cell': float(cell),
        'nx': int(nx),
        'ny': int(ny),
        'unit': UNIT,
        'data': base64.b64encode(q.astype('<i2').tobytes()).decode('ascii'),
    }


def decode(obj):
    raw = np.frombuffer(base64.b64decode(obj['data']), dtype='<i2').astype(float) * obj['unit']
    D = raw.reshape(obj['ny'], obj['nx'], 2)
    return (obj['x0'], obj['y0'], obj['nx'], obj['ny'], obj['cell'], D)
