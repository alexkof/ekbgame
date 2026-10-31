import type { ObjectKind } from './types';

/** Палитра и размеры карты. Ширины — в реальных метрах (на карте умножаются на масштаб). */
export const STYLE = {
  outside: '#cdd6c3',
  landCenter: '#f1ebdd',
  landEdge: '#e2e3d0',
  park: '#b9d89c',
  forest: '#a3c98b',
  plaza: '#e6dfd0',
  water: '#5d9fcb',
  waterLight: '#7fb7dc',
  bank: '#d8cfbc',
  street: {
    casing: '#c3b9a6',
    fill: { 1: '#858b94', 2: '#979ba2', 3: '#a9acb1' } as Record<number, string>,
    width: { 1: 24, 2: 16, 3: 12 } as Record<number, number>,
    minPx: { 1: 2.4, 2: 1.6, 3: 1.1 } as Record<number, number>,
    /** С какого зума (px на игровую единицу) показывать улицы ранга. */
    minZoom: { 1: 0, 2: 0.045, 3: 0.12 } as Record<number, number>,
  },
  tram: '#5f544b',
  rail: '#8e887d',
  metro: '#2e9a5a',
  plot: {
    paving: '#ded6c6',
    lawn: '#bddb9f',
    sand: '#ead9a8',
    edge: '#c8bba3',
    selected: '#f2b630',
  },
  shadow: 'rgba(40, 46, 70, 0.2)',
  label: {
    text: '#1d1d1f',
    halo: 'rgba(250, 247, 240, 0.92)',
    street: '#4c4a46',
    district: '#7b7566',
    water: '#e9f4fb',
  },
};

export const KIND_INFO: Record<ObjectKind, { title: string; icon: string; color: string }> = {
  skyscraper: { title: 'Небоскрёб', icon: '🏙️', color: '#4f7ea8' },
  civic: { title: 'Администрация', icon: '🏛️', color: '#c0573e' },
  church: { title: 'Храм', icon: '⛪', color: '#d7a637' },
  theatre: { title: 'Театр', icon: '🎭', color: '#9a5bb5' },
  museum: { title: 'Музей, культурный центр', icon: '🏛️', color: '#5a8f8a' },
  dam: { title: 'Плотина, набережная', icon: '🌊', color: '#3f86b8' },
  park: { title: 'Парк', icon: '🌳', color: '#4f9a48' },
  metro: { title: 'Станция метро', icon: 'Ⓜ️', color: '#d6262b' },
  station: { title: 'Вокзал', icon: '🚉', color: '#6c6f7d' },
  square: { title: 'Площадь', icon: '⬜', color: '#9b8f7a' },
  building: { title: 'Здание', icon: '🏢', color: '#8c7b6b' },
  hotel: { title: 'Гостиница', icon: '🏨', color: '#b0703c' },
  circus: { title: 'Цирк', icon: '🎪', color: '#c43d5a' },
};
