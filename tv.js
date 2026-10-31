// Dart Dębica TV – mecze na żywo z turnieju w Nakka, pod telewizor.
// Turniej wybiera się w panelu admina (/admin). Do testów można dopisać do adresu ?t=t_XXXX_1234.
(function () {
  'use strict';

  const API = ['https://api.n01darts.com/api/v1', 'https://push.n01darts.com/api/v1'];
  const ODSWIEZ_MECZE_MS = 5000; // lista meczów na żywo
  const MIN_ODSTEP_SZCZEGOLOW_MS = 4000; // szczegóły jednego meczu najczęściej co tyle
  const ODSWIEZ_TURNIEJ_MS = 60000; // nazwa turnieju i statystyki
  const ODSWIEZ_USTAWIENIA_MS = 20000; // czy admin nie zmienił turnieju
  const CZAS_STRONY_MS = 15000; // gdy mecze się nie mieszczą – zmiana strony
  const CZAS_WYSKOKU_MS = 6500;
  const SZYBKI_LEG = 18;
  const HIGH_FINISH = 100;

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------------- Nakka ---------------- */

  async function pobierzJson(sciezka, timeout = 8000) {
    let blad;
    for (const baza of API) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeout);
      try {
        const sep = sciezka.includes('?') ? '&' : '?';
        const res = await fetch(baza + sciezka + sep + '_t=' + Date.now(), { cache: 'no-store', signal: ctrl.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        if (j && j.result !== undefined && j.result !== 0) throw new Error('kod ' + j.result);
        return j;
      } catch (e) {
        blad = e;
      } finally {
        clearTimeout(t);
      }
    }
    throw blad;
  }

  /* ---------------- stan ---------------- */

  const stan = {
    tdid: null,
    tytulWlasny: '',
    tytul: '',
    imiona: {}, // tpid -> nazwa
    staty: {}, // tpid -> statystyki turnieju (ton80, highOut, best)
    mecze: new Map(), // mid -> { lista, szczegoly, podpis, ostatnioPobrany, kolejnosc }
    zdarzenia: [], // wszystkie wykryte wydarzenia
    widziane: new Set(),
    pierwszeSprawdzenie: true,
    strona: 0,
    licznikKolejnosci: 0,
    wyskoki: [],
    wyskokTrwa: false,
    akcje: new Map(), // mid -> czas do kiedy podświetlić kartę
    nowe: new Set(), // klucze wierszy wyróżnień do mignięcia
  };

  /* ---------------- przebieg legów ---------------- */

  /** Czy pierwszy wpis lega to stan startowy (score 0, left 501). Jak w aplikacji LSDD. */
  function pomijacPierwszy(d) {
    const st = d.statsData || [];
    const legi = d.legData || [];
    const policz = (skip) => [0, 1].map((p) => legi.reduce((s, leg) => {
      const raw = (leg.playerData && leg.playerData[p]) || [];
      const r = skip ? raw.slice(1) : raw;
      const fin = r.findIndex((x) => Number(x.score) < 0);
      return s + (fin >= 0 ? 3 * fin + Math.abs(Number(r[fin].score)) : 3 * r.length);
    }, 0));
    const dd = [Number(st[0] && st[0].allDarts), Number(st[1] && st[1].allDarts)];
    const a = policz(false), b = policz(true);
    if (a[0] === dd[0] && a[1] === dd[1]) return false;
    if (b[0] === dd[0] && b[1] === dd[1]) return true;
    const pierwsze = legi.flatMap((leg) => [0, 1].map((p) => leg.playerData && leg.playerData[p] && leg.playerData[p][0]).filter(Boolean));
    return pierwsze.length > 0 && pierwsze.every((x) => Number(x.score) === 0);
  }

  /** Rundy gracza w legu (bez wpisu startowego) i liczba punktów na starcie lega. */
  function rundy(leg, p, skip) {
    const raw = (leg && leg.playerData && leg.playerData[p]) || [];
    const r = skip ? raw.slice(1) : raw;
    let start = skip && raw[0] ? Number(raw[0].left) : NaN;
    if (!(start > 0) && r[0]) start = Number(r[0].left) + Math.max(0, Number(r[0].score));
    return { r, start: start > 0 ? start : 501 };
  }

  /** Wydarzenia z meczu: 180, 171, szybki leg (do 18 lotki), high finish (100+). */
  function wydarzeniaMeczu(mid, d) {
    const st = d.statsData || [];
    if (st.length < 2 || !Array.isArray(d.legData)) return [];
    const skip = pomijacPierwszy(d);
    const out = [];
    d.legData.forEach((leg, li) => {
      [0, 1].forEach((p) => {
        const { r, start } = rundy(leg, p, skip);
        const ja = st[p] || {}, on = st[1 - p] || {};
        const baza = { mid, tpid: ja.tpid || '', nazwa: ja.name || 'Gracz', rywal: on.name || '' };
        const k = (typ, left) => mid + '|' + li + '|' + p + '|' + typ + '|' + left;
        for (let i = 0; i < r.length; i++) {
          const sc = Number(r[i].score), left = Number(r[i].left);
          if (sc === 180 || sc === 171) out.push({ ...baza, klucz: k(sc, left), typ: String(sc), w: sc });
          if (sc < 0) {
            const lotki = 3 * i + Math.abs(sc);
            const przed = i > 0 ? Number(r[i - 1].left) : start;
            if (Number(leg.middleForDiddle) !== 1 && lotki >= 9 && lotki <= SZYBKI_LEG) out.push({ ...baza, klucz: k('bl', 0), typ: 'bl', w: lotki });
            if (przed >= HIGH_FINISH && przed <= 170) out.push({ ...baza, klucz: k('hf', 0), typ: 'hf', w: przed });
            break;
          }
        }
      });
    });
    return out;
  }

  /** Stan bieżącego lega: ile zostało, ostatnia runda, kto rzuca. */
  function stanLega(d) {
    const legi = d.legData || [];
    if (!legi.length) return null;
    const skip = pomijacPierwszy(d);
    const leg = legi[legi.length - 1];
    const gracze = [0, 1].map((p) => {
      const { r, start } = rundy(leg, p, skip);
      const ost = r[r.length - 1];
      const skonczyl = r.some((x) => Number(x.score) < 0);
      return { zostalo: skonczyl ? 0 : ost ? Number(ost.left) : start, ostatnio: ost && Number(ost.score) >= 0 ? Number(ost.score) : null, ile: r.length, skonczyl };
    });
    let rzuca = null;
    const cp = Number(leg.currentPlayer);
    if (!gracze[0].skonczyl && !gracze[1].skonczyl && Number(leg.endFlag) !== 1 && (cp === 0 || cp === 1)) {
      rzuca = cp;
    } else if (!gracze[0].skonczyl && !gracze[1].skonczyl) {
      if (gracze[0].ile !== gracze[1].ile) rzuca = gracze[0].ile < gracze[1].ile ? 0 : 1;
      else {
        // przy równej liczbie rund rzuca ten, kto zaczynał lega; zaczynający zmienia się co leg
        for (let j = legi.length - 2; j >= 0; j--) {
          const a = rundy(legi[j], 0, skip).r.length, b = rundy(legi[j], 1, skip).r.length;
          if (a !== b) {
            const zaczal = a > b ? 0 : 1;
            rzuca = (legi.length - 1 - j) % 2 === 0 ? zaczal : 1 - zaczal;
            break;
          }
        }
      }
    }
    return { gracze, rzuca, numer: legi.length };
  }

  /** Faza turnieju: Nakka dopisuje ją do tytułu meczu („<nazwa turnieju> Top 16”); zapasowo z identyfikatora meczu. */
  function faza(m) {
    const tytulMeczu = String(m.title || (m.szczegolyTytul || '')).trim();
    if (tytulMeczu && stan.tytul && tytulMeczu.startsWith(stan.tytul)) {
      const reszta = tytulMeczu.slice(stan.tytul.length).replace(/^[\s\-–·:]+/, '').trim();
      if (reszta) return reszta;
    }
    const tmid = String(m.tmid || '');
    const g = tmid.match(/_rr_([A-Za-z0-9]+)_/);
    if (g) return 'Grupa ' + (/^\d+$/.test(g[1]) ? String.fromCharCode(65 + Math.max(0, Number(g[1]) - 1)) : g[1]);
    if (/_t3_/.test(tmid)) return 'Mecz o 3. miejsce';
    if (/_t_\d+_/.test(tmid)) return 'Faza pucharowa';
    return '';
  }

  /* ---------------- pobieranie ---------------- */

  async function wczytajUstawienia() {
    const zAdresu = new URLSearchParams(location.search).get('t');
    if (zAdresu) return { tdid: zAdresu, tytul: '' };
    for (const url of ['/api/ustawienia', 'ustawienia.json']) {
      try {
        const res = await fetch(url + '?_t=' + Date.now(), { cache: 'no-store' });
        if (res.ok) return await res.json();
      } catch (e) { /* próbujemy dalej */ }
    }
    return null;
  }

  async function sprawdzUstawienia() {
    const u = await wczytajUstawienia();
    if (!u) return;
    const tdid = u.tdid || null;
    stan.tytulWlasny = u.tytul || '';
    if (tdid !== stan.tdid) {
      // nowy turniej – zaczynamy od zera
      stan.tdid = tdid;
      stan.tytul = '';
      stan.imiona = {};
      stan.staty = {};
      stan.mecze.clear();
      stan.zdarzenia = [];
      stan.widziane.clear();
      stan.pierwszeSprawdzenie = true;
      stan.strona = 0;
      stan.wyskoki = [];
      await wczytajTurniej();
      await odswiezMecze();
    }
    rysujTytul();
  }

  async function wczytajTurniej() {
    if (!stan.tdid) return;
    const q = encodeURIComponent(stan.tdid);
    try {
      const j = await pobierzJson('/tournament/get?tdid=' + q);
      const t = j.tournament || {};
      stan.tytul = t.title || '';
      (t.entry_list || []).forEach((e) => { if (e.tpid) stan.imiona[e.tpid] = e.name; });
    } catch (e) { /* spróbujemy za minutę */ }
    try {
      const s = await pobierzJson('/tournament/stats?tdid=' + q + '&kind=stats_list');
      stan.staty = (s && s.stats) || {};
    } catch (e) { /* bez statystyk */ }
    rysujTytul();
    rysujWyroznienia();
  }

  function podpis(m) {
    return (m.statsData || []).map((s) => s.allDarts + '/' + s.winLegs + '/' + s.winSets).join('|') + '|' + m.endMatch;
  }

  let trwa = false;
  async function odswiezMecze() {
    if (!stan.tdid || trwa) return;
    trwa = true;
    try {
      let lista;
      try {
        const j = await pobierzJson('/match/list?tdid=' + encodeURIComponent(stan.tdid) + '&live=1', 6000);
        lista = (j.list || []).filter((m) => m.mid && (!m.tmid || String(m.tmid).startsWith(stan.tdid)));
      } catch (e) {
        return; // Nakka chwilowo nie odpowiada – zostaje to, co na ekranie
      }
      const teraz = Date.now();
      const obecne = new Set();
      const doPobrania = [];
      lista.forEach((m) => {
        const koniec = Number(m.endMatch) === 1 || m.endMatch === true;
        const stary = stan.mecze.get(m.mid);
        if (koniec) {
          // mecz właśnie się skończył – jedno ostatnie pobranie (ostatnie zamknięcie), potem znika z ekranu
          if (stary && !stary.koniec) { stary.koniec = true; stary.lista = m; doPobrania.push(stary); }
          return;
        }
        obecne.add(m.mid);
        const w = stary || { mid: m.mid, podpis: '', ostatnio: 0, kolejnosc: stan.licznikKolejnosci++ };
        w.lista = m;
        stan.mecze.set(m.mid, w);
        const p = podpis(m);
        if (p !== w.podpis && teraz - w.ostatnio >= MIN_ODSTEP_SZCZEGOLOW_MS) doPobrania.push(w);
      });
      // mecze, które zniknęły z listy
      stan.mecze.forEach((w, mid) => {
        if (!obecne.has(mid) && !w.koniec) { w.koniec = true; doPobrania.push(w); }
      });

      for (let i = 0; i < doPobrania.length; i += 4) {
        await Promise.all(doPobrania.slice(i, i + 4).map(async (w) => {
          w.ostatnio = Date.now();
          try {
            const j = await pobierzJson('/match/get?mid=' + encodeURIComponent(w.mid));
            const d = j.match || j;
            if (!d || !d.legData) throw new Error('brak legów');
            w.szczegoly = d;
            w.podpis = podpis(w.lista);
            przyjmijZdarzenia(wydarzeniaMeczu(w.mid, d));
          } catch (e) {
            if (w.koniec && !obecne.has(w.mid)) w.koniec = false; // spróbujemy jeszcze raz
          }
        }));
      }
      // usuwamy zakończone
      stan.mecze.forEach((w, mid) => { if (w.koniec && w.szczegoly !== undefined && !obecne.has(mid)) stan.mecze.delete(mid); });
      stan.pierwszeSprawdzenie = false;
      rysujMecze();
      rysujTasme();
    } finally {
      trwa = false;
    }
  }

  function przyjmijZdarzenia(lista) {
    let cos = false;
    lista.forEach((z) => {
      if (stan.widziane.has(z.klucz)) return;
      stan.widziane.add(z.klucz);
      z.stare = stan.pierwszeSprawdzenie;
      z.czas = Date.now();
      stan.zdarzenia.push(z);
      cos = true;
      if (!z.stare) {
        stan.wyskoki.push(z);
        stan.akcje.set(z.mid, Date.now() + 9000);
        stan.nowe.add(z.typ + '|' + z.tpid);
      }
    });
    if (cos) {
      rysujWyroznienia();
      pokazWyskok();
    }
  }

  /* ---------------- rysowanie ---------------- */

  function rysujTytul() {
    const t = stan.tytulWlasny || stan.tytul || (stan.tdid ? 'Turniej' : 'Dart Dębica TV');
    $('#tytul').textContent = t;
    document.title = t + ' · na żywo';
  }

  function srednia(s) {
    return s && Number(s.allDarts) > 0 ? ((Number(s.allScore) / Number(s.allDarts)) * 3).toFixed(2) : null;
  }

  /** Ile kart na stronie i w jakim układzie (kolumny × wiersze) */
  function uklad(n) {
    if (n <= 1) return { k: 1, w: 1, s: 1.9 };
    if (n <= 2) return { k: 2, w: 1, s: 1.55 };
    if (n <= 4) return { k: 2, w: 2, s: 1.4 };
    if (n <= 6) return { k: 3, w: 2, s: 1.15 };
    if (n <= 9) return { k: 3, w: 3, s: 1.0 };
    return { k: 4, w: 3, s: 0.86 };
  }
  const NA_STRONIE = 12;

  function chipy(mid, tpid) {
    const z = stan.zdarzenia.filter((e) => e.mid === mid && e.tpid === tpid);
    const ile = (t) => z.filter((e) => e.typ === t).length;
    const out = [];
    if (ile('180')) out.push('<span class="chip c180">180' + (ile('180') > 1 ? '×' + ile('180') : '') + '</span>');
    if (ile('171')) out.push('<span class="chip c171">171' + (ile('171') > 1 ? '×' + ile('171') : '') + '</span>');
    const hf = z.filter((e) => e.typ === 'hf').map((e) => e.w);
    if (hf.length) out.push('<span class="chip chf">HF ' + Math.max(...hf) + '</span>');
    const bl = z.filter((e) => e.typ === 'bl').map((e) => e.w);
    if (bl.length) out.push('<span class="chip cbl">BL ' + Math.min(...bl) + '</span>');
    return out.join('');
  }

  function kartaHtml(w) {
    const m = w.lista;
    const d = w.szczegoly || m;
    const st = (d.statsData && d.statsData.length >= 2 ? d.statsData : m.statsData) || [];
    const leg = w.szczegoly ? stanLega(w.szczegoly) : null;
    const sety = st.some((s) => Number(s.winSets) > 0);
    const legiA = Number(st[0] && st[0].winLegs) || 0, legiB = Number(st[1] && st[1].winLegs) || 0;
    const akcja = (stan.akcje.get(w.mid) || 0) > Date.now();
    const gracz = (p) => {
      const s = st[p] || {};
      const g = leg ? leg.gracze[p] : null;
      const moje = p === 0 ? legiA : legiB, jego = p === 0 ? legiB : legiA;
      const sr = srednia(s);
      const pod = [sr ? 'śr. ' + sr : '', g && g.ostatnio !== null ? 'ostatnio ' + g.ostatnio : ''].filter(Boolean).join(' · ');
      return '<div class="k-gracz' + (leg && leg.rzuca === p ? ' rzuca' : '') + (moje > jego ? ' prowadzi' : '') + '">' +
        '<div class="k-kto"><span class="k-nazwa">' + esc(s.name || 'Gracz ' + (p + 1)) + '</span>' +
        '<span class="k-pod"><span>' + esc(pod) + '</span>' + chipy(w.mid, s.tpid) + '</span></div>' +
        '<span class="k-zostalo">' + (g ? g.zostalo : '') + '</span>' +
        '<span class="k-legi">' + (sety ? '<span class="k-sety">' + (Number(s.winSets) || 0) + '</span>·' : '') + moje + '</span></div>';
    };
    const f = faza(m);
    return '<article class="karta' + (akcja ? ' akcja' : '') + '">' +
      '<div class="k-gora"><span class="k-faza">' + esc(f || 'Mecz') + '</span><span>' + (leg ? 'Leg ' + leg.numer : '') + '</span></div>' +
      gracz(0) + gracz(1) + '</article>';
  }

  function aktywne() {
    return Array.from(stan.mecze.values()).filter((w) => !w.koniec).sort((a, b) => a.kolejnosc - b.kolejnosc);
  }

  function rysujMecze() {
    const el = $('#mecze');
    const lista = aktywne();
    $('#licznik').textContent = lista.length ? 'Na żywo · ' + lista.length + ' ' + odmiana(lista.length) : 'Na żywo';
    if (!stan.tdid) {
      el.style.setProperty('--k', 1); el.style.setProperty('--w', 1);
      el.innerHTML = '<div class="pusto"><b>Brak wybranego turnieju</b><span>Wklej link do turnieju z Nakka w panelu admina – ekran sam się przełączy.</span></div>';
      $('#strony').hidden = true;
      return;
    }
    if (!lista.length) {
      el.style.setProperty('--k', 1); el.style.setProperty('--w', 1);
      el.innerHTML = '<div class="pusto"><b>Za chwilę kolejne mecze</b><span>Mecze pojawią się tu same, gdy tylko zawodnicy zaczną grać w Nakka.</span></div>';
      $('#strony').hidden = true;
      return;
    }
    const strony = Math.ceil(lista.length / NA_STRONIE);
    if (stan.strona >= strony) stan.strona = 0;
    // mecze dzielimy po równo między strony (np. 18 = 2 × 9), wtedy karty są większe; układ ten sam na każdej stronie
    const naJednej = Math.ceil(lista.length / strony);
    const naStronie = lista.slice(stan.strona * naJednej, (stan.strona + 1) * naJednej);
    const u = uklad(naJednej);
    el.style.setProperty('--k', u.k);
    el.style.setProperty('--w', u.w);
    el.style.setProperty('--s', u.s);
    el.innerHTML = naStronie.map(kartaHtml).join('');
    skrocNazwiska(el);
    const sEl = $('#strony');
    if (strony > 1) {
      sEl.hidden = false;
      sEl.innerHTML = 'Strona ' + (stan.strona + 1) + '/' + strony + ' ' + Array.from({ length: strony }, (_, i) => '<i class="' + (i === stan.strona ? 'ta' : '') + '"></i>').join('');
    } else sEl.hidden = true;
  }

  /** Nazwisko się nie mieści – skracamy imię do inicjału („S. Parkitny”). */
  function skrocNazwiska(el) {
    el.querySelectorAll('.k-nazwa').forEach((n) => {
      if (n.scrollWidth <= n.clientWidth + 1) return;
      const czesci = n.textContent.trim().split(/\s+/);
      if (czesci.length < 2) return;
      n.title = n.textContent;
      n.textContent = czesci[0][0] + '. ' + czesci.slice(1).join(' ');
    });
  }

  function odmiana(n) {
    return n === 1 ? 'mecz' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'mecze' : 'meczów';
  }

  // zmiana strony co 15 s, gdy mecze się nie mieszczą
  let timerStrony = null;
  function planujStrone() {
    clearTimeout(timerStrony);
    const strony = Math.ceil(aktywne().length / NA_STRONIE);
    const postep = $('#postep');
    postep.classList.remove('biegnie');
    if (strony > 1) {
      void postep.offsetWidth;
      postep.style.setProperty('--strona', CZAS_STRONY_MS / 1000 + 's');
      postep.classList.add('biegnie');
    }
    timerStrony = setTimeout(() => {
      const n = Math.ceil(aktywne().length / NA_STRONIE);
      if (n > 1) {
        stan.strona = (stan.strona + 1) % n;
        rysujMecze();
        const el = $('#mecze');
        el.classList.remove('zmiana'); void el.offsetWidth; el.classList.add('zmiana');
      }
      planujStrone();
    }, CZAS_STRONY_MS);
  }

  /** Pasek na dole: wyniki wszystkich trwających meczów, przewija się w kółko. */
  function trescTasmy() {
    return aktywne().map((w) => {
      const st = (w.szczegoly && w.szczegoly.statsData) || w.lista.statsData || [];
      const a = st[0] || {}, b = st[1] || {};
      const sety = st.some((s) => Number(s.winSets) > 0);
      return '<span class="t-mecz">' + esc(a.name || '') + ' <b>' + (sety ? (a.winSets || 0) + ':' + (b.winSets || 0) + ' <small>sety</small> ' : '') +
        (Number(a.winLegs) || 0) + ':' + (Number(b.winLegs) || 0) + '</b> ' + esc(b.name || '') + '</span>';
    }).join('');
  }
  function rysujTasme(wymus) {
    const t = $('#tasma');
    const tresc = trescTasmy();
    if (!tresc) { t.innerHTML = '<span class="t-mecz"><small>Brak trwających meczów</small></span>'; t.classList.add('stoi'); return; }
    // przy działającej animacji treść podmieniamy dopiero na końcu przejazdu (bez szarpnięcia)
    if (!wymus && !t.classList.contains('stoi') && t.dataset.ok === '1') { t.dataset.czeka = '1'; return; }
    t.classList.remove('stoi');
    t.innerHTML = tresc + tresc; // dwie kopie = płynna pętla
    t.dataset.ok = '1';
    const szer = t.scrollWidth / 2;
    t.style.setProperty('--czas', Math.max(20, szer / 90) + 's'); // ok. 90 px na sekundę
  }
  $('#tasma').addEventListener('animationiteration', () => {
    const t = $('#tasma');
    if (t.dataset.czeka === '1') { t.dataset.czeka = ''; rysujTasme(true); }
  });

  /** Panel boczny: 180, 171, high finishe i najszybsze legi całego turnieju. */
  function rysujWyroznienia() {
    const zd = stan.zdarzenia;
    const nazwa = (tpid, zapas) => stan.imiona[tpid] || zapas || '';
    const naz = {};
    zd.forEach((z) => { naz[z.tpid] = z.nazwa; });

    // 180: większa z liczb – ze statystyk turnieju albo z wykrytych w meczach (żeby nie liczyć podwójnie)
    const ile180 = {};
    Object.entries(stan.staty).forEach(([tpid, s]) => { if (Number(s.ton80) > 0) ile180[tpid] = Number(s.ton80); });
    const z180 = {};
    zd.filter((z) => z.typ === '180').forEach((z) => { z180[z.tpid] = (z180[z.tpid] || 0) + 1; });
    Object.entries(z180).forEach(([tpid, n]) => { ile180[tpid] = Math.max(ile180[tpid] || 0, n); });

    const ile171 = {};
    zd.filter((z) => z.typ === '171').forEach((z) => { ile171[z.tpid] = (ile171[z.tpid] || 0) + 1; });

    const hf = {};
    Object.entries(stan.staty).forEach(([tpid, s]) => { if (Number(s.highOut) >= HIGH_FINISH) hf[tpid] = Number(s.highOut); });
    zd.filter((z) => z.typ === 'hf').forEach((z) => { hf[z.tpid] = Math.max(hf[z.tpid] || 0, z.w); });

    const bl = {};
    Object.entries(stan.staty).forEach(([tpid, s]) => { const b = Number(s.best); if (b >= 9 && b <= SZYBKI_LEG) bl[tpid] = b; });
    zd.filter((z) => z.typ === 'bl').forEach((z) => { bl[z.tpid] = Math.min(bl[z.tpid] || 99, z.w); });

    const sekcja = (typ, tytul, obj, malejaco, format) => {
      const wiersze = Object.entries(obj).map(([tpid, v]) => ({ tpid, v, n: nazwa(tpid, naz[tpid]) })).filter((x) => x.n)
        .sort((a, b) => (malejaco ? b.v - a.v : a.v - b.v) || a.n.localeCompare(b.n, 'pl'));
      const html = wiersze.map((x) => {
        const nowy = stan.nowe.has(typ + '|' + x.tpid);
        return '<div class="w-wiersz' + (nowy ? ' nowe' : '') + '"><span>' + esc(x.n) + '</span><b>' + format(x.v) + '</b></div>';
      }).join('');
      // sekcja z większą liczbą zawodników dostaje więcej miejsca
      return '<div class="w-sekcja w-' + typ + '" style="flex-grow:' + Math.max(1, Math.min(wiersze.length, 8)) + '"><h3>' + tytul + '</h3>' +
        '<div class="w-lista">' + (html ? '<div class="w-tasma">' + html + '</div>' : '<p class="w-brak">jeszcze nikt</p>') + '</div></div>';
    };
    const html =
      sekcja('180', '180', ile180, true, (v) => '×' + v) +
      sekcja('171', '171', ile171, true, (v) => '×' + v) +
      sekcja('hf', 'High finish 100+', hf, true, (v) => v) +
      sekcja('bl', 'Best leg do 18', bl, false, (v) => lotka(v));
    stan.nowe.clear();
    const box = $('#wyroznienia');
    if (box.dataset.html === html) return; // nic się nie zmieniło – nie przerywamy przewijania
    box.dataset.html = html;
    box.innerHTML = html;
    przewijajWyroznienia();
  }

  function lotka(n) {
    return n + ' lotka';
  }

  /** Sekcja, w której nie mieszczą się wszyscy zawodnicy, sama przewija się powoli w górę, w kółko. */
  function przewijajWyroznienia() {
    $('#wyroznienia').querySelectorAll('.w-lista').forEach((lista) => {
      const tasma = lista.querySelector('.w-tasma');
      if (!tasma || tasma.scrollHeight <= lista.clientHeight + 2) return;
      const wiersze = tasma.children.length;
      const kopia = tasma.innerHTML + '<div class="w-odstep"></div>';
      tasma.innerHTML = kopia + kopia; // dwie kopie = płynna pętla
      tasma.classList.add('jedzie');
      tasma.style.setProperty('--czas', Math.max(10, wiersze * 2.2) + 's');
    });
  }

  /* ---------------- wyskakujące okienko ---------------- */

  const OPIS = {
    '180': { duzy: '180', rodzaj: 'Max!', klasa: '' },
    '171': { duzy: '171', rodzaj: 'Runda', klasa: 'turkus' },
    hf: { rodzaj: 'High finish', klasa: '' },
    bl: { rodzaj: 'Szybki leg', klasa: 'turkus' },
  };
  function pokazWyskok() {
    if (stan.wyskokTrwa || !stan.wyskoki.length) return;
    const z = stan.wyskoki.shift();
    stan.wyskokTrwa = true;
    const o = OPIS[z.typ];
    const duzy = o.duzy || (z.typ === 'bl' ? z.w + '<small style="font-size:.45em"> lotka</small>' : z.w);
    const el = document.createElement('div');
    el.className = 'wyskok ' + o.klasa;
    el.innerHTML = '<span class="duzy">' + duzy + '</span><span class="opis"><span class="rodzaj">' + o.rodzaj + '</span>' +
      '<span class="kto">' + esc(z.nazwa) + '</span>' + (z.rywal ? '<span class="vs">vs ' + esc(z.rywal) + '</span>' : '') + '</span>';
    const w = $('#wyskok');
    w.innerHTML = '';
    w.appendChild(el);
    rysujMecze(); // podświetlenie karty
    setTimeout(() => el.classList.add('znika'), CZAS_WYSKOKU_MS);
    setTimeout(() => {
      el.remove();
      stan.wyskokTrwa = false;
      if (stan.wyskoki.length) pokazWyskok();
      else rysujMecze();
    }, CZAS_WYSKOKU_MS + 450);
  }

  /* ---------------- zegar, pełny ekran, kursor, wygaszacz ---------------- */

  function zegar() {
    $('#zegar').textContent = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  }

  let timerKursora = setTimeout(() => document.body.classList.add('bez-kursora'), 20000);
  document.addEventListener('mousemove', () => {
    document.body.classList.remove('bez-kursora');
    clearTimeout(timerKursora);
    timerKursora = setTimeout(() => document.body.classList.add('bez-kursora'), 4000);
  });
  $('#pelny').addEventListener('click', () => {
    const d = document.documentElement;
    (d.requestFullscreen || d.webkitRequestFullscreen || (() => {})).call(d);
    zablokujWygaszanie();
  });
  document.addEventListener('fullscreenchange', () => $('#pelny').classList.toggle('ukryj', !!document.fullscreenElement));

  // telewizor / laptop nie wygasza ekranu, gdy strona jest otwarta
  let blokada = null;
  async function zablokujWygaszanie() {
    try { if ('wakeLock' in navigator && !blokada) { blokada = await navigator.wakeLock.request('screen'); blokada.addEventListener('release', () => { blokada = null; }); } } catch (e) { /* niedostępne */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { zablokujWygaszanie(); odswiezMecze(); } });

  /* ---------------- start ---------------- */

  async function start() {
    zegar();
    setInterval(zegar, 5000);
    rysujMecze();
    rysujWyroznienia();
    rysujTasme();
    await sprawdzUstawienia();
    setInterval(sprawdzUstawienia, ODSWIEZ_USTAWIENIA_MS);
    setInterval(odswiezMecze, ODSWIEZ_MECZE_MS);
    setInterval(wczytajTurniej, ODSWIEZ_TURNIEJ_MS);
    // co sekundę zdejmujemy wygasłe podświetlenia kart
    setInterval(() => {
      let zmiana = false;
      stan.akcje.forEach((do_, mid) => { if (do_ <= Date.now()) { stan.akcje.delete(mid); zmiana = true; } });
      if (zmiana) rysujMecze();
    }, 1000);
    planujStrone();
    zablokujWygaszanie();
  }
  start();
})();
