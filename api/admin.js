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
const KATALOG_LOGO = 'partnerzy';
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

function bladGithuba(r) {
  if (r.status === 401) return new Error('token GitHub jest nieprawidłowy albo wygasł');
  if (r.status === 403 || r.status === 404) return new Error('token GitHub nie ma uprawnienia do zapisu w tym repozytorium (Contents: Read and write)');
  return new Error('GitHub odpowiedział ' + r.status);
}
function bladDanych(tekst) { const e = new Error(tekst); e.status = 400; return e; }

async function czytajUstawienia() {
  const r = await github('/contents/' + PLIK + '?ref=main');
  if (r.status === 404) return { dane: {}, sha: null };
  if (!r.ok) throw bladGithuba(r);
  const p = await r.json();
  let dane = {};
  try { dane = JSON.parse(Buffer.from(p.content, 'base64').toString('utf8')); } catch (e) { /* uszkodzony plik zapiszemy od nowa */ }
  return { dane, sha: p.sha };
}

async function zapiszPlik(sciezka, base64, opis, sha) {
  const r = await github('/contents/' + sciezka, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: opis, content: base64, ...(sha ? { sha } : {}), branch: 'main' }),
  });
  if (!r.ok) throw bladGithuba(r);
}

async function zapiszUstawienia(dane, opis) {
  const { sha } = await czytajUstawienia();
  await zapiszPlik(PLIK, Buffer.from(JSON.stringify(dane, null, 2) + '\n', 'utf8').toString('base64'), opis, sha);
  return dane;
}

/* ---------- partnerzy wydarzenia (sponsorzy, współorganizatorzy, gospodarz…) ---------- */
const tekstPartnera = (t, max) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, max);
const tloPartnera = (t) => (t === 'ciemne' ? 'ciemne' : 'jasne');
const LOGO_MAX_BAJTOW = 1500 * 1024;
const TYPY_LOGO = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg' };

async function partnerDodaj(body) {
  const nazwa = tekstPartnera(body.nazwa, 60);
  if (!nazwa) throw bladDanych('Wpisz nazwę.');
  const m = /^data:(image\/(?:webp|png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.obraz || ''));
  if (!m) throw bladDanych('Logo musi być obrazem (PNG, JPG, WebP lub SVG).');
  if (Buffer.byteLength(m[2], 'base64') > LOGO_MAX_BAJTOW) throw bladDanych('Plik z logo jest za duży.');
  const plik = crypto.randomBytes(8).toString('hex') + '.' + TYPY_LOGO[m[1]];
  await zapiszPlik(KATALOG_LOGO + '/' + plik, m[2], 'Panel admina: logo ' + nazwa);
  const { dane } = await czytajUstawienia();
  const partnerzy = Array.isArray(dane.partnerzy) ? dane.partnerzy : [];
  partnerzy.push({ id: plik, nazwa, rola: tekstPartnera(body.rola, 40), tlo: tloPartnera(body.tlo), pokaz: true });
  dane.partnerzy = partnerzy;
  await zapiszUstawienia(dane, 'Panel admina: dodano ' + nazwa);
  return { ok: true, partnerzy };
}

/** Kolejność, przełączniki i podpisy – tylko dla już istniejących pozycji. */
async function partnerzyZapisz(body) {
  const { dane } = await czytajUstawienia();
  const obecni = Array.isArray(dane.partnerzy) ? dane.partnerzy : [];
  const zmiany = Array.isArray(body.lista) ? body.lista : [];
  const nowi = [];
  zmiany.forEach((z) => {
    const p = obecni.find((x) => x.id === z.id);
    if (p && !nowi.includes(p)) nowi.push({ ...p, nazwa: tekstPartnera(z.nazwa, 60) || p.nazwa, rola: tekstPartnera(z.rola, 40), tlo: tloPartnera(z.tlo), pokaz: !!z.pokaz });
  });
  obecni.forEach((p) => { if (!nowi.some((x) => x.id === p.id)) nowi.push(p); });
  dane.partnerzy = nowi;
  await zapiszUstawienia(dane, 'Panel admina: partnerzy');
  return { ok: true, partnerzy: nowi };
}

async function partnerUsun(body) {
  const { dane } = await czytajUstawienia();
  const obecni = Array.isArray(dane.partnerzy) ? dane.partnerzy : [];
  const p = obecni.find((x) => x.id === body.id);
  if (!p) throw bladDanych('Nie ma takiej pozycji.');
  dane.partnerzy = obecni.filter((x) => x !== p);
  await zapiszUstawienia(dane, 'Panel admina: usunięto ' + p.nazwa);
  const r = await github('/contents/' + KATALOG_LOGO + '/' + p.id + '?ref=main');
  if (r.ok) {
    const f = await r.json();
    await github('/contents/' + KATALOG_LOGO + '/' + p.id, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Panel admina: usunięto logo ' + p.nazwa, sha: f.sha, branch: 'main' }),
    });
  }
  return { ok: true, partnerzy: dane.partnerzy };
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
  if (!['zapisz', 'partner-dodaj', 'partnerzy', 'partner-usun'].includes(body.akcja)) return res.status(400).json({ ok: false, blad: 'Nieznana akcja.' });

  if (!TOKEN()) {
    return res.status(500).json({ ok: false, blad: 'Strona nie widzi tokenu GitHub (zmienna GITHUB_TOKEN w Vercel). Sprawdź nazwę zmiennej i zrób Redeploy.' });
  }

  try {
    if (body.akcja === 'partner-dodaj') return res.status(200).json(await partnerDodaj(body));
    if (body.akcja === 'partnerzy') return res.status(200).json(await partnerzyZapisz(body));
    if (body.akcja === 'partner-usun') return res.status(200).json(await partnerUsun(body));

    const tdid = body.tdid ? String(body.tdid) : '';
    if (tdid && !WZOR_TDID.test(tdid)) return res.status(400).json({ ok: false, blad: 'To nie wygląda na link do turnieju z Nakka.' });
    const { dane } = await czytajUstawienia();
    const ustawienia = await zapiszUstawienia({
      tdid: tdid || null,
      link: tdid ? 'https://n01darts.com/n01/tournament/comp.php?id=' + tdid : null,
      tytul: String(body.tytul || '').slice(0, 80),
      napis: String(body.napis || '').slice(0, 160),
      partnerzy: Array.isArray(dane.partnerzy) ? dane.partnerzy : [], // partnerzy zostają przy zmianie turnieju
      zmieniono: new Date().toISOString(),
    }, 'Panel admina: ' + (tdid ? 'turniej ' + tdid : 'brak turnieju'));
    return res.status(200).json({ ok: true, ustawienia });
  } catch (e) {
    return res.status(e.status || 502).json({ ok: false, blad: e.status ? e.message : 'Nie udało się zapisać: ' + e.message + '.' });
  }
};
