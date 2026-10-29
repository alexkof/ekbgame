import './style.css';
import { formatBuildInfo } from './ui/buildInfo';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <main class="title">
    <h1>Екатеринбург</h1>
    <p class="subtitle">Игра о городе и выборах мэра</p>
    <p class="status">🚧 Игра в разработке</p>
    <p><a href="./prototype/">Сыграть в прототип «Живой город»</a></p>
  </main>
  <footer class="build">${formatBuildInfo(__BUILD_INFO__)}</footer>
`;
