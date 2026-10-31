// Dart Dębica TV – aktualne ustawienia ekranu (który turniej pokazać).
// Czyta ustawienia.json prosto z GitHuba, więc zmiana w panelu admina działa w kilka sekund,
// bez przebudowy strony. Gdy GitHub nie odpowiada – zwraca wersję zapisaną w stronie.

const lokalne = require('../ustawienia.json');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPO) {
    try {
      const r = await fetch('https://api.github.com/repos/' + process.env.GITHUB_REPO + '/contents/ustawienia.json?ref=main', {
        headers: {
          Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
          Accept: 'application/vnd.github.raw+json',
          'User-Agent': 'dart-debica-tv',
        },
      });
      if (r.ok) return res.status(200).json(JSON.parse(await r.text()));
    } catch (e) { /* niżej wersja zapasowa */ }
  }
  return res.status(200).json(lokalne);
};
