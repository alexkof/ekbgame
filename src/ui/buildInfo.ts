export function formatBuildInfo(info: typeof __BUILD_INFO__): string {
  const date = new Date(info.builtAt).toLocaleString('ru-RU', { timeZone: 'Asia/Yekaterinburg' });
  return `${info.branch} · ${info.commit} · ${date} (ЕКБ)`;
}
