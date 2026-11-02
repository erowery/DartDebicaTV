// Dart Dębica TV – aktualne ustawienia ekranu (który turniej pokazać).
// Czyta ustawienia.json prosto z GitHuba, więc zmiana działa w kilka sekund bez przebudowy strony.
// Z tokenem (GITHUB_TOKEN) – przez API GitHuba; bez tokenu – z publicznego adresu raw (repozytorium publiczne).
// Gdy GitHub nie odpowiada – wersja zapisana w stronie.

const lokalne = require('../ustawienia.json');

function zmienna(nazwa) {
  const klucz = Object.keys(process.env).find((k) => k.trim().toUpperCase() === nazwa);
  return klucz ? String(process.env[klucz] || '').trim() : '';
}
const TOKEN = zmienna('GITHUB_TOKEN');
const REPO = zmienna('GITHUB_REPO').replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '') || 'erowery/DartDebicaTV';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (TOKEN) {
    try {
      const r = await fetch('https://api.github.com/repos/' + REPO + '/contents/ustawienia.json?ref=main', {
        headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github.raw+json', 'User-Agent': 'dart-debica-tv' },
      });
      if (r.ok) return res.status(200).json(JSON.parse(await r.text()));
    } catch (e) { /* niżej kolejne sposoby */ }
  }
  try {
    const r = await fetch('https://raw.githubusercontent.com/' + REPO + '/main/ustawienia.json?t=' + Date.now(), { cache: 'no-store' });
    if (r.ok) return res.status(200).json(JSON.parse(await r.text()));
  } catch (e) { /* wersja zapasowa */ }
  return res.status(200).json(lokalne);
};
