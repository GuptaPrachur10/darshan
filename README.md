# ISKCON London Darshan Catalog

A digital version of the dress book. Each card's text lives in `config.json`
here on GitHub. Photos live in Google Drive and load only when a dress is
opened.

## For photo editors (Google Drive)

```
DarshanApp/
├── Darshan/
│   ├── 1/        ← photos of dress 1 (any file names, any number of photos)
│   ├── 2/
│   └── …
└── Night Outfits/
    ├── A/        ← photos of night outfit A
    └── …
```

- Folder names must be **exactly** the dress number (`7`) or night outfit letter (`E`).
  Not `007`, not `7 - Peacock`. Only one folder per number or letter.
- Add, remove or replace photos freely. The site shows them on the next refresh.
- Upload **JPEG** if you can (iPhone: Settings → Camera → Formats → *Most Compatible*).
  HEIC photos still show, but can't be zoomed to full detail.

## For text editors (GitHub)

Edit `config.json` (the pencil icon on GitHub) and add an entry to `dresses`:

```json
{
  "id": 2,
  "name": "Peacock Garden",
  "weather": "cold",
  "colors": ["green", "gold"],
  "nightOutfits": ["A", "C"],
  "jewelry": {
    "RK":  { "jewellery1": "✓", "jewellery3": "✓" },
    "JBS": { "jewellery1": "S" }
  },
  "backdrop": "Green curtain"
}
```

| Field | Required | Values |
|---|---|---|
| `id` | yes | whole number, same as the Drive folder name |
| `name` | yes | text |
| `weather` | yes | `hot`, `cold` or `both` |
| `colors` | no | list of words |
| `nightOutfits` | no | list of single capital letters |
| `jewelry` | no | deity set → jewellery → `✓` (whole set) or member letters (e.g. `S`) |
| `backdrop` | no | text |

- Leave out empty jewelry cells.
- Deity sets and jewellery names must match the `glossary` at the top of the file.
