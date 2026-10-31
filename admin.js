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
      if (!u.tdid) { $('#teraz').textContent = 'Nic – ekran pokazuje „Brak wybranego turnieju”.'; return; }
      const n = await nazwaTurnieju(u.tdid);
      $('#teraz').innerHTML = '<b></b><br><span class="pomoc"></span>';
      $('#teraz b').textContent = u.tytul || n || u.tdid;
      $('#teraz span').textContent = u.tdid + (u.zmieniono ? ' · ustawiono ' + new Date(u.zmieniono).toLocaleString('pl-PL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
    } catch (e) {
      $('#teraz').textContent = 'Nie udało się odczytać ustawień.';
    }
  }

  function zalogowano() {
    $('#logowanie').hidden = true;
    $('#panel').hidden = false;
    pokazTeraz();
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
    zalogowano();
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

  async function zapisz(tdid, tytul, przycisk, el) {
    przycisk.disabled = true;
    const j = await api({ akcja: 'zapisz', tdid, tytul });
    przycisk.disabled = false;
    if (!j.ok) return komunikat(el, j.blad || 'Nie udało się zapisać.', true);
    komunikat(el, tdid ? 'Zapisane. Telewizor przełączy się w ciągu ok. 20 sekund.' : 'Wyczyszczone. Ekran zmieni się w ciągu ok. 20 sekund.');
    pokazTeraz();
  }

  $('#form-turniej').addEventListener('submit', (e) => {
    e.preventDefault();
    const tdid = tdidZLinku($('#link').value);
    if (!tdid) return komunikat($('#kom-zapis'), 'To nie wygląda na link do turnieju z Nakka.', true);
    zapisz(tdid, $('#tytul').value.trim(), $('#zapisz'), $('#kom-zapis'));
  });
  $('#wyczysc').addEventListener('click', () => {
    if (!confirm('Wyczyścić ekran? Telewizor przestanie pokazywać mecze.')) return;
    zapisz(null, '', $('#wyczysc'), $('#kom-wyczysc'));
  });
  $('#wyloguj').addEventListener('click', wyloguj);

  if (sesja) {
    api({ akcja: 'sprawdz' }).then((j) => { if (j.ok) zalogowano(); });
  }
})();
