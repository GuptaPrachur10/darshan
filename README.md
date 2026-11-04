# ISKCON London Darshan Catalog

A digital version of the dress book. All dress information comes from the
Google Sheet **"Deity Outfits Full Collection"** (tab *For App*). Photos live
in Google Drive and load only when a dress is opened.

## For sheet editors

Edit the sheet as normal. The site picks up changes within about 5 minutes
(Google caches the published sheet). Return visitors see the saved copy first,
then the update.

- **One row per dress.** `No.` must be a whole number, the same as the dress's
  Drive photo folder name. Rows without a number are skipped.
- **Spacing, commas and capitals don't matter.** `gold ,silver,` is shown as
  `Gold, Silver`. Short codes like `AB` or `TCR` are left as typed.
- **New columns** appear on the dress page automatically, under the main details.
- **Blank cells** are hidden (for crowns / turbans / suryas, blank means "none").

| Column | How the site uses it |
|---|---|
| `No.` | Dress number: link and photo folder |
| `Name` | Title. Words in brackets, e.g. `(EKADASI)`, also become a **Tag** filter |
| `Jewellery` | Jewellery colours, comma-separated. Shown prominently; **filter** |
| `RK`, `JB`, `S`, `GN/GG` | Crowns / turban pieces / suryas table, using codes `C`, `T`, `S`, optionally after `Gold` or `Silver` (e.g. `Gold C, T`) |
| `Backdrop` | Text, or a dress number (e.g. `69`) meaning "same backdrop as dress 69" |
| `Night Outfits` | Letters, comma-separated; each links to its night outfit page |
| `Weather Suitability` | `Hot`, `Cold`, or `Hot, Cold` for both; **filter** |
| `Location` | `Pujari` or `TCR` (Tottenham Court Road); **filter**. TCR dresses are dimmed in the list |
| `Repair Requirements`, `First Offered`, `Designed By` | Kept in the sheet only; not shown |

**Sheet check:** open `…/#/check` on the site after editing. It lists skipped
rows, repeated numbers, cells it couldn't read (shown as typed), and possible
duplicate spellings such as `Gopi` / `Gopis`.

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

## Settings (`settings.json`)

| Key | What |
|---|---|
| `sheetCsvUrl` | The sheet's *Publish to web → CSV* link for the *For App* tab |
| `apiKey` | Google API key used for Drive photos |
| `dressesFolderId`, `nightOutfitsFolderId` | Drive folder IDs for `Darshan` and `Night Outfits` |
