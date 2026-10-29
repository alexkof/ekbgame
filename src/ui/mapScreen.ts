import { applyAction, createInitialState, type GameAction, type GameState } from '../core';
import { MAP_CONFIG, MAP_LAYERS, MAP_MODELS, MAP_OBJECTS } from '../map/data';
import { MapView } from '../map/mapView';
import { createProjection } from '../map/projection';
import { KIND_INFO } from '../map/style';
import { buildWorld, type WorldObject } from '../map/world';
import { formatBuildInfo } from './buildInfo';

const ZONE_NAMES = Object.fromEntries(MAP_CONFIG.zones.map((z) => [z.id, z.name]));

/** Экран карты: сама карта, кнопки зума, карточка выбранного объекта, режим разработчика. */
export function mountMapScreen(root: HTMLElement): void {
  root.innerHTML = `
    <div class="screen">
      <header class="topbar">
        <div class="brand"><b>Екатеринбург</b><small>карта города · в разработке</small></div>
        <a class="topbar-link" href="./prototype/">Прототип</a>
      </header>
      <div class="map" id="map"></div>
      <div class="map-tools">
        <button data-act="in" title="Приблизить" aria-label="Приблизить">+</button>
        <button data-act="out" title="Отдалить" aria-label="Отдалить">−</button>
        <button data-act="home" title="Центр города" aria-label="Центр города">⌂</button>
        <button data-act="all" title="Весь город" aria-label="Весь город">◎</button>
        <button data-act="debug" title="Режим разработчика: зоны, участки, координаты" aria-label="Режим разработчика">⚙</button>
      </div>
      <div class="dev-info hidden" id="devInfo"></div>
      <section class="card hidden" id="card" aria-live="polite"></section>
      <footer class="build">${formatBuildInfo(__BUILD_INFO__)} · данные © участники OpenStreetMap</footer>
    </div>
  `;

  const projection = createProjection(MAP_CONFIG);
  const world = buildWorld(projection, MAP_LAYERS, MAP_OBJECTS);
  let game: GameState = createInitialState(1);
  const mapEl = root.querySelector<HTMLDivElement>('#map')!;
  const card = root.querySelector<HTMLElement>('#card')!;
  const devInfo = root.querySelector<HTMLElement>('#devInfo')!;
  const view = new MapView(mapEl, world, MAP_MODELS, {
    structures: game.cityMap.structures,
    selectedId: null,
    debug: false,
  });

  const dispatch = (action: GameAction) => {
    game = applyAction(game, action);
    view.setState({ structures: game.cityMap.structures });
    const selected = world.objects.find((o) => o.props.id === view.getState().selectedId);
    if (selected) showCard(selected);
  };

  const showCard = (o: WorldObject) => {
    const p = o.props;
    const info = KIND_INFO[p.kind];
    const current = game.cityMap.structures[p.id];
    const replaced = current !== undefined;
    const modelName = current === null ? 'пустой участок' : MAP_MODELS[current ?? p.model]?.name;
    const [lon, lat] = projection.worldToGeo(o.anchor[0], o.anchor[1]);
    const osm = p.osm
      ? `<a href="https://www.openstreetmap.org/${p.osm}" target="_blank" rel="noopener">OSM</a>`
      : '';
    card.innerHTML = `
      <button class="card-close" aria-label="Закрыть">✕</button>
      <div class="card-kind">${info.icon} ${info.title} · ${ZONE_NAMES[o.zone] ?? ''}</div>
      <h2>${p.name}</h2>
      ${p.address ? `<div class="card-address">${p.address}</div>` : ''}
      ${p.description ? `<p>${p.description}</p>` : ''}
      ${replaced ? `<p class="card-note">Сейчас на участке: <b>${modelName}</b></p>` : ''}
      <div class="card-actions">
        ${current !== null ? '<button data-card="remove">Убрать с карты</button>' : ''}
        ${current !== 'square-park' ? '<button data-card="park">Поставить сквер</button>' : ''}
        ${replaced ? '<button data-card="reset" class="primary">Вернуть как было</button>' : ''}
      </div>
      <div class="card-meta">${lat.toFixed(5)}, ${lon.toFixed(5)} · масштаб ×${o.scale.toFixed(2)} ${osm}</div>
    `;
    card.classList.remove('hidden');
    card.querySelector('.card-close')!.addEventListener('click', () => select(null));
    card.querySelectorAll<HTMLButtonElement>('[data-card]').forEach((b) =>
      b.addEventListener('click', () => {
        const act = b.dataset.card;
        if (act === 'remove') dispatch({ type: 'setStructure', objectId: p.id, model: null });
        if (act === 'park')
          dispatch({ type: 'setStructure', objectId: p.id, model: 'square-park' });
        if (act === 'reset') dispatch({ type: 'resetStructure', objectId: p.id });
      }),
    );
  };

  const select = (o: WorldObject | null) => {
    view.setState({ selectedId: o?.props.id ?? null });
    if (o) {
      showCard(o);
      view.focusObject(o);
    } else {
      card.classList.add('hidden');
    }
  };
  view.onSelect = select;
  // Для отладки в консоли браузера (только в режиме разработки).
  if (import.meta.env.DEV) Object.assign(window, { ekbMap: view });

  view.onHover = (geo) => {
    if (!view.getState().debug || !geo) return;
    const scale = projection.scaleAtGeo(geo);
    const [x, y] = projection.geoToLocal(geo);
    devInfo.textContent = `${geo[1].toFixed(5)}, ${geo[0].toFixed(5)} · ${(Math.hypot(x, y) / 1000).toFixed(2)} км от центра · масштаб ×${scale.toFixed(2)}`;
  };

  root.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) =>
    b.addEventListener('click', () => {
      switch (b.dataset.act) {
        case 'in':
          view.zoomBy(1.6);
          break;
        case 'out':
          view.zoomBy(1 / 1.6);
          break;
        case 'home':
          view.home();
          break;
        case 'all':
          view.overview();
          break;
        case 'debug': {
          const debug = !view.getState().debug;
          view.setState({ debug });
          b.classList.toggle('active', debug);
          devInfo.classList.toggle('hidden', !debug);
          devInfo.textContent = 'Наведите на карту: координаты, расстояние от центра, масштаб';
          break;
        }
      }
    }),
  );
}
