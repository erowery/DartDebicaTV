// Panel admina Dart Dębica TV: logowanie hasłem i wybór turnieju pokazywanego na telewizorze.
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const KLUCZ = 'tv_sesja_v1';
  const NAKKA = ['https://api.n01darts.com/api/v1', 'https://push.n01darts.com/api/v1'];
  let sesja = null;
  try { sesja = localStorage.getItem(KLUCZ) || sessionStorage.getItem(KLUCZ); } catch (e) { /* bez pamięci */ }

  function komunikat(el, tekst, blad) {
    el.textContent = tekst;
    el.className = 'komunikat ' + (blad ? 'blad' : 'ok');
  }

  async function api(dane) {
    const res = await fetch('/api/admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...dane, sesja }) });
    let j = {};
    try { j = await res.json(); } catch (e) { j = { ok: false, blad: 'Serwer nie odpowiedział poprawnie (' + res.status + ').' }; }
    if (res.status === 401 && dane.akcja !== 'zaloguj') wyloguj();
    return j;
  }

  /** Wyciąga identyfikator turnieju (t_XXXX_1234) z linku albo z samego identyfikatora. */
  function tdidZLinku(tekst) {
    const m = String(tekst || '').match(/t_[A-Za-z0-9]{2,8}_\d{1,8}/);
    return m ? m[0] : null;
  }

  async function nazwaTurnieju(tdid) {
    for (const baza of NAKKA) {
      try {
        const r = await fetch(baza + '/tournament/get?tdid=' + encodeURIComponent(tdid) + '&_t=' + Date.now(), { cache: 'no-store' });
        const j = await r.json();
        if (j && j.result === 0 && j.tournament) return j.tournament.title || '(bez nazwy)';
        if (j && j.result !== undefined) return null;
      } catch (e) { /* następny serwer */ }
    }
    return undefined; // Nakka nie odpowiada
  }

  async function pokazTeraz() {
    try {
      const r = await fetch('/api/ustawienia?_t=' + Date.now(), { cache: 'no-store' });
      const u = await r.json();
      if (!$('#link').value && u.link) $('#link').value = u.link;
      if (!$('#tytul').value && u.tytul) $('#tytul').value = u.tytul;
      if (!$('#napis').value && u.napis) $('#napis').value = u.napis;
      rysujPartnerow(u.partnerzy);
      if (Number.isFinite(u.margines) && document.activeElement !== $('#margines')) {
        $('#margines').value = u.margines;
        $('#margines-wartosc').textContent = u.margines;
      }
      if (!u.tdid) { $('#teraz').textContent = 'Nic – ekran pokazuje „Brak wybranego turnieju”.'; return; }
      const n = await nazwaTurnieju(u.tdid);
      $('#teraz').innerHTML = '<b></b><br><span class="pomoc"></span>';
      $('#teraz b').textContent = u.tytul || n || u.tdid;
      $('#teraz span').textContent = u.tdid + (u.zmieniono ? ' · ustawiono ' + new Date(u.zmieniono).toLocaleString('pl-PL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
    } catch (e) {
      $('#teraz').textContent = 'Nie udało się odczytać ustawień.';
    }
  }

  function pokazStanGithuba(g) {
    const el = $('#stan-gh');
    if (!g) { el.hidden = true; return; }
    el.hidden = false;
    el.className = 'stan-gh ' + (g.ok ? 'ok' : 'blad');
    el.textContent = (g.ok ? '✓ ' : '⚠ ') + g.opis;
  }

  function odswiezPodglad() {
    const f = $('#podglad-tv');
    if (getComputedStyle(f).display === 'none') return; // telefon – bez podglądu
    f.src = '/?podglad=1&_=' + Date.now();
  }

  function zalogowano(github) {
    $('#logowanie').hidden = true;
    $('#panel').hidden = false;
    pokazStanGithuba(github);
    pokazTeraz();
    odswiezPodglad();
  }
  function wyloguj() {
    sesja = null;
    try { localStorage.removeItem(KLUCZ); sessionStorage.removeItem(KLUCZ); } catch (e) { /* nic */ }
    $('#panel').hidden = true;
    $('#logowanie').hidden = false;
  }

  $('#form-log').addEventListener('submit', async (e) => {
    e.preventDefault();
    const przycisk = e.submitter || $('#form-log button');
    przycisk.disabled = true;
    const j = await api({ akcja: 'zaloguj', haslo: $('#haslo').value, trwale: $('#trwale').checked });
    przycisk.disabled = false;
    if (!j.ok) return komunikat($('#kom-log'), j.blad || 'Nie udało się zalogować.', true);
    sesja = j.sesja;
    try { ($('#trwale').checked ? localStorage : sessionStorage).setItem(KLUCZ, sesja); } catch (e2) { /* nic */ }
    $('#haslo').value = '';
    $('#kom-log').textContent = '';
    zalogowano(j.github);
  });

  // podgląd: po wklejeniu linku od razu widać, jaki to turniej
  let licznikPodgladu = 0;
  $('#link').addEventListener('input', async () => {
    const nr = ++licznikPodgladu;
    const tdid = tdidZLinku($('#link').value);
    const p = $('#podglad');
    if (!tdid) { p.hidden = !$('#link').value; p.textContent = 'Nie widzę w tym linku identyfikatora turnieju (t_…).'; return; }
    p.hidden = false;
    p.textContent = 'Sprawdzam turniej ' + tdid + '…';
    const n = await nazwaTurnieju(tdid);
    if (nr !== licznikPodgladu) return;
    if (n === null) p.textContent = 'Nakka nie zna turnieju ' + tdid + '. Sprawdź link.';
    else if (n === undefined) p.textContent = 'Turniej ' + tdid + ' (Nakka chwilowo nie odpowiada, ale można zapisać).';
    else { p.innerHTML = 'Turniej: <b></b>'; p.querySelector('b').textContent = n; }
  });

  async function zapisz(tdid, tytul, przycisk, el, napis) {
    przycisk.disabled = true;
    const j = await api({ akcja: 'zapisz', tdid, tytul, napis: napis || '' });
    przycisk.disabled = false;
    if (!j.ok) return komunikat(el, j.blad || 'Nie udało się zapisać.', true);
    komunikat(el, tdid ? 'Zapisane. Telewizor przełączy się w ciągu ok. 20 sekund.' : 'Wyczyszczone. Ekran zmieni się w ciągu ok. 20 sekund.');
    pokazStanGithuba({ ok: true, opis: 'Połączenie z GitHub działa.' });
    if (!tdid) { $('#link').value = ''; $('#tytul').value = ''; $('#napis').value = ''; $('#podglad').hidden = true; }
    pokazTeraz();
    setTimeout(odswiezPodglad, 1500);
  }

  $('#form-turniej').addEventListener('submit', (e) => {
    e.preventDefault();
    const tdid = tdidZLinku($('#link').value);
    if (!tdid) return komunikat($('#kom-zapis'), 'To nie wygląda na link do turnieju z Nakka.', true);
    zapisz(tdid, $('#tytul').value.trim(), $('#zapisz'), $('#kom-zapis'), $('#napis').value.trim());
  });
  $('#wyczysc').addEventListener('click', () => {
    if (!confirm('Wyczyścić ekran? Telewizor przestanie pokazywać mecze.')) return;
    zapisz(null, '', $('#wyczysc'), $('#kom-wyczysc'));
  });
  $('#wyloguj').addEventListener('click', wyloguj);

  $('#margines').addEventListener('input', (e) => { $('#margines-wartosc').textContent = e.target.value; });
  $('#margines').addEventListener('change', async (e) => {
    komunikat($('#kom-margines'), 'Zapisuję…');
    const j = await api({ akcja: 'margines', margines: Number(e.target.value) });
    if (j.ok) komunikat($('#kom-margines'), 'Zapisane. Telewizor zmieni się w ciągu ok. 20 sekund.');
    else komunikat($('#kom-margines'), j.blad || 'Nie udało się zapisać.', true);
  });

  /* ---------- partnerzy wydarzenia ---------- */
  let partnerzy = [];
  let otwartyPartner = null;

  function rysujPartnerow(lista) {
    partnerzy = Array.isArray(lista) ? lista : [];
    const box = $('#lista-partnerow');
    box.textContent = '';
    if (!partnerzy.length) box.innerHTML = '<p class="pt-pusto">Nie ma jeszcze żadnego logo. Wgraj pierwsze poniżej.</p>';
    $('#pt-liczba').textContent = partnerzy.length + ' · na ekranie ' + partnerzy.filter((p) => p.pokaz).length;
    partnerzy.forEach((p, i) => {
      const w = document.createElement('div');
      w.className = 'pt-wiersz' + (p.pokaz ? '' : ' schowany');
      w.innerHTML = '<div class="pt-glowa"><div class="pt-mini"><img alt=""></div><div class="pt-tekst"><b></b><small></small></div>' +
        '<input type="checkbox" aria-label="Pokazuj na ekranie" title="Pokazuj na ekranie"><button type="button" class="drugi" data-a="wiecej" aria-label="Więcej opcji" aria-expanded="false">⋯</button></div>' +
        '<div class="pt-panel" hidden><label>Podpis nad logo</label><input type="text" maxlength="40" list="role" placeholder="Bez podpisu">' +
        '<div class="pt-akcje"><button type="button" class="drugi" data-a="tlo">Zmień tło</button><button type="button" class="drugi" data-a="gora" aria-label="W górę">↑</button><button type="button" class="drugi" data-a="dol" aria-label="W dół">↓</button><button type="button" class="drugi" data-a="usun">Usuń na stałe</button></div></div>';
      const mini = w.querySelector('.pt-mini');
      mini.classList.add(p.tlo === 'ciemne' ? 'ciemne' : 'jasne');
      w.querySelector('img').src = '/api/logo?plik=' + encodeURIComponent(p.id);
      w.querySelector('img').alt = p.nazwa;
      w.querySelector('b').textContent = p.nazwa;
      w.querySelector('small').textContent = p.rola || 'bez podpisu';
      const panel = w.querySelector('.pt-panel');
      const wiecej = w.querySelector('[data-a=wiecej]');
      const pokazPanel = (tak) => { panel.hidden = !tak; wiecej.setAttribute('aria-expanded', tak); };
      pokazPanel(otwartyPartner === p.id);
      wiecej.addEventListener('click', () => {
        otwartyPartner = otwartyPartner === p.id ? null : p.id;
        rysujPartnerow(partnerzy);
      });
      const rola = w.querySelector('.pt-panel input');
      rola.value = p.rola || '';
      rola.addEventListener('change', () => { p.rola = rola.value.trim(); zapiszPartnerow(); });
      const ptaszek = w.querySelector('input[type=checkbox]');
      ptaszek.checked = !!p.pokaz;
      ptaszek.addEventListener('change', () => { p.pokaz = ptaszek.checked; zapiszPartnerow(); });
      w.querySelector('[data-a=tlo]').addEventListener('click', () => { p.tlo = p.tlo === 'ciemne' ? 'jasne' : 'ciemne'; zapiszPartnerow(); });
      const przesun = (o) => { const [x] = partnerzy.splice(i, 1); partnerzy.splice(i + o, 0, x); zapiszPartnerow(); };
      w.querySelector('[data-a=gora]').disabled = i === 0;
      w.querySelector('[data-a=dol]').disabled = i === partnerzy.length - 1;
      w.querySelector('[data-a=gora]').addEventListener('click', () => przesun(-1));
      w.querySelector('[data-a=dol]').addEventListener('click', () => przesun(1));
      w.querySelector('[data-a=usun]').addEventListener('click', async () => {
        if (!confirm('Usunąć „' + p.nazwa + '” na stałe? Trzeba będzie wgrać logo od nowa.\n\nŻeby tylko schować je z ekranu, odznacz „Pokazuj na ekranie”.')) return;
        wynikPartnerow(await api({ akcja: 'partner-usun', id: p.id }), 'Usunięto.');
      });
      box.appendChild(w);
    });
  }

  function wynikPartnerow(j, tekst) {
    if (!j.ok) { komunikat($('#kom-partner'), j.blad || 'Nie udało się zapisać.', true); pokazTeraz(); return false; }
    rysujPartnerow(j.partnerzy);
    komunikat($('#kom-partner'), tekst + ' Telewizor zmieni się w ciągu ok. 20 sekund.');
    setTimeout(odswiezPodglad, 1500);
    return true;
  }

  async function zapiszPartnerow() {
    rysujPartnerow(partnerzy);
    wynikPartnerow(await api({ akcja: 'partnerzy', lista: partnerzy }), 'Zapisane.');
  }

  /** Usuwa puste brzegi pliku (przezroczyste lub w kolorze rogu), żeby loga miały na ekranie tę samą wielkość. */
  function obetnijMarginesy(c) {
    const { width: sz, height: wy } = c;
    const d = c.getContext('2d').getImageData(0, 0, sz, wy).data;
    const [r, g, b, a] = d;
    const tlo = (i) => (a < 16 ? d[i + 3] < 16 : d[i + 3] < 16 || (Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b) < 40));
    let x0 = sz, x1 = -1, y0 = wy, y1 = -1;
    for (let y = 0; y < wy; y++) for (let x = 0; x < sz; x++) {
      if (tlo((y * sz + x) * 4)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (x1 < 0) return c;
    const n = document.createElement('canvas');
    n.width = x1 - x0 + 1;
    n.height = y1 - y0 + 1;
    n.getContext('2d').drawImage(c, -x0, -y0);
    return n;
  }

  /** Zmniejsza logo w przeglądarce (max 800 × 400), zachowując przezroczystość. */
  function przygotujLogo(plik) {
    return new Promise((ok, zle) => {
      const adres = URL.createObjectURL(plik);
      const im = new Image();
      im.onload = () => {
        const sz = im.naturalWidth || 800, wy = im.naturalHeight || 400;
        const skala = plik.type === 'image/svg+xml' ? Math.min(800 / sz, 400 / wy) : Math.min(1, 800 / sz, 400 / wy);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(sz * skala));
        c.height = Math.max(1, Math.round(wy * skala));
        c.getContext('2d', { willReadFrequently: true }).drawImage(im, 0, 0, c.width, c.height);
        URL.revokeObjectURL(adres);
        const obciety = obetnijMarginesy(c);
        const webp = obciety.toDataURL('image/webp', 0.9);
        ok(webp.startsWith('data:image/webp') ? webp : obciety.toDataURL('image/png'));
      };
      im.onerror = () => { URL.revokeObjectURL(adres); zle(new Error('Nie udało się odczytać tego pliku jako obrazu.')); };
      im.src = adres;
    });
  }

  function podgladLogo() {
    const pole = $('#pt-podglad');
    const f = $('#pt-plik').files[0];
    pole.hidden = !f;
    pole.className = 'pt-podglad ' + $('#pt-tlo').value;
    if (f) {
      const img = pole.querySelector('img');
      if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
      img.src = URL.createObjectURL(f);
      if (!$('#pt-nazwa').value) $('#pt-nazwa').value = f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    }
  }
  $('#pt-plik').addEventListener('change', podgladLogo);
  $('#pt-tlo').addEventListener('change', podgladLogo);

  $('#form-partner').addEventListener('submit', async (e) => {
    e.preventDefault();
    const przycisk = $('#pt-dodaj');
    przycisk.disabled = true;
    komunikat($('#kom-partner'), 'Wysyłam logo…');
    try {
      const obraz = await przygotujLogo($('#pt-plik').files[0]);
      const j = await api({ akcja: 'partner-dodaj', obraz, nazwa: $('#pt-nazwa').value, rola: $('#pt-rola').value, tlo: $('#pt-tlo').value });
      if (wynikPartnerow(j, 'Dodano.')) {
        e.target.reset();
        $('#nowe-logo').open = false;
        $('#zapisane').open = true;
        $('#pt-podglad').hidden = true;
      }
    } catch (err) {
      komunikat($('#kom-partner'), err.message, true);
    }
    przycisk.disabled = false;
  });

  if (sesja) {
    api({ akcja: 'sprawdz' }).then((j) => { if (j.ok) zalogowano(j.github); });
  }
})();
