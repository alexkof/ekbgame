import type { Projection } from './projection';
import type { RoadNetwork } from './types';

/**
 * Граф улиц для перемещения машин и персонажей. Данные — layers/roads.json (узлы и улицы
 * как цепочки узлов), здесь они превращаются в списки смежности: из каждого узла — рёбра
 * к соседним узлам по улицам. Чистые функции без DOM.
 */
export interface RoadEdge {
  to: number;
  /** Индекс улицы в RoadNetwork.streets. */
  street: number;
  /** Длина в реальных метрах. */
  length: number;
  /** Может ли здесь проехать машина (одностороннее движение запрещает встречный проезд). */
  car: boolean;
}

export interface RoadGraph {
  network: RoadNetwork;
  /** Мировые координаты узлов (со спрямлением). */
  nodes: [number, number][];
  /** Для каждого узла — рёбра из него. */
  edges: RoadEdge[][];
}

export function buildRoadGraph(network: RoadNetwork, projection: Projection): RoadGraph {
  const nodes = network.nodes.map((p) => projection.geoToWorld(p));
  const local = network.nodes.map((p) => projection.geoToLocal(p));
  const edges: RoadEdge[][] = nodes.map(() => []);
  network.streets.forEach((s, street) => {
    for (let i = 1; i < s.nodes.length; i++) {
      const a = s.nodes[i - 1]!;
      const b = s.nodes[i]!;
      const length = Math.hypot(local[b]![0] - local[a]![0], local[b]![1] - local[a]![1]);
      edges[a]!.push({ to: b, street, length, car: s.oneway !== -1 });
      edges[b]!.push({ to: a, street, length, car: s.oneway !== 1 });
    }
  });
  return { network, nodes, edges };
}

/** Ближайший к мировой точке узел. */
export function nearestNode(g: RoadGraph, X: number, Y: number): number {
  let best = -1;
  let bestD = Infinity;
  g.nodes.forEach(([x, y], i) => {
    const d = (x - X) ** 2 + (y - Y) ** 2;
    if (d < bestD && g.edges[i]!.length > 0) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/**
 * Кратчайший путь по улицам (алгоритм Дейкстры): узлы от from до to включительно или null,
 * если пути нет. 'car' соблюдает одностороннее движение, 'walk' — нет.
 */
export function shortestPath(
  g: RoadGraph,
  from: number,
  to: number,
  mode: 'car' | 'walk' = 'walk',
): number[] | null {
  const dist = new Float64Array(g.nodes.length).fill(Infinity);
  const prev = new Int32Array(g.nodes.length).fill(-1);
  const heap: [number, number][] = [[0, from]];
  dist[from] = 0;
  while (heap.length) {
    const [d, u] = popMin(heap);
    if (u === to) break;
    if (d > dist[u]!) continue;
    for (const e of g.edges[u]!) {
      if (mode === 'car' && !e.car) continue;
      const nd = d + e.length;
      if (nd < dist[e.to]!) {
        dist[e.to] = nd;
        prev[e.to] = u;
        push(heap, [nd, e.to]);
      }
    }
  }
  if (dist[to] === Infinity) return null;
  const path = [to];
  while (path[path.length - 1] !== from) path.push(prev[path[path.length - 1]!]!);
  return path.reverse();
}

/** Длина пути в реальных метрах. */
export function pathLength(g: RoadGraph, path: number[]): number {
  let sum = 0;
  for (let i = 1; i < path.length; i++) {
    const e = g.edges[path[i - 1]!]!.find((x) => x.to === path[i]);
    sum += e?.length ?? Infinity;
  }
  return sum;
}

// --------------------------------------------- двоичная куча по первому элементу

function push(heap: [number, number][], item: [number, number]) {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heap[p]![0] <= heap[i]![0]) break;
    [heap[p], heap[i]] = [heap[i]!, heap[p]!];
    i = p;
  }
}

function popMin(heap: [number, number][]): [number, number] {
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
      if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
      if (m === i) break;
      [heap[m], heap[i]] = [heap[i]!, heap[m]!];
      i = m;
    }
  }
  return top;
}
