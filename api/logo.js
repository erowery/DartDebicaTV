// Logo partnera wydarzenia: pliki z katalogu partnerzy/ na GitHubie (dodawane w panelu admina, bez przebudowy strony).
function zmienna(nazwa) {
  const klucz = Object.keys(process.env).find((k) => k.trim().toUpperCase() === nazwa);
  return klucz ? String(process.env[klucz] || '').trim() : '';
}
const TOKEN = zmienna('GITHUB_TOKEN');
const REPO = zmienna('GITHUB_REPO').replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '') || 'erowery/DartDebicaTV';
const TYPY = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg' };

module.exports = async function handler(req, res) {
  const m = /^[a-f0-9]{16}\.(webp|png|jpg)$/.exec(String(req.query.plik || ''));
  if (!m) return res.status(400).end();
  const adres = TOKEN
    ? ['https://api.github.com/repos/' + REPO + '/contents/partnerzy/' + m[0] + '?ref=main', { headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github.raw+json', 'User-Agent': 'dart-debica-tv' } }]
    : ['https://raw.githubusercontent.com/' + REPO + '/main/partnerzy/' + m[0], {}];
  try {
    const r = await fetch(adres[0], adres[1]);
    if (!r.ok) return res.status(404).end();
    res.setHeader('Content-Type', TYPY[m[1]]);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // nazwa pliku jest losowa i się nie zmienia
    return res.status(200).send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    return res.status(502).end();
  }
};
