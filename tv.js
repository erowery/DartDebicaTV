// Dart Dębica TV – mecze na żywo z turnieju w Nakka, pod telewizor.
// Turniej wybiera się w panelu admina (/admin). Do testów można dopisać do adresu ?t=t_XXXX_1234.
(function () {
  'use strict';

  const API = ['https://api.n01darts.com/api/v1', 'https://push.n01darts.com/api/v1'];
  const ODSWIEZ_MECZE_MS = 5000; // lista meczów na żywo
  const ODSWIEZ_TURNIEJ_MS = 60000; // nazwa turnieju i statystyki
  const ODSWIEZ_USTAWIENIA_MS = 20000; // czy admin nie zmienił turnieju
  const CZAS_STRONY_MS = 15000; // gdy mecze się nie mieszczą – zmiana strony
  const CZAS_WYSKOKU_MS = 6500;
  const SZYBKI_LEG = 18;
  const OKNO_TURNIEJU_S = 14 * 3600; // gdy Nakka nie podaje daty turnieju: mecze starsze niż 14 h pomijamy
  const PRZED_DATA_S = 12 * 3600; // mecze wcześniejsze niż 12 h przed datą turnieju (np. testowe) pomijamy

  /** Od kiedy liczą się mecze turnieju (sekundy). Turniej może trwać kilka dni. */
  function poczatekTurnieju() {
    const td = Number(stan.turniej && stan.turniej.t_date);
    if (td > 0) return td - PRZED_DATA_S;
    return Date.now() / 1000 - OKNO_TURNIEJU_S;
  }
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
    przeanalizowane: new Set(),
    archiwum: [], // wszystkie mecze turnieju (match/list zwraca na żywo najwyżej 100 ostatnich)
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
    stan.napis = u.napis || '';
    if (tdid !== stan.tdid) {
      // nowy turniej – zaczynamy od zera
      stan.tdid = tdid;
      stan.tytul = '';
      stan.imiona = {};
      stan.staty = {};
      stan.mecze.clear();
      stan.zdarzenia = [];
      stan.widziane.clear();
      stan.przeanalizowane.clear();
      stan.archiwum = [];
      stan.archiwumGotowe = false;
      stan.ostatniaAktywnosc = 0;
      stan.koniecZauwazony = 0;
      stan.znaniZapisani = null;
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
      stan.turniej = t;
    } catch (e) { /* spróbujemy za minutę */ }
    try {
      const s = await pobierzJson('/tournament/stats?tdid=' + q + '&kind=stats_list');
      stan.staty = (s && s.stats) || {};
    } catch (e) { /* bez statystyk */ }
    rysujTytul();
    // archiwum w tle – nie opóźnia pokazania meczów na żywo
    wczytajArchiwum().then(() => { rysujWyroznienia(); rysujTasme(); });
    rysujWyroznienia();
    rysujMecze();
    rysujTasme();
  }

  /** Wszystkie mecze turnieju od jego początku (po 100 na stronę) i ich 180/171/HF/BL do wyróżnień. */
  let archiwumTrwa = false;
  async function wczytajArchiwum() {
    if (!stan.tdid || archiwumTrwa) return;
    archiwumTrwa = true;
    const tdid = stan.tdid;
    try {
      const od = Math.floor(poczatekTurnieju());
      const doK = Math.floor(Date.now() / 1000) + 3600;
      let wszystkie = [];
      for (let skip = 0; skip < 2000; skip += 100) {
        const j = await pobierzJson('/match/list?tdid=' + encodeURIComponent(tdid) + '&startTime__gte=' + od + '&startTime__lt=' + doK + '&count=100&skip=' + skip, 10000);
        const l = (j.list || []).filter((m) => m.mid && (!m.tmid || String(m.tmid).startsWith(tdid)));
        wszystkie = wszystkie.concat(l);
        if ((j.list || []).length < 100) break;
      }
      if (tdid !== stan.tdid) return;
      stan.archiwum = wszystkie;
      const doAnalizy = wszystkie.filter((m) => (Number(m.endMatch) === 1 || m.endMatch === true) && !stan.przeanalizowane.has(m.mid) && !stan.mecze.has(m.mid));
      for (let i = 0; i < doAnalizy.length; i += 10) {
        await Promise.all(doAnalizy.slice(i, i + 10).map(async (m) => {
          try {
            const j = await pobierzJson('/match/get?mid=' + encodeURIComponent(m.mid));
            const d = j.match || j;
            if (d && d.legData && tdid === stan.tdid) {
              przyjmijZdarzenia(wydarzeniaMeczu(m.mid, d), true);
              stan.przeanalizowane.add(m.mid);
              let u = Number(d.updateTime) || 0;
              if (u > 0 && u < 1e12) u *= 1000;
              if (u > (stan.ostatniaAktywnosc || 0)) stan.ostatniaAktywnosc = u;
            }
          } catch (e) { /* następnym razem */ }
        }));
        if (tdid !== stan.tdid) return;
      }
      stan.archiwumGotowe = true;
    } catch (e) {
      /* Nakka nie odpowiada – spróbujemy za minutę */
    } finally {
      archiwumTrwa = false;
    }
  }

  function podpis(m) {
    return (m.statsData || []).map((s) => s.allDarts + '/' + s.winLegs + '/' + s.winSets).join('|') + '|' + m.endMatch;
  }

  // Wynik rzut po rzucie: ten sam adres, z którego korzysta podgląd meczu w Nakka (match/get ma tylko skończone legi).
  const WIDOK = 'https://lbc.n01darts.com/n01/tournament/n01_view_t.php?cmd=getViewData&sid=';
  const CO_ILE_MECZ_MS = 3000; // każdy trwający mecz najczęściej co tyle (szybciej po sygnale z Nakka)

  async function pobierzWidok(mid) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(WIDOK + '&_t=' + Date.now(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ mid, updateTime: 0, poling: 0 }),
        cache: 'no-store',
        signal: ctrl.signal,
      });
      const j = await res.json();
      if (!j || j.result !== 1 || !j.data || !Array.isArray(j.data.legData)) throw new Error('brak danych');
      return j;
    } finally {
      clearTimeout(t);
    }
  }

  /** Łączy listę meczów (nazwiska, średnie) z danymi na żywo (legi, rundy). */
  function polacz(lista, widok) {
    const st = (lista.statsData || []).map((s, i) => {
      const v = (widok.data.statsData || [])[i] || {};
      return { ...s, winLegs: v.winLegs !== undefined ? v.winLegs : s.winLegs, winSets: v.winSets !== undefined ? v.winSets : s.winSets };
    });
    return { ...lista, statsData: st, legData: widok.data.legData, currentLeg: widok.data.currentLeg };
  }

  /** Pobiera stan jednego meczu (rzut po rzucie); zapasowo match/get (stan po ostatnim skończonym legu). */
  async function pobierzMecz(w) {
    w.ostatnio = Date.now();
    w.pilne = false;
    if (w.limitSet === undefined) {
      w.limitSet = 0;
      pobierzJson('/match/get?mid=' + encodeURIComponent(w.mid)).then((j) => {
        const d = j.match || j;
        w.limitSet = Number(d && d.limitSet) || 0;
        w.limitLeg = Number(d && d.limitLeg) || 0;
        if (w.limitSet) stan.doNarysowania = true;
      }).catch(() => { w.limitSet = undefined; });
    }
    let d = null;
    try {
      const v = await pobierzWidok(w.mid);
      if (Number(v.data.updateTime) > 0) {
        w.aktualizacja = Number(v.data.updateTime);
        if (w.aktualizacja > (stan.ostatniaAktywnosc || 0)) stan.ostatniaAktywnosc = w.aktualizacja;
      }
      d = polacz(w.lista, v);
    } catch (e) {
      try {
        const j = await pobierzJson('/match/get?mid=' + encodeURIComponent(w.mid));
        d = j.match || j;
        if (!d || !d.legData) d = null;
      } catch (e2) { d = null; }
    }
    if (!d) return false;
    w.szczegoly = d;
    przyjmijZdarzenia(wydarzeniaMeczu(w.mid, d));
    stan.doNarysowania = true;
    return true;
  }

  // co sekundę: mecze, których dawno nie sprawdzaliśmy albo o których Nakka dała znać – najwyżej 6 naraz
  let wTrakcie = 0;
  function tykniecie() {
    const teraz = Date.now();
    // sprawdzamy też mecze wyglądające na porzucone (rzadziej, co 30 s) – mogą wrócić do gry
    const kolej = Array.from(stan.mecze.values())
      .filter((w) => !w.koniec && !w.pobieram && (w.pilne || teraz - (w.ostatnio || 0) >= (teraz - ostatniRuch(w) < PORZUCONY_MS || !w.szczegoly ? CO_ILE_MECZ_MS : 30000)))
      .sort((a, b) => (b.pilne ? 1 : 0) - (a.pilne ? 1 : 0) || (a.ostatnio || 0) - (b.ostatnio || 0));
    for (const w of kolej) {
      if (wTrakcie >= 6) break;
      wTrakcie++;
      w.pobieram = true;
      pobierzMecz(w).finally(() => { w.pobieram = false; wTrakcie--; });
    }
    if (stan.doNarysowania) {
      stan.doNarysowania = false;
      rysujMecze();
      rysujTasme();
    }
  }

  /* Sygnały z Nakka (WebSocket): „w meczu X coś się zmieniło” – wtedy pobieramy go od razu. */
  let gniazdo = null;
  const subskrybowane = new Set();
  function polaczSygnaly() {
    try {
      gniazdo = new WebSocket('wss://push.n01darts.com/push');
    } catch (e) { gniazdo = null; return; }
    subskrybowane.clear();
    gniazdo.onopen = () => subskrybuj();
    gniazdo.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.ping) { gniazdo.send(JSON.stringify({ pong: 1 })); return; }
      if (msg.notify) {
        const mid = String(msg.notify).replace(/^score_/, '');
        const w = stan.mecze.get(mid);
        if (w) w.pilne = true;
      }
    };
    gniazdo.onclose = () => { gniazdo = null; setTimeout(polaczSygnaly, 10000); };
  }
  function subskrybuj() {
    if (!gniazdo || gniazdo.readyState !== 1) return;
    aktywne().forEach((w) => {
      if (subskrybowane.has(w.mid)) return;
      subskrybowane.add(w.mid);
      gniazdo.send(JSON.stringify({ push: { id: 'score_' + w.mid } }));
    });
  }
  setInterval(() => { try { if (gniazdo && gniazdo.readyState === 1) gniazdo.send(JSON.stringify({ ping: 1 })); } catch (e) { /* nic */ } }, 30000);

  /** Pasek ostrzegawczy, gdy od 30 s nie ma nowych danych z Nakka. Znika sam po powrocie danych. */
  const BRAK_DANYCH_MS = 30000;
  function rysujPolaczenie() {
    const el = $('#awaria');
    if (!el) return;
    const t = tryb();
    const brak = !!stan.ostatnieDane && !['czekam', 'koniec'].includes(t) && Date.now() - stan.ostatnieDane > BRAK_DANYCH_MS;
    el.hidden = !brak;
    document.body.classList.toggle('bez-danych', brak);
    if (brak) {
      const g = new Date(stan.ostatnieDane);
      el.textContent = 'Brak połączenia z Nakka · ostatnia aktualizacja ' + String(g.getHours()).padStart(2, '0') + ':' + String(g.getMinutes()).padStart(2, '0');
    }
  }
  setInterval(rysujPolaczenie, 5000);

  /** Lista meczów turnieju (które trwają) – co 5 s. */
  let trwa = false;
  async function odswiezMecze() {
    if (!stan.tdid || trwa) return;
    trwa = true;
    try {
      let lista;
      try {
        const j = await pobierzJson('/match/list?tdid=' + encodeURIComponent(stan.tdid) + '&live=1', 6000);
        const od = poczatekTurnieju();
        lista = (j.list || []).filter((m) => m.mid && (!m.tmid || String(m.tmid).startsWith(stan.tdid)) && Number(m.startTime) >= od);
        stan.lista = lista;
        stan.ostatnieDane = Date.now();
        rysujPolaczenie();
      } catch (e) {
        rysujPolaczenie();
        return; // Nakka chwilowo nie odpowiada – zostaje to, co na ekranie
      }
      // zakończone mecze turnieju, których jeszcze nie przeanalizowaliśmy (np. sprzed włączenia ekranu)
      const doAnalizy = lista.filter((m) => (Number(m.endMatch) === 1 || m.endMatch === true) && !stan.przeanalizowane.has(m.mid) && !stan.mecze.has(m.mid)).slice(0, 6);
      await Promise.all(doAnalizy.map(async (m) => {
        try {
          const j = await pobierzJson('/match/get?mid=' + encodeURIComponent(m.mid));
          const d = j.match || j;
          if (d && d.legData) { przyjmijZdarzenia(wydarzeniaMeczu(m.mid, d), true); stan.przeanalizowane.add(m.mid); }
        } catch (e) { /* następnym razem */ }
      }));
      const obecne = new Set();
      const koncowe = [];
      lista.forEach((m) => {
        const koniec = Number(m.endMatch) === 1 || m.endMatch === true;
        const stary = stan.mecze.get(m.mid);
        if (koniec) {
          // mecz właśnie się skończył – jedno ostatnie pobranie (ostatnie zamknięcie), potem znika z ekranu
          if (stary && !stary.koniec) { stary.koniec = true; stary.lista = m; koncowe.push(stary); }
          return;
        }
        obecne.add(m.mid);
        const w = stary || { mid: m.mid, ostatnio: 0, kolejnosc: stan.licznikKolejnosci++ };
        w.lista = m;
        stan.mecze.set(m.mid, w);
      });
      // mecze, które zniknęły z listy
      stan.mecze.forEach((w, mid) => {
        if (!obecne.has(mid) && !w.koniec) { w.koniec = true; koncowe.push(w); }
      });
      await Promise.all(koncowe.map((w) => pobierzMecz(w)));
      stan.mecze.forEach((w, mid) => { if (w.koniec && !obecne.has(mid)) stan.mecze.delete(mid); });
      subskrybuj();
      stan.doNarysowania = true;
      // pierwsze wczytanie: wszystkie trwające mecze od razu (to, co już było, nie wyskakuje w okienkach)
      if (stan.pierwszeSprawdzenie) {
        const brak = Array.from(stan.mecze.values()).filter((w) => !w.koniec && !w.szczegoly && !w.pobieram);
        for (let i = 0; i < brak.length; i += 6) await Promise.all(brak.slice(i, i + 6).map((w) => pobierzMecz(w)));
        stan.pierwszeSprawdzenie = false;
      }
      tykniecie();
    } finally {
      trwa = false;
    }
  }

  function przyjmijZdarzenia(lista, stare) {
    let cos = false;
    lista.forEach((z) => {
      if (stan.widziane.has(z.klucz)) return;
      stan.widziane.add(z.klucz);
      z.stare = stare || stan.pierwszeSprawdzenie;
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
    const czekam = document.body.classList.contains('tryb-czekam');
    const t = czekam ? 'TV Dart' : stan.tytulWlasny || stan.tytul || (stan.tdid ? 'Turniej' : 'TV Dart');
    $('#tytul').textContent = t;
    document.title = t + ' · na żywo';
  }

  /** Średnia z 3 lotek liczona na żywo z przebiegu wszystkich legów (łącznie z trwającym). */
  function sredniaZLegow(d, p) {
    const skip = pomijacPierwszy(d);
    let pkt = 0, lotki = 0;
    (d.legData || []).forEach((leg) => {
      const { r, start } = rundy(leg, p, skip);
      for (let i = 0; i < r.length; i++) {
        const sc = Number(r[i].score);
        if (sc < 0) { pkt += i > 0 ? Number(r[i - 1].left) : start; lotki += Math.abs(sc); break; }
        pkt += sc; lotki += 3;
      }
    });
    return lotki > 0 ? ((pkt / lotki) * 3).toFixed(2) : null;
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
    if (n <= 12) return { k: 4, w: 3, s: 0.86 };
    return { k: 4, w: 4, s: 0.72 }; // do 16 meczów na jednym ekranie
  }
  const NA_STRONIE = 16;

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

  /** Runda drabinki jak w ustawieniach Nakka: 1, 2… oraz -2 półfinał, -1 finał, -3 mecz o 3. miejsce. */
  function rundaDrabinki(m, ts) {
    const tmid = String(m.tmid || '');
    if (/_t3_/.test(tmid)) return -3;
    const ile = Math.ceil(Math.log2(Number(ts.t_player_count) || 2));
    const top = String(m.title || '').match(/Top\s*(\d+)\s*$/i);
    let i = null; // numer rundy od 0
    if (top && Number(top[1]) >= 2) i = ile - Math.log2(Number(top[1]));
    else {
      const n = tmid.match(/_t_(\d+)_/);
      if (n) i = Number(n[1]);
    }
    if (i === null) return null;
    return i === ile - 1 ? -1 : i === ile - 2 ? -2 : i + 1;
  }

  /** Do ilu wygranych legów gra się w tym meczu: z meczu w Nakka, a gdy go brak – z ustawień turnieju. */
  function legiDoWygranej(w) {
    if (Number(w.limitLeg) > 0) return Number(w.limitLeg);
    const t = stan.turniej;
    const m = w.lista || {};
    const tmid = String(m.tmid || '');
    if (!t) return 0;
    if (/_rr_/.test(tmid)) return Number(t.rr_setting && t.rr_setting.limit_leg_count) || 0;
    const ts = t.t_setting;
    if (!ts || !/_t3?_/.test(tmid)) return 0;
    const runda = rundaDrabinki(m, ts);
    const g = (ts.game_setting || []).find((x) => x.round === runda);
    return Number((g && g.limit_leg_count) || ts.limit_leg_count) || 0;
  }

  /** Napis „Best of 5” (przy meczu na sety „Best of 3 sety”); pusty, gdy nie ma tej informacji. */
  function bestOfNapis(w, sety) {
    if (sety) {
      const ile = Number(w.limitSet);
      return ile > 0 ? 'Best of ' + (2 * ile - 1) + ' sety' : '';
    }
    const legi = legiDoWygranej(w);
    return legi > 0 ? 'Best of ' + (2 * legi - 1) : '';
  }

  /** Czy mecz jest grany na sety (ustawienie meczu w Nakka albo wygrany już jakiś set). */
  function naSety(w, st) {
    return Number(w.limitSet) > 0 || st.some((s) => Number(s.winSets) > 0);
  }

  // W Nakka zwykle „Nazwisko Imię”, ale zdarza się „Imię Nazwisko” – rozpoznajemy po popularnych imionach.
  const IMIONA = new Set(('Adam Adrian Albert Aleksander Andrzej Antoni Arkadiusz Artur Bartłomiej Bartosz Błażej Bogdan Bogusław Cezary Czesław Damian Daniel Dariusz Dawid Dominik Edward Emil Eryk Ernest Fabian Filip Franciszek Gabriel Grzegorz Henryk Hubert Igor Ireneusz Jacek Jakub Jan Janusz Jarosław Jerzy Józef Julian Kacper Kamil Karol Kazimierz Konrad Krystian Krzysztof Leszek Łukasz Maciej Maksymilian Marcel Marcin Marek Mariusz Mateusz Michał Mieczysław Mikołaj Miłosz Nikodem Norbert Oliwier Oskar Patryk Paweł Piotr Przemysław Radek Radosław Rafał Robert Roman Ryszard Sebastian Stanisław Stefan Sławomir Szymon Tadeusz Tomasz Tymoteusz Wacław Waldemar Wiesław Wiktor Witold Władysław Włodzimierz Wojciech Zbigniew Zdzisław Zygmunt Agata Agnieszka Aleksandra Alicja Anna Barbara Beata Danuta Dorota Ewa Iwona Joanna Julia Justyna Karolina Katarzyna Kinga Magdalena Małgorzata Maria Marta Monika Natalia Patrycja Renata Sylwia Teresa Urszula Weronika Wiktoria Zofia').split(' '));

  /** Inicjał imienia i nazwisko („S. Parkitny”), niezależnie od kolejności w Nakka. */
  function krotkaNazwa(n) {
    const c = String(n).trim().split(/\s+/);
    if (c.length < 2) return c[0];
    const imieNaPoczatku = IMIONA.has(c[0]) && !IMIONA.has(c[c.length - 1]);
    return imieNaPoczatku ? c[0][0] + '. ' + c.slice(1).join(' ') : c[c.length - 1][0] + '. ' + c.slice(0, -1).join(' ');
  }

  /** Debel: dwa nazwiska rozdzielone w Nakka znakiem „/”, „&” lub „+”; singiel: jedna pozycja. */
  function czesciNazwy(nazwa) {
    const czesci = String(nazwa).split(/\s*[\/&+]\s*/).map((x) => x.trim()).filter(Boolean);
    return czesci.length === 2 ? czesci : [String(nazwa)];
  }

  /** Na karcie meczu każdy zawodnik debla ma osobny wiersz. */
  function nazwyHtml(nazwa) {
    const czesci = czesciNazwy(nazwa);
    return czesci.map((n) => '<span class="k-nazwa' + (czesci.length === 2 ? ' k-debel' : '') + '">' + esc(n) + '</span>').join('');
  }

  function kartaHtml(w) {
    const m = w.lista;
    const d = w.szczegoly || m;
    const st = (d.statsData && d.statsData.length >= 2 ? d.statsData : m.statsData) || [];
    const leg = w.szczegoly ? stanLega(w.szczegoly) : null;
    const sety = naSety(w, st);
    const legiA = Number(st[0] && st[0].winLegs) || 0, legiB = Number(st[1] && st[1].winLegs) || 0;
    const setyA = Number(st[0] && st[0].winSets) || 0, setyB = Number(st[1] && st[1].winSets) || 0;
    const akcja = (stan.akcje.get(w.mid) || 0) > Date.now();
    const gracz = (p) => {
      const s = st[p] || {};
      const g = leg ? leg.gracze[p] : null;
      const moje = p === 0 ? legiA : legiB, jego = p === 0 ? legiB : legiA;
      const mojeS = p === 0 ? setyA : setyB, jegoS = p === 0 ? setyB : setyA;
      const sr = (w.szczegoly && sredniaZLegow(w.szczegoly, p)) || srednia(s);
      const pod = [sr ? 'śr. ' + sr : '', g && g.ostatnio !== null ? 'ostatnio ' + g.ostatnio : ''].filter(Boolean).join(' · ');
      const wynik = sety
        ? '<span class="k-box k-set' + (mojeS > jegoS ? ' prow' : '') + '"><small>Sety</small>' + mojeS + '</span>' +
          '<span class="k-box' + (moje > jego ? ' prow' : '') + '"><small>Legi</small>' + moje + '</span>'
        : '<span class="k-legi">' + moje + '</span>';
      return '<div class="k-gracz' + (leg && leg.rzuca === p ? ' rzuca' : '') + (moje > jego ? ' prowadzi' : '') + '">' +
        '<div class="k-kto">' + nazwyHtml(s.name || 'Gracz ' + (p + 1)) +
        '<span class="k-pod"><span>' + esc(pod) + '</span>' + chipy(w.mid, s.tpid) + '</span></div>' +
        '<span class="k-zostalo">' + (g ? g.zostalo : '') + '</span>' + wynik + '</div>';
    };
    const f = faza(m);
    const ktory = sety ? 'Set ' + (setyA + setyB + 1) + ' · Leg ' + (legiA + legiB + 1) : leg ? 'Leg ' + leg.numer : '';
    return '<article class="karta' + (sety ? ' setowa' : '') + (akcja ? ' akcja' : '') + '">' +
      '<div class="k-gora"><span class="k-faza">' + esc(f || 'Mecz') + '</span><span class="k-format">' + [bestOfNapis(w, sety), ktory].filter(Boolean).join(' · ') + '</span></div>' +
      gracz(0) + gracz(1) + '</article>';
  }

  const PORZUCONY_MS = 15 * 60 * 1000;
  function ostatniRuch(w) {
    const u = Number(w.aktualizacja) || 0;
    return Math.max(u, (Number(w.lista && w.lista.startTime) || 0) * 1000);
  }
  /** Trwające mecze. Pomija porzucone (bez wpisu od 15 minut) i stare zapisy tego samego zawodnika. */
  function aktywne() {
    const teraz = Date.now();
    const lista = Array.from(stan.mecze.values()).filter((w) => !w.koniec && teraz - ostatniRuch(w) < PORZUCONY_MS);
    lista.sort((a, b) => (Number(b.lista.startTime) || 0) - (Number(a.lista.startTime) || 0));
    const zajeci = new Set();
    const wynik = lista.filter((w) => {
      const tp = (w.lista.statsData || []).map((x) => x.tpid).filter(Boolean);
      if (tp.some((t) => zajeci.has(t))) return false;
      tp.forEach((t) => zajeci.add(t));
      return true;
    });
    return wynik.sort((a, b) => a.kolejnosc - b.kolejnosc);
  }

  const KONIEC_POKAZ_MS = 10 * 60 * 1000; // plansza końcowa tyle po ostatnim meczu

  /** Kiedy skończył się turniej (ostatnia aktywność w meczach), ms. */
  function koniecCzas() {
    let t = Number(stan.ostatniaAktywnosc) || 0;
    wszystkieMecze().forEach((m) => { t = Math.max(t, (Number(m.startTime) || 0) * 1000); });
    if (!stan.koniecZauwazony) stan.koniecZauwazony = Date.now();
    return t || stan.koniecZauwazony;
  }

  /** Co pokazuje ekran: czekam / zapowiedz / mecze / przerwa / koniec */
  function tryb() {
    if (!stan.tdid) return 'czekam';
    if (aktywne().length) return 'mecze';
    if (turniejZakonczony()) {
      if (!stan.archiwumGotowe) return 'koniec';
      return Date.now() - koniecCzas() < KONIEC_POKAZ_MS ? 'koniec' : 'czekam';
    }
    // dopóki w turnieju nie rozpoczął się żaden mecz – lista zawodników
    if (stan.turniej && !wszystkieMecze().length) return 'zapowiedz';
    return 'przerwa';
  }

  function ustawTryb(t) {
    ['czekam', 'zapowiedz', 'mecze', 'przerwa', 'koniec'].forEach((x) => document.body.classList.toggle(x === 'koniec' ? 'koniec' : 'tryb-' + x, x === t));
  }

  /** Ten sam HTML nie jest wstawiany drugi raz (nie przerywamy animacji). */
  function wstaw(el, html) {
    if (el.dataset.widok === html) return;
    el.dataset.widok = html;
    el.innerHTML = html;
  }

  function rysujMecze() {
    const el = $('#mecze');
    const lista = aktywne();
    const t = tryb();
    ustawTryb(t);
    rysujTytul();
    $('#strony').hidden = true;
    if (t !== 'mecze') { el.style.setProperty('--k', 1); el.style.setProperty('--w', 1); }
    if (t === 'czekam') {
      $('#licznik').textContent = 'Gotowy';
      wstaw(el, ekranOczekiwania());
      return;
    }
    if (t === 'koniec') {
      $('#licznik').textContent = 'Turniej zakończony';
      wstaw(el, ekranKoncowy());
      return;
    }
    if (t === 'zapowiedz') {
      $('#licznik').textContent = 'Zapowiedź turnieju';
      wstaw(el, ekranZapowiedzi());
      przewijajListe(el);
      odliczanie();
      return;
    }
    $('#licznik').textContent = lista.length ? 'Na żywo · ' + lista.length + ' ' + odmiana(lista.length) : 'Na żywo';
    if (t === 'przerwa') {
      wstaw(el, '<div class="pusto"><b>Za chwilę kolejne mecze</b><span>Mecze pojawią się tu same, gdy tylko zawodnicy zaczną grać w Nakka.</span></div>');
      return;
    }
    el.dataset.widok = '';
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
      n.title = n.textContent;
      n.textContent = krotkaNazwa(n.textContent);
    });
  }

  /* ---------------- oczekiwanie i zapowiedź ---------------- */

  /** Tarcza do darta w SVG (tło animacji): 20 pól, podwójne i potrójne, bull. */
  /** Logo TV Dart z pulsowaniem (ekran oczekiwania i zapowiedź turnieju). */
  function logoPuls(klasa) {
    return '<div class="logo-puls ' + klasa + '"><img src="img/tvdart-logo.png" alt="TV Dart – tvdart.vercel.app"></div>';
  }

  function ekranOczekiwania() {
    return '<div class="oczekiwanie">' +
      logoPuls('ocz-puls') +
      '<div class="ocz-tekst"><p class="ocz-nad">Stowarzyszenie Dart Dębica</p><h2>Czekam na turniej</h2>' +
      '<p class="ocz-pod">Ekran włączy się sam, gdy w panelu admina zostanie wybrany turniej z Nakka.</p></div></div>';
  }

  /** Data i godzina turnieju z Nakka („sobota, 28 listopada · 18:00”). */
  function dataTurnieju() {
    const td = Number(stan.turniej && stan.turniej.t_date);
    if (!(td > 0)) return '';
    const d = new Date(td * 1000);
    const dzien = d.toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' });
    const godz = d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    return dzien.charAt(0).toUpperCase() + dzien.slice(1) + (godz !== '00:00' ? ' · ' + godz : '');
  }

  /** Lista zawodników zapisanych do turnieju. */
  function ekranZapowiedzi() {
    const t = stan.turniej || {};
    const zapisani = (t.entry_list || []).filter((e) => e && e.name);
    // nowe nazwiska na liście – mignięcie
    const znani = stan.znaniZapisani;
    const nowi = new Set(znani ? zapisani.filter((e) => !znani.has(e.tpid)).map((e) => e.tpid) : []);
    stan.znaniZapisani = new Set(zapisani.map((e) => e.tpid));
    if (nowi.size) stan.nowiDo = Date.now() + 8000;
    const posort = zapisani.slice().sort((a, b) => a.name.localeCompare(b.name, 'pl'));
    const prawa = '<h3>Lista zawodników</h3>' + (posort.length
      ? '<div class="zp-lista"><div class="zp-tasma zp-nazwiska">' + posort.map((e) => '<span class="' + (nowi.has(e.tpid) ? 'nowy' : '') + '">' + esc(e.name) + '</span>').join('') + '</div></div>'
      : '<p class="zp-brak">Zapisy właśnie się zaczynają…</p>');
    const n = zapisani.length;
    const data = dataTurnieju();
    return '<div class="zapowiedz-ekran">' +
      '<div class="zp-lewa">' + logoPuls('zp-puls') +
      '<p class="zp-nad">Zapowiedź turnieju</p>' +
      '<h2>' + esc(stan.tytulWlasny || stan.tytul || 'Turniej') + '</h2>' +
      (data ? '<p class="zp-data">' + esc(data) + '</p>' : '') +
      '<p class="zp-odliczanie" id="odliczanie"></p>' +
      '<div class="zp-licznik' + (nowi.size ? ' bump' : '') + '"><b>' + n + '</b><span>' + (n === 1 ? 'zawodnik' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'zawodników' : 'zawodników') + '<br>na liście startowej</span></div>' +
      '</div><div class="zp-prawa">' + prawa + '</div></div>';
  }

  /** Odliczanie do startu (osobno, żeby nie przerysowywać listy co minutę). */
  function odliczanie() {
    const el = document.getElementById('odliczanie');
    if (!el) return;
    const td = Number(stan.turniej && stan.turniej.t_date);
    if (!(td > 0)) { el.textContent = 'Start już wkrótce'; return; }
    const ile = td * 1000 - Date.now();
    if (ile <= 60000) { el.textContent = 'Za chwilę start!'; return; }
    const min = Math.round(ile / 60000);
    const h = Math.floor(min / 60), m = min % 60;
    el.textContent = 'Start za ' + (h ? h + ' h ' : '') + (h && !m ? '' : m + ' min');
  }

  /** Lista dłuższa niż miejsce: powolne przewijanie w górę, w kółko. */
  function przewijajListe(el) {
    const lista = el.querySelector('.zp-lista');
    const tasma = lista && lista.querySelector('.zp-tasma');
    if (!tasma || tasma.dataset.przewija) return;
    if (tasma.scrollHeight <= lista.clientHeight + 2) return;
    const elementy = tasma.children.length;
    const kopia = tasma.innerHTML;
    tasma.innerHTML = kopia + kopia;
    tasma.dataset.przewija = '1';
    tasma.classList.add('jedzie');
    tasma.style.setProperty('--czas', Math.max(15, elementy * 1.6) + 's');
  }

  /* ---------------- po turnieju ---------------- */

  function turniejZakonczony() {
    return !!stan.turniej && Number(stan.turniej.status) === 40;
  }

  const pusty = (x) => !x || x === 'empty';
  const tablica = (x) => (Array.isArray(x) ? x : x && typeof x === 'object' ? Object.keys(x).sort((a, b) => a - b).map((k) => x[k]) : []);
  function wynikPary(wyniki, runda, a, b) {
    const r = tablica(wyniki)[runda];
    const ra = r && r[a] && r[a][b], rb = r && r[b] && r[b][a];
    return ra && rb ? [Number(ra.r), Number(rb.r)] : null;
  }
  function zwyciezca(wyniki, runda, a, b, nastepna) {
    const w = wynikPary(wyniki, runda, a, b);
    if (w && w[0] !== w[1]) return w[0] > w[1] ? a : b;
    if (nastepna && nastepna.includes(a)) return a;
    if (nastepna && nastepna.includes(b)) return b;
    return null;
  }

  /** Podium z drabinki Nakka: 1., 2. i 3. miejsce (mecz o 3. miejsce albo dwóch przegranych półfinalistów). */
  function podium() {
    const t = stan.turniej || {};
    const typ = ['t', 's2'].find((k) => { const tab = tablica(t[k + '_table']); return tab.length && tablica(tab[0]).some((x) => !pusty(x)); });
    if (!typ) return null;
    const tab = tablica(t[typ + '_table']).map(tablica);
    const wyniki = t[typ + '_result'];
    const out = { pierwszy: null, drugi: null, trzeci: [], final: null };
    for (let i = 0; i < tab.length; i++) {
      const runda = tab[i];
      if (runda.length !== 2 && runda.length !== 4) continue;
      for (let p = 0; p + 1 < runda.length; p += 2) {
        const a = runda[p], b = runda[p + 1];
        if (pusty(a) || pusty(b)) continue;
        const w = zwyciezca(wyniki, i, a, b, tab[i + 1]);
        if (!w) continue;
        const l = w === a ? b : a;
        if (runda.length === 2) {
          out.pierwszy = w; out.drugi = l;
          const wy = wynikPary(wyniki, i, w, l);
          out.final = { w, l, wynik: wy };
        } else out.trzeci.push(l);
      }
    }
    const t3 = typ === 't' ? 't3' : 's2_3';
    const tab3 = tablica(t[t3 + '_table']).map(tablica);
    if (tab3[0] && tab3[0].length >= 2 && !pusty(tab3[0][0]) && !pusty(tab3[0][1])) {
      const w = zwyciezca(t[t3 + '_result'], 0, tab3[0][0], tab3[0][1], tab3[1]);
      if (w) out.trzeci = [w];
    }
    return out.pierwszy ? out : null;
  }

  /** Mecz finałowy z listy Nakka (do średnich). */
  function meczFinalu(a, b) {
    const m = wszystkieMecze().filter((x) => { const tp = (x.statsData || []).map((s) => s.tpid); return tp.includes(a) && tp.includes(b); })
      .sort((x, y) => (Number(y.startTime) || 0) - (Number(x.startTime) || 0))[0];
    if (!m) return null;
    const sr = {};
    (m.statsData || []).forEach((s) => { sr[s.tpid] = srednia(s); });
    return sr;
  }

  function ekranKoncowy() {
    const pd = podium();
    const imie = (tp) => esc(stan.imiona[tp] || '');
    if (!pd) {
      return '<div class="pusto"><b>Turniej zakończony</b><span>Dziękujemy wszystkim zawodnikom!</span></div>';
    }
    const sr = pd.final ? meczFinalu(pd.final.w, pd.final.l) : null;
    const finalHtml = pd.final && pd.final.wynik
      ? '<div class="final"><p class="final-tytul">Finał</p><div class="final-mecz">' +
        '<span class="fg"><b>' + imie(pd.final.w) + '</b>' + (sr && sr[pd.final.w] ? '<small>śr. ' + sr[pd.final.w] + '</small>' : '') + '</span>' +
        '<span class="fw">' + pd.final.wynik[0] + '<i>:</i>' + pd.final.wynik[1] + '</span>' +
        '<span class="fg"><b>' + imie(pd.final.l) + '</b>' + (sr && sr[pd.final.l] ? '<small>śr. ' + sr[pd.final.l] + '</small>' : '') + '</span></div></div>'
      : '';
    return '<div class="koniec-ekran">' +
      '<div class="pd pd-1"><span class="pd-m">1</span><span class="pd-n">' + imie(pd.pierwszy) + '</span><span class="pd-o">Zwycięzca</span></div>' +
      '<div class="pd-rzad">' +
      '<div class="pd pd-2"><span class="pd-m">2</span><span class="pd-n">' + imie(pd.drugi) + '</span></div>' +
      pd.trzeci.map((tp) => '<div class="pd pd-3"><span class="pd-m">3</span><span class="pd-n">' + imie(tp) + '</span></div>').join('') +
      '</div>' + finalHtml + '</div>';
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
  /** Lista na żywo + archiwum, bez powtórek (ten sam mid). */
  function wszystkieMecze() {
    const out = new Map();
    (stan.archiwum || []).forEach((m) => out.set(m.mid, m));
    (stan.lista || []).forEach((m) => out.set(m.mid, m));
    return Array.from(out.values());
  }

  /** Pasek na dole: najpierw trwające mecze, a gdy jest ich mało – dopełniony wynikami ostatnio zakończonych. */
  const PASEK_MIN = 14; // tyle pozycji na pasku staramy się mieć
  function trescTasmy() {
    const zywe = aktywne();
    const live = zywe.map((w) => {
      const st = (w.szczegoly && w.szczegoly.statsData) || w.lista.statsData || [];
      const a = st[0] || {}, b = st[1] || {};
      const sety = naSety(w, st);
      const legi = (Number(a.winLegs) || 0) + ':' + (Number(b.winLegs) || 0);
      return '<span class="t-mecz">' + esc(a.name || '') + ' ' +
        (sety ? '<b class="t-sety">' + (Number(a.winSets) || 0) + ':' + (Number(b.winSets) || 0) + '</b><small>sety</small> <b>' + legi + '</b><small>legi</small>' : '<b>' + legi + '</b>') +
        ' ' + esc(b.name || '') + '</span>';
    });
    // zakończone mecze turnieju (najnowsze najpierw, bez powtórek tego samego meczu)
    const widziane = new Set(zywe.map((w) => w.lista.tmid || w.mid));
    const koniec = wszystkieMecze()
      .filter((m) => Number(m.endMatch) === 1 || m.endMatch === true)
      .sort((x, y) => (Number(y.startTime) || 0) - (Number(x.startTime) || 0))
      .filter((m) => { const k = m.tmid || m.mid; if (widziane.has(k)) return false; widziane.add(k); return true; })
      .slice(0, Math.max(6, PASEK_MIN - live.length))
      .map((m) => {
        const st = m.statsData || [];
        const a = st[0] || {}, b = st[1] || {};
        const la = Number(a.winLegs) || 0, lb = Number(b.winLegs) || 0;
        const sa = Number(a.winSets) || 0, sb = Number(b.winSets) || 0;
        const sety = sa + sb > 0;
        const wygrA = sety ? sa > sb : la > lb, wygrB = sety ? sb > sa : lb > la;
        const f = faza(m);
        return '<span class="t-mecz t-kon">' + (f ? '<small class="t-faza">' + esc(f) + '</small>' : '') +
          '<span class="' + (wygrA ? 't-wygr' : 't-przegr') + '">' + esc(a.name || '') + '</span> ' +
          (sety ? '<b class="t-sety">' + sa + ':' + sb + '</b><small>sety</small>' : '<b>' + la + ':' + lb + '</b>') + ' <span class="' + (wygrB ? 't-wygr' : 't-przegr') + '">' + esc(b.name || '') + '</span></span>';
      });
    if (!live.length && !koniec.length) return '';
    return (live.length ? '<span class="t-etykieta t-live"><i></i>Na żywo</span>' + live.join('') : '') +
      (koniec.length ? '<span class="t-etykieta">Zakończone</span>' + koniec.join('') : '');
  }
  function rysujTasme(wymus) {
    const t = $('#tasma');
    const tr = tryb();
    let napis = null;
    if (tr === 'czekam') napis = 'Stowarzyszenie Dart Dębica zaprasza na turnieje i ligę · Śledź nas na facebook.com/dartdebica 🎯';
    else if (tr === 'koniec') napis = stan.napis || 'Dziękujemy za udział i kibicowanie! Do zobaczenia przy tarczy 🎯';
    else if (tr === 'zapowiedz') {
      const n = ((stan.turniej && stan.turniej.entry_list) || []).filter((e) => e && e.name).length;
      const data = dataTurnieju();
      napis = 'Zapisy trwają · Na liście: ' + n + (data ? ' · Start: ' + data.charAt(0).toLowerCase() + data.slice(1) : '') + ' · Powodzenia wszystkim zawodnikom! 🎯';
    }
    const etykieta = { czekam: 'Info', zapowiedz: 'Zapisy', koniec: 'Dziękujemy' }[tr] || 'Wyniki';
    const et = document.querySelector('.pasek-etykieta');
    if (et && et.textContent !== etykieta) et.textContent = etykieta;
    const tresc = napis === null ? trescTasmy() : '';
    if (napis !== null) {
      const html = '<span class="t-mecz t-napis">' + esc(napis) + '</span>';
      if (t.dataset.napis !== html) {
        t.dataset.napis = html;
        t.dataset.ok = '';
        t.classList.remove('stoi');
        t.innerHTML = html + html;
        t.style.setProperty('--czas', Math.max(20, t.scrollWidth / 2 / 90) + 's');
      }
      return;
    }
    t.dataset.napis = '';
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
    const z180 = {};
    zd.filter((z) => z.typ === '180').forEach((z) => { z180[z.tpid] = (z180[z.tpid] || 0) + 1; });
    Object.entries(z180).forEach(([tpid, n]) => { ile180[tpid] = n; });

    const ile171 = {};
    zd.filter((z) => z.typ === '171').forEach((z) => { ile171[z.tpid] = (ile171[z.tpid] || 0) + 1; });

    // każde osiągnięcie osobno: zawodnik + wartość + ile razy („Kowalski 16 lotka ×2”, niżej „Nowak 17 lotka”)
    const osiagniecia = (typ) => {
      const m = new Map();
      zd.filter((z) => z.typ === typ).forEach((z) => {
        const k = z.tpid + '|' + z.w;
        const x = m.get(k) || { tpid: z.tpid, w: z.w, ile: 0 };
        x.ile++;
        m.set(k, x);
      });
      return Array.from(m.values());
    };

    // pełne nazwy i „lotka” zostają na planszy końcowej, gdzie panel jest szeroki
    const pelne = tryb() === 'koniec';
    const sekcja = (typ, tytul, dane, malejaco, format) => {
      // 180 i 171: liczba na zawodnika; High finish i Best leg: lista osiągnięć
      const wpisy = Array.isArray(dane) ? dane : Object.entries(dane).map(([tpid, v]) => ({ tpid, w: v, ile: 1 }));
      const wiersze = wpisy.map((x) => ({ ...x, n: nazwa(x.tpid, naz[x.tpid]) })).filter((x) => x.n)
        .sort((a, b) => (malejaco ? b.w - a.w : a.w - b.w) || b.ile - a.ile || a.n.localeCompare(b.n, 'pl'));
      const html = wiersze.map((x) => {
        const nowy = stan.nowe.has(typ + '|' + x.tpid);
        return '<div class="w-wiersz' + (nowy ? ' nowe' : '') + '"><span class="w-nazwy">' + czesciNazwy(x.n).map((n) => '<span class="w-nazwa">' + esc(pelne ? n : krotkaNazwa(n)) + '</span>').join('') + '</span><b>' + format(x.w) + (x.ile > 1 ? ' ×' + x.ile : '') + '</b></div>';
      }).join('');
      // sekcja z większą liczbą zawodników dostaje więcej miejsca
      return '<div class="w-sekcja w-' + typ + '" style="flex-grow:' + Math.max(1, Math.min(wiersze.length, 8)) + '"><h3>' + tytul + '</h3>' +
        '<div class="w-lista">' + (html ? '<div class="w-tasma">' + html + '</div>' : '<p class="w-brak">jeszcze nikt</p>') + '</div></div>';
    };
    const html =
      sekcja('180', '180', ile180, true, (v) => '×' + v) +
      sekcja('171', '171', ile171, true, (v) => '×' + v) +
      sekcja('hf', 'High finish 100+', osiagniecia('hf'), true, (v) => v) +
      sekcja('bl', 'Best leg do 18', osiagniecia('bl'), false, pelne ? lotka : (v) => v + ' L');
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
    el.className = 'wyskok';
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

  // podgląd w panelu admina: bez przycisku pełnego ekranu
  if (new URLSearchParams(location.search).get('podglad')) document.body.classList.add('podglad-tryb');

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
    setInterval(tykniecie, 1000);
    // co 15 s: przejście z planszy końcowej do oczekiwania, odliczanie, nowe zapisy przed turniejem
    setInterval(() => {
      if (document.body.classList.contains('tryb-zapowiedz')) wczytajTurniej();
      rysujMecze();
      rysujTasme();
    }, 15000);
    polaczSygnaly();
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
