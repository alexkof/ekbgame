import './style.css';
import { applyAction, createInitialState, type GameState } from './core';
import { formatBuildInfo } from './ui/buildInfo';

const app = document.querySelector<HTMLDivElement>('#app')!;

let state: GameState = createInitialState(Date.now() >>> 0);

function render() {
  app.innerHTML = `
    <main class="title">
      <h1>Екатеринбург</h1>
      <p class="subtitle">Игра о городе и выборах мэра</p>
      <p class="status">Каркас проекта. Ход: <b>${state.turn}</b></p>
      <button id="end-turn" type="button">Завершить ход</button>
      <p><a href="./prototype/">Открыть прототип «Живой город»</a></p>
    </main>
    <footer class="build">${formatBuildInfo(__BUILD_INFO__)}</footer>
  `;
  app.querySelector('#end-turn')!.addEventListener('click', () => {
    state = applyAction(state, { type: 'endTurn' });
    render();
  });
}

render();
