# Dart Dębica TV

Ekran pod telewizor: mecze na żywo z jednego turnieju w Nakka (n01darts) z wyróżnieniem 180, 171, high finishy 100+ i legów do 18 lotek.

- `/` – ekran TV (1920×1080, skaluje się do każdego ekranu). Gdy mecze się nie mieszczą, strony zmieniają się co 15 s. Na dole przewija się pasek z wynikami wszystkich meczów.
- `/admin` – panel: wklejasz link do turnieju z Nakka, ekran przełącza się w ok. 20 s (bez przebudowy strony).
- Do testów: `/?t=t_XXXX_1234` pokazuje dany turniej bez zmiany ustawień.

## Vercel – zmienne środowiskowe
- `ADMIN_HASLO` – hasło do panelu
- `GITHUB_TOKEN` – token GitHub (Contents: Read and write) do tego repozytorium
- `GITHUB_REPO` – np. `erowery/DartDebicaTV`

Zapis turnieju zmienia tylko `ustawienia.json`; `vercel.json` (ignoreCommand) pomija wtedy przebudowę.
