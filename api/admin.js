// Dart Dębica TV – funkcja serwerowa Vercel dla panelu admina.
// Sprawdza hasło i zapisuje ustawienia.json (który turniej pokazuje ekran) na GitHubie.
// Zapis tego pliku NIE przebudowuje strony (vercel.json → ignoreCommand), ekran odczytuje go przez /api/ustawienia.
//
// Zmienne środowiskowe w Vercel (Settings → Environment Variables):
//   ADMIN_HASLO   – hasło do panelu admina
//   GITHUB_TOKEN  – token GitHub z uprawnieniem Contents: Read and write do tego repozytorium
//   GITHUB_REPO   – właściciel/nazwa repozytorium, np. erowery/TurniejTV

const crypto = require('crypto');

const PLIK = 'ustawienia.json';
const REPO_DOMYSLNE = 'erowery/DartDebicaTV';

/** Zmienna z Vercela; wybacza spacje i małe litery w nazwie oraz spacje wokół wartości. */
function zmienna(nazwa) {
  const klucz = Object.keys(process.env).find((k) => k.trim().toUpperCase() === nazwa);
  return klucz ? String(process.env[klucz] || '').trim() : '';
}
const TOKEN = () => zmienna('GITHUB_TOKEN');
const REPO = () => zmienna('GITHUB_REPO').replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '') || REPO_DOMYSLNE;
const HASLO = () => zmienna('ADMIN_HASLO');
const WZOR_TDID = /^t_[A-Za-z0-9]{2,8}_\d{1,8}$/;
const czekaj = (ms) => new Promise((ok) => setTimeout(ok, ms));

function hasloPoprawne(podane) {
  const wzor = HASLO();
  if (!wzor || typeof podane !== 'string') return false;
  const a = crypto.createHash('sha256').update(podane, 'utf8').digest();
  const b = crypto.createHash('sha256').update(wzor, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

// Sesja: podpisany bilet „waznosc.podpis”. Zmiana hasła unieważnia wszystkie sesje.
const SESJA_KROTKA_MS = 12 * 60 * 60 * 1000;
const SESJA_DLUGA_MS = 30 * 24 * 60 * 60 * 1000;
const kluczSesji = () => crypto.createHash('sha256').update('tv-sesja:' + (HASLO()) + ':' + TOKEN(), 'utf8').digest();
const podpis = (w) => crypto.createHmac('sha256', kluczSesji()).update(String(w)).digest('base64url');
function nowaSesja(trwala) {
  const w = Date.now() + (trwala ? SESJA_DLUGA_MS : SESJA_KROTKA_MS);
  return w + '.' + podpis(w);
}
function sesjaPoprawna(bilet) {
  if (typeof bilet !== 'string' || !HASLO()) return false;
  const [w, p] = bilet.split('.');
  if (!w || !p || !(Number(w) > Date.now())) return false;
  const a = Buffer.from(p), b = Buffer.from(podpis(w));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function github(sciezka, opcje = {}) {
  return fetch('https://api.github.com/repos/' + REPO() + sciezka, {
    ...opcje,
    headers: {
      Authorization: 'Bearer ' + TOKEN(),
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dart-debica-tv-admin',
      ...(opcje.headers || {}),
    },
  });
}

/** Czy zapis na GitHubie zadziała – pokazywane w panelu zaraz po zalogowaniu. */
async function stanGithuba() {
  if (!TOKEN()) return { ok: false, opis: 'Brak tokenu GitHub – strona nie widzi zmiennej GITHUB_TOKEN. Dodaj ją w Vercel i zrób Redeploy.' };
  try {
    const r = await github('');
    if (r.status === 401) return { ok: false, opis: 'Token GitHub jest nieprawidłowy albo wygasł.' };
    if (r.status === 404) return { ok: false, opis: 'Token nie ma dostępu do repozytorium ' + REPO() + '. Dopisz je do tokenu na GitHubie.' };
    if (!r.ok) return { ok: false, opis: 'GitHub odpowiedział ' + r.status + '.' };
    const j = await r.json();
    if (j.permissions && !j.permissions.push) return { ok: false, opis: 'Token ma dostęp do ' + REPO() + ' tylko do odczytu. Ustaw Contents: Read and write.' };
    return { ok: true, opis: 'Połączenie z GitHub działa (' + REPO() + ').' };
  } catch (e) {
    return { ok: false, opis: 'Nie udało się połączyć z GitHub.' };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, blad: 'Dozwolona tylko metoda POST.' });
  if (!HASLO()) return res.status(500).json({ ok: false, blad: 'Na Vercelu nie ustawiono hasła (zmienna ADMIN_HASLO).' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  if (body.akcja === 'zaloguj') {
    if (!hasloPoprawne(body.haslo)) {
      await czekaj(1500);
      return res.status(401).json({ ok: false, blad: 'Nieprawidłowe hasło.' });
    }
    return res.status(200).json({ ok: true, sesja: nowaSesja(!!body.trwale), github: await stanGithuba() });
  }

  if (!sesjaPoprawna(body.sesja)) {
    await czekaj(1500);
    return res.status(401).json({ ok: false, blad: 'Sesja wygasła. Zaloguj się ponownie.' });
  }
  if (body.akcja === 'sprawdz') return res.status(200).json({ ok: true, github: await stanGithuba() });
  if (body.akcja !== 'zapisz') return res.status(400).json({ ok: false, blad: 'Nieznana akcja.' });

  if (!TOKEN()) {
    return res.status(500).json({ ok: false, blad: 'Strona nie widzi tokenu GitHub (zmienna GITHUB_TOKEN w Vercel). Sprawdź nazwę zmiennej i zrób Redeploy.' });
  }
  const tdid = body.tdid ? String(body.tdid) : '';
  if (tdid && !WZOR_TDID.test(tdid)) return res.status(400).json({ ok: false, blad: 'To nie wygląda na link do turnieju z Nakka.' });
  const ustawienia = {
    tdid: tdid || null,
    link: tdid ? 'https://n01darts.com/n01/tournament/comp.php?id=' + tdid : null,
    tytul: String(body.tytul || '').slice(0, 80),
    napis: String(body.napis || '').slice(0, 160),
    zmieniono: new Date().toISOString(),
  };

  try {
    const teraz = await github('/contents/' + PLIK + '?ref=main');
    if (teraz.status === 401) throw new Error('token GitHub jest nieprawidłowy albo wygasł');
    if (!teraz.ok && teraz.status !== 404) throw new Error('GitHub odpowiedział ' + teraz.status);
    const plik = teraz.ok ? await teraz.json() : {};
    const zapis = await github('/contents/' + PLIK, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Panel admina: ' + (tdid ? 'turniej ' + tdid : 'brak turnieju'),
        content: Buffer.from(JSON.stringify(ustawienia, null, 2) + '\n', 'utf8').toString('base64'),
        ...(plik.sha ? { sha: plik.sha } : {}),
        branch: 'main',
      }),
    });
    if (zapis.status === 403 || zapis.status === 404) throw new Error('token GitHub nie ma uprawnienia do zapisu w tym repozytorium (Contents: Read and write)');
    if (!zapis.ok) throw new Error('GitHub odpowiedział ' + zapis.status);
    return res.status(200).json({ ok: true, ustawienia });
  } catch (e) {
    return res.status(502).json({ ok: false, blad: 'Nie udało się zapisać: ' + e.message + '.' });
  }
};
