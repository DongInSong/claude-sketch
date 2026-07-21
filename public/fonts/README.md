# Bundled handwriting faces

Everything the UI draws with ships here. No webfont CDN is used: the page must
work offline, and asking Google for a font would leak that you are running this.

| file | face | licence | covers |
|---|---|---|---|
| `Excalifont-Regular.woff2` | Excalifont | OFL — `LICENSE-Excalifont.txt` | Latin, as shipped |
| `Gaegu-Hangul.woff2` | Gaegu | OFL — `LICENSE-Gaegu.txt` | all 2,350 Hangul syllables Gaegu draws |
| `KleeOne-UI.woff2` | Klee One | OFL — `LICENSE-KleeOne.txt` | the ~240 characters this UI writes in Japanese |
| `MaShanZheng-UI.woff2` | Ma Shan Zheng | OFL — `LICENSE-MaShanZheng.txt` | the ~255 characters this UI writes in Chinese |

Gaegu is complete for practical Korean — the upstream font has no other
syllables, so the subset loses nothing the CDN would have given you. Japanese
and Chinese are a different story: full coverage is 2.1MB and 3.2MB, so those
two carry the interface's own wording only. Text you typed yourself — a session
title in Japanese, say — falls back to whatever the system has.

Both ideograph faces claim U+4E00–9FFF, so `index.html` keeps them apart with
`html[lang=…]` rather than font-stack order.

## Rebuilding a subset

Adding UI strings in Japanese or Chinese means rebuilding, or the new
characters fall back and look out of place:

```bash
pip install "fonttools[woff]"

# Korean — the whole Hangul block; Gaegu supplies what it has
python -m fontTools.subset Gaegu-Regular.ttf \
  --unicodes="AC00-D7A3,1100-11FF,3130-318F,3000-303F,FF01-FF60" \
  --layout-features='' --no-hinting --desubroutinize \
  --flavor=woff2 --output-file=Gaegu-Hangul.woff2

# Japanese / Chinese — exactly the characters the i18n block uses
python -m fontTools.subset KleeOne-Regular.ttf --unicodes-file=ja.txt \
  --layout-features='' --no-hinting --desubroutinize \
  --flavor=woff2 --output-file=KleeOne-UI.woff2
```

`ja.txt` / `zh.txt` are comma-separated hex codepoints, taken from the `ja:` and
`zh:` objects in `public/index.html`. Sources: [Gaegu](https://fonts.google.com/specimen/Gaegu),
[Klee One](https://fonts.google.com/specimen/Klee+One),
[Ma Shan Zheng](https://fonts.google.com/specimen/Ma+Shan+Zheng) — all SIL OFL 1.1.
